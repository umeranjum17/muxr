//! Explicit, user-invoked clipboard transfer.
//!
//! Read and write are separate requests the consumer makes on a user action.
//! The clipboard is never polled, never watched, and never used as a hidden way
//! to type: a phone that silently replaced the user's clipboard would be worse
//! than one that could not copy at all.

use anyhow::{Context, Result};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use wl_clipboard_rs::paste::{ClipboardType, MimeType as PasteMime, Seat};

/// The engine's bound on a single clipboard transfer. Larger than any real
/// paste of text, small enough that a hostile client cannot use it as a file
/// transfer.
pub const MAX_CLIPBOARD_BYTES: usize = 256 * 1024;

pub fn read() -> Result<(String, bool)> {
    let options = wl_clipboard_rs::paste::get_contents(
        ClipboardType::Regular,
        Seat::Unspecified,
        PasteMime::Text,
    );
    let (mut pipe, _mime) = options.context("no text on the desktop clipboard")?;
    let mut raw = Vec::new();
    std::io::Read::take(&mut pipe, MAX_CLIPBOARD_BYTES as u64 + 1)
        .read_to_end(&mut raw)
        .context("the clipboard did not read")?;
    bounded_text(&raw, MAX_CLIPBOARD_BYTES)
}

/// The text within `limit` bytes, cut on a character boundary, and whether
/// anything past the limit was dropped.
fn bounded_text(raw: &[u8], limit: usize) -> Result<(String, bool)> {
    let truncated = raw.len() > limit;
    let bytes = if truncated { &raw[..limit] } else { raw };
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok((text.to_owned(), truncated)),
        Err(error) if truncated && error.error_len().is_none() => {
            // The invalid sequence is an incomplete one at the cut, so the bytes
            // before it are the text the desktop held.
            let valid = error.valid_up_to();
            Ok((String::from_utf8_lossy(&bytes[..valid]).into_owned(), true))
        }
        Err(_) => Err(anyhow::anyhow!("the clipboard contents are not valid UTF-8 text")),
    }
}

pub fn write(text: &str) -> Result<()> {
    if text.len() > MAX_CLIPBOARD_BYTES {
        anyhow::bail!("refusing to place {} bytes on the clipboard", text.len());
    }
    // wl-copy acknowledges setup before forking its selection server. The
    // explicit copy survives Back/engine exit, until another app replaces it.
    let mut child = Command::new("wl-copy")
        .args(["--type", "text/plain;charset=utf-8"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("wl-clipboard is required to write the desktop clipboard")?;
    let written = child.stdin.take().expect("piped clipboard input").write_all(text.as_bytes());
    let status = child.wait().context("the clipboard writer did not exit")?;
    written.context("the clipboard writer did not accept the text")?;
    anyhow::ensure!(status.success(), "the compositor refused a clipboard write");
    Ok(())
}

pub fn writer_available() -> bool {
    Command::new("wl-copy")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Distinguishing "nothing there" from "unsupported" matters for the message the
/// user sees, so the caller can report which one happened.
pub fn read_or_explain() -> Result<(String, bool), String> {
    match read() {
        Ok(result) => Ok(result),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_oversized_clipboard_is_cut_cleanly_and_reported() {
        let mut raw = vec![b'a'; 4];
        raw.extend_from_slice("\u{e9}".as_bytes());
        raw.extend_from_slice(b"zzzz");
        let (text, truncated) = bounded_text(&raw, 5).expect("a character-boundary cut is valid text");
        assert!(truncated, "a cut past the limit must be reported");
        assert_eq!(text, "aaaa", "the partial character is dropped, not invented");

        // A byte that is not valid UTF-8 before the cut is not a partial
        // character; the whole read is refused.
        let mut invalid = vec![b'a'; 4];
        invalid.push(0xff);
        invalid.extend_from_slice(b"zzzz");
        assert!(bounded_text(&invalid, 5).is_err());

        let (text, truncated) = bounded_text(b"hello", 5).unwrap();
        assert!(!truncated);
        assert_eq!(text, "hello");

        let (text, truncated) = bounded_text(b"hello world", 5).unwrap();
        assert!(truncated);
        assert_eq!(text, "hello");
    }
}
