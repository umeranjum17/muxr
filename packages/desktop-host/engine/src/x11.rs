//! An X11 desktop: capture and input over one connection.
//!
//! This is the second capture backend, and the one a machine without a working
//! screen-cast portal uses — a headless X server, a remote X session, or
//! XWayland. It is capability-detected rather than assumed: the portal is
//! preferred when it is there, because the portal is what carries the user's
//! consent on a Wayland desktop.
//!
//! Capture reads the root window directly and input goes through XTest, so on an
//! X server this process owns, **nothing it does can reach another session's
//! keyboard**: XTest is scoped to the X server it is connected to, unlike
//! `uinput`, which the kernel delivers to whatever holds the seat.

use crate::convert::{fit, to_i420, I420};
use anyhow::{Context, Result};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{ConnectionExt as _, ImageFormat, Screen};
use x11rb::protocol::xtest::ConnectionExt as _;
use x11rb::rust_connection::RustConnection;

/// X key codes are evdev codes offset by 8 on every evdev-backed server,
/// including Xvfb, so the layout mapping the engine already has applies here too.
const X_KEYCODE_OFFSET: u8 = 8;

/// X core-protocol button numbers.
pub mod button {
    pub const LEFT: u8 = 1;
    pub const MIDDLE: u8 = 2;
    pub const RIGHT: u8 = 3;
    pub const WHEEL_UP: u8 = 4;
    pub const WHEEL_DOWN: u8 = 5;
    pub const WHEEL_LEFT: u8 = 6;
    pub const WHEEL_RIGHT: u8 = 7;
}

pub struct X11Desktop {
    connection: RustConnection,
    root: u32,
    pub width: usize,
    pub height: usize,
    /// Bytes per pixel the server reports; 4 for the 24/32-bit TrueColor that
    /// every normal server uses, and the only depth this backend reads.
    depth: u8,
}

impl X11Desktop {
    /// Connect to `display` (`:99`, or the `DISPLAY` environment when omitted).
    pub fn connect(display: Option<&str>) -> Result<Self> {
        let (connection, screen_number) = match display {
            Some(display) => RustConnection::connect(Some(display))
                .with_context(|| format!("cannot open X display {display}"))?,
            None => RustConnection::connect(None).context("cannot open the X display in DISPLAY")?,
        };
        let screen: &Screen = connection
            .setup()
            .roots
            .get(screen_number as usize)
            .context("the X display has no screen")?;
        if screen.root_depth != 24 {
            anyhow::bail!(
                "unsupported X root depth {}; this backend reads 24-bit TrueColor",
                screen.root_depth
            );
        }
        Ok(Self {
            root: screen.root,
            width: screen.width_in_pixels as usize,
            height: screen.height_in_pixels as usize,
            depth: screen.root_depth,
            connection,
        })
    }

    pub fn screen_size(&self) -> (i32, i32) {
        (self.width as i32, self.height as i32)
    }

    /// Read the whole root window as I420, downscaled into the caller's box.
    ///
    /// The root image is the composited screen contents: on a server with no
    /// compositor this is every window drawn onto the framebuffer, which is what
    /// the viewer expects to see.
    pub fn capture(&mut self, max_width: usize, max_height: usize) -> Result<I420> {
        let image = self
            .connection
            .get_image(
                ImageFormat::Z_PIXMAP,
                self.root,
                0,
                0,
                self.width as u16,
                self.height as u16,
                u32::MAX,
            )
            .context("X11 GetImage failed")?
            .reply()
            .context("X11 GetImage returned no reply")?;
        let stride = self.width * 4;
        if image.data.len() < stride * self.height {
            anyhow::bail!(
                "X11 returned {} bytes for a {}x{} screen",
                image.data.len(),
                self.width,
                self.height
            );
        }
        let (width, height) = fit(self.width, self.height, max_width, max_height);
        // The server's depth is the only field that can tell us how the pixel is
        // packed; the engine assumes the byte order every TrueColor server uses.
        let _ = self.depth;
        to_i420(
            &image.data,
            self.width,
            self.height,
            stride,
            crate::capture::PixelFormat::Bgrx,
            width,
            height,
        )
        .context("the captured X11 pixels are not a format this engine can read")
    }

    fn flush(&self) -> Result<()> {
        self.connection
            .flush()
            .context("the X11 connection dropped")
    }

    pub fn move_pointer(&self, x: i64, y: i64) -> Result<()> {
        let (x, y) = self.clamp(x, y);
        self.connection
            .xtest_fake_input(
                x11rb::protocol::xproto::MOTION_NOTIFY_EVENT,
                false as u8,
                0,
                self.root,
                x as i16,
                y as i16,
                0,
            )
            .context("XTest motion failed")?;
        self.flush()
    }

    pub fn button(&self, button: u8, down: bool) -> Result<()> {
        self.connection
            .xtest_fake_input(
                x11rb::protocol::xproto::BUTTON_PRESS_EVENT + u8::from(!down),
                button,
                0,
                self.root,
                0,
                0,
                0,
            )
            .context("XTest button failed")?;
        self.flush()
    }

    /// A wheel notch. `dy` is in detents and positive means "down", matching the
    /// control channel's convention.
    pub fn scroll(&self, dx: i64, dy: i64) -> Result<()> {
        for _ in 0..dy.abs().min(20) {
            self.button(if dy > 0 { button::WHEEL_DOWN } else { button::WHEEL_UP }, true)?;
            self.button(if dy > 0 { button::WHEEL_DOWN } else { button::WHEEL_UP }, false)?;
        }
        for _ in 0..dx.abs().min(20) {
            self.button(if dx > 0 { button::WHEEL_RIGHT } else { button::WHEEL_LEFT }, true)?;
            self.button(if dx > 0 { button::WHEEL_RIGHT } else { button::WHEEL_LEFT }, false)?;
        }
        Ok(())
    }

    /// `evdev_code` is the layout layer's Linux key code; the X server's own key
    /// code for it is that value plus eight.
    pub fn key(&self, evdev_code: i16, down: bool) -> Result<()> {
        let keycode = evdev_code.saturating_add(X_KEYCODE_OFFSET as i16);
        if !(8..=255).contains(&keycode) {
            anyhow::bail!("{evdev_code} is not a key this X server can press");
        }
        self.connection
            .xtest_fake_input(
                x11rb::protocol::xproto::KEY_PRESS_EVENT + u8::from(!down),
                keycode as u8,
                0,
                0,
                0,
                0,
                0,
            )
            .context("XTest key failed")?;
        self.flush()
    }

    fn clamp(&self, x: i64, y: i64) -> (i64, i64) {
        (
            x.clamp(0, self.width.saturating_sub(1) as i64),
            y.clamp(0, self.height.saturating_sub(1) as i64),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fitting_never_upscales_and_keeps_even_dimensions() {
        assert_eq!(fit(800, 600, 1280, 800), (800, 600));
        assert_eq!(fit(1920, 1080, 1280, 720), (1280, 720));
        let (w, h) = fit(1000, 1000, 600, 600);
        assert_eq!((w, h), (600, 600));
    }
}
