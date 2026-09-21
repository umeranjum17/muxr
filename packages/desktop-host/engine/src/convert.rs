//! Pixel conversion and downscale into the I420 plane layout libvpx encodes.
//!
//! Deliberately dependency-free: the source format a compositor actually offers
//! over PipeWire is a packed 4-byte one (`BGRx`/`RGBx`/`BGRA`/`RGBA`), and a box
//! downscale is the correct filter when the encoded surface is smaller than the
//! source — it is the only one that does not alias the desktop's text.

use crate::capture::PixelFormat;

/// A tightly packed I420 frame; the plane strides are the frame width/2 so the
/// buffer is exactly what `vpx_image_t` wants when we hand libvpx three planes.
pub struct I420 {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

impl I420 {
    fn new(width: usize, height: usize) -> Self {
        let y = width * height;
        let c = (width / 2) * (height / 2);
        Self {
            width,
            height,
            data: vec![0u8; y + 2 * c],
        }
    }

    pub fn y_plane(&self) -> &[u8] {
        &self.data[..self.width * self.height]
    }

    pub fn u_plane(&self) -> &[u8] {
        let y = self.width * self.height;
        &self.data[y..y + (self.width / 2) * (self.height / 2)]
    }

    pub fn v_plane(&self) -> &[u8] {
        let y = self.width * self.height;
        let c = (self.width / 2) * (self.height / 2);
        &self.data[y + c..y + 2 * c]
    }
}

#[inline]
fn rgb_to_yuv(r: i32, g: i32, b: i32) -> (u8, u8, u8) {
    // BT.601 limited range, integer weights (the classic libyuv-equivalent form).
    let y = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
    let u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
    let v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
    (y.clamp(0, 255) as u8, u.clamp(0, 255) as u8, v.clamp(0, 255) as u8)
}

/// Box-average `src` (a packed 4-byte image) down to `dst_w`x`dst_h` of I420.
///
/// `src_stride` is in bytes. Returns `None` for a format we cannot read, so the
/// caller reports an unsupported source instead of encoding noise.
pub fn to_i420(
    src: &[u8],
    src_w: usize,
    src_h: usize,
    src_stride: usize,
    format: PixelFormat,
    dst_w: usize,
    dst_h: usize,
) -> Option<I420> {
    if src_w == 0 || src_h == 0 || dst_w == 0 || dst_h == 0 {
        return None;
    }
    // I420 chroma is subsampled 2x2, so an odd destination would leave a
    // half-populated chroma plane. Even dimensions are the caller's contract and
    // the encoder's; enforcing it here keeps the buffer self-consistent.
    let dst_w = dst_w & !1;
    let dst_h = dst_h & !1;
    if dst_w < 2 || dst_h < 2 {
        return None;
    }
    let mut out = I420::new(dst_w, dst_h);

    // Source pixel accessors keyed by format.
    let bytes_per_pixel = match format {
        PixelFormat::Bgrx | PixelFormat::Rgbx | PixelFormat::Bgra | PixelFormat::Rgba => 4,
        PixelFormat::Bgr | PixelFormat::Rgb => 3,
        PixelFormat::Unsupported => return None,
    };
    if src_stride < src_w * bytes_per_pixel {
        return None;
    }
    if src.len() < src_stride * src_h {
        return None;
    }

    // Sampling window per destination pixel, in source pixels.
    let step_x = src_w as f64 / dst_w as f64;
    let step_y = src_h as f64 / dst_h as f64;

    let mut row = vec![(0u8, 0u8, 0u8); dst_w];
    for dy in 0..dst_h {
        let y0 = (dy as f64 * step_y) as usize;
        let y1 = (((dy + 1) as f64 * step_y).ceil() as usize).clamp(y0 + 1, src_h);
        for dx in 0..dst_w {
            let x0 = (dx as f64 * step_x) as usize;
            let x1 = (((dx + 1) as f64 * step_x).ceil() as usize).clamp(x0 + 1, src_w);

            let (mut rs, mut gs, mut bs, mut n) = (0i32, 0i32, 0i32, 0i32);
            for sy in y0..y1 {
                let base = sy * src_stride;
                for sx in x0..x1 {
                    let i = base + sx * bytes_per_pixel;
                    let (r, g, b) = match format {
                        PixelFormat::Bgrx | PixelFormat::Bgra => {
                            (src[i + 2] as i32, src[i + 1] as i32, src[i] as i32)
                        }
                        PixelFormat::Rgbx | PixelFormat::Rgba => {
                            (src[i] as i32, src[i + 1] as i32, src[i + 2] as i32)
                        }
                        PixelFormat::Bgr => (src[i + 2] as i32, src[i + 1] as i32, src[i] as i32),
                        PixelFormat::Rgb => (src[i] as i32, src[i + 1] as i32, src[i + 2] as i32),
                        PixelFormat::Unsupported => return None,
                    };
                    rs += r;
                    gs += g;
                    bs += b;
                    n += 1;
                }
            }
            let n = n.max(1);
            row[dx] = rgb_to_yuv(rs / n, gs / n, bs / n);
        }

        // Y plane for this row, plus the chroma row when we complete a 2x2 block.
        let y_base = dy * dst_w;
        for dx in 0..dst_w {
            out.data[y_base + dx] = row[dx].0;
        }
        if dy % 2 == 1 {
            let cw = dst_w / 2;
            let chroma_plane = cw * (dst_h / 2);
            let chroma_row = (dy / 2) * cw;
            let u_base = dst_w * dst_h + chroma_row;
            let v_base = dst_w * dst_h + chroma_plane + chroma_row;
            for dx in 0..cw {
                let (u0, v0) = (row[dx * 2].1 as u32, row[dx * 2].2 as u32);
                let (u1, v1) = (row[dx * 2 + 1].1 as u32, row[dx * 2 + 1].2 as u32);
                out.data[u_base + dx] = ((u0 + u1) / 2) as u8;
                out.data[v_base + dx] = ((v0 + v1) / 2) as u8;
            }
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn downscale_keeps_average_colour_and_plane_sizes() {
        // 4x4 opaque red desktop in BGRx, downscaled to 2x2.
        let mut src = vec![0u8; 4 * 16];
        for px in src.chunks_exact_mut(4) {
            px[0] = 0; // B
            px[1] = 0; // G
            px[2] = 255; // R
            px[3] = 255; // X
        }
        let out = to_i420(&src, 4, 4, 16, PixelFormat::Bgrx, 2, 2).unwrap();
        assert_eq!(out.data.len(), 4 + 2 * 1);
        assert!(out.y_plane().iter().all(|&y| y > 70), "red luma should be high");
        assert!(out.u_plane().iter().all(|&u| u < 128), "red has low Cb");
        assert!(out.v_plane().iter().all(|&v| v > 200), "red has high Cr");
    }

    #[test]
    fn odd_destination_is_clamped_to_whole_chroma_blocks() {
        let src = vec![255u8; 4 * 16];
        let out = to_i420(&src, 4, 4, 16, PixelFormat::Bgrx, 3, 3).unwrap();
        assert_eq!((out.width, out.height), (2, 2));
        assert_eq!(out.data.len(), 4 + 2 * 1);
    }

    #[test]
    fn unsupported_format_is_reported_not_guessed() {
        assert!(to_i420(&vec![0u8; 64], 4, 4, 16, PixelFormat::Unsupported, 2, 2).is_none());
    }
}
