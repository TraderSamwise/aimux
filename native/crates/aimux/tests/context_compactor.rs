use aimux::context_compactor::{
    CompactCommandRunner, HistoryReadOptions, SummaryProvenance, algorithmic_compact, context_dir,
    list_history_session_ids, llm_compact_with_runner, read_history,
};
use serde_json::json;
use std::cell::RefCell;
use std::fs::{create_dir_all, read_to_string, remove_dir_all, write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Default)]
struct FakeRunner {
    calls: RefCell<Vec<(String, String)>>,
    fail: bool,
}

impl CompactCommandRunner for FakeRunner {
    fn run(&mut self, command: &str, input: &str) -> Result<String, String> {
        self.calls
            .borrow_mut()
            .push((command.to_owned(), input.to_owned()));
        if self.fail {
            Err("boom".into())
        } else {
            Ok("## LLM summary\nDone.".into())
        }
    }
}

#[test]
fn lists_history_session_ids_like_cli_compact() {
    let repo = temp_repo("aimux-compact-list");
    let missing = list_history_session_ids(&repo).unwrap_err();
    assert!(missing.starts_with("No history found at "));

    let history = repo.join(".aimux/history");
    create_dir_all(&history).unwrap();
    assert_eq!(
        list_history_session_ids(&repo).unwrap_err(),
        "No session history files found."
    );

    write(history.join("a.jsonl"), "{}\n").unwrap();
    write(history.join("agent.v1.jsonl"), "{}\n").unwrap();
    write(history.join("b.txt"), "{}\n").unwrap();
    write(history.join("c.JSONL"), "{}\n").unwrap();
    let mut session_ids = list_history_session_ids(&repo).unwrap();
    session_ids.sort();
    assert_eq!(session_ids, vec!["a", "agent.v1"]);

    remove_dir_all(repo).ok();
}

#[test]
fn reads_history_with_malformed_lines_tail_and_last_n() {
    let repo = temp_repo("aimux-compact-history");
    let history = repo.join(".aimux/history");
    create_dir_all(&history).unwrap();
    write(
        history.join("codex-1.jsonl"),
        [
            "not-json",
            &json!({ "ts": "2026-03-31T00:00:00.000Z", "type": "prompt", "content": "old" })
                .to_string(),
            &json!({ "ts": "2026-03-31T00:00:01.000Z", "type": "response", "content": "new" })
                .to_string(),
        ]
        .join("\n"),
    )
    .unwrap();

    let turns = read_history(
        &repo,
        "codex-1",
        HistoryReadOptions {
            last_n: Some(1),
            ..HistoryReadOptions::default()
        },
    );
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].content, "new");

    let tail_turns = read_history(
        &repo,
        "codex-1",
        HistoryReadOptions {
            max_bytes: Some(120),
            ..HistoryReadOptions::default()
        },
    );
    assert!(tail_turns.iter().all(|turn| turn.content != "old"));

    remove_dir_all(repo).ok();
}

#[test]
fn llm_compact_writes_summary_artifacts_and_prompt_shape() {
    let repo = temp_repo("aimux-compact-llm");
    write_history(
        &repo,
        "claude-test",
        &[
            json!({ "ts": "2026-03-31T00:00:00.000Z", "type": "prompt", "content": "write a poem" }),
            json!({ "ts": "2026-03-31T00:00:05.000Z", "type": "response", "content": "here is a poem", "files": ["poem.md"] }),
            json!({ "ts": "2026-03-31T00:00:10.000Z", "type": "git", "content": "commit abc", "files": ["poem.md"] }),
        ],
    );
    let mut runner = FakeRunner::default();

    llm_compact_with_runner(&repo, &["claude-test".into()], "fake-compact", &mut runner);

    let calls = runner.calls.borrow();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "fake-compact");
    assert!(
        calls[0]
            .1
            .starts_with("Summarize the following agent session history.")
    );
    assert!(
        calls[0]
            .1
            .contains("=== Session: claude-test (3 turns) ===")
    );
    assert!(calls[0].1.contains("[00:00] User: write a poem"));
    assert!(calls[0].1.contains("[00:00] Agent: here is a poem"));
    assert!(calls[0].1.contains("  Files: poem.md"));
    assert!(calls[0].1.contains("[00:00] Git: commit abc"));

    let session_dir = context_dir(&repo).join("claude-test");
    let summary = read_to_string(session_dir.join("summary.md")).unwrap();
    let meta: SummaryProvenance =
        serde_json::from_str(&read_to_string(session_dir.join("summary.meta.json")).unwrap())
            .unwrap();
    let checkpoints = read_to_string(session_dir.join("summary.checkpoints.jsonl")).unwrap();

    assert!(summary.contains("# claude-test \u{2014} Session Summary"));
    assert!(summary.contains("Source: llm"));
    assert!(summary.contains("Turns covered: 3"));
    assert!(summary.contains("History digest:"));
    assert!(summary.contains("## LLM summary"));
    assert_eq!(meta.session_id, "claude-test");
    assert_eq!(meta.mode, "llm");
    assert_eq!(meta.turns, 3);
    assert_eq!(meta.summary_bytes, summary.len());
    assert_eq!(checkpoints.trim().lines().count(), 1);

    remove_dir_all(repo).ok();
}

#[test]
fn llm_failure_falls_back_to_algorithmic_for_that_session() {
    let repo = temp_repo("aimux-compact-fallback");
    write_history(
        &repo,
        "codex-test",
        &[
            json!({ "ts": "2026-03-31T00:10:00.000Z", "type": "prompt", "content": "investigate login bug" }),
            json!({ "ts": "2026-03-31T00:10:05.000Z", "type": "response", "content": "decided on the fix after error logs", "files": ["src/login.ts"] }),
        ],
    );
    let mut runner = FakeRunner {
        fail: true,
        ..FakeRunner::default()
    };

    llm_compact_with_runner(&repo, &["codex-test".into()], "fake-compact", &mut runner);
    let session_dir = context_dir(&repo).join("codex-test");
    let summary = read_to_string(session_dir.join("summary.md")).unwrap();
    let meta: SummaryProvenance =
        serde_json::from_str(&read_to_string(session_dir.join("summary.meta.json")).unwrap())
            .unwrap();

    assert!(summary.contains("Source: algorithmic"));
    assert!(summary.contains("### Key tasks"));
    assert!(summary.contains("- investigate login bug"));
    assert!(summary.contains("### Files modified"));
    assert!(summary.contains("- src/login.ts (1 time)"));
    assert_eq!(meta.mode, "algorithmic");
    assert_eq!(
        read_history(&repo, "codex-test", HistoryReadOptions::default()).len(),
        2
    );

    algorithmic_compact(&repo, &["codex-test".into()]);
    let checkpoints = read_to_string(session_dir.join("summary.checkpoints.jsonl")).unwrap();
    assert_eq!(checkpoints.trim().lines().count(), 2);

    remove_dir_all(repo).ok();
}

fn write_history(repo: &Path, session_id: &str, turns: &[serde_json::Value]) {
    let history = repo.join(".aimux/history");
    create_dir_all(&history).unwrap();
    let body = turns
        .iter()
        .map(serde_json::Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    write(
        history.join(format!("{session_id}.jsonl")),
        format!("{body}\n"),
    )
    .unwrap();
}

fn temp_repo(prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    let path = std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()));
    create_dir_all(path.join(".git")).expect("mkdir repo");
    path
}
