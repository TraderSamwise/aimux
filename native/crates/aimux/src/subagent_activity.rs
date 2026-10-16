//! Which sub-agents an agent session has working, and where that is read from.
//!
//! Launch metadata and vendor transcripts feed one shared presentation.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

/// Maximum silence before a running record is considered stale.
pub const SUBAGENT_STALE_AFTER_MS: u64 = 10 * 60 * 1000;

/// Bound only the names, not the total count.
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

/// Missing descriptive metadata falls back to the sub-agent ID.
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
            .map(display_text)
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

/// Unknown turn state is still working while the transcript is fresh.
pub fn claude_subagent_running(turn: &str, updated_at_ms: u64, now_ms: u64) -> bool {
    if turn == "complete" {
        return false;
    }
    now_ms.saturating_sub(updated_at_ms) < SUBAGENT_STALE_AFTER_MS
}

/// The one shape the published answer takes, or `None` when nothing is
/// working.
///
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
        "detail": subagent_summary_detail(runs.len(), &ordered),
        "items": items,
    }))
}

/// The one sentence that says both how many and which, rendered verbatim by
/// the dashboard's details pane and the app's chat header.
///
pub fn subagent_summary_detail(running: usize, named: &[SubagentRun]) -> String {
    let label = subagent_summary_label(running);
    let names = named
        .iter()
        .take(SUBAGENT_ITEM_LIMIT)
        .map(|run| match &run.kind {
            Some(kind) => format!("{} ({kind})", run.name),
            None => run.name.clone(),
        })
        .collect::<Vec<_>>();
    if names.is_empty() {
        return label;
    }
    format!("{label}: {}", names.join(", "))
}

/// The one label for a count of working sub-agents, rendered verbatim by the
/// dashboard row, the app row and anything added later.
pub fn subagent_summary_label(running: usize) -> String {
    match running {
        1 => "1 sub-agent".to_owned(),
        other => format!("{other} sub-agents"),
    }
}

/// Distinguish no work from inability to inspect it.
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

/// The label to render for a published summary, or `None` when there is
/// nothing to say.
///
pub fn subagent_label(summary: Option<&Value>) -> Option<String> {
    summary_text(summary, "label")
}

/// The one-sentence detail to render, or `None` when there is nothing to say.
pub fn subagent_detail(summary: Option<&Value>) -> Option<String> {
    summary_text(summary, "detail").or_else(|| subagent_label(summary))
}

fn summary_text(summary: Option<&Value>, key: &str) -> Option<String> {
    if subagent_running_count(summary) == 0 {
        return None;
    }
    summary?
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
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
    fn the_detail_says_how_many_and_which() {
        let runs = vec![
            claude_subagent_run("agent-a", Some(&meta()), Some(1), 2),
            SubagentRun {
                key: "agent-b".into(),
                name: "Audit phase 3".into(),
                kind: None,
                model: None,
                started_at_ms: Some(2),
                updated_at_ms: 3,
            },
        ];
        let summary = subagent_summary(&runs).expect("summary");
        assert_eq!(
            summary["detail"],
            "2 sub-agents: Adversarial review of PR 451 (Explore), Audit phase 3",
            "the label verbatim, then what they are"
        );
        // The names follow the published order, so the pane and the app agree
        // with the list beside them.
        assert_eq!(summary["items"][0]["key"], "agent-a");
    }

    #[test]
    fn the_detail_of_one_unnamed_subagent_is_just_the_label() {
        let runs = vec![claude_subagent_run("agent-a", None, None, 1)];
        let summary = subagent_summary(&runs).expect("summary");
        // The key is the name when there is no meta file, so there is always
        // something to say; an empty list would be the only way to get here.
        assert_eq!(summary["detail"], "1 sub-agent: agent-a");
        assert_eq!(subagent_summary_detail(3, &[]), "3 sub-agents");
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
    fn a_summary_that_says_none_are_working_renders_nothing() {
        let zero = json!({ "running": 0, "label": "0 sub-agents", "detail": "0 sub-agents" });
        assert_eq!(subagent_label(Some(&zero)), None);
        assert_eq!(subagent_detail(Some(&zero)), None);
        assert_eq!(subagent_label(None), None);
        // A summary from a build that published no detail still has something
        // to render, rather than a surface falling back to its own spelling.
        let no_detail = json!({ "running": 2, "label": "2 sub-agents" });
        assert_eq!(
            subagent_detail(Some(&no_detail)).as_deref(),
            Some("2 sub-agents")
        );
        let blank = json!({ "running": 2, "label": "   " });
        assert_eq!(subagent_label(Some(&blank)), None);
    }

    #[test]
    fn the_count_is_read_back_out_of_what_was_published() {
        let runs = vec![claude_subagent_run("agent-abc", Some(&meta()), None, 1)];
        let summary = subagent_summary(&runs);
        assert_eq!(subagent_running_count(summary.as_ref()), 1);
        assert_eq!(subagent_running_count(None), 0);
    }
}

/// Folds correlated Codex spawn/list calls from complete rollout records.
#[derive(Debug, Default)]
pub struct CodexSubagentScan {
    outstanding: std::collections::BTreeMap<String, CodexSubagent>,
    calls: std::collections::BTreeMap<String, (String, u64)>,
}

#[derive(Clone, Debug)]
struct CodexSubagent {
    name: String,
    started_at_ms: u64,
    confirmed_at_ms: u64,
}

impl CodexSubagentScan {
    // Callers advance physical cursors from raw bytes, never this lossy text.
    pub fn fold(&mut self, text: &str, now_ms: u64) -> u64 {
        let mut consumed = 0;
        for line in text.split_inclusive('\n') {
            if !line.ends_with('\n') {
                break;
            }
            consumed += line.len() as u64;
            self.fold_line(line.trim_end(), now_ms);
        }
        consumed
    }

    fn fold_line(&mut self, line: &str, now_ms: u64) {
        if line.trim().is_empty() {
            return;
        }
        let entry = match serde_json::from_str::<Value>(line) {
            Ok(entry) => entry,
            Err(error) => {
                crate::debug_logging::log_at(
                    crate::debug_logging::LogLevel::Warn,
                    "invalid Codex rollout record",
                    "subagent-activity",
                    Some(json!({ "error": error.to_string() })),
                );
                return;
            }
        };
        if entry.get("type").and_then(Value::as_str) != Some("response_item") {
            return;
        }
        let Some(payload) = entry.get("payload") else {
            return;
        };
        let at_ms = entry
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(crate::visual_client_leases::parse_iso_millis)
            .and_then(|ms| u64::try_from(ms).ok())
            .unwrap_or(now_ms);
        let kind = payload.get("type").and_then(Value::as_str).unwrap_or("");
        let name = payload.get("name").and_then(Value::as_str).unwrap_or("");
        let Some(call_id) = payload
            .get("call_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        else {
            return;
        };
        if matches!(kind, "function_call" | "custom_tool_call") {
            if matches!(name, "spawn_agent" | "list_agents") {
                self.calls
                    .insert(call_id.to_owned(), (name.to_owned(), at_ms));
            }
            return;
        }
        if !matches!(kind, "function_call_output" | "custom_tool_call_output") {
            return;
        }
        let Some((call, started_at_ms)) = self.calls.remove(call_id) else {
            return;
        };
        let Some(output) = payload
            .get("output")
            .and_then(Value::as_str)
            .and_then(|output| serde_json::from_str::<Value>(output).ok())
        else {
            return;
        };
        if call == "spawn_agent" {
            if let Some(name) = output
                .get("task_name")
                .and_then(Value::as_str)
                .filter(|name| !name.is_empty())
            {
                self.outstanding.insert(
                    name.to_owned(),
                    CodexSubagent {
                        name: display_text(name.rsplit('/').next().unwrap_or(name)),
                        started_at_ms,
                        confirmed_at_ms: at_ms,
                    },
                );
            }
        } else if let Some(agents) = output.get("agents").and_then(Value::as_array) {
            let mut listed = std::collections::BTreeSet::new();
            for agent in agents {
                let Some(name) = agent.get("agent_name").and_then(Value::as_str) else {
                    continue;
                };
                if !name.trim_start_matches('/').contains('/') {
                    continue;
                }
                if agent.get("agent_status").and_then(Value::as_str) != Some("running") {
                    self.outstanding.remove(name);
                    continue;
                }
                listed.insert(name.to_owned());
                let run = self
                    .outstanding
                    .entry(name.to_owned())
                    .or_insert(CodexSubagent {
                        name: display_text(name.rsplit('/').next().unwrap_or(name)),
                        started_at_ms: at_ms,
                        confirmed_at_ms: at_ms,
                    });
                run.confirmed_at_ms = at_ms;
            }
            self.outstanding.retain(|key, _| listed.contains(key));
        }
        // Bound pending calls even while replaying an old rollout.
        self.calls
            .retain(|_, (_, at)| at_ms.saturating_sub(*at) < SUBAGENT_STALE_AFTER_MS);
    }

    pub fn runs(&mut self, now_ms: u64) -> Vec<SubagentRun> {
        self.outstanding
            .retain(|_, run| now_ms.saturating_sub(run.confirmed_at_ms) < SUBAGENT_STALE_AFTER_MS);
        self.calls
            .retain(|_, (_, at)| now_ms.saturating_sub(*at) < SUBAGENT_STALE_AFTER_MS);
        self.outstanding
            .iter()
            .map(|(key, run)| SubagentRun {
                key: key.clone(),
                name: run.name.clone(),
                kind: None,
                model: None,
                started_at_ms: Some(run.started_at_ms),
                updated_at_ms: run.confirmed_at_ms,
            })
            .collect()
    }
}

fn display_text(text: &str) -> String {
    text.chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .take(240)
        .collect()
}

#[cfg(test)]
mod display_safety {
    use super::*;
    #[test]
    fn vendor_descriptions_cannot_control_the_terminal() {
        let meta = json!({"description":"review\u{1b}[2J\nnext", "agentType":"Explore\u{9b}bad"});
        let run = claude_subagent_run("agent-a", Some(&meta), None, 1);
        let summary = subagent_summary(&[run]).unwrap();
        assert!(
            !summary["detail"]
                .as_str()
                .unwrap()
                .chars()
                .any(char::is_control)
        );
        assert_eq!(display_text(&"a".repeat(1_000)).len(), 240);
    }
}
