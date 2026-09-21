//! VP9 encoding, wrapping libvpx's encoder through the C shim in
//! `native/vpx_shim.c`.
//!
//! Real-time, single pass, zero lookahead: one frame in, one packet out, so the
//! far end never waits on a frame the encoder is still holding. Hardware
//! encoders are deliberately not used — VP9 hardware encode is vendor-specific
//! and would put a driver dependency on the machine class, while software VP9
//! at a phone-sized resolution is cheap and identical everywhere.

use crate::convert::I420;
use anyhow::Result;
use std::os::raw::c_int;

#[repr(C)]
struct NativeEncoder {
    _private: [u8; 0],
}

extern "C" {
    fn dl_vpx_create(
        width: c_int,
        height: c_int,
        bitrate_kbps: c_int,
        fps: c_int,
        threads: c_int,
        cpu_used: c_int,
    ) -> *mut NativeEncoder;
    fn dl_vpx_encode(
        encoder: *mut NativeEncoder,
        i420: *const u8,
        force_keyframe: c_int,
    ) -> c_int;
    fn dl_vpx_packet_data(encoder: *const NativeEncoder) -> *const u8;
    fn dl_vpx_packet_size(encoder: *const NativeEncoder) -> usize;
    fn dl_vpx_destroy(encoder: *mut NativeEncoder);
}

/// One encoded VP9 frame as libvpx produced it.
pub struct EncodedFrame {
    pub data: Vec<u8>,
}

pub struct Encoder {
    native: *mut NativeEncoder,
    width: usize,
    height: usize,
    pub bitrate_kbps: u32,
}

// The encoder is moved to the pipeline thread and only used there; libvpx has
// no cross-thread requirements of its own beyond not calling into one context
// concurrently, which the session's single writer guarantees.
unsafe impl Send for Encoder {}

impl Encoder {
    pub fn new(
        width: usize,
        height: usize,
        bitrate_kbps: u32,
        fps: u32,
        threads: u32,
    ) -> Result<Self> {
        let native = unsafe {
            dl_vpx_create(
                width as c_int,
                height as c_int,
                bitrate_kbps as c_int,
                fps.max(1) as c_int,
                threads.max(1) as c_int,
                8,
            )
        };
        if native.is_null() {
            anyhow::bail!("libvpx refused to initialise a VP9 encoder for {width}x{height}");
        }
        Ok(Self {
            native,
            width,
            height,
            bitrate_kbps,
        })
    }

    pub fn encode(&mut self, frame: &I420, force_keyframe: bool) -> Result<EncodedFrame> {
        if frame.width != self.width || frame.height != self.height {
            anyhow::bail!(
                "encoder is {}x{} but was given {}x{}",
                self.width,
                self.height,
                frame.width,
                frame.height
            );
        }
        let status = unsafe {
            dl_vpx_encode(self.native, frame.data.as_ptr(), force_keyframe as c_int)
        };
        if status < 0 {
            anyhow::bail!("libvpx rejected a {}x{} frame", self.width, self.height);
        }
        if status == 0 {
            anyhow::bail!("libvpx produced no packet for a frame");
        }
        let size = unsafe { dl_vpx_packet_size(self.native) };
        let data = unsafe { dl_vpx_packet_data(self.native) };
        if data.is_null() || size == 0 {
            anyhow::bail!("libvpx reported a zero-length packet");
        }
        let bytes = unsafe { std::slice::from_raw_parts(data, size) }.to_vec();
        Ok(EncodedFrame { data: bytes })
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        if !self.native.is_null() {
            unsafe { dl_vpx_destroy(self.native) };
            self.native = std::ptr::null_mut();
        }
    }
}

impl std::fmt::Debug for Encoder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Encoder({}x{}, {}kbps)", self.width, self.height, self.bitrate_kbps)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank(width: usize, height: usize) -> I420 {
        I420 {
            width,
            height,
            data: vec![128u8; width * height + 2 * (width / 2) * (height / 2)],
        }
    }

    #[test]
    fn encodes_successive_frames_and_refuses_a_mismatched_geometry() {
        let (w, h) = (64usize, 64usize);
        let mut encoder = Encoder::new(w, h, 500, 30, 2).expect("encoder should start");
        assert!(!encoder.encode(&blank(w, h), true).unwrap().data.is_empty());
        assert!(!encoder.encode(&blank(w, h), false).unwrap().data.is_empty());
        assert!(encoder.encode(&blank(32, 32), false).is_err());
    }
}
