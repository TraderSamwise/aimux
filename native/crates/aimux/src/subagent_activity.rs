//! Which sub-agents an agent session has working, and where that is read from.
//!
//! # The parent transcript is the wrong file
//!
//! The obvious source is the parent's own transcript: an `Agent` tool call
//! with no matching `tool_result` looks like a sub-agent still running. It is
//! not. Measured on a real 468MB session, 322 of 446 launches get a
//! `tool_result` back within milliseconds saying "Async agent launched
//! successfully" -- the ack, not the report -- so unpaired-means-running
//! reports a long-finished agent forever and a running one not at all.
//!
//! # The right file is the sub-agent's own
//!
//! Claude writes a pair per sub-agent beside the parent's transcript:
//!
//! ```text
//! ~/.claude/projects/<encoded-cwd>/<parentSessionId>/subagents/
//!   agent-<id>.jsonl        the sub-agent's own transcript
//!   agent-<id>.meta.json    {"agentType","description","toolUseId","model",...}
//! ```
//!
//! So the description a human wants to read is already written down, and
//! whether that sub-agent is working is the turn-state of its own transcript --
//! the same [`crate::transcript_turn_state::claude_turn_state`] the reconciler
//! settles sessions with. No parsing of the parent is needed at all.
//!
//! # Why a clock is part of the answer
//!
//! A sub-agent that was killed mid-turn leaves its transcript reading
//! `in_progress` forever, so turn-state alone would pin a phantom to the row.
//! Freshness decides it: a working sub-agent appends, and
//! [`SUBAGENT_STALE_AFTER_MS`] is the longest silence still called working.
//!
//! # When it started
//!
//! The meta file carries no timestamp, and `created()` is not available on
//! every filesystem, so the launch time is the meta file's own mtime: it is
//! written once, at launch, and never touched again. Measured against the
//! first record's `timestamp` on three real sub-agents, it agrees to within
//! 35ms.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

/// How long a sub-agent transcript may go unwritten and still read as working.
///
/// Generous on purpose. A sub-agent writes an entry per tool call, and one
/// tool call can be a ten-minute build, so a short window would report its own
/// agents as finished mid-run. The cost of the other direction is bounded and
/// visible: a killed sub-agent lingers for at most this long.
///
/// The window is a liveness claim and it can be wrong in both directions. A
/// sub-agent inside a single tool call longer than this drops off the row and
/// comes back when it next writes; the alternative -- trusting the turn-state
/// alone -- leaves a killed one on the row for the life of the process, which
/// is worse because nothing ever takes it off.
pub const SUBAGENT_STALE_AFTER_MS: u64 = 10 * 60 * 1000;

/// How many running sub-agents the published summary names.
///
/// The count is always the real one; this caps only the list, because a row
/// that renders twelve descriptions is a row nobody reads.
pub const SUBAGENT_ITEM_LIMIT: usize = 5;

const CLAUDE_SUBAGENTS_DIR: &str = "subagents";
const CLAUDE_SUBAGENT_PREFIX: &str = "agent-";
const CLAUDE_SUBAGENT_SUFFIX: &str = ".jsonl";
const CLAUDE_SUBAGENT_META_SUFFIX: &str = ".meta.json";

/// One sub-agent, as every surface receives it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubagentRun {
    /// The file stem that identifies it, e.g. `agent-aee1cddaa7c9690af`. Used
    /// as the published identity so a surface can key a list on it.
    pub key: String,
    /// What it was asked to do, as the launcher described it.
    pub name: String,
    /// The agent type, e.g. `Explore`.
    pub kind: Option<String>,
    pub model: Option<String>,
    /// When it was launched, if known.
    pub started_at_ms: Option<u64>,
    /// When its transcript was last written.
    pub updated_at_ms: u64,
}

/// Where a Claude session's sub-agent transcripts live, given its own.
///
/// `~/.claude/projects/<slug>/<id>.jsonl` -> `.../<slug>/<id>/subagents`.
pub fn claude_subagents_dir(transcript_path: impl AsRef<Path>) -> Option<PathBuf> {
    let transcript_path = transcript_path.as_ref();
    let stem = transcript_path.file_name().and_then(|name| name.to_str())?;
    let stem = stem.strip_suffix(CLAUDE_SUBAGENT_SUFFIX)?;
    if stem.is_empty() {
        return None;
    }
    Some(
        transcript_path
            .parent()?
            .join(stem)
            .join(CLAUDE_SUBAGENTS_DIR),
    )
}

/// The sub-agent key a transcript file name carries, or `None` if the name is
/// not one.
pub fn claude_subagent_key(file_name: &str) -> Option<&str> {
    let key = file_name.strip_suffix(CLAUDE_SUBAGENT_SUFFIX)?;
    // `agent-<id>.meta.json` does not end in `.jsonl`, so only the transcript
    // reaches here; the prefix check keeps anything else a tool drops in the
    // directory out of the answer.
    if !key.starts_with(CLAUDE_SUBAGENT_PREFIX) || key.len() <= CLAUDE_SUBAGENT_PREFIX.len() {
        return None;
    }
    Some(key)
}

/// The meta file that sits beside a sub-agent transcript.
pub fn claude_subagent_meta_path(transcript_path: impl AsRef<Path>) -> Option<PathBuf> {
    let transcript_path = transcript_path.as_ref();
    let key = claude_subagent_key(transcript_path.file_name()?.to_str()?)?;
    Some(
        transcript_path
            .parent()?
            .join(format!("{key}{CLAUDE_SUBAGENT_META_SUFFIX}")),
    )
}

/// One sub-agent's published form, from its meta file and the two stats.
///
/// A meta file that is missing or unreadable is not fatal: the key still names
/// the sub-agent, and reporting "a sub-agent is working" without its
/// description beats reporting nothing.
pub fn claude_subagent_run(
    key: &str,
    meta: Option<&Value>,
    started_at_ms: Option<u64>,
    updated_at_ms: u64,
) -> SubagentRun {
    let field = |name: &str| {
        meta.and_then(|meta| meta.get(name))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
    };
    SubagentRun {
        name: field("description").unwrap_or_else(|| key.to_owned()),
        kind: field("agentType"),
        model: field("model"),
        key: key.to_owned(),
        started_at_ms,
        updated_at_ms,
    }
}

/// Whether a sub-agent transcript describes a sub-agent still working.
///
/// Two facts, because neither answers alone: `complete` is the only turn-state
/// that means finished, and a transcript nobody has written to for
/// [`SUBAGENT_STALE_AFTER_MS`] is not being worked on whatever its last entry
/// said.
///
/// `claude_turn_state` has a third answer, `unknown`, for a tail it cannot
/// read a `stop_reason` out of -- which is what a file being created looks
/// like. That counts as working, deliberately: a sub-agent whose first bytes
/// are on disk has started.
pub fn claude_subagent_running(turn: &str, updated_at_ms: u64, now_ms: u64) -> bool {
    if turn == "complete" {
        return false;
    }
    now_ms.saturating_sub(updated_at_ms) < SUBAGENT_STALE_AFTER_MS
}

/// Whether a finished sub-agent can be skipped for the rest of the process.
///
/// A sub-agent id is minted per launch and its transcript is never reopened,
/// so `complete` is terminal. This is what keeps a directory of hundreds of
/// finished sub-agents from costing a tail read each on every tick.
///
/// Only `complete`. Caching `unknown` would freeze a sub-agent that was still
/// being created at its first half-written tail.
pub fn claude_subagent_is_terminal(turn: &str) -> bool {
    turn == "complete"
}

/// The one shape the published answer takes, or `None` when nothing is
/// working.
///
/// `None` rather than a zero: every surface reads this, and an absent key is
/// how a row says there is nothing to show. Oldest first, because the one that
/// has been running longest is the one worth naming.
pub fn subagent_summary(runs: &[SubagentRun]) -> Option<Value> {
    if runs.is_empty() {
        return None;
    }
    let mut ordered = runs.to_vec();
    ordered.sort_by(|left, right| {
        left.started_at_ms
            .unwrap_or(left.updated_at_ms)
            .cmp(&right.started_at_ms.unwrap_or(right.updated_at_ms))
            .then_with(|| left.key.cmp(&right.key))
    });
    let items = ordered
        .iter()
        .take(SUBAGENT_ITEM_LIMIT)
        .map(|run| {
            let mut item = json!({ "key": run.key, "name": run.name });
            if let Some(kind) = &run.kind {
                item["kind"] = Value::String(kind.clone());
            }
            if let Some(model) = &run.model {
                item["model"] = Value::String(model.clone());
            }
            if let Some(started) = run.started_at_ms {
                item["startedAtMs"] = Value::from(started);
            }
            item
        })
        .collect::<Vec<_>>();
    Some(json!({
        "running": runs.len(),
        "label": subagent_summary_label(runs.len()),
        "items": items,
    }))
}

/// The one label for a count of working sub-agents, rendered verbatim by the
/// dashboard row, the app row and anything added later.
pub fn subagent_summary_label(running: usize) -> String {
    match running {
        1 => "1 sub-agent".to_owned(),
        other => format!("{other} sub-agents"),
    }
}

/// What a scan should do to what is already published.
///
/// Three outcomes, not two, because "nobody is working" and "I could not look"
/// are different answers and writing the same thing for both erases a good
/// value. A session whose transcript path is not resolvable yet -- no backend
/// session id recorded, no worktree, a tool whose sub-agents cannot be read --
/// leaves what is there alone rather than clearing it.
#[derive(Clone, Debug, PartialEq)]
pub enum SubagentPublish {
    /// Could not look. Leave whatever is published where it is.
    Leave,
    /// Looked, and nothing is working. Remove the key.
    Clear,
    /// Looked, and this is what is working.
    Set(Value),
}

pub fn subagent_publish(scan: Option<&[SubagentRun]>) -> SubagentPublish {
    match scan {
        None => SubagentPublish::Leave,
        Some(runs) => match subagent_summary(runs) {
            Some(summary) => SubagentPublish::Set(summary),
            None => SubagentPublish::Clear,
        },
    }
}

/// How many sub-agents a published summary says are working.
pub fn subagent_running_count(summary: Option<&Value>) -> usize {
    summary
        .and_then(|summary| summary.get("running"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    const META: &str = r#"{"agentType":"Explore","description":"Adversarial review of PR 451","toolUseId":"toolu_015PxBxu1VviiYrdkoRanmbn","spawnDepth":1,"requestShape":"background","requestNonInteractive":true,"model":"opus"}"#;

    fn meta() -> Value {
        serde_json::from_str(META).expect("real meta shape parses")
    }

    #[test]
    fn the_subagents_directory_sits_beside_the_parent_transcript() {
        let dir = claude_subagents_dir("/p/-Users-sam/94760225-52eb.jsonl").expect("dir");
        assert_eq!(
            dir,
            PathBuf::from("/p/-Users-sam/94760225-52eb/subagents"),
            "the parent session id names the directory"
        );
        assert_eq!(claude_subagents_dir("/p/notes.txt"), None);
        assert_eq!(claude_subagents_dir("/p/.jsonl"), None);
    }

    #[test]
    fn only_a_subagent_transcript_is_one() {
        assert_eq!(claude_subagent_key("agent-abc.jsonl"), Some("agent-abc"));
        // The meta file is read through its transcript, never counted as one.
        assert_eq!(claude_subagent_key("agent-abc.meta.json"), None);
        assert_eq!(claude_subagent_key("rollout-2026.jsonl"), None);
        assert_eq!(claude_subagent_key("agent-.jsonl"), None);
    }

    #[test]
    fn the_meta_file_is_found_beside_the_transcript() {
        assert_eq!(
            claude_subagent_meta_path("/p/s/subagents/agent-abc.jsonl"),
            Some(PathBuf::from("/p/s/subagents/agent-abc.meta.json"))
        );
    }

    #[test]
    fn a_run_carries_what_the_launcher_wrote_down() {
        let run = claude_subagent_run("agent-abc", Some(&meta()), Some(10), 20);
        assert_eq!(run.name, "Adversarial review of PR 451");
        assert_eq!(run.kind.as_deref(), Some("Explore"));
        assert_eq!(run.model.as_deref(), Some("opus"));
        assert_eq!(run.started_at_ms, Some(10));
    }

    #[test]
    fn a_run_without_a_meta_file_still_names_itself() {
        // Reporting "something is working" beats reporting nothing because one
        // small file could not be read.
        let run = claude_subagent_run("agent-abc", None, None, 20);
        assert_eq!(run.name, "agent-abc");
        assert_eq!(run.kind, None);
    }

    #[test]
    fn a_complete_transcript_is_finished_however_fresh_it_is() {
        assert!(!claude_subagent_running("complete", 1_000, 1_000));
        assert!(claude_subagent_is_terminal("complete"));
        assert!(!claude_subagent_is_terminal("in_progress"));
    }

    #[test]
    fn a_killed_subagent_stops_being_reported_once_it_goes_quiet() {
        let now = 100 * SUBAGENT_STALE_AFTER_MS;
        assert!(claude_subagent_running(
            "in_progress",
            now - SUBAGENT_STALE_AFTER_MS + 1,
            now
        ));
        assert!(!claude_subagent_running(
            "in_progress",
            now - SUBAGENT_STALE_AFTER_MS,
            now
        ));
        // `unknown` is not `complete`, so a transcript too short to read a turn
        // out of is still working while it is being written.
        assert!(claude_subagent_running("unknown", now, now));
    }

    #[test]
    fn nothing_working_publishes_nothing() {
        assert_eq!(subagent_summary(&[]), None);
    }

    #[test]
    fn the_summary_counts_all_of_them_and_names_the_oldest() {
        let runs = (0..SUBAGENT_ITEM_LIMIT + 2)
            .map(|index| SubagentRun {
                key: format!("agent-{index}"),
                name: format!("job {index}"),
                kind: None,
                model: None,
                started_at_ms: Some(1_000 - index as u64),
                updated_at_ms: 2_000,
            })
            .collect::<Vec<_>>();
        let summary = subagent_summary(&runs).expect("summary");
        assert_eq!(
            summary["running"],
            SUBAGENT_ITEM_LIMIT + 2,
            "the count is the real one, not the capped list"
        );
        let items = summary["items"].as_array().expect("items");
        assert_eq!(items.len(), SUBAGENT_ITEM_LIMIT);
        assert_eq!(
            items[0]["name"], "job 6",
            "the longest-running one is named first"
        );
        assert_eq!(summary["label"], "7 sub-agents");
    }

    #[test]
    fn one_subagent_reads_as_one() {
        assert_eq!(subagent_summary_label(1), "1 sub-agent");
        assert_eq!(subagent_summary_label(2), "2 sub-agents");
    }

    #[test]
    fn a_scan_that_could_not_look_leaves_what_is_published_alone() {
        // The failure this exists for: a session whose backend id has not been
        // recorded yet publishes nothing, and clearing on that would flicker
        // the label off a row whose sub-agents are still working.
        assert_eq!(subagent_publish(None), SubagentPublish::Leave);
        assert_eq!(subagent_publish(Some(&[])), SubagentPublish::Clear);
        let runs = vec![claude_subagent_run("agent-abc", Some(&meta()), None, 1)];
        assert!(matches!(
            subagent_publish(Some(&runs)),
            SubagentPublish::Set(_)
        ));
    }

    #[test]
    fn the_count_is_read_back_out_of_what_was_published() {
        let runs = vec![claude_subagent_run("agent-abc", Some(&meta()), None, 1)];
        let summary = subagent_summary(&runs);
        assert_eq!(subagent_running_count(summary.as_ref()), 1);
        assert_eq!(subagent_running_count(None), 0);
    }
}
