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
    /// Make `clear_stale_response` report failure, so a clear that did not land
    /// can be seen being tried again rather than recorded as done.
    refuse_clears: bool,
    clear_attempts: usize,
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
    fn settle_activity(&mut self, session_id: &str) -> bool {
        self.settled.push(session_id.to_owned());
        true
    }
    fn clear_stale_response(&mut self, session_id: &str) -> bool {
        self.clear_attempts += 1;
        if self.refuse_clears {
            return false;
        }
        self.cleared.push(session_id.to_owned());
        true
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

fn in_progress() -> Option<TranscriptProbe> {
    Some(TranscriptProbe {
        turn: "in_progress".to_owned(),
        size: 10,
        mtime_ms: 1,
    })
}

/// A transcript that has grown since the last probe, which is what a working
/// agent looks like and what stops the dwell from accumulating.
fn complete_with_size(size: u64) -> Option<TranscriptProbe> {
    Some(TranscriptProbe {
        turn: "complete".to_owned(),
        size,
        mtime_ms: 1,
    })
}

/// An overseer or a scribe. The only thing that differs is who reads its
/// prompt, which is exactly what Part C turns on.
fn control_session(tool: &str) -> SessionView {
    SessionView {
        project_control: true,
        ..session(tool)
    }
}

fn needs_input() -> Value {
    json!({ "activity": "waiting", "attention": "needs_input" })
}

fn needs_response() -> Value {
    json!({ "activity": "waiting", "attention": "needs_response" })
}

fn session(tool: &str) -> SessionView {
    SessionView {
        id: "a".to_owned(),
        tool_config_key: tool.to_owned(),
        backend_session_id: Some("be-a".to_owned()),
        worktree_path: Some("/wt/a".to_owned()),
        project_control: false,
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

/// A scribe stranded at `needs_input` is cleared so something can talk to it
/// again.
///
/// The case observed on tealstreet-next 2026-10-05: the scribe finished its
/// turn at 11:40 PM and had not been briefed in fifteen hours, because
/// `scribe_readiness` refuses a scribe whose attention is not normal and
/// nothing in the system clears a stranded `needs_input`.
#[test]
fn a_control_session_stranded_at_needs_input_is_cleared() {
    let mut reconciler = TranscriptReconciler::new();
    let mut deps = TestDeps {
        probe_result: complete(),
        ..Default::default()
    };
    let sessions = [control_session("claude")];
    let metadata = metadata(needs_input(), json!({}));

    reconciler.scan(&sessions, &metadata, &mut deps);
    assert!(
        deps.cleared.is_empty(),
        "not on the tick that first saw the transcript"
    );
    reconciler.scan(&sessions, &metadata, &mut deps);
    assert!(
        deps.cleared.is_empty(),
        "nor on the one that found it unchanged"
    );
    reconciler.scan(&sessions, &metadata, &mut deps);
    assert_eq!(deps.cleared, vec!["a".to_owned()]);
    assert!(
        deps.settled.is_empty(),
        "the activity is not touched; only the attention was stranded"
    );
}

/// A coder's `needs_input` is left alone, which is the whole reason Part C is
/// gated on the role: a person reads a coder's prompt, and the reply is what
/// clears it.
#[test]
fn a_coders_needs_input_is_never_cleared() {
    let mut reconciler = TranscriptReconciler::new();
    let mut deps = TestDeps {
        probe_result: complete(),
        ..Default::default()
    };
    let sessions = [session("claude")];
    let metadata = metadata(needs_input(), json!({}));

    for _ in 0..6 {
        reconciler.scan(&sessions, &metadata, &mut deps);
    }
    assert!(deps.cleared.is_empty());
    assert!(deps.settled.is_empty());
}

/// A control session genuinely mid-request keeps its `needs_input`.
///
/// The transcript is the discriminator, and it is why this cannot be a timer:
/// an agent waiting on a permission prompt has a turn that is not complete, so
/// no amount of dwelling clears it.
#[test]
fn a_control_session_still_mid_turn_keeps_its_needs_input() {
    let mut reconciler = TranscriptReconciler::new();
    let mut deps = TestDeps {
        probe_result: in_progress(),
        ..Default::default()
    };
    let sessions = [control_session("claude")];
    let metadata = metadata(needs_input(), json!({}));

    for _ in 0..6 {
        reconciler.scan(&sessions, &metadata, &mut deps);
    }
    assert!(deps.cleared.is_empty());
}

/// A transcript still being appended to is not quiescent, so the dwell restarts
/// rather than accumulating across probes that disagree.
#[test]
fn an_appending_transcript_restarts_the_dwell() {
    let mut reconciler = TranscriptReconciler::new();
    let mut deps = TestDeps {
        probe_result: complete_with_size(10),
        ..Default::default()
    };
    let sessions = [control_session("claude")];
    let metadata = metadata(needs_input(), json!({}));

    reconciler.scan(&sessions, &metadata, &mut deps);
    deps.probe_result = complete_with_size(11);
    reconciler.scan(&sessions, &metadata, &mut deps);
    deps.probe_result = complete_with_size(12);
    reconciler.scan(&sessions, &metadata, &mut deps);
    assert!(
        deps.cleared.is_empty(),
        "three ticks, but no two agreed, so it was never quiescent"
    );
}

/// The two attentions do not share a dwell.
///
/// Part B clears a stranded `needs_response` and Part C a stranded
/// `needs_input`, each with its own set, so a session that flips between them
/// cannot have one attention's first tick pay for the other's second.
#[test]
fn flipping_between_the_two_attentions_does_not_shortcut_either_dwell() {
    let mut reconciler = TranscriptReconciler::new();
    let mut deps = TestDeps {
        probe_result: complete(),
        ..Default::default()
    };
    let sessions = [control_session("claude")];

    reconciler.scan(&sessions, &metadata(needs_input(), json!({})), &mut deps);
    reconciler.scan(&sessions, &metadata(needs_input(), json!({})), &mut deps);
    // Now it is `needs_response`. Part B's dwell starts here, from nothing,
    // however many ticks Part C had banked.
    reconciler.scan(&sessions, &metadata(needs_response(), json!({})), &mut deps);
    assert!(
        deps.cleared.is_empty(),
        "Part C's ticks must not pay for Part B's dwell"
    );
}

/// A clear the service rejected is tried again rather than recorded as done.
#[test]
fn a_clear_that_does_not_land_is_tried_again() {
    let mut reconciler = TranscriptReconciler::new();
    let mut deps = TestDeps {
        probe_result: complete(),
        refuse_clears: true,
        ..Default::default()
    };
    let sessions = [control_session("claude")];
    let metadata = metadata(needs_input(), json!({}));

    for _ in 0..5 {
        reconciler.scan(&sessions, &metadata, &mut deps);
    }
    assert!(
        deps.clear_attempts >= 2,
        "a rejected clear has to be attempted again: {} attempts",
        deps.clear_attempts
    );
    assert!(deps.cleared.is_empty());
}
