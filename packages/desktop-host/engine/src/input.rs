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

/// A live pair of virtual devices. Dropping this releases anything still held
/// and removes the devices, which is what makes a dropped connection safe.
pub struct InputDevices {
    mouse: *mut Mouse,
    keyboard: *mut Keyboard,
    pressed_keys: Vec<i16>,
    pressed_buttons: Vec<Button>,
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
            pressed_keys: Vec::new(),
            pressed_buttons: Vec::new(),
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
            if !self.pressed_buttons.contains(&button) {
                self.pressed_buttons.push(button);
            }
            unsafe { inputtino_mouse_press_button(self.mouse, button as c_int) };
        } else {
            self.pressed_buttons.retain(|held| *held != button);
            unsafe { inputtino_mouse_release_button(self.mouse, button as c_int) };
        }
    }

    pub fn scroll(&mut self, dx: i64, dy: i64) {
        // libinput's high-resolution wheel unit is 120 per detent; a phone's
        // scroll gesture maps to a small number of detents, not to pixels.
        let vertical = (dy * 120).clamp(-1200, 1200) as c_int;
        let horizontal = (dx * 120).clamp(-1200, 1200) as c_int;
        if vertical != 0 {
            unsafe { inputtino_mouse_scroll_vertical(self.mouse, vertical) };
        }
        if horizontal != 0 {
            unsafe { inputtino_mouse_scroll_horizontal(self.mouse, horizontal) };
        }
    }

    pub fn key(&mut self, code: i16, down: bool) {
        if down {
            if !self.pressed_keys.contains(&code) {
                self.pressed_keys.push(code);
            }
            unsafe { inputtino_keyboard_press(self.keyboard, code) };
        } else {
            self.pressed_keys.retain(|held| *held != code);
            unsafe { inputtino_keyboard_release(self.keyboard, code) };
        }
    }

    /// Release everything this session pressed. Called on close, on revoke and
    /// on drop, so a dropped connection cannot leave a modifier stuck down.
    pub fn release_all(&mut self) {
        for button in std::mem::take(&mut self.pressed_buttons) {
            unsafe { inputtino_mouse_release_button(self.mouse, button as c_int) };
        }
        for code in std::mem::take(&mut self.pressed_keys) {
            unsafe { inputtino_keyboard_release(self.keyboard, code) };
        }
    }

    pub fn held(&self) -> usize {
        self.pressed_keys.len() + self.pressed_buttons.len()
    }
}

impl Drop for InputDevices {
    fn drop(&mut self) {
        self.release_all();
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

    /// Proving the backend is really available here is the point: if this host
    /// cannot create the devices, the engine must say so rather than offer a
    /// control surface that does nothing.
    #[test]
    fn this_host_can_create_and_destroy_the_virtual_devices() {
        match InputDevices::create(2560, 1440) {
            Ok(mut devices) => {
                assert_eq!(devices.held(), 0);
                devices.release_all();
            }
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
