//! A transcript tail must survive a cut that lands mid-character.
//!
//! The cut is at a byte offset, so any transcript holding a character outside
//! ASCII -- which is every transcript of real work -- can be cut mid-codepoint.
//! Node's `buffer.toString("utf8")` replaced those bytes; the Rust port
//! returned `None`, and `None` is how every caller spells "no answer about
//! this transcript".

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use aimux::transcript_turn_state::{claude_turn_state, probe_transcript, read_file_tail};

fn temp_transcript(contents: &[u8]) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "aimux-transcript-tail-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_nanos())
            .unwrap_or(0)
    ));
    fs::create_dir_all(&dir).expect("mkdir");
    let path = dir.join("transcript.jsonl");
    fs::write(&path, contents).expect("write");
    path
}

/// The emoji is four bytes; the cut takes the last three of them.
fn split_transcript() -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice("{\"type\":\"user\",\"text\":\"🎉".as_bytes());
    bytes.extend_from_slice(
        "\"}\n{\"type\":\"assistant\",\"message\":{\"stop_reason\":\"end_turn\"}}\n".as_bytes(),
    );
    bytes
}

#[test]
fn a_tail_cut_mid_character_still_reads() {
    let contents = split_transcript();
    let path = temp_transcript(&contents);
    // 3 bytes into the 4-byte emoji, counted from the end of the file.
    let max_bytes = (contents.len() - "{\"type\":\"user\",\"text\":\"".len() - 1) as u64;
    let tail = read_file_tail(&path, Some(max_bytes)).expect("a tail, not a refusal");
    assert!(
        tail.contains("end_turn"),
        "the readable lines are still there: {tail:?}"
    );
    assert_eq!(
        claude_turn_state(&tail),
        "complete",
        "and the turn-state is still readable, which is what the caller wanted"
    );
    let _ = fs::remove_dir_all(path.parent().expect("dir"));
}

#[test]
fn a_probe_of_such_a_transcript_is_an_answer() {
    // The whole file fits the real tail budget, so this is the end-to-end
    // shape: a transcript with an emoji in it answers like any other.
    let path = temp_transcript(&split_transcript());
    let probe = probe_transcript("claude", &path).expect("a probe, not a refusal");
    assert_eq!(probe.turn, "complete");
    let _ = fs::remove_dir_all(path.parent().expect("dir"));
}
