//! How many tokens a session has spent against a goal's budget.
//!
//! # One quantity, two very different files
//!
//! A `tokenBudget` is a single number a human types, so both runtimes have to
//! answer in the same currency. They do not naturally: on one live rollout
//! codex reported 721,896,697 total tokens of which 710,263,424 were
//! `cached_input_tokens`, while claude's `input_tokens` EXCLUDES cache reads
//! entirely. Summed naively, the same work reads as two numbers three orders
//! of magnitude apart.
//!
//! So both are reduced to billed-equivalent spend -- what was actually paid
//! for, which is cache WRITES and fresh input and output, never cache reads.
//! A budget counting cache reads would fire on noise.
//!
//! # Measured from when the goal started, not from the dawn of the session
//!
//! A budget is for this goal, and a transcript outlives it: the one in front
//! of me is 415MB. So the reader takes a baseline at first sight and only ever
//! counts forward. That also means a cold start never parses history, which it
//! could not afford to do inside a tick budget.
//!
//! # What a restart costs
//!
//! The baselines live in the loop-watcher task, in memory only. A project
//! service that restarts takes a fresh baseline at the current end of each
//! transcript, so spend counted before the restart is gone and a budget starts
//! again from zero. A long budget on a service that restarts often can
//! therefore never be reached. Persisting them would fix it and is not done
//! here; the limit is written down rather than discovered.

use serde_json::{Value, json};

use crate::debug_logging::{LogLevel, log_at};
use std::fs::{File, metadata};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// Billed-equivalent tokens from one claude `usage` object.
///
/// `cache_read_input_tokens` is deliberately absent: those are the cheap ones,
/// and including them made a human-set budget meaningless.
fn claude_billed(usage: &Value) -> u64 {
    [
        "input_tokens",
        "cache_creation_input_tokens",
        "output_tokens",
    ]
    .iter()
    .filter_map(|field| usage.get(*field).and_then(Value::as_u64))
    .sum()
}

/// The same quantity from codex's cumulative `total_token_usage`.
///
/// Codex counts cached input inside `input_tokens`, so the cached part is
/// subtracted back out to leave what claude would have called input.
fn codex_billed(usage: &Value) -> u64 {
    let field = |name: &str| usage.get(name).and_then(Value::as_u64).unwrap_or(0);
    let input = field("input_tokens").saturating_sub(field("cached_input_tokens"));
    input
        .saturating_add(field("cache_write_input_tokens"))
        .saturating_add(field("output_tokens"))
}

/// What one pass over a claude transcript chunk added.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ClaudeSpendChunk {
    pub billed: u64,
    /// The last message id counted, carried to the next chunk so a message
    /// split across the boundary is not counted twice.
    pub last_id: Option<String>,
    /// Bytes of complete lines consumed. A trailing partial line is left for
    /// next time rather than parsed half-written.
    pub consumed: u64,
}

/// Sum billed tokens over newline-delimited claude transcript records.
///
/// One assistant message emits one usage record PER CONTENT BLOCK, each
/// carrying the same totals: on the transcript in front of me that is 43,591
/// records for 27,902 messages, and summing them inflates output by 88%. The
/// repeats are always adjacent -- collapsing neighbours alone reproduces the
/// unique count exactly -- so carrying one id forward is enough, and that is
/// what makes an incremental reader possible at all.
pub fn claude_spend_chunk(text: &str, carried_id: Option<&str>) -> ClaudeSpendChunk {
    let mut chunk = ClaudeSpendChunk {
        last_id: carried_id.map(str::to_owned),
        ..Default::default()
    };
    // Only whole lines: a transcript is appended to while this reads, so the
    // tail is routinely a half-written record.
    for line in text.split_inclusive('\n') {
        if !line.ends_with('\n') {
            break;
        }
        chunk.consumed += line.len() as u64;
        let Ok(entry) = serde_json::from_str::<Value>(line.trim_end()) else {
            continue;
        };
        let Some(message) = entry.get("message") else {
            continue;
        };
        let Some(usage) = message.get("usage") else {
            continue;
        };
        let id = message.get("id").and_then(Value::as_str);
        if id.is_some() && id.map(str::to_owned) == chunk.last_id {
            continue;
        }
        chunk.billed += claude_billed(usage);
        if let Some(id) = id {
            chunk.last_id = Some(id.to_owned());
        }
    }
    chunk
}

/// Codex's running cumulative, read from the newest `token_count` it wrote.
///
/// Codex is the easy one: it keeps a total rather than per-message deltas, so
/// a tail read answers without summing anything, and no offset is needed.
pub fn codex_cumulative_billed(text: &str) -> Option<u64> {
    text.lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find_map(|entry| {
            let payload = entry.get("payload")?;
            if payload.get("type").and_then(Value::as_str) != Some("token_count") {
                return None;
            }
            payload
                .get("info")
                .and_then(|info| info.get("total_token_usage"))
                .map(codex_billed)
        })
}

/// What a session has spent against its goal.
///
/// `None` is not zero: it means this runtime reports no usage, which aider and
/// shell agents never do, and a budget cannot be judged met or unmet from it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpendSinceBaseline {
    Measured(u64),
    Unmeasured(&'static str),
}

/// Whether a runtime reports usage at all.
pub fn runtime_reports_usage(tool: &str) -> bool {
    matches!(tool.trim(), "claude" | "codex")
}

pub const NO_USAGE_FOR_RUNTIME: &str = "this runtime does not report token usage";
pub const NO_TRANSCRIPT_YET: &str = "no transcript written yet";
pub const BASELINE_JUST_TAKEN: &str = "measuring from now";
/// A read that FAILED, which is not a transcript that was never written. The
/// cause goes to the log, because this string reaches a nudge and a dialog.
pub const TRANSCRIPT_UNREADABLE: &str = "transcript could not be read";

/// Spend since a baseline, for a runtime that keeps a cumulative total.
///
/// A cumulative that went BACKWARDS means a different session's file, so the
/// baseline is stale and the honest answer is to re-baseline rather than
/// report a wrapped subtraction.
pub fn cumulative_spend_since(baseline: Option<u64>, current: Option<u64>) -> SpendSinceBaseline {
    let Some(current) = current else {
        return SpendSinceBaseline::Unmeasured(NO_TRANSCRIPT_YET);
    };
    match baseline {
        None => SpendSinceBaseline::Unmeasured(BASELINE_JUST_TAKEN),
        Some(baseline) if current < baseline => SpendSinceBaseline::Unmeasured(BASELINE_JUST_TAKEN),
        Some(baseline) => SpendSinceBaseline::Measured(current - baseline),
    }
}

/// Whether a stored read position still describes this file.
///
/// A length below the offset is a file that was replaced or truncated -- a
/// resumed session forks a new transcript -- and reading on from the old
/// position would sum somebody else's tokens into this goal.
pub fn offset_still_valid(offset: u64, len: u64) -> bool {
    len >= offset
}

/// What a session's spend is measured against, carried between ticks.
///
/// Held in the task rather than persisted: it is derived per tick, and the
/// loop watcher state hard-errors on an unknown version, so adding a field
/// there would be a migration for something that can be recomputed.
#[derive(Debug, Clone, Default)]
pub struct SpendBaseline {
    /// Bytes already counted, for the runtime that has no running total.
    pub offset: u64,
    /// The last message id counted, so a message split across a tick boundary
    /// is not charged twice.
    pub last_id: Option<String>,
    /// Billed tokens counted since the baseline was taken.
    pub billed: u64,
    /// The cumulative figure at baseline, for the runtime that keeps one.
    pub cumulative_at_baseline: Option<u64>,
    /// Which transcript this describes. A resumed session forks a new file, so
    /// a different path means the baseline belongs to somebody else.
    pub transcript: Option<String>,
    /// Which GOAL this describes. A session can hold one token goal after
    /// another without its loop ever going inactive, and the spend of the one
    /// before is not this one's.
    pub episode: Option<String>,
}

/// Start again when the goal changed under a session that never stopped
/// looping.
///
/// Without this the count carries over, so a fresh 50,000 budget on a session
/// that already spent 60,000 reads as met the moment it is set and the
/// reminders never fire -- the opposite of "measured from when the goal
/// started". Returns whether it reset, so a caller can say that it did.
pub fn rebaseline_for_new_episode(baseline: &mut SpendBaseline, episode: &str) -> bool {
    if baseline.episode.as_deref() == Some(episode) {
        return false;
    }
    *baseline = SpendBaseline {
        episode: Some(episode.to_owned()),
        ..SpendBaseline::default()
    };
    true
}

/// Fold a newly read chunk into a baseline, for a runtime that reports
/// per-message usage and no total.
/// Returns whether it started again, so the caller can report "measuring from
/// now" instead of a confident zero: a transcript truncated in place under the
/// SAME name reset `billed` to 0, and the old code then answered
/// `Measured(0)` -- a goal at 480,000 of a 500,000 budget read as nothing
/// spent, labelled as a measurement.
pub fn advance_summed_baseline(
    baseline: &mut SpendBaseline,
    transcript: &str,
    file_len: u64,
    chunk: ClaudeSpendChunk,
) -> bool {
    let same_file = baseline.transcript.as_deref() == Some(transcript);
    if !same_file || !offset_still_valid(baseline.offset, file_len) {
        // A new or truncated transcript: start again from here rather than
        // charging this goal for a file it never wrote.
        *baseline = SpendBaseline {
            offset: file_len,
            transcript: Some(transcript.to_owned()),
            episode: baseline.episode.clone(),
            ..SpendBaseline::default()
        };
        return true;
    }
    baseline.offset += chunk.consumed;
    baseline.billed += chunk.billed;
    if chunk.last_id.is_some() {
        baseline.last_id = chunk.last_id;
    }
    false
}

/// Fold a cumulative reading into a baseline, for a runtime that keeps a total.
pub fn advance_cumulative_baseline(
    baseline: &mut SpendBaseline,
    transcript: &str,
    current: Option<u64>,
) -> SpendSinceBaseline {
    let same_file = baseline.transcript.as_deref() == Some(transcript);
    if !same_file {
        *baseline = SpendBaseline {
            transcript: Some(transcript.to_owned()),
            cumulative_at_baseline: current,
            episode: baseline.episode.clone(),
            ..SpendBaseline::default()
        };
        return SpendSinceBaseline::Unmeasured(BASELINE_JUST_TAKEN);
    }
    let spend = cumulative_spend_since(baseline.cumulative_at_baseline, current);
    if matches!(spend, SpendSinceBaseline::Unmeasured(BASELINE_JUST_TAKEN)) {
        baseline.cumulative_at_baseline = current;
    }
    if let SpendSinceBaseline::Measured(billed) = spend {
        baseline.billed = billed;
    }
    spend
}

/// Read the bytes a summing runtime has appended since `offset`.
///
/// Bounded per tick: a transcript here is 415MB, and a goal only needs what
/// arrived since the last look. A chunk larger than this is a session that has
/// been busy, and the rest is picked up next tick rather than in one read.
pub const MAX_CHUNK_BYTES: u64 = 4 * 1024 * 1024;

/// One tick's worth of a transcript.
pub struct AppendedChunk {
    pub text: String,
    /// The file's length when it was read, for the stale-offset check.
    pub len: u64,
    /// Bytes actually taken. Compared against the cap rather than `text.len()`,
    /// which lossy decoding can change.
    pub read: u64,
}

pub fn read_appended(path: &Path, offset: u64) -> Result<AppendedChunk, String> {
    let len = metadata(path)
        .map_err(|error| format!("stat {}: {error}", path.display()))?
        .len();
    let empty = |len| AppendedChunk {
        text: String::new(),
        len,
        read: 0,
    };
    if !offset_still_valid(offset, len) {
        return Ok(empty(len));
    }
    let take = (len - offset).min(MAX_CHUNK_BYTES);
    if take == 0 {
        return Ok(empty(len));
    }
    let mut file = File::open(path).map_err(|error| format!("open {}: {error}", path.display()))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("seek {}: {error}", path.display()))?;
    let mut bytes = vec![0; take as usize];
    file.read_exact(&mut bytes)
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    // Lossy on purpose: a chunk boundary can split a multi-byte character, and
    // one mangled character must not stop a goal being measured.
    Ok(AppendedChunk {
        text: String::from_utf8_lossy(&bytes).into_owned(),
        len,
        read: take,
    })
}

/// Whether a full window arrived with no complete line in it.
///
/// That means one record is longer than the window, and the reader must step
/// over it: leaving the offset where it is re-reads the same bytes every tick
/// for ever, which freezes the spend and leaves the goal reminding as unmet
/// until someone notices. The longest line in the transcript this was built
/// against is 2,992,506 bytes, so the case is one large tool result away.
pub fn chunk_spans_an_oversized_record(consumed: u64, read: u64) -> bool {
    consumed == 0 && read >= MAX_CHUNK_BYTES
}

/// Spend for one session, folding whatever its runtime reports into the
/// baseline it carries between ticks.
pub fn spend_for_session(
    tool: &str,
    transcript: Option<&Path>,
    baseline: &mut SpendBaseline,
) -> SpendSinceBaseline {
    if !runtime_reports_usage(tool) {
        return SpendSinceBaseline::Unmeasured(NO_USAGE_FOR_RUNTIME);
    }
    let Some(transcript) = transcript.filter(|path| path.is_file()) else {
        return SpendSinceBaseline::Unmeasured(NO_TRANSCRIPT_YET);
    };
    let name = transcript.to_string_lossy().into_owned();
    if tool.trim() == "codex" {
        let tail = match read_tail_lossy(transcript, CODEX_TAIL_BYTES) {
            Ok(tail) => tail,
            Err(reason) => return unreadable(transcript, &reason),
        };
        return advance_cumulative_baseline(baseline, &name, codex_cumulative_billed(&tail));
    }
    let fresh = baseline.transcript.as_deref() != Some(name.as_str());
    let appended = match read_appended(transcript, baseline.offset) {
        Ok(read) => read,
        // A read that failed is not a session that spent nothing, and it is
        // not one that was never written either.
        Err(reason) => return unreadable(transcript, &reason),
    };
    let mut chunk = claude_spend_chunk(&appended.text, baseline.last_id.as_deref());
    if chunk_spans_an_oversized_record(chunk.consumed, appended.read) {
        // Stepped over, not re-read: the tokens in that one record are lost,
        // which is a smaller lie than a budget that never moves again. The
        // next chunk starts mid-record and its unparseable tail is consumed
        // the same way, so the reader recovers on its own.
        log_at(
            LogLevel::Warn,
            "stepping over a transcript record larger than one tick's window",
            "token-spend",
            Some(json!({
                "transcript": transcript.display().to_string(),
                "skippedBytes": appended.read,
            })),
        );
        chunk.consumed = appended.read;
    }
    let rebased = advance_summed_baseline(baseline, &name, appended.len, chunk);
    if fresh || rebased {
        // `rebased` here means the file was truncated or replaced under the
        // same name, so the count restarted. Reporting `Measured(0)` for that
        // told a goal at 480,000 of a 500,000 budget that it had spent
        // nothing, and called it a measurement.
        return SpendSinceBaseline::Unmeasured(BASELINE_JUST_TAKEN);
    }
    SpendSinceBaseline::Measured(baseline.billed)
}

/// One tick's tail for the runtime that keeps a running total.
///
/// Far larger than the 256KiB the turn-state probe uses: on a real 154MB
/// rollout, 128 of 1,832 gaps between `token_count` records exceed 256KiB and
/// the largest is 2,380,073 bytes -- and those are exactly the big-tool-output
/// windows where spend is highest. A tail that misses the record reads as no
/// transcript at all.
pub const CODEX_TAIL_BYTES: u64 = MAX_CHUNK_BYTES;

/// Read the last `max_bytes` of a file, tolerating a split character.
///
/// The shared turn-state tail reader is strict UTF-8, so a multi-byte
/// character straddling the tail boundary made it return nothing -- and
/// nothing read as "no transcript written yet". A spend reader cannot be
/// stopped by one mangled character, which is why the claude path has always
/// been lossy here.
fn read_tail_lossy(path: &Path, max_bytes: u64) -> Result<String, String> {
    let len = metadata(path)
        .map_err(|error| format!("stat {}: {error}", path.display()))?
        .len();
    let start = len.saturating_sub(max_bytes);
    let take = len - start;
    if take == 0 {
        return Ok(String::new());
    }
    let mut file = File::open(path).map_err(|error| format!("open {}: {error}", path.display()))?;
    file.seek(SeekFrom::Start(start))
        .map_err(|error| format!("seek {}: {error}", path.display()))?;
    let mut bytes = vec![0; take as usize];
    file.read_exact(&mut bytes)
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// A read that failed, said out loud rather than passed off as absence.
fn unreadable(transcript: &Path, reason: &str) -> SpendSinceBaseline {
    log_at(
        LogLevel::Warn,
        "token spend could not read a transcript",
        "token-spend",
        Some(json!({
            "transcript": transcript.display().to_string(),
            "error": reason,
        })),
    );
    SpendSinceBaseline::Unmeasured(TRANSCRIPT_UNREADABLE)
}
