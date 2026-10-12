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

use serde_json::Value;

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
