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
        control_flags: json!({ "id": "a", "role": "scribe", "scribe": true }),
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
        control_flags: json!({ "id": "a" }),
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

    // One tick to bank the probe, a second to find the file unchanged. The same
    // bar as Part A, and deliberately not Part B's extra dwell: Part B waits
    // twice because its signal is an in-memory interaction registry that can be
    // mid-rebuild after a restart, and this one's signal is the transcript.
    reconciler.scan(&sessions, &metadata, &mut deps);
    assert!(
        deps.cleared.is_empty(),
        "not on the tick that first saw the transcript"
    );
    reconciler.scan(&sessions, &metadata, &mut deps);
    assert_eq!(deps.cleared, vec!["a".to_owned()]);
    // And the activity, because clearing the attention alone does not make a
    // scribe ready: `scribe_readiness` wants activity idle-or-done AND
    // attention normal, and a scribe stranded this way is `waiting`.
    assert_eq!(deps.settled, vec!["a".to_owned()]);
}

/// Clearing the attention alone would not have been enough.
///
/// `scribe_readiness` is an AND of two fields, and a stranded scribe fails
/// both: `activity: "waiting"`, `attention: "needs_input"`. This asserts the
/// state Part C leaves behind actually satisfies it, through the real
/// predicate, rather than trusting that the two halves meet.
#[test]
fn the_state_part_c_leaves_behind_is_one_the_scribe_watcher_accepts() {
    let before = json!({
        "sessions": [{ "id": "a", "status": "running" }],
        "metadata": { "sessions": { "a": {
            "scribe": true,
            "derived": { "activity": "waiting", "attention": "needs_input" }
        }}}
    });
    assert!(
        !aimux::scribe_watcher::scribe_readiness(&before, Some("a")),
        "the stranded state is the one that was being refused"
    );

    // Exactly what Part C posts: `settle_activity` writes `idle`,
    // `clear_stale_response` writes `normal`.
    let after = json!({
        "sessions": [{ "id": "a", "status": "running" }],
        "metadata": { "sessions": { "a": {
            "scribe": true,
            "derived": { "activity": "idle", "attention": "normal" }
        }}}
    });
    assert!(aimux::scribe_watcher::scribe_readiness(&after, Some("a")));

    // And the half-fix, to say out loud why both writes are needed.
    let attention_only = json!({
        "sessions": [{ "id": "a", "status": "running" }],
        "metadata": { "sessions": { "a": {
            "scribe": true,
            "derived": { "activity": "waiting", "attention": "normal" }
        }}}
    });
    assert!(
        !aimux::scribe_watcher::scribe_readiness(&attention_only, Some("a")),
        "clearing only the attention leaves the scribe still unready"
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

/// Part B's dwell is not spent by Part C, in the direction that can tell.
///
/// An earlier version of this test ran `needs_input` twice and then
/// `needs_response` once, and passed on master -- Part B's dwell lives in its
/// own set, which Part C never touched, and one `needs_response` tick can never
/// clear anyway. The discriminating direction is the other one: bank a tick of
/// Part B's dwell first, then strand the session at `needs_input` and check
/// Part C does not spend it.
#[test]
fn part_b_s_dwell_is_not_spent_by_part_c() {
    let mut reconciler = TranscriptReconciler::new();
    let mut deps = TestDeps {
        probe_result: complete(),
        ..Default::default()
    };
    let sessions = [control_session("claude")];

    // One unbacked `needs_response` tick: Part B records it and waits.
    reconciler.scan(&sessions, &metadata(needs_response(), json!({})), &mut deps);
    assert!(deps.cleared.is_empty());

    // Now it is `needs_input` instead. Part C starts from nothing; if it read
    // Part B's banked tick it would write on this one.
    reconciler.scan(&sessions, &metadata(needs_input(), json!({})), &mut deps);
    assert!(
        deps.cleared.is_empty(),
        "Part B's tick must not pay for Part C's dwell"
    );
    assert!(deps.settled.is_empty());
}

/// And Part A's dwell is not spent by Part C, which is the direction that was
/// actually broken.
///
/// Sharing one `pending` map let a control session bank quiescence while it was
/// stranded at `needs_input`, and then hand that banked tick to Part A the
/// moment its attention went back to normal with the agent working again. The
/// result was a scribe briefed and relabelled `ready` in the same breath, with
/// no dwell of Part A's own -- so the agent would read idle while it worked.
#[test]
fn part_a_s_dwell_is_not_spent_by_part_c() {
    let mut reconciler = TranscriptReconciler::new();
    let mut deps = TestDeps {
        probe_result: complete(),
        ..Default::default()
    };
    let sessions = [control_session("claude")];

    // Stranded, and banking quiescence.
    reconciler.scan(&sessions, &metadata(needs_input(), json!({})), &mut deps);

    // Briefed: the attention is normal and it is working again. Part A must pay
    // a tick of its own before calling the turn over.
    reconciler.scan(&sessions, &metadata(running(), json!({})), &mut deps);
    assert!(
        deps.settled.is_empty(),
        "Part C's banked tick must not settle a working agent on sight"
    );

    // On its own second tick, with the file still unchanged, it may.
    reconciler.scan(&sessions, &metadata(running(), json!({})), &mut deps);
    assert_eq!(deps.settled, vec!["a".to_owned()]);
}

/// A clear the service rejected is tried again rather than recorded as done --
/// and the write that DID land is not tried again with it.
///
/// Part C makes two writes. Retrying the pair wholesale would re-POST the
/// settle on every tick for as long as the clear kept failing, which is the
/// same spam the delivery path keeps per-recipient state to avoid.
#[test]
fn a_clear_that_does_not_land_is_retried_without_repeating_the_settle() {
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
    assert_eq!(
        deps.settled,
        vec!["a".to_owned()],
        "the settle landed on the first try, so it is not sent again"
    );
}

/// A session the metadata has DEMOTED is a coder, whatever the topology says.
///
/// `agents.rs` models a stored `{"scribe": false}` over a topology that still
/// describes the session by role, and every other caller resolves that through
/// `session_with_stored_control_flags`. Deciding from the topology value alone
/// would read a demoted coder as control and clear its real prompt -- which is
/// the one thing Part C's role gate exists to prevent.
#[test]
fn a_metadata_demotion_beats_a_topology_role() {
    let mut reconciler = TranscriptReconciler::new();
    let mut deps = TestDeps {
        probe_result: complete(),
        ..Default::default()
    };
    let sessions = [control_session("claude")];
    let demoted = json!({ "sessions": { "a": {
        "scribe": false,
        "overseer": false,
        "derived": { "activity": "waiting", "attention": "needs_input" },
        "context": {}
    }}});

    for _ in 0..5 {
        reconciler.scan(&sessions, &demoted, &mut deps);
    }
    assert!(
        deps.cleared.is_empty(),
        "a demoted session's prompt is a person's to answer"
    );
    assert!(deps.settled.is_empty());
}
