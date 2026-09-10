use aimux::loop_watcher::{LoopSend, LoopWatcher};
use serde_json::{Value, json};

/// Unix-millis, because the cooldown is measured against the epoch.
const NOW: i64 = 1_788_000_000_000;

fn looping_session(id: &str, activity: &str) -> (Value, Value) {
    (
        json!({ "id": id, "tool": "claude", "worktreePath": "/repo" }),
        json!({
            "loop": { "active": true, "goal": "ship it", "since": "2026-09-09T00:00:00.000Z" },
            "derived": { "activity": activity, "attention": "normal" }
        }),
    )
}

fn input(sessions: Vec<Value>, metadata: Value, auto_nudge: bool) -> Value {
    input_with_config(
        sessions,
        metadata,
        json!({ "nudgeCooldownMs": 60_000, "autoNudgeWithoutOverseer": auto_nudge }),
    )
}

fn input_with_config(sessions: Vec<Value>, metadata: Value, config: Value) -> Value {
    json!({
        "sessions": sessions,
        "metadata": metadata,
        "config": config,
        "pendingInteractions": []
    })
}

#[test]
fn a_failed_send_does_not_consume_the_overseer_cooldown() {
    let (boss, boss_meta) = looping_session("boss", "idle");
    let (worker, worker_meta) = looping_session("worker", "idle");
    let mut boss_meta = boss_meta;
    boss_meta["overseer"] = json!(true);
    let input = input(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        false,
    );

    let mut watcher = LoopWatcher::new();
    let mut fail = |_: &LoopSend| false;
    assert_eq!(watcher.scan(&input, NOW, &mut fail).len(), 1);

    // one millisecond later, well inside the cooldown: it must try again,
    // because a briefing that never landed cannot silence the overseer
    assert_eq!(watcher.scan(&input, NOW + 1, &mut fail).len(), 1);

    let mut ok = |_: &LoopSend| true;
    assert_eq!(watcher.scan(&input, NOW + 2, &mut ok).len(), 1);
    // now it landed, so the cooldown holds
    assert!(watcher.scan(&input, NOW + 3, &mut ok).is_empty());
}

#[test]
fn an_agent_waiting_on_a_human_is_never_nudged() {
    let (worker, mut worker_meta) = looping_session("worker", "idle");
    worker_meta["derived"]["attention"] = json!("needs_input");
    let input = input(
        vec![worker],
        json!({ "sessions": { "worker": worker_meta } }),
        true,
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert!(watcher.scan(&input, NOW, &mut ok).is_empty());
}

#[test]
fn an_agent_with_a_pending_interaction_is_never_nudged() {
    let (worker, worker_meta) = looping_session("worker", "idle");
    let mut input = input(
        vec![worker],
        json!({ "sessions": { "worker": worker_meta } }),
        true,
    );
    input["pendingInteractions"] = json!(["worker"]);

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert!(watcher.scan(&input, NOW, &mut ok).is_empty());
}

#[test]
fn a_running_agent_is_left_alone() {
    let (worker, worker_meta) = looping_session("worker", "running");
    let input = input(
        vec![worker],
        json!({ "sessions": { "worker": worker_meta } }),
        true,
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert!(watcher.scan(&input, NOW, &mut ok).is_empty());
}

#[test]
fn a_loop_candidate_must_remain_stopped_for_the_dwell_window() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 60_000, "stoppedDwellMs": 30_000 }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert!(watcher.scan(&input, NOW, &mut ok).is_empty());
    assert!(watcher.scan(&input, NOW + 29_999, &mut ok).is_empty());
    assert_eq!(watcher.scan(&input, NOW + 30_000, &mut ok).len(), 1);
}

#[test]
fn running_resets_the_stopped_dwell_window() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, mut worker_meta) = looping_session("worker", "idle");
    let mut input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta.clone() } }),
        json!({ "nudgeCooldownMs": 60_000, "stoppedDwellMs": 30_000 }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert!(watcher.scan(&input, NOW, &mut ok).is_empty());
    worker_meta["derived"]["activity"] = json!("running");
    input["metadata"]["sessions"]["worker"] = worker_meta.clone();
    assert!(watcher.scan(&input, NOW + 15_000, &mut ok).is_empty());

    worker_meta["derived"]["activity"] = json!("idle");
    input["metadata"]["sessions"]["worker"] = worker_meta;
    assert!(
        watcher.scan(&input, NOW + 30_000, &mut ok).is_empty(),
        "the second idle observation must start a fresh dwell window"
    );
    assert_eq!(watcher.scan(&input, NOW + 60_000, &mut ok).len(), 1);
}

#[test]
fn overseer_wakeups_are_edge_triggered_then_reminded_by_tick_count() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let (second, second_meta) = looping_session("second", "idle");
    let mut input = input_with_config(
        vec![boss.clone(), worker],
        json!({ "sessions": { "boss": boss_meta.clone(), "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0, "unchangedReminderTicks": 2 }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert_eq!(watcher.scan(&input, NOW, &mut ok).len(), 1);
    assert!(watcher.scan(&input, NOW + 1, &mut ok).is_empty());
    assert_eq!(watcher.scan(&input, NOW + 2, &mut ok).len(), 1);

    input["sessions"] =
        json!([boss, { "id": "worker", "tool": "claude", "worktreePath": "/repo" }, second]);
    input["metadata"]["sessions"]["boss"] = boss_meta;
    input["metadata"]["sessions"]["second"] = second_meta;
    assert_eq!(
        watcher.scan(&input, NOW + 3, &mut ok).len(),
        1,
        "a changed candidate set is a new edge and bypasses the unchanged reminder"
    );
}

#[test]
fn unchanged_candidate_reminders_do_not_bypass_the_cooldown_floor() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 60_000, "stoppedDwellMs": 0, "unchangedReminderTicks": 2 }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert_eq!(watcher.scan(&input, NOW, &mut ok).len(), 1);
    assert!(watcher.scan(&input, NOW + 15_000, &mut ok).is_empty());
    assert!(
        watcher.scan(&input, NOW + 30_000, &mut ok).is_empty(),
        "tick cadence alone must not spam while the cooldown floor still holds"
    );
    assert!(watcher.scan(&input, NOW + 45_000, &mut ok).is_empty());
    assert_eq!(watcher.scan(&input, NOW + 60_000, &mut ok).len(), 1);
}

#[test]
fn without_an_overseer_nothing_is_sent_unless_auto_nudge_is_enabled() {
    let (worker, worker_meta) = looping_session("worker", "idle");
    let sessions = vec![worker];
    let metadata = json!({ "sessions": { "worker": worker_meta } });

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert!(
        watcher
            .scan(
                &input(sessions.clone(), metadata.clone(), false),
                NOW,
                &mut ok
            )
            .is_empty(),
        "observe-only is the default"
    );

    let mut watcher = LoopWatcher::new();
    assert_eq!(
        watcher
            .scan(&input(sessions, metadata, true), NOW, &mut ok)
            .len(),
        1
    );
}

mod task_inputs {
    use aimux::project_service::loop_watcher_task::{
        NUDGEABLE_SESSION_STATUSES, apply_live_activity_override, build_scan_input, is_scribe,
    };
    use serde_json::json;

    #[test]
    fn only_sessions_with_a_live_window_are_ever_eligible() {
        // this is the list handed to list_topology_session_states, and it is
        // what keeps a graveyarded session with stale loop metadata unreachable
        assert_eq!(NUDGEABLE_SESSION_STATUSES, ["starting", "running", "idle"]);
        assert!(!NUDGEABLE_SESSION_STATUSES.contains(&"graveyard"));
        assert!(!NUDGEABLE_SESSION_STATUSES.contains(&"offline"));
        assert!(!NUDGEABLE_SESSION_STATUSES.contains(&"exited"));
    }

    #[test]
    fn the_scribe_is_filtered_out_before_the_watcher_sees_it() {
        let metadata = json!({ "sessions": {
            "claude-scribe": { "scribe": true },
            "worker": {}
        }});
        let sessions = vec![json!({ "id": "claude-scribe" }), json!({ "id": "worker" })];

        assert!(is_scribe(&metadata, &sessions[0]));
        assert!(!is_scribe(&metadata, &sessions[1]));

        let input = build_scan_input(sessions, &metadata, &[], json!({}));
        let ids = input["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|session| session["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(ids, ["worker"]);
    }

    #[test]
    fn pending_interactions_are_reduced_to_session_ids() {
        let pending = vec![
            json!({ "sessionId": "worker", "status": "pending" }),
            json!({ "status": "pending" }),
        ];
        let input = build_scan_input(vec![], &json!({}), &pending, json!({}));
        assert_eq!(input["pendingInteractions"], json!(["worker"]));
    }

    #[test]
    fn an_absent_loop_config_leaves_auto_nudge_off() {
        use aimux::loop_watcher::{LoopSend, LoopWatcher};
        let metadata = json!({ "sessions": { "worker": {
            "loop": { "active": true, "since": "2026-09-09T00:00:00.000Z" },
            "derived": { "activity": "idle", "attention": "normal" }
        }}});
        // config Null is what load_config_for_project yields when `loop` is absent
        let input = build_scan_input(
            vec![json!({ "id": "worker" })],
            &metadata,
            &[],
            serde_json::Value::Null,
        );

        let mut watcher = LoopWatcher::new();
        let mut ok = |_: &LoopSend| true;
        assert!(
            watcher.scan(&input, super::NOW, &mut ok).is_empty(),
            "a missing config must not enable auto-nudging"
        );
    }

    #[test]
    fn live_running_activity_overrides_stale_stopped_metadata() {
        use aimux::loop_watcher::{LoopSend, LoopWatcher};

        let mut boss_meta = json!({
            "overseer": true,
            "derived": { "activity": "idle", "attention": "normal" }
        });
        boss_meta["loop"] = json!({ "active": false });
        let metadata = json!({ "sessions": {
            "boss": boss_meta,
            "worker": {
                "loop": { "active": true, "since": "2026-09-09T00:00:00.000Z" },
                "derived": { "activity": "done", "attention": "normal" }
            }
        }});
        let sessions = vec![
            json!({ "id": "boss", "tool": "claude" }),
            json!({ "id": "worker", "tool": "codex" }),
        ];
        let mut input = build_scan_input(
            sessions,
            &metadata,
            &[],
            json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
        );

        apply_live_activity_override(
            &mut input,
            "worker",
            &json!({ "activity": "running", "activityText": "Working (3s)" }),
        );

        let mut watcher = LoopWatcher::new();
        let mut ok = |_: &LoopSend| true;
        assert!(
            watcher.scan(&input, super::NOW, &mut ok).is_empty(),
            "a visible working pane must not be reported as stopped just because metadata is stale"
        );
    }
}

mod scribe_spellings {
    use aimux::project_service::loop_watcher_task::is_scribe;
    use serde_json::json;

    #[test]
    fn a_scribe_by_team_role_is_recognised_as_well_as_by_flag() {
        let metadata = json!({ "sessions": {
            "flagged":  { "scribe": true },
            "by-role":  {},
            "worker":   {}
        }});
        let scribe_by_flag = json!({ "id": "flagged" });
        let scribe_by_role =
            json!({ "id": "by-role", "team": { "teamId": "scribe", "role": "scribe" } });
        let worker = json!({ "id": "worker" });

        assert!(is_scribe(&metadata, &scribe_by_flag));
        assert!(is_scribe(&metadata, &scribe_by_role));
        assert!(!is_scribe(&metadata, &worker));
    }

    #[test]
    fn a_scribe_role_on_the_topology_session_alone_still_counts() {
        let metadata = json!({ "sessions": {} });
        let session = json!({ "id": "s", "team": { "role": "scribe" } });
        assert!(is_scribe(&metadata, &session));
    }

    #[test]
    fn an_explicit_scribe_false_in_metadata_wins_over_the_session_role() {
        let metadata = json!({ "sessions": { "s": { "scribe": false } } });
        let session = json!({ "id": "s", "team": { "role": "scribe" } });
        assert!(
            !is_scribe(&metadata, &session),
            "the negation must be honoured"
        );
    }
}
