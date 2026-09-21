//! Explicit, user-invoked clipboard transfer.
//!
//! Read and write are separate requests the consumer makes on a user action.
//! The clipboard is never polled, never watched, and never used as a hidden way
//! to type: a phone that silently replaced the user's clipboard would be worse
//! than one that could not copy at all.

use anyhow::{Context, Result};
use std::io::Read;
use wl_clipboard_rs::copy::{MimeType, Options, Source};
use wl_clipboard_rs::paste::{ClipboardType, Error as PasteError, MimeType as PasteMime, Seat};

/// The engine's bound on a single clipboard transfer. Larger than any real
/// paste of text, small enough that a hostile client cannot use it as a file
/// transfer.
pub const MAX_CLIPBOARD_BYTES: usize = 256 * 1024;

pub fn read() -> Result<String> {
    let mut options = wl_clipboard_rs::paste::get_contents(
        ClipboardType::Regular,
        Seat::Unspecified,
        PasteMime::Text,
    );
    let (mut pipe, _mime) = options.context("no text on the desktop clipboard")?;
    let mut text = String::new();
    std::io::Read::take(&mut pipe, MAX_CLIPBOARD_BYTES as u64)
        .read_to_string(&mut text)
        .context("the clipboard contents are not valid UTF-8 text")?;
    Ok(text)
}

pub fn write(text: &str) -> Result<()> {
    if text.len() > MAX_CLIPBOARD_BYTES {
        anyhow::bail!("refusing to place {} bytes on the clipboard", text.len());
    }
    Options::new()
        .copy(
            Source::Bytes(text.as_bytes().to_vec().into_boxed_slice()),
            MimeType::Text,
        )
        .context("the compositor refused a clipboard write")
}

/// Distinguishing "nothing there" from "unsupported" matters for the message the
/// user sees, so the caller can report which one happened.
pub fn read_or_explain() -> Result<String, String> {
    match read() {
        Ok(text) => Ok(text),
        Err(error) => {
            let root = error.root_cause().to_string();
            if root.contains("no suitable") || root.contains("was provided") {
                Err(String::from("the desktop clipboard has no text"))
            } else {
                Err(root)
            }
        }
    }
}

/// True when a paste failure was simply an empty clipboard.
pub fn is_empty_clipboard(error: &PasteError) -> bool {
    matches!(error, PasteError::NoMimeType | PasteError::NoSeats)
}
