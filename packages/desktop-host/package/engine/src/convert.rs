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
fn luma(r: i32, g: i32, b: i32) -> u8 {
    // BT.601 limited range, integer weights (the classic libyuv-equivalent form).
    (((66 * r + 129 * g + 25 * b + 128) >> 8) + 16).clamp(0, 255) as u8
}

#[inline]
fn chroma(r: i32, g: i32, b: i32) -> (u8, u8) {
    let u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
    let v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
    (u.clamp(0, 255) as u8, v.clamp(0, 255) as u8)
}

/// Fit a source into a box without upscaling and with even dimensions, because
/// I420 chroma is subsampled and the encoder refuses a frame whose size is not
/// the one it was built for. This is the single definition of that rule: the
/// encoder's geometry, the portal frames and the X11 frames all call it.
pub fn fit(width: usize, height: usize, max_width: usize, max_height: usize) -> (usize, usize) {
    if max_width == 0 || max_height == 0 || (width <= max_width && height <= max_height) {
        return (width & !1, height & !1);
    }
    let scale = f64::min(
        max_width as f64 / width as f64,
        max_height as f64 / height as f64,
    );
    (
        (((width as f64 * scale) as usize) & !1).max(2),
        (((height as f64 * scale) as usize) & !1).max(2),
    )
}

/// Which bytes of a source pixel are red, green and blue, and how wide it is.
fn layout(format: PixelFormat) -> Option<(usize, [usize; 3])> {
    match format {
        PixelFormat::Bgrx | PixelFormat::Bgra => Some((4, [2, 1, 0])),
        PixelFormat::Rgbx | PixelFormat::Rgba => Some((4, [0, 1, 2])),
        PixelFormat::Bgr => Some((3, [2, 1, 0])),
        PixelFormat::Rgb => Some((3, [0, 1, 2])),
        PixelFormat::Unsupported => None,
    }
}

/// How many threads convert one frame. A 4K desktop is 8 million pixels, which
/// one core converts in tens of milliseconds, the whole budget of a frame; a few
/// bands bring that under the encoder's own cost without taking the machine.
fn bands() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .clamp(1, 8)
}

/// Convert `src` (packed RGB of some byte order) to `dst_w`x`dst_h` I420.
///
/// At the source's own size every pixel is converted as it is, which is what
/// keeps text sharp; smaller, each destination pixel is the box average of the
/// source pixels it covers, the only downscale filter that does not alias text;
/// larger (a stream a few pixels short of the encoder's size), the nearest
/// source pixel.
/// Chroma is the average of each 2x2 block. `src_stride` is in bytes. Returns
/// `None` for a format we cannot read, so the caller reports an unsupported
/// source instead of encoding noise.
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
    let (bytes_per_pixel, order) = layout(format)?;
    if src_stride < src_w * bytes_per_pixel
        || src.len() < src_stride * (src_h - 1) + src_w * bytes_per_pixel
    {
        return None;
    }
    let mut out = I420::new(dst_w, dst_h);
    let (y_plane, chroma) = out.data.split_at_mut(dst_w * dst_h);
    let (u_plane, v_plane) = chroma.split_at_mut((dst_w / 2) * (dst_h / 2));

    // Bands of whole row pairs, so each thread owns disjoint luma and chroma rows.
    let pairs = dst_h / 2;
    let per_band = pairs.div_ceil(bands());
    let cw = dst_w / 2;
    let source = Source {
        data: src,
        width: src_w,
        height: src_h,
        stride: src_stride,
        bytes_per_pixel,
        order,
    };
    std::thread::scope(|scope| {
        let y_bands = y_plane.chunks_mut(per_band * 2 * dst_w);
        let u_bands = u_plane.chunks_mut(per_band * cw);
        let v_bands = v_plane.chunks_mut(per_band * cw);
        for (band, ((y, u), v)) in y_bands.zip(u_bands).zip(v_bands).enumerate() {
            let source = &source;
            scope.spawn(move || {
                let first_pair = band * per_band;
                for pair in 0..u.len() / cw {
                    let dy = (first_pair + pair) * 2;
                    let (top, bottom) =
                        y[pair * 2 * dst_w..(pair + 1) * 2 * dst_w].split_at_mut(dst_w);
                    let u_row = &mut u[pair * cw..(pair + 1) * cw];
                    let v_row = &mut v[pair * cw..(pair + 1) * cw];
                    source.row_pair(dy, dst_w, dst_h, top, bottom, u_row, v_row);
                }
            });
        }
    });
    Some(out)
}

struct Source<'a> {
    data: &'a [u8],
    width: usize,
    height: usize,
    stride: usize,
    bytes_per_pixel: usize,
    order: [usize; 3],
}

impl Source<'_> {
    #[inline]
    fn rgb(&self, x: usize, y: usize) -> (i32, i32, i32) {
        let i = y * self.stride + x * self.bytes_per_pixel;
        let p = &self.data[i..i + 3];
        (
            p[self.order[0]] as i32,
            p[self.order[1]] as i32,
            p[self.order[2]] as i32,
        )
    }

    /// The average colour of the source pixels destination pixel (dx, dy) covers.
    #[inline]
    fn sample(&self, dx: usize, dy: usize, dst_w: usize, dst_h: usize) -> (i32, i32, i32) {
        if dst_w == self.width && dst_h == self.height {
            return self.rgb(dx, dy);
        }
        let x0 = dx * self.width / dst_w;
        let x1 = ((dx + 1) * self.width)
            .div_ceil(dst_w)
            .clamp(x0 + 1, self.width);
        let y0 = dy * self.height / dst_h;
        let y1 = ((dy + 1) * self.height)
            .div_ceil(dst_h)
            .clamp(y0 + 1, self.height);
        let (mut r, mut g, mut b) = (0i32, 0i32, 0i32);
        for y in y0..y1 {
            for x in x0..x1 {
                let (pr, pg, pb) = self.rgb(x, y);
                r += pr;
                g += pg;
                b += pb;
            }
        }
        let n = ((x1 - x0) * (y1 - y0)) as i32;
        (r / n, g / n, b / n)
    }

    /// Two destination rows and the chroma row they share.
    #[allow(clippy::too_many_arguments)]
    fn row_pair(
        &self,
        dy: usize,
        dst_w: usize,
        dst_h: usize,
        top: &mut [u8],
        bottom: &mut [u8],
        u: &mut [u8],
        v: &mut [u8],
    ) {
        for cx in 0..dst_w / 2 {
            let dx = cx * 2;
            let a = self.sample(dx, dy, dst_w, dst_h);
            let b = self.sample(dx + 1, dy, dst_w, dst_h);
            let c = self.sample(dx, dy + 1, dst_w, dst_h);
            let d = self.sample(dx + 1, dy + 1, dst_w, dst_h);
            top[dx] = luma(a.0, a.1, a.2);
            top[dx + 1] = luma(b.0, b.1, b.2);
            bottom[dx] = luma(c.0, c.1, c.2);
            bottom[dx + 1] = luma(d.0, d.1, d.2);
            let (cu, cv) = chroma(
                (a.0 + b.0 + c.0 + d.0 + 2) >> 2,
                (a.1 + b.1 + c.1 + d.1 + 2) >> 2,
                (a.2 + b.2 + c.2 + d.2 + 2) >> 2,
            );
            u[cx] = cu;
            v[cx] = cv;
        }
    }
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
        assert!(
            out.y_plane().iter().all(|&y| y > 70),
            "red luma should be high"
        );
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
    fn a_stream_a_few_pixels_off_the_encoders_size_is_converted_to_exactly_that_size() {
        // A fractional-scaled display reports one size to the portal and
        // streams another; the encoder only accepts its own.
        let src = vec![200u8; 4 * 1704 * 1066];
        let out = to_i420(&src, 1704, 1066, 1704 * 4, PixelFormat::Bgrx, 1706, 1066).unwrap();
        assert_eq!((out.width, out.height), (1706, 1066));
        let out = to_i420(&src, 1704, 1066, 1704 * 4, PixelFormat::Bgrx, 1702, 1064).unwrap();
        assert_eq!((out.width, out.height), (1702, 1064));
    }

    #[test]
    fn unsupported_format_is_reported_not_guessed() {
        assert!(to_i420(&vec![0u8; 64], 4, 4, 16, PixelFormat::Unsupported, 2, 2).is_none());
    }
}
