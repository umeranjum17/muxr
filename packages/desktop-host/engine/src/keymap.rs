//! Turning a character or a named key into a Linux key code plus the modifier
//! presses that reach it on the layout this process compiles.
//!
//! The layout comes from the session's `XKB_DEFAULT_*` variables when it exports
//! them, and from xkbcommon's defaults (`us` on `evdev`/`pc105`) otherwise. It is
//! not yet the compositor's live layout; `capabilities()` reports the identity
//! actually compiled so the two can be told apart. A character the compiled
//! layout cannot produce is refused rather than approximated, which is why the
//! protocol reports the text capability it actually has.

use crate::input::keycode;
use anyhow::Result;
use xkbcommon::xkb;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Keystroke {
    pub code: i16,
    pub shift: bool,
    pub alt_gr: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub meta: bool,
}

impl Keystroke {
    fn simple(code: i16) -> Self {
        Self {
            code,
            shift: false,
            alt_gr: false,
            ctrl: false,
            alt: false,
            meta: false,
        }
    }

    /// Modifier key codes to press before this keystroke, outermost first.
    pub fn modifiers(&self) -> Vec<i16> {
        let mut held = Vec::new();
        if self.ctrl {
            held.push(keycode::LEFT_CTRL);
        }
        if self.alt {
            held.push(keycode::LEFT_ALT);
        }
        if self.meta {
            held.push(keycode::LEFT_META);
        }
        if self.shift {
            held.push(keycode::LEFT_SHIFT);
        }
        if self.alt_gr {
            held.push(keycode::RIGHT_ALT);
        }
        held
    }
}

/// Keys that have no character of their own.
pub fn named_key(name: &str) -> Option<Keystroke> {
    let code = match name {
        "Enter" | "Return" => keycode::ENTER,
        "Tab" => keycode::TAB,
        "Escape" => keycode::ESC,
        "Backspace" | "DeleteBackward" => keycode::BACKSPACE,
        "Delete" | "DeleteForward" => keycode::DELETE,
        "ArrowUp" => keycode::UP,
        "ArrowDown" => keycode::DOWN,
        "ArrowLeft" => keycode::LEFT,
        "ArrowRight" => keycode::RIGHT,
        "Home" => keycode::HOME,
        "End" => keycode::END,
        "PageUp" => keycode::PAGE_UP,
        "PageDown" => keycode::PAGE_DOWN,
        _ => return None,
    };
    Some(Keystroke::simple(code))
}

/// A modifier the client asked for by name, resolved against the real key codes.
pub fn modifier_key(name: &str) -> Option<i16> {
    match name {
        "Control" | "ControlLeft" | "Ctrl" => Some(keycode::LEFT_CTRL),
        "ControlRight" => Some(keycode::RIGHT_CTRL),
        "Shift" | "ShiftLeft" => Some(keycode::LEFT_SHIFT),
        "ShiftRight" => Some(keycode::RIGHT_SHIFT),
        "Alt" | "AltLeft" => Some(keycode::LEFT_ALT),
        "AltRight" | "AltGraph" => Some(keycode::RIGHT_ALT),
        "Meta" | "MetaLeft" | "Super" | "Command" => Some(keycode::LEFT_META),
        "MetaRight" => Some(keycode::RIGHT_META),
        _ => None,
    }
}

// xkbcommon keymaps are immutable once compiled and documented as safe for
// concurrent reads; the engine only ever reads this one, and only under a mutex.
unsafe impl Send for Layout {}
unsafe impl Sync for Layout {}

/// The RMLVO names the engine compiles, from the session's `XKB_DEFAULT_*`
/// variables or xkbcommon's defaults when it exports none.
pub struct LayoutNames {
    pub rules: String,
    pub model: String,
    pub layout: String,
    pub variant: String,
    pub options: Option<String>,
}

impl LayoutNames {
    pub fn from_environment() -> Self {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    /// The identity the capability surface reports, e.g. `us` or `de(nodeadkeys)`.
    pub fn identity(&self) -> String {
        if self.variant.is_empty() {
            self.layout.clone()
        } else {
            format!("{}({})", self.layout, self.variant)
        }
    }

    fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let named = |key: &str, fallback: &str| {
            lookup(key)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| String::from(fallback))
        };
        Self {
            rules: named("XKB_DEFAULT_RULES", "evdev"),
            model: named("XKB_DEFAULT_MODEL", "pc105"),
            layout: named("XKB_DEFAULT_LAYOUT", "us"),
            variant: named("XKB_DEFAULT_VARIANT", ""),
            options: lookup("XKB_DEFAULT_OPTIONS").filter(|value| !value.is_empty()),
        }
    }
}

/// The active keyboard layout, compiled once per session.
pub struct Layout {
    keymap: xkb::Keymap,
    shift_mask: xkb::ModMask,
    alt_gr_mask: xkb::ModMask,
}

impl Layout {
    /// Build from the session's RMLVO, falling back to the standard
    /// `evdev`/`pc105`/`us` keymap when it exports none.
    pub fn from_environment() -> Result<Self> {
        Self::from_names(&LayoutNames::from_environment())
    }

    fn from_names(names: &LayoutNames) -> Result<Self> {
        let context = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
        let keymap = xkb::Keymap::new_from_names(
            &context,
            &names.rules,
            &names.model,
            &names.layout,
            &names.variant,
            names.options.clone(),
            xkb::KEYMAP_COMPILE_NO_FLAGS,
        )
        .ok_or_else(|| anyhow::anyhow!("xkbcommon could not compile the {} keymap", names.identity()))?;
        // Level bit 0 is the shift level and bit 1 the AltGr/level-3 shift on
        // every standard XKB layout, and the real modifier index for each name
        // comes from the compiled keymap rather than from an assumption that
        // shift is mod 1.
        let shift_mask = 1u32 << keymap.mod_get_index(xkb::MOD_NAME_SHIFT);
        let alt_gr_mask = 1u32 << keymap.mod_get_index(xkb::MOD_NAME_ALT);
        Ok(Self {
            keymap,
            shift_mask,
            alt_gr_mask,
        })
    }

    /// Find a key code and modifier combination that produces `character`, by
    /// walking exactly the levels the active layout defines.
    pub fn keystroke_for_char(&self, character: char) -> Option<Keystroke> {
        let wanted = xkb::Keysym::from_char(character);
        let shift = self.shift_mask;
        let alt_gr = self.alt_gr_mask;
        for raw in 9u32..=255u32 {
            let code = xkb::Keycode::new(raw);
            let levels = self.keymap.num_levels_for_key(code, 0);
            for level in 0..levels {
                let mut modifiers = xkb::ModMask::from(0u32);
                if level & 1 == 1 {
                    modifiers |= shift;
                }
                if level & 2 == 2 {
                    modifiers |= alt_gr;
                }
                let syms = self.keymap.key_get_syms_by_level(code, 0, level);
                if !syms.contains(&wanted) {
                    continue;
                }
                return Some(Keystroke {
                    // XKB key codes are evdev codes offset by 8.
                    code: (raw - 8) as i16,
                    shift: modifiers & shift != 0,
                    alt_gr: modifiers & alt_gr != 0,
                    ctrl: false,
                    alt: false,
                    meta: false,
                });
            }
        }
        None
    }

    /// Apply text as real key events. Returns the characters that this layout
    /// cannot produce, so the caller can report an honest partial result rather
    /// than silently dropping them.
    pub fn plan_text(&self, text: &str) -> (Vec<Vec<Keystroke>>, String) {
        let mut plan = Vec::new();
        let mut unreachable = String::new();
        for character in text.chars() {
            if character == '\n' {
                plan.push(vec![Keystroke::simple(keycode::ENTER)]);
                continue;
            }
            if character == '\t' {
                plan.push(vec![Keystroke::simple(keycode::TAB)]);
                continue;
            }
            match self.keystroke_for_char(character) {
                Some(keystroke) => plan.push(vec![keystroke]),
                None => unreachable.push(character),
            }
        }
        (plan, unreachable)
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_layout_that_comes_from_the_environment_is_the_one_compiled() {
        let names = LayoutNames::from_lookup(|key| match key {
            "XKB_DEFAULT_LAYOUT" => Some(String::from("de")),
            _ => None,
        });
        assert_eq!(names.identity(), "de");

        let layout = Layout::from_names(&names).expect("the German keymap should compile");
        let (plan, unreachable) = layout.plan_text("z");
        assert!(unreachable.is_empty(), "z should be reachable: {unreachable:?}");
        // QWERTZ puts z where a US layout puts y, so the compiled keymap is the
        // environment's, not the library default.
        assert_eq!(plan[0][0].code, 21, "z must sit on the y key position");
    }

    #[test]
    fn a_session_with_no_layout_variable_reports_the_library_default() {
        assert_eq!(LayoutNames::from_lookup(|_| None).identity(), "us");
    }

    #[test]
    fn a_character_is_planned_as_a_real_key_event_on_the_compiled_layout() {
        let layout = Layout::from_environment().expect("a keymap should compile");
        let (plan, unreachable) = layout.plan_text("aA");
        assert!(unreachable.is_empty(), "ASCII should be reachable: {unreachable:?}");
        assert_eq!(plan.len(), 2);
        assert!(!plan[0][0].shift, "lower-case a needs no shift");
        assert!(plan[1][0].shift, "upper-case A needs shift on any normal layout");
        assert_eq!(plan[0][0].code, plan[1][0].code, "both letters share a key");
    }

    #[test]
    fn named_keys_and_modifiers_resolve_to_linux_key_codes() {
        assert_eq!(named_key("Enter").unwrap().code, keycode::ENTER);
        assert_eq!(named_key("ArrowLeft").unwrap().code, keycode::LEFT);
        assert_eq!(modifier_key("Control"), Some(keycode::LEFT_CTRL));
        assert!(named_key("Frobnicate").is_none());
        assert!(modifier_key("Hyper").is_none());
    }

    #[test]
    fn text_this_layout_cannot_produce_is_reported_not_invented() {
        let layout = Layout::from_environment().unwrap();
        let (_, unreachable) = layout.plan_text("\u{1F600}");
        assert_eq!(unreachable, "\u{1F600}");
    }
}
