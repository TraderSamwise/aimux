//! Putting a tmux copy on the clipboard of the machine the user is sitting at.
//!
//! tmux's own OSC 52 carries an EMPTY selector (`ESC ] 52 ; ; <base64> BEL`),
//! and mosh only speaks the `c` selector, so every clipboard sequence tmux
//! produces is dropped on the way to a mosh client. The host-side
//! `copy-command` does not help either: on a Mac it lands on that Mac's
//! clipboard rather than the one in front of the user, and on a headless Linux
//! box there is no clipboard to land on at all.
//!
//! So aimux writes the sequence itself, with the `c` selector, straight to each
//! attached client's terminal.

use std::io::Write;

/// `ESC ] 52 ; c ; <base64> BEL` — the form mosh forwards.
pub fn osc52_clipboard_sequence(payload: &[u8]) -> String {
    format!("\u{1b}]52;c;{}\u{7}", base64_encode(payload))
}

/// Terminals drop a clipboard sequence past their buffer, and a runaway
/// selection should not wedge one. Matches the limit tmux applies to its own.
pub const MAX_CLIPBOARD_BYTES: usize = 1_000_000;

pub fn clipboard_payload(selection: &[u8]) -> &[u8] {
    if selection.len() > MAX_CLIPBOARD_BYTES {
        &selection[..MAX_CLIPBOARD_BYTES]
    } else {
        selection
    }
}

/// Write the sequence to every attached client. Multiple clients is the normal
/// case — a local terminal and a mosh session can both be on one session, and
/// the copy belongs on whichever one the user used.
pub fn write_clipboard_to_client_ttys(ttys: &[String], payload: &[u8]) -> Result<usize, String> {
    let sequence = osc52_clipboard_sequence(clipboard_payload(payload));
    let mut written = 0;
    let mut last_error = None;
    for tty in ttys {
        let tty = tty.trim();
        if tty.is_empty() {
            continue;
        }
        match write_sequence_to_tty(tty, &sequence) {
            Ok(()) => written += 1,
            Err(error) => last_error = Some(format!("{tty}: {error}")),
        }
    }
    if written == 0 {
        // A copy that reached nobody is the failure this exists to stop being
        // silent, so it is reported rather than returned as a quiet zero.
        return Err(match last_error {
            Some(error) => format!("no client terminal accepted the clipboard sequence ({error})"),
            None => "no client terminal is attached".to_owned(),
        });
    }
    Ok(written)
}

fn write_sequence_to_tty(tty: &str, sequence: &str) -> Result<(), String> {
    let mut handle = std::fs::OpenOptions::new()
        .write(true)
        .open(tty)
        .map_err(|error| error.to_string())?;
    handle
        .write_all(sequence.as_bytes())
        .map_err(|error| error.to_string())?;
    handle.flush().map_err(|error| error.to_string())
}

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(data: &[u8]) -> String {
    let mut encoded = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let bytes = [
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let triple = (u32::from(bytes[0]) << 16) | (u32::from(bytes[1]) << 8) | u32::from(bytes[2]);
        encoded.push(BASE64_ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        encoded.push(BASE64_ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        encoded.push(if chunk.len() > 1 {
            BASE64_ALPHABET[(triple >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            BASE64_ALPHABET[triple as usize & 0x3f] as char
        } else {
            '='
        });
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_selector_is_c_because_mosh_drops_the_empty_one() {
        let sequence = osc52_clipboard_sequence(b"hi");
        assert!(
            sequence.starts_with("\u{1b}]52;c;"),
            "mosh forwards only the c selector: {sequence:?}"
        );
        assert!(!sequence.contains("]52;;"), "{sequence:?}");
        assert!(sequence.ends_with('\u{7}'), "{sequence:?}");
    }

    #[test]
    fn base64_matches_the_standard_alphabet_and_padding() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"CSELECTORWORKS"), "Q1NFTEVDVE9SV09SS1M=");
    }

    #[test]
    fn an_oversized_selection_is_truncated_rather_than_sent_whole() {
        let selection = vec![b'x'; MAX_CLIPBOARD_BYTES + 10];
        assert_eq!(clipboard_payload(&selection).len(), MAX_CLIPBOARD_BYTES);
        assert_eq!(clipboard_payload(b"short").len(), 5);
    }

    #[test]
    fn a_copy_that_reached_nobody_is_an_error_not_a_quiet_zero() {
        let error = write_clipboard_to_client_ttys(&[], b"hi").expect_err("no clients");
        assert!(error.contains("no client terminal"), "{error}");

        let error = write_clipboard_to_client_ttys(&["/dev/does-not-exist".to_owned()], b"hi")
            .expect_err("unwritable tty");
        assert!(error.contains("/dev/does-not-exist"), "{error}");
    }
}
