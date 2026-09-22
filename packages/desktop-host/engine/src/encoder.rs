//! VP9 encoding, wrapping libvpx's encoder through the C shim in
//! `native/vpx_shim.c`.
//!
//! Real-time, single pass, zero lookahead: one frame in, one packet out, so the
//! far end never waits on a frame the encoder is still holding. Hardware
//! encoders are deliberately not used — VP9 hardware encode is vendor-specific
//! and would put a driver dependency on the machine class.
//!
//! Tuned for a desktop rather than a camera: screen-content mode, key frames
//! only on request, and a refinement pass. While the desktop moves, frames are
//! coded against the rate target; once it stops, the last frame is coded once
//! more under a low quantizer ceiling, so what the user reads is sharp without
//! paying for sharpness on every frame of a scroll.

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
    fn dl_vpx_reconfigure(encoder: *mut NativeEncoder, bitrate_kbps: c_int, max_quantizer: c_int) -> c_int;
    fn dl_vpx_motion_max_q() -> c_int;
    fn dl_vpx_packet_data(encoder: *const NativeEncoder) -> *const u8;
    fn dl_vpx_packet_size(encoder: *const NativeEncoder) -> usize;
    fn dl_vpx_packet_is_key(encoder: *const NativeEncoder) -> c_int;
    fn dl_vpx_destroy(encoder: *mut NativeEncoder);
}

/// The quantizer ceiling of a refinement pass (VP9's 0–63 scale). Low enough
/// that small text is crisp; the pass happens once per still, not per frame.
const REFINE_MAX_Q: c_int = 10;

/// libvpx's speed/quality trade for real time. 8 codes a 4K desktop frame well
/// inside a 30 fps budget on a desktop CPU.
const CPU_USED: c_int = 8;

/// One encoded VP9 frame as libvpx produced it.
pub struct EncodedFrame {
    pub data: Vec<u8>,
    /// A key frame: decodable on its own. The transport has to say so.
    pub keyframe: bool,
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
                CPU_USED,
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

    /// Change the rate target for the frames that follow.
    pub fn set_bitrate(&mut self, bitrate_kbps: u32) -> Result<()> {
        let status = unsafe {
            dl_vpx_reconfigure(self.native, bitrate_kbps.max(1) as c_int, dl_vpx_motion_max_q())
        };
        if status != 0 {
            anyhow::bail!("libvpx refused a {bitrate_kbps} kbps target");
        }
        self.bitrate_kbps = bitrate_kbps.max(1);
        Ok(())
    }

    /// Code `frame` again, unchanged, under the refinement ceiling. The result is
    /// an inter frame that carries only the detail the last one lacked.
    pub fn refine(&mut self, frame: &I420) -> Result<EncodedFrame> {
        let bitrate = self.bitrate_kbps.max(1) as c_int;
        if unsafe { dl_vpx_reconfigure(self.native, bitrate, REFINE_MAX_Q) } != 0 {
            anyhow::bail!("libvpx refused the refinement ceiling");
        }
        let packet = self.encode(frame, false);
        let restored = unsafe { dl_vpx_reconfigure(self.native, bitrate, dl_vpx_motion_max_q()) };
        if restored != 0 {
            anyhow::bail!("libvpx refused to restore the motion ceiling");
        }
        packet
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
        let keyframe = unsafe { dl_vpx_packet_is_key(self.native) } != 0;
        Ok(EncodedFrame { data: bytes, keyframe })
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

