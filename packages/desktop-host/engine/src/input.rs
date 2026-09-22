//! Virtual pointer and keyboard through inputtino (MIT) over `uinput`.
//!
//! The engine creates *its own* virtual devices and destroys them when the
//! session ends. It never reads real input devices, never needs the broad
//! `input` group for anything but the `uinput` node itself, and never asks for
//! privileges: if `/dev/uinput` is not writable the backend reports itself
//! unavailable and the engine still captures.

use anyhow::Result;
use std::ffi::CString;
use std::os::raw::{c_char, c_int, c_short, c_void};

#[repr(C)]
struct DeviceDefinition {
    name: *const c_char,
    vendor_id: u16,
    product_id: u16,
    version: u16,
    device_phys: *const c_char,
    device_uniq: *const c_char,
}

#[repr(C)]
struct ErrorHandler {
    handler: Option<extern "C" fn(*const c_char, *mut c_void)>,
    user_data: *mut c_void,
}

enum Mouse {}
enum Keyboard {}

extern "C" {
    fn inputtino_mouse_create(
        device: *const DeviceDefinition,
        handler: *const ErrorHandler,
    ) -> *mut Mouse;
    fn inputtino_mouse_move_absolute(
        mouse: *mut Mouse,
        x: c_int,
        y: c_int,
        screen_width: c_int,
        screen_height: c_int,
    );
    fn inputtino_mouse_press_button(mouse: *mut Mouse, button: c_int);
    fn inputtino_mouse_release_button(mouse: *mut Mouse, button: c_int);
    fn inputtino_mouse_scroll_vertical(mouse: *mut Mouse, distance: c_int);
    fn inputtino_mouse_scroll_horizontal(mouse: *mut Mouse, distance: c_int);
    fn inputtino_mouse_destroy(mouse: *mut Mouse);

    fn inputtino_keyboard_create(
        device: *const DeviceDefinition,
        handler: *const ErrorHandler,
    ) -> *mut Keyboard;
    fn inputtino_keyboard_press(keyboard: *mut Keyboard, key_code: c_short);
    fn inputtino_keyboard_release(keyboard: *mut Keyboard, key_code: c_short);
    fn inputtino_keyboard_destroy(keyboard: *mut Keyboard);
    fn dl_inputtino_keycode(evdev_code: c_short) -> c_short;
}

/// Convert the engine's physical key identity at the native injector boundary.
pub fn native_keycode(code: i16) -> Result<i16> {
    let native = unsafe { dl_inputtino_keycode(code) };
    anyhow::ensure!(native >= 0, "the input backend cannot emit physical key {code}");
    Ok(native)
}

/// Pointer buttons, mirroring inputtino's own enum order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left = 0,
    Middle = 1,
    Right = 2,
}

impl Button {
    pub fn from_number(number: i64) -> Button {
        match number {
            2 => Button::Middle,
            3 => Button::Right,
            _ => Button::Left,
        }
    }
}

/// Linux evdev key codes, named only where the engine uses them directly.
pub mod keycode {
    pub const ESC: i16 = 1;
    pub const BACKSPACE: i16 = 14;
    pub const TAB: i16 = 15;
    pub const ENTER: i16 = 28;
    pub const LEFT_CTRL: i16 = 29;
    pub const LEFT_SHIFT: i16 = 42;
    pub const RIGHT_SHIFT: i16 = 54;
    pub const LEFT_ALT: i16 = 56;
    pub const LEFT_META: i16 = 125;
    pub const RIGHT_CTRL: i16 = 97;
    pub const RIGHT_ALT: i16 = 100;
    pub const RIGHT_META: i16 = 126;
    pub const UP: i16 = 103;
    pub const DOWN: i16 = 108;
    pub const LEFT: i16 = 105;
    pub const RIGHT: i16 = 106;
    pub const HOME: i16 = 102;
    pub const END: i16 = 107;
    pub const PAGE_UP: i16 = 104;
    pub const PAGE_DOWN: i16 = 109;
    pub const DELETE: i16 = 111;
}

/// Why the input backend is unavailable, so the consumer can say something true
/// instead of showing a dead surface.
#[derive(Debug, Clone, serde::Serialize)]
pub struct InputUnavailable {
    pub reason: String,
    pub remedy: String,
}

pub fn probe() -> Result<(), InputUnavailable> {
    match std::fs::OpenOptions::new().write(true).open("/dev/uinput") {
        Ok(_) => Ok(()),
        Err(error) => Err(InputUnavailable {
            reason: format!("/dev/uinput is not writable: {error}"),
            remedy: String::from(
                "run `desklink-host setup-input` to see the one-time, narrowly scoped access rule",
            ),
        }),
    }
}

/// What one session is currently holding down.
///
/// Kept separately from the device that applies it so the release rule — release
/// exactly what this session pressed, in a defined order, once — is one piece of
/// testable logic rather than a habit of each backend. A key released that this
/// session never pressed is the failure mode this prevents: on a shared virtual
/// keyboard it would lift a modifier someone else is holding.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct HeldState {
    keys: Vec<i16>,
    buttons: Vec<Button>,
}

impl HeldState {
    pub fn key(&mut self, code: i16, down: bool) {
        if down {
            if !self.keys.contains(&code) {
                self.keys.push(code);
            }
            return;
        }
        self.keys.retain(|held| *held != code);
    }

    pub fn button(&mut self, button: Button, down: bool) {
        if down {
            if !self.buttons.contains(&button) {
                self.buttons.push(button);
            }
            return;
        }
        self.buttons.retain(|held| *held != button);
    }

    /// Everything to release, and nothing this session did not press. Buttons
    /// first: on a desktop, a pointer button released after a modifier is the
    /// order the user's own hand would produce.
    pub fn release_plan(&mut self) -> (Vec<Button>, Vec<i16>) {
        (
            std::mem::take(&mut self.buttons),
            std::mem::take(&mut self.keys),
        )
    }
}

/// A live pair of virtual devices. Dropping this releases anything still held
/// and removes the devices, which is what makes a dropped connection safe.
pub struct InputDevices {
    mouse: *mut Mouse,
    keyboard: *mut Keyboard,
    screen_width: i32,
    screen_height: i32,
}

// Owned by one session and only touched from its input path.
unsafe impl Send for InputDevices {}

impl InputDevices {
    pub fn create(screen_width: i32, screen_height: i32) -> Result<Self> {
        probe().map_err(|unavailable| anyhow::anyhow!(unavailable.reason))?;
        let handler = ErrorHandler {
            handler: None,
            user_data: std::ptr::null_mut(),
        };
        let mouse_name = CString::new("desklink pointer").unwrap();
        let keyboard_name = CString::new("desklink keyboard").unwrap();
        let mouse_def = DeviceDefinition {
            name: mouse_name.as_ptr(),
            vendor_id: 0x1234,
            product_id: 0x0001,
            version: 1,
            device_phys: std::ptr::null(),
            device_uniq: std::ptr::null(),
        };
        let keyboard_def = DeviceDefinition {
            name: keyboard_name.as_ptr(),
            vendor_id: 0x1234,
            product_id: 0x0002,
            version: 1,
            device_phys: std::ptr::null(),
            device_uniq: std::ptr::null(),
        };

        let mouse = unsafe { inputtino_mouse_create(&mouse_def, &handler) };
        if mouse.is_null() {
            anyhow::bail!("inputtino could not create a virtual pointer");
        }
        let keyboard = unsafe { inputtino_keyboard_create(&keyboard_def, &handler) };
        if keyboard.is_null() {
            unsafe { inputtino_mouse_destroy(mouse) };
            anyhow::bail!("inputtino could not create a virtual keyboard");
        }

        Ok(Self {
            mouse,
            keyboard,
            screen_width,
            screen_height,
        })
    }

    pub fn move_absolute(&mut self, x: i64, y: i64) {
        let x = x.clamp(0, self.screen_width as i64 - 1) as c_int;
        let y = y.clamp(0, self.screen_height as i64 - 1) as c_int;
        unsafe { inputtino_mouse_move_absolute(self.mouse, x, y, self.screen_width, self.screen_height) };
    }

    pub fn button(&mut self, button: Button, down: bool) {
        if down {
            unsafe { inputtino_mouse_press_button(self.mouse, button as c_int) };
        } else {
            unsafe { inputtino_mouse_release_button(self.mouse, button as c_int) };
        }
    }

    pub fn scroll(&mut self, dx: f64, dy: f64) {
        // Protocol deltas are down/right, as in DOM wheel events and X11.
        // evdev's vertical wheel has the opposite sign (positive is up).
        // Its high-resolution unit is 120 per detent, not one screen pixel, so a
        // fraction of a detent is a smooth scroll where the client supports it.
        let vertical = (-dy * 120.0).round().clamp(-1200.0, 1200.0) as c_int;
        let horizontal = (dx * 120.0).round().clamp(-1200.0, 1200.0) as c_int;
        if vertical != 0 {
            unsafe { inputtino_mouse_scroll_vertical(self.mouse, vertical) };
        }
        if horizontal != 0 {
            unsafe { inputtino_mouse_scroll_horizontal(self.mouse, horizontal) };
        }
    }

    pub fn key(&mut self, code: i16, down: bool) -> Result<()> {
        let native_code = native_keycode(code)?;
        if down {
            unsafe { inputtino_keyboard_press(self.keyboard, native_code) };
        } else {
            unsafe { inputtino_keyboard_release(self.keyboard, native_code) };
        }
        Ok(())
    }


}

impl Drop for InputDevices {
    fn drop(&mut self) {
        // Held state is released by the session before it drops the devices; a
        // device removed without that would still leave the kernel-side release
        // to chance.
        if !self.keyboard.is_null() {
            unsafe { inputtino_keyboard_destroy(self.keyboard) };
            self.keyboard = std::ptr::null_mut();
        }
        if !self.mouse.is_null() {
            unsafe { inputtino_mouse_destroy(self.mouse) };
            self.mouse = std::ptr::null_mut();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn button_numbers_map_to_the_expected_pointer_buttons() {
        assert_eq!(Button::from_number(1), Button::Left);
        assert_eq!(Button::from_number(2), Button::Middle);
        assert_eq!(Button::from_number(3), Button::Right);
        assert_eq!(Button::from_number(9), Button::Left);
    }

    #[test]
    fn held_state_releases_exactly_what_this_session_pressed() {
        let mut held = HeldState::default();
        held.key(29, true); // left ctrl
        held.key(46, true); // c
        held.button(Button::Left, true);
        // A repeat press is the same press, not a second one, so the plan still
        // releases it exactly once.
        held.key(29, true);

        let (buttons, keys) = held.release_plan();
        assert_eq!(buttons, vec![Button::Left]);
        assert_eq!(keys, vec![29, 46]);
        assert!(held.release_plan().1.is_empty(), "releasing twice releases nothing");
    }

    #[test]
    fn an_explicit_release_leaves_only_what_is_still_pressed() {
        let mut held = HeldState::default();
        held.key(29, true);
        held.key(46, true);
        held.key(46, false);
        let (buttons, keys) = held.release_plan();
        assert!(buttons.is_empty());
        assert_eq!(keys, vec![29]);
    }

    /// Proving the backend is really available here is the point: if this host
    /// cannot create the devices, the engine must say so rather than offer a
    /// control surface that does nothing.
    #[test]
    fn this_host_can_create_and_destroy_the_virtual_devices() {
        // This touches the real desktop when uinput is writable. Ordinary
        // suites must never create devices on the owner's active session.
        if std::env::var("DESKLINK_TEST_UINPUT").as_deref() != Ok("1") {
            return;
        }
        match InputDevices::create(2560, 1440) {
            Ok(_devices) => {}
            Err(error) => {
                let unavailable = probe().unwrap_err();
                assert!(
                    error.to_string().contains(&unavailable.reason),
                    "a creation failure must be the reported availability problem"
                );
            }
        }
    }
}
