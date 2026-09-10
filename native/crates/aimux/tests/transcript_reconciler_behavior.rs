//! Behaviour the corpus does not reach: the real path derivation, an unreadable
//! transcript, a session record with no `derived`, and cache purging.

use aimux::transcript_reconciler::{
    SessionView, TranscriptProbe, TranscriptReconciler, TranscriptReconcilerDeps,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Default)]
struct TestDeps {
    pending_interaction: bool,
    probe_result: Option<TranscriptProbe>,
    probe_results: BTreeMap<String, Option<TranscriptProbe>>,
    codex_path: Option<String>,
    settled: Vec<String>,
    cleared: Vec<String>,
    probed: Vec<(String, String)>,
    codex_calls: Vec<String>,
}

impl TranscriptReconcilerDeps for TestDeps {
    fn has_pending_interaction(&mut self, _session_id: &str) -> bool {
        self.pending_interaction
    }
    fn settle_activity(&mut self, session_id: &str) {
        self.settled.push(session_id.to_owned());
    }
    fn clear_stale_response(&mut self, session_id: &str) {
        self.cleared.push(session_id.to_owned());
    }
    fn probe(&mut self, tool_config_key: &str, path: &str) -> Option<TranscriptProbe> {
        self.probed
            .push((tool_config_key.to_owned(), path.to_owned()));
        self.probe_results
            .get(path)
            .cloned()
            .unwrap_or_else(|| self.probe_result.clone())
    }
    fn find_codex_path(&mut self, backend_session_id: &str) -> Option<String> {
        self.codex_calls.push(backend_session_id.to_owned());
        self.codex_path.clone()
    }
}

fn complete() -> Option<TranscriptProbe> {
    Some(TranscriptProbe {
        turn: "complete".to_owned(),
        size: 10,
        mtime_ms: 1,
    })
}

fn session(tool: &str) -> SessionView {
    SessionView {
        id: "a".to_owned(),
        tool_config_key: tool.to_owned(),
        backend_session_id: Some("be-a".to_owned()),
        worktree_path: Some("/wt/a".to_owned()),
    }
}

fn metadata(derived: Value, context: Value) -> Value {
    json!({ "sessions": { "a": { "derived": derived, "context": context } } })
}

fn running() -> Value {
    json!({ "activity": "running", "attention": "normal" })
}

#[test]
fn stored_transcript_path_wins_over_derivation() {
    let mut reconciler = TranscriptReconciler::new();
    let mut deps = TestDeps {
        probe_result: complete(),
        ..Default::default()
    };
    let metadata = metadata(running(), json!({ "transcriptPath": "/stored/be-a.jsonl" }));
    reconciler.scan(&[session("claude")], &metadata, &mut deps);
    assert_eq!(
        deps.probed,
        vec![("claude".to_owned(), "/stored/be-a.jsonl".to_owned())]
    );
}

#[test]
fn stale_stored_transcript_path_for_previous_backend_does_not_settle() {
    let mut reconciler = TranscriptReconciler::new();
    let mut deps = TestDeps {
        probe_results: BTreeMap::from([("/stored/be-old.jsonl".to_owned(), complete())]),
        ..Default::default()
    };
    let metadata = metadata(
        running(),
        json!({ "transcriptPath": "/stored/be-old.jsonl" }),
    );

    reconciler.scan(&[session("claude")], &metadata, &mut deps);
    reconciler.scan(&[session("claude")], &metadata, &mut deps);

    assert_eq!(deps.probed.len(), 2);
    for (_, path) in &deps.probed {
        assert_ne!(path, "/stored/be-old.jsonl");
        assert!(
            path.ends_with("/.claude/projects/-wt-a/be-a.jsonl"),
            "resolved path did not belong to the current backend: {path}"
        );
    }
    assert!(
        deps.settled.is_empty(),
        "settled from a transcript path that belonged to the old backend: {:?}",
        deps.settled
    );
}

#[test]
fn claude_path_is_derived_from_the_real_projects_encoding() {
    let mut reconciler = TranscriptReconciler::new();
    let mut deps = TestDeps {
        probe_result: complete(),
        ..Default::default()
    };
    reconciler.scan(
        &[session("claude")],
        &metadata(running(), json!({})),
        &mut deps,
    );
    let (tool, path) = deps.probed.first().expect("a probe happened").clone();
    assert_eq!(tool, "claude");
    assert!(
        path.ends_with("/.claude/projects/-wt-a/be-a.jsonl"),
        "derived claude transcript path was {path}"
    );
}

#[test]
fn worktree_path_falls_back_to_the_stored_context() {
    let mut reconciler = TranscriptReconciler::new();
    let mut deps = TestDeps {
        probe_result: complete(),
        ..Default::default()
    };
    let mut session = session("claude");
    session.worktree_path = None;
    let metadata = metadata(running(), json!({ "worktreePath": "/ctx/a" }));
    reconciler.scan(&[session], &metadata, &mut deps);
    let (_, path) = deps.probed.first().expect("a probe happened").clone();
    assert!(
        path.ends_with("/.claude/projects/-ctx-a/be-a.jsonl"),
        "derived claude transcript path was {path}"
    );
}

#[test]
fn a_session_with_no_derived_record_is_skipped_without_dropping_its_pending() {
    let mut reconciler = TranscriptReconciler::new();
    let live = metadata(running(), json!({ "transcriptPath": "/t/be-a.jsonl" }));
    let bare = json!({ "sessions": { "a": { "context": {} } } });
    let mut deps = TestDeps {
        probe_result: complete(),
        ..Default::default()
    };

    reconciler.scan(&[session("claude")], &live, &mut deps);
    // A tick where the metadata record has no `derived` at all: Node `continue`s
    // before either part, so the pending confirmation must survive it.
    reconciler.scan(&[session("claude")], &bare, &mut deps);
    assert_eq!(
        deps.probed.len(),
        1,
        "probed a session with no derived record"
    );

    reconciler.scan(&[session("claude")], &live, &mut deps);
    assert_eq!(
        deps.settled,
        vec!["a".to_owned()],
        "the no-derived tick dropped the pending confirmation"
    );
}

#[test]
fn an_unreadable_transcript_drops_the_pending_confirmation() {
    let mut reconciler = TranscriptReconciler::new();
    let metadata = metadata(running(), json!({ "transcriptPath": "/t/be-a.jsonl" }));
    let mut deps = TestDeps {
        probe_result: complete(),
        ..Default::default()
    };
    reconciler.scan(&[session("claude")], &metadata, &mut deps);

    // The transcript becomes unreadable, then readable again at the same stat.
    deps.probe_result = None;
    reconciler.scan(&[session("claude")], &metadata, &mut deps);
    deps.probe_result = complete();
    reconciler.scan(&[session("claude")], &metadata, &mut deps);

    assert!(
        deps.settled.is_empty(),
        "settled across an unreadable tick: {:?}",
        deps.settled
    );

    // A fourth quiescent tick still settles, proving only the gap was dropped.
    reconciler.scan(&[session("claude")], &metadata, &mut deps);
    assert_eq!(deps.settled, vec!["a".to_owned()]);
}

#[test]
fn leaving_the_live_set_purges_the_codex_path_cache() {
    let mut reconciler = TranscriptReconciler::new();
    let metadata = metadata(running(), json!({}));
    let mut deps = TestDeps {
        probe_result: complete(),
        codex_path: Some("/codex/be-a.jsonl".to_owned()),
        ..Default::default()
    };
    reconciler.scan(&[session("codex")], &metadata, &mut deps);
    reconciler.scan(&[session("codex")], &metadata, &mut deps);
    assert_eq!(
        deps.codex_calls,
        vec!["be-a".to_owned()],
        "cache did not hold"
    );

    reconciler.scan(&[], &json!({ "sessions": {} }), &mut deps);
    reconciler.scan(&[session("codex")], &metadata, &mut deps);
    assert_eq!(
        deps.codex_calls,
        vec!["be-a".to_owned(), "be-a".to_owned()],
        "cache survived the session leaving"
    );
}

#[test]
fn needs_response_clears_only_after_a_second_unbacked_tick() {
    let mut reconciler = TranscriptReconciler::new();
    let metadata = metadata(
        json!({ "activity": "idle", "attention": "needs_response" }),
        json!({}),
    );
    let mut deps = TestDeps::default();
    reconciler.scan(&[session("claude")], &metadata, &mut deps);
    assert!(deps.cleared.is_empty(), "cleared on the first tick");
    reconciler.scan(&[session("claude")], &metadata, &mut deps);
    assert_eq!(deps.cleared, vec!["a".to_owned()]);
}

#[test]
fn a_re_registered_interaction_resets_the_clear_confirmation() {
    let mut reconciler = TranscriptReconciler::new();
    let metadata = metadata(
        json!({ "activity": "idle", "attention": "needs_response" }),
        json!({}),
    );
    let mut deps = TestDeps::default();
    reconciler.scan(&[session("claude")], &metadata, &mut deps);
    deps.pending_interaction = true;
    reconciler.scan(&[session("claude")], &metadata, &mut deps);
    deps.pending_interaction = false;
    reconciler.scan(&[session("claude")], &metadata, &mut deps);
    assert!(
        deps.cleared.is_empty(),
        "cleared despite the interaction re-registering: {:?}",
        deps.cleared
    );
}
