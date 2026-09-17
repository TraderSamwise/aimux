use aimux::loop_watcher::{
    LoopAlertPauseProvenance, LoopDeliveryOutcome, LoopScanIndeterminate, LoopSend, LoopSendKind,
    LoopWatcher, load_loop_watcher_state, loop_pause_key_from_loop_metadata,
    loop_watcher_state_path, save_loop_watcher_state,
};
use serde_json::{Value, json};
use std::fs;
use std::path::PathBuf;

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

fn looping_session_with_status(id: &str, status: Option<&str>, activity: &str) -> (Value, Value) {
    let (mut session, meta) = looping_session(id, activity);
    if let Some(status) = status {
        session["status"] = json!(status);
    }
    (session, meta)
}

fn self_exited_session_with_status(id: &str, status: Option<&str>, action: &str) -> (Value, Value) {
    let mut session = json!({ "id": id, "tool": "claude", "worktreePath": "/repo" });
    if let Some(status) = status {
        session["status"] = json!(status);
    }
    (
        session,
        json!({
            "loopLastAction": {
                "action": action,
                "at": "2026-09-09T00:10:00.000Z",
                "source": "agent",
                "updatedBySessionId": id,
                "goal": "ship it",
                "reason": "finished the goal"
            },
            "derived": { "activity": "done", "attention": "normal" }
        }),
    )
}

fn non_loop_session(id: &str, activity: &str) -> (Value, Value) {
    (
        json!({ "id": id, "tool": "codex", "worktreePath": "/repo", "status": "running" }),
        json!({
            "derived": { "activity": activity, "attention": "normal" }
        }),
    )
}

fn briefing_mentions(send: &LoopSend, id: &str) -> bool {
    send.text
        .lines()
        .any(|line| line.starts_with(&format!("- {id}")))
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
        "pendingInteractions": [],
        "runtimeExchange": { "tasks": [] },
        "coordinationWorklist": []
    })
}

fn temp_state_dir(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-loop-watcher-{name}-{}-{}",
        std::process::id(),
        NOW
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("create temp state dir");
    path
}

#[test]
fn a_failed_send_is_recorded_and_backed_off_until_reminder() {
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
    let record = watcher.last_delivery_record().expect("delivery record");
    assert_eq!(record.outcome, "failed");
    assert_eq!(record.session_id, "boss");

    assert!(
        watcher.scan(&input, NOW + 1, &mut fail).is_empty(),
        "a failed attempt must not make the same unchanged briefing look new on the next tick"
    );

    let mut ok = |_: &LoopSend| true;
    assert_eq!(
        watcher.scan(&input, NOW + 60_000, &mut ok).len(),
        1,
        "the normal reminder/cooldown path still retries after a failed attempt"
    );
    assert!(watcher.scan(&input, NOW + 60_001, &mut ok).is_empty());
}

#[test]
fn a_reported_stopped_agent_does_not_realert_after_state_reload() {
    let state_dir = temp_state_dir("restart");
    let path = loop_watcher_state_path(&state_dir);
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
    let mut ok = |_: &LoopSend| true;
    assert_eq!(watcher.scan(&input, NOW, &mut ok).len(), 1);
    save_loop_watcher_state(&path, &watcher).expect("save loop watcher state");

    let mut restarted = load_loop_watcher_state(&path).expect("load loop watcher state");
    assert!(
        restarted.scan(&input, NOW + 1, &mut ok).is_empty(),
        "the durable state must remember that this unchanged candidate was already reported"
    );
}

#[test]
fn an_accepted_or_queued_overseer_briefing_suppresses_the_same_busy_receiver_level() {
    let (boss, boss_meta) = looping_session("boss", "busy");
    let (worker, worker_meta) = looping_session("worker", "idle");
    let mut boss_meta = boss_meta;
    boss_meta["overseer"] = json!(true);
    let input = input(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        false,
    );

    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(sends.len(), 1);
    watcher.commit_send_result(&sends[0], NOW, LoopDeliveryOutcome::Delivered);

    assert!(
        watcher.plan_sends(&input, NOW + 1).is_empty(),
        "a queued/accepted briefing to a busy overseer must not repeat while the stopped-agent level is unchanged"
    );
}

#[test]
fn a_failed_delivery_attempt_survives_reload_without_becoming_a_new_edge() {
    let state_dir = temp_state_dir("failed-delivery");
    let path = loop_watcher_state_path(&state_dir);
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
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(sends.len(), 1);
    watcher.commit_send_result(
        &sends[0],
        NOW,
        LoopDeliveryOutcome::Failed {
            error: "forced delivery failure".to_owned(),
        },
    );
    save_loop_watcher_state(&path, &watcher).expect("save failed attempt");

    let mut restarted = load_loop_watcher_state(&path).expect("load failed attempt");
    let record = restarted.last_delivery_record().expect("delivery record");
    assert_eq!(record.outcome, "failed");
    assert_eq!(record.error.as_deref(), Some("forced delivery failure"));
    assert!(
        restarted.plan_sends(&input, NOW + 1).is_empty(),
        "a saved failed attempt must suppress the unchanged level until the reminder cadence"
    );
}

#[test]
fn legacy_aggregate_state_migrates_to_per_agent_attempt_cadence() {
    let state_dir = temp_state_dir("legacy-aggregate");
    let path = loop_watcher_state_path(&state_dir);
    fs::write(
        &path,
        json!({
            "version": 1,
            "lastNudgeAt": {},
            "lastOverseerWakeAt": NOW,
            "stoppedSince": [{
                "sessionId": "worker",
                "loopSince": "2026-09-09T00:00:00.000Z",
                "goal": "ship it",
                "loopSource": "",
                "firstSeenMs": NOW - 30_000
            }],
            "lastCandidateSignature": "worker",
            "lastOverseerReportedSignature": "worker",
            "lastOverseerAttemptedSignature": "worker",
            "unchangedCandidateTicks": 1,
            "deliveryRecords": []
        })
        .to_string(),
    )
    .expect("write legacy watcher state");

    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 60_000, "stoppedDwellMs": 30_000 }),
    );

    let mut watcher = load_loop_watcher_state(&path).expect("load legacy state");
    let mut ok = |_: &LoopSend| true;
    assert!(
        watcher.scan(&input, NOW + 1, &mut ok).is_empty(),
        "legacy aggregate attempts must suppress the same per-agent stopped level after upgrade"
    );
}

#[test]
fn a_new_stopped_agent_still_alerts_immediately_after_a_failed_attempt() {
    let (boss, boss_meta) = looping_session("boss", "idle");
    let (worker, worker_meta) = looping_session("worker", "idle");
    let (second, second_meta) = looping_session("second", "idle");
    let mut boss_meta = boss_meta;
    boss_meta["overseer"] = json!(true);
    let mut input = input(
        vec![boss.clone(), worker],
        json!({ "sessions": { "boss": boss_meta.clone(), "worker": worker_meta } }),
        false,
    );

    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(sends.len(), 1);
    watcher.commit_send_result(
        &sends[0],
        NOW,
        LoopDeliveryOutcome::Failed {
            error: "forced delivery failure".to_owned(),
        },
    );
    assert!(watcher.plan_sends(&input, NOW + 1).is_empty());

    input["sessions"] = json!([
        boss,
        { "id": "worker", "tool": "claude", "worktreePath": "/repo" },
        second
    ]);
    input["metadata"]["sessions"]["boss"] = boss_meta;
    input["metadata"]["sessions"]["second"] = second_meta;
    assert_eq!(
        watcher.plan_sends(&input, NOW + 2).len(),
        1,
        "a genuinely changed candidate set must bypass the failed-attempt backoff"
    );
}

#[test]
fn corrupt_loop_watcher_state_fails_loud_instead_of_defaulting() {
    let state_dir = temp_state_dir("corrupt");
    let path = loop_watcher_state_path(&state_dir);
    fs::write(&path, "{ not json").expect("write corrupt state");

    let error = load_loop_watcher_state(&path).expect_err("corrupt state must fail");
    assert!(error.contains("read loop watcher state"));
    assert!(error.contains(path.to_string_lossy().as_ref()));
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
fn retasking_resets_the_stopped_dwell_window_for_the_new_assignment() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, mut worker_meta) = looping_session("worker", "idle");
    let mut input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta.clone() } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 30_000 }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert!(watcher.scan(&input, NOW, &mut ok).is_empty());

    worker_meta["loop"]["since"] = json!("2026-09-09T00:00:20.000Z");
    worker_meta["loop"]["goal"] = json!("new goal");
    worker_meta["loop"]["source"] = json!("task");
    input["metadata"]["sessions"]["worker"] = worker_meta;

    assert!(watcher.scan(&input, NOW + 20_000, &mut ok).is_empty());
    assert!(
        watcher.scan(&input, NOW + 49_999, &mut ok).is_empty(),
        "the new assignment must receive its own continuous dwell window"
    );
    assert_eq!(watcher.scan(&input, NOW + 50_000, &mut ok).len(), 1);
}

#[test]
fn assignment_add_action_resets_stale_stopped_dwell_for_a_fresh_dispatch() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, mut worker_meta) = looping_session("worker", "done");
    let mut input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta.clone() } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 30_000 }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert!(watcher.scan(&input, NOW, &mut ok).is_empty());

    worker_meta["loopLastAction"] = json!({
        "action": "add",
        "at": "2026-09-15T07:36:02.346Z",
        "goal": "ship it",
        "source": "overseer",
        "updatedBySessionId": "boss"
    });
    input["metadata"]["sessions"]["worker"] = worker_meta;

    assert!(
        watcher.scan(&input, NOW + 30_000, &mut ok).is_empty(),
        "a fresh assignment edge must start a fresh stopped dwell window"
    );
    assert!(watcher.scan(&input, NOW + 59_999, &mut ok).is_empty());
    let sends = watcher.scan(&input, NOW + 60_000, &mut ok);
    assert_eq!(
        sends.len(),
        1,
        "a truly stopped agent must still alert after the assignment dwell elapses"
    );
    assert!(briefing_mentions(&sends[0], "worker"));
    assert!(sends[0].text.contains("appear to have stopped:"));
}

#[test]
fn reassigning_an_already_enrolled_agent_resets_prior_stopped_alert_state() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, mut worker_meta) = looping_session("worker", "done");
    let mut input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta.clone() } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 30_000 }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert!(watcher.scan(&input, NOW, &mut ok).is_empty());
    let first = watcher.scan(&input, NOW + 30_000, &mut ok);
    assert_eq!(first.len(), 1);
    assert!(briefing_mentions(&first[0], "worker"));

    worker_meta["loopLastAction"] = json!({
        "action": "add",
        "at": "2026-09-15T07:36:02.346Z",
        "goal": "ship it",
        "source": "overseer",
        "updatedBySessionId": "boss"
    });
    input["metadata"]["sessions"]["worker"] = worker_meta;

    assert!(
        watcher.scan(&input, NOW + 30_001, &mut ok).is_empty(),
        "a re-assignment must clear the prior stopped alert state"
    );
    assert!(watcher.scan(&input, NOW + 60_000, &mut ok).is_empty());
    let sends = watcher.scan(&input, NOW + 60_001, &mut ok);
    assert_eq!(
        sends.len(),
        1,
        "a re-assigned agent still alerts if it remains stopped for its new dwell window"
    );
    assert!(briefing_mentions(&sends[0], "worker"));
}

#[test]
fn same_assignment_bookkeeping_does_not_reset_the_stopped_dwell_window() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, mut worker_meta) = looping_session("worker", "idle");
    let mut input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta.clone() } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 30_000 }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert!(watcher.scan(&input, NOW, &mut ok).is_empty());

    worker_meta["loop"]["updatedBy"] = json!("overseer");
    worker_meta["loop"]["updatedBySessionId"] = json!("boss");
    input["metadata"]["sessions"]["worker"] = worker_meta;

    assert!(watcher.scan(&input, NOW + 29_999, &mut ok).is_empty());
    assert_eq!(
        watcher.scan(&input, NOW + 30_000, &mut ok).len(),
        1,
        "bookkeeping on the same assignment must not mask a genuinely stuck agent"
    );
}

#[test]
fn stopped_agent_still_alerts_while_surrounding_project_is_busy() {
    let (boss, mut boss_meta) = looping_session_with_status("boss", Some("running"), "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session_with_status("worker", Some("running"), "done");
    let (busy, mut busy_meta) =
        looping_session_with_status("busy-agent", Some("running"), "running");
    busy_meta["loop"] = json!({ "active": false });
    let mut input = input_with_config(
        vec![boss.clone(), worker.clone(), busy.clone()],
        json!({ "sessions": {
            "boss": boss_meta.clone(),
            "worker": worker_meta.clone(),
            "busy-agent": busy_meta.clone()
        } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 30_000 }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert!(watcher.scan(&input, NOW, &mut ok).is_empty());

    for offset in [5_000, 15_000, 29_999] {
        input["metadata"]["sessions"]["boss"]["derived"]["activity"] = json!("running");
        input["metadata"]["sessions"]["busy-agent"]["derived"]["activityText"] =
            json!(format!("issued command at {offset}"));
        input["metadata"]["sessions"]["busy-agent"]["progress"] =
            json!({ "current": offset / 5_000, "total": 6 });
        assert!(
            watcher.scan(&input, NOW + offset, &mut ok).is_empty(),
            "unrelated project activity must not restart the worker's stopped dwell"
        );
    }

    let sends = watcher.scan(&input, NOW + 30_000, &mut ok);
    assert_eq!(sends.len(), 1);
    assert!(briefing_mentions(&sends[0], "worker"));
    assert!(!briefing_mentions(&sends[0], "busy-agent"));
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
fn overseer_wakeups_are_per_agent_edges_then_reminded_by_tick_count() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let (second, second_meta) = looping_session("second", "idle");
    let mut input = input_with_config(
        vec![boss.clone(), worker],
        json!({ "sessions": { "boss": boss_meta.clone(), "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0, "unchangedReminderTicks": 4 }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    let first = watcher.scan(&input, NOW, &mut ok);
    assert_eq!(first.len(), 1);
    assert!(briefing_mentions(&first[0], "worker"));
    assert!(watcher.scan(&input, NOW + 1, &mut ok).is_empty());

    input["sessions"] =
        json!([boss, { "id": "worker", "tool": "claude", "worktreePath": "/repo" }, second]);
    input["metadata"]["sessions"]["boss"] = boss_meta;
    input["metadata"]["sessions"]["second"] = second_meta;
    let second_only = watcher.scan(&input, NOW + 2, &mut ok);
    assert_eq!(second_only.len(), 1);
    assert!(!briefing_mentions(&second_only[0], "worker"));
    assert!(briefing_mentions(&second_only[0], "second"));

    input["sessions"] = json!([{ "id": "boss", "tool": "claude" }, {
        "id": "worker",
        "tool": "claude",
        "worktreePath": "/repo"
    }]);
    input["metadata"]["sessions"]
        .as_object_mut()
        .expect("metadata sessions")
        .remove("second");
    assert!(watcher.scan(&input, NOW + 3, &mut ok).is_empty());
    let worker_reminder = watcher.scan(&input, NOW + 4, &mut ok);
    assert_eq!(
        worker_reminder.len(),
        1,
        "a stopped agent should remind only on its own unchanged cadence"
    );
    assert!(briefing_mentions(&worker_reminder[0], "worker"));
    assert!(!briefing_mentions(&worker_reminder[0], "second"));
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
fn one_tick_stopped_flicker_does_not_alert_before_dwell() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, mut worker_meta) = looping_session("worker", "done");
    let mut input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta.clone() } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 30_000 }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert!(watcher.scan(&input, NOW, &mut ok).is_empty());

    worker_meta["derived"]["activity"] = json!("running");
    input["metadata"]["sessions"]["worker"] = worker_meta;
    assert!(
        watcher.scan(&input, NOW + 30_000, &mut ok).is_empty(),
        "one stopped sample inside an active turn must not satisfy dwell"
    );
}

#[test]
fn resuming_one_stopped_agent_clears_only_that_agents_state() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, mut worker_meta) = looping_session("worker", "idle");
    let (second, second_meta) = looping_session("second", "idle");
    let mut input = input_with_config(
        vec![boss, worker.clone(), second],
        json!({ "sessions": {
            "boss": boss_meta,
            "worker": worker_meta.clone(),
            "second": second_meta
        }}),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 30_000, "unchangedReminderTicks": 2 }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert!(watcher.scan(&input, NOW, &mut ok).is_empty());
    let first = watcher.scan(&input, NOW + 30_000, &mut ok);
    assert_eq!(first.len(), 1);
    assert!(briefing_mentions(&first[0], "worker"));
    assert!(briefing_mentions(&first[0], "second"));

    worker_meta["derived"]["activity"] = json!("running");
    input["metadata"]["sessions"]["worker"] = worker_meta.clone();
    assert!(watcher.scan(&input, NOW + 30_001, &mut ok).is_empty());

    let second_reminder = watcher.scan(&input, NOW + 30_002, &mut ok);
    assert_eq!(second_reminder.len(), 1);
    assert!(!briefing_mentions(&second_reminder[0], "worker"));
    assert!(briefing_mentions(&second_reminder[0], "second"));

    worker_meta["derived"]["activity"] = json!("idle");
    input["metadata"]["sessions"]["worker"] = worker_meta;
    assert!(
        watcher.scan(&input, NOW + 30_003, &mut ok).is_empty(),
        "a resumed agent starts a fresh stopped edge without disturbing another agent"
    );
    let later_second_reminder = watcher.scan(&input, NOW + 30_004, &mut ok);
    assert_eq!(later_second_reminder.len(), 1);
    assert!(
        !briefing_mentions(&later_second_reminder[0], "worker"),
        "a resumed agent must not keep its pre-resume reminder counter"
    );
    assert!(briefing_mentions(&later_second_reminder[0], "second"));
}

#[test]
fn sending_an_instruction_resets_only_that_agents_alert_cadence() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, mut worker_meta) = looping_session("worker", "idle");
    let (second, second_meta) = looping_session("second", "idle");
    let mut input = input_with_config(
        vec![boss, worker, second],
        json!({ "sessions": {
            "boss": boss_meta,
            "worker": worker_meta.clone(),
            "second": second_meta
        }}),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 30_000, "unchangedReminderTicks": 2 }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert!(watcher.scan(&input, NOW, &mut ok).is_empty());
    let first = watcher.scan(&input, NOW + 30_000, &mut ok);
    assert_eq!(first.len(), 1);
    assert!(briefing_mentions(&first[0], "worker"));
    assert!(briefing_mentions(&first[0], "second"));

    worker_meta["loopLastAction"] = json!({
        "action": "continue",
        "at": "2026-09-09T00:00:31.000Z",
        "updatedBySessionId": "boss"
    });
    input["metadata"]["sessions"]["worker"] = worker_meta;

    assert!(watcher.scan(&input, NOW + 30_001, &mut ok).is_empty());
    let second_reminder = watcher.scan(&input, NOW + 30_002, &mut ok);
    assert_eq!(second_reminder.len(), 1);
    assert!(!briefing_mentions(&second_reminder[0], "worker"));
    assert!(briefing_mentions(&second_reminder[0], "second"));
    assert!(
        watcher.scan(&input, NOW + 60_000, &mut ok).is_empty(),
        "an instruction starts a fresh dwell before this agent can alert again"
    );
}

#[test]
fn paused_loop_agent_is_removed_from_stopped_reminders_but_summarized_by_cadence() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta.clone() } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
    );
    let pause_key =
        loop_pause_key_from_loop_metadata(&worker_meta["loop"]).expect("active loop pause key");

    let mut watcher = LoopWatcher::new();
    watcher.pause_loop_alerts(
        "worker",
        pause_key,
        NOW,
        LoopAlertPauseProvenance::default(),
    );
    let mut ok = |_: &LoopSend| true;
    for offset in 0..9 {
        assert!(
            watcher.scan(&input, NOW + offset, &mut ok).is_empty(),
            "paused loop agents must not keep sending stopped-agent reminders"
        );
    }
    let sends = watcher.scan(&input, NOW + 10, &mut ok);
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].session_id, "boss");
    assert!(sends[0].text.contains("loop alerts paused"));
    assert!(sends[0].text.contains("worker"));
}

#[test]
fn global_pause_buffers_planned_alerts_instead_of_dropping_them() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    watcher.set_global_pause(NOW, NOW + 60_000, LoopAlertPauseProvenance::default());
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(sends.len(), 1);
    watcher.buffer_send(&sends[0], NOW);
    watcher.commit_send_result(&sends[0], NOW, LoopDeliveryOutcome::Buffered);

    assert_eq!(watcher.buffered_send_count(), 1);
    let record = watcher.last_delivery_record().expect("delivery record");
    assert_eq!(record.outcome, "buffered");
    assert_eq!(record.session_id, "boss");
}

#[test]
fn clearing_global_pause_exposes_buffered_alert_for_delivery() {
    let state_dir = temp_state_dir("global-pause-buffered-delivery");
    let path = loop_watcher_state_path(&state_dir);
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    watcher.set_global_pause(NOW, NOW + 60_000, LoopAlertPauseProvenance::default());
    let sends = watcher.plan_sends(&input, NOW);
    watcher.buffer_send(&sends[0], NOW);
    watcher.commit_send_result(&sends[0], NOW, LoopDeliveryOutcome::Buffered);
    save_loop_watcher_state(&path, &watcher).expect("save buffered pause state");

    let mut watcher = load_loop_watcher_state(&path).expect("load buffered pause state");
    watcher.clear_global_pause();

    let buffered = watcher.buffered_sends_to_deliver(8);
    assert_eq!(buffered.len(), 1);
    assert_eq!(buffered[0].session_id, "boss");
    assert_eq!(buffered[0].text, sends[0].text);
    watcher.commit_send_result(&buffered[0], NOW + 1, LoopDeliveryOutcome::Delivered);
    watcher.remove_buffered_send(&buffered[0]);
    save_loop_watcher_state(&path, &watcher).expect("save delivered pause state");

    let saved: Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("read watcher state"))
            .expect("watcher state json");
    assert_eq!(saved["stoppedSince"][0]["lastAttemptedMs"], json!(NOW + 1));
    assert_eq!(saved["stoppedSince"][0]["lastReportedMs"], json!(NOW + 1));
    assert_eq!(saved["bufferedSends"], json!({}));
}

#[test]
fn global_pause_expiry_resumes_without_human_input_and_keeps_buffered_alert() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    watcher.set_global_pause(NOW, NOW + 10, LoopAlertPauseProvenance::default());
    let sends = watcher.plan_sends(&input, NOW);
    watcher.buffer_send(&sends[0], NOW);
    watcher.commit_send_result(&sends[0], NOW, LoopDeliveryOutcome::Buffered);

    assert!(watcher.is_global_pause_active(NOW + 9));
    assert!(watcher.expire_global_pause(NOW + 11).is_some());
    assert!(!watcher.is_global_pause_active(NOW + 11));
    assert_eq!(watcher.buffered_sends_to_deliver(8).len(), 1);
}

#[test]
fn global_pause_with_no_due_alerts_releases_nothing() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "running");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    watcher.set_global_pause(NOW, NOW + 60_000, LoopAlertPauseProvenance::default());
    assert!(watcher.plan_sends(&input, NOW).is_empty());
    watcher.clear_global_pause();

    assert!(
        watcher.buffered_sends_to_deliver(8).is_empty(),
        "an empty pause window must not manufacture a phantom delivery"
    );
    assert_eq!(watcher.buffered_send_count(), 0);
    assert!(
        watcher.last_delivery_record().is_none(),
        "no delivery record should exist when no alert was buffered"
    );
}

#[test]
fn reconciliation_alerts_once_for_visible_unowned_work_and_idle_capacity_then_respects_cadence() {
    let (boss, mut boss_meta) = looping_session("boss", "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let mut input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({
            "nudgeCooldownMs": 0,
            "stoppedDwellMs": 60_000,
            "reconciliationDwellMs": 0,
            "reconciliationReminderTicks": 2,
            "reconciliationCooldownMs": 0
        }),
    );
    input["runtimeExchange"] = json!({
        "tasks": [{
            "id": "task-1",
            "status": "pending",
            "description": "wire the widget"
        }]
    });

    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].kind, LoopSendKind::Reconciliation);
    assert!(sends[0].text.contains("Runtime-exchange/worklist work"));
    assert!(sends[0].text.contains("external queue files"));
    assert!(sends[0].text.contains("task task-1"));
    assert!(sends[0].text.contains("worker"));
    watcher.commit_send_result(&sends[0], NOW, LoopDeliveryOutcome::Delivered);

    assert!(
        watcher.plan_sends(&input, NOW + 1).is_empty(),
        "unchanged visible work and unchanged idle capacity must not alert every tick"
    );
    assert_eq!(
        watcher.plan_sends(&input, NOW + 2).len(),
        1,
        "configured reconciliation reminder cadence should eventually re-alert"
    );
}

#[test]
fn reconciliation_uses_worklist_needs_you_not_stale_items() {
    let (boss, mut boss_meta) = looping_session("boss", "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let mut input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({
            "nudgeCooldownMs": 0,
            "stoppedDwellMs": 60_000,
            "reconciliationDwellMs": 0,
            "reconciliationReminderTicks": 1,
            "reconciliationCooldownMs": 0
        }),
    );
    input["coordinationWorklist"] = json!({
        "items": [{
            "key": "t:thread-dl7mi65x48t3",
            "kind": "thread",
            "type": "task",
            "bucket": "awake",
            "title": "URGENT: cargo test rewrites Sam's live tmux key bindings",
            "actionable": true,
            "thread": {
                "thread": {
                    "id": "thread-dl7mi65x48t3",
                    "status": "done",
                    "waitingOn": []
                },
                "messages": [{
                    "id": "msg-1",
                    "to": ["claude-gqaapg"],
                    "deliveredTo": ["claude-gqaapg"]
                }],
                "pendingDeliveries": 0
            }
        }],
        "needsYou": [],
        "tail": []
    });

    let mut watcher = LoopWatcher::new();
    assert!(
        watcher.plan_sends(&input, NOW).is_empty(),
        "terminal threads cleared from /coordination-worklist needsYou must not reappear as unassigned reconciliation work"
    );
}

#[test]
fn reconciliation_surfaces_worklist_object_missing_needs_you() {
    let (boss, mut boss_meta) = looping_session("boss", "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let mut input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({
            "nudgeCooldownMs": 0,
            "stoppedDwellMs": 60_000,
            "reconciliationDwellMs": 0,
            "reconciliationReminderTicks": 1,
            "reconciliationCooldownMs": 0
        }),
    );
    input["coordinationWorklist"] = json!({
        "items": [],
        "tail": []
    });

    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].kind, LoopSendKind::Reconciliation);
    assert!(sends[0].text.contains("worklist-contract"));
    assert!(
        sends[0]
            .text
            .contains("coordinationWorklist object missing needsYou")
    );
}

#[test]
fn reconciliation_alerts_for_worklist_needs_you_items() {
    let (boss, mut boss_meta) = looping_session("boss", "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let mut input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({
            "nudgeCooldownMs": 0,
            "stoppedDwellMs": 60_000,
            "reconciliationDwellMs": 0,
            "reconciliationReminderTicks": 1,
            "reconciliationCooldownMs": 0
        }),
    );
    input["coordinationWorklist"] = json!({
        "items": [],
        "needsYou": [{
            "key": "t:thread-open",
            "kind": "thread",
            "type": "task",
            "bucket": "awake",
            "title": "open handoff",
            "actionable": true
        }],
        "tail": []
    });

    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].kind, LoopSendKind::Reconciliation);
    assert!(sends[0].text.contains("thread t:thread-open"));
}

#[test]
fn reconciliation_condition_persists_across_item_churn_until_reminder_cadence() {
    let (boss, mut boss_meta) = looping_session("boss", "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let mut input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({
            "nudgeCooldownMs": 0,
            "stoppedDwellMs": 60_000,
            "reconciliationDwellMs": 0,
            "reconciliationReminderTicks": 3,
            "reconciliationCooldownMs": 0
        }),
    );
    input["runtimeExchange"] = json!({
        "tasks": [
            { "id": "task-1", "status": "pending", "description": "first" },
            { "id": "task-2", "status": "pending", "description": "second" },
            { "id": "task-3", "status": "pending", "description": "third" }
        ]
    });

    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(sends.len(), 1);
    watcher.commit_send_result(&sends[0], NOW, LoopDeliveryOutcome::Delivered);

    input["runtimeExchange"]["tasks"] = json!([
        { "id": "task-2", "status": "pending", "description": "second" },
        { "id": "task-3", "status": "pending", "description": "third" }
    ]);
    assert!(
        watcher.plan_sends(&input, NOW + 1).is_empty(),
        "closing one item is progress under the same reconciliation condition, not a new edge"
    );

    input["runtimeExchange"]["tasks"] = json!([
        { "id": "task-3", "status": "pending", "description": "third" },
        { "id": "task-4", "status": "pending", "description": "new arrival" }
    ]);
    assert!(
        watcher.plan_sends(&input, NOW + 2).is_empty(),
        "item churn while work and capacity still coexist must respect reminder cadence"
    );

    assert_eq!(
        watcher.plan_sends(&input, NOW + 4).len(),
        1,
        "the unchanged reconciliation condition still re-alerts on the documented cadence"
    );
}

#[test]
fn reconciliation_alerts_again_after_condition_fully_clears_and_returns() {
    let (boss, mut boss_meta) = looping_session("boss", "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let mut input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({
            "nudgeCooldownMs": 0,
            "stoppedDwellMs": 60_000,
            "reconciliationDwellMs": 0,
            "reconciliationReminderTicks": 10,
            "reconciliationCooldownMs": 0
        }),
    );
    input["runtimeExchange"] = json!({
        "tasks": [{ "id": "task-1", "status": "pending", "description": "first" }]
    });

    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(sends.len(), 1);
    watcher.commit_send_result(&sends[0], NOW, LoopDeliveryOutcome::Delivered);

    input["runtimeExchange"]["tasks"] = json!([]);
    assert!(
        watcher.plan_sends(&input, NOW + 1).is_empty(),
        "clearing the work clears the reconciliation condition without sending a progress alert"
    );

    input["runtimeExchange"]["tasks"] = json!([
        { "id": "task-2", "status": "pending", "description": "new condition" }
    ]);
    assert_eq!(
        watcher.plan_sends(&input, NOW + 2).len(),
        1,
        "after the condition fully clears, a new work-plus-capacity condition is a fresh edge"
    );
}

#[test]
fn reconciliation_requires_condition_dwell_before_alerting() {
    let (boss, mut boss_meta) = looping_session("boss", "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let mut input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({
            "nudgeCooldownMs": 0,
            "stoppedDwellMs": 60_000,
            "reconciliationDwellMs": 30_000,
            "reconciliationReminderTicks": 10,
            "reconciliationCooldownMs": 0
        }),
    );
    input["runtimeExchange"] = json!({
        "tasks": [{ "id": "task-1", "status": "pending", "description": "first" }]
    });

    let mut watcher = LoopWatcher::new();
    assert!(
        watcher.plan_sends(&input, NOW).is_empty(),
        "a brand-new reconciliation condition must dwell before alerting"
    );
    assert!(watcher.plan_sends(&input, NOW + 29_999).is_empty());
    assert_eq!(watcher.plan_sends(&input, NOW + 30_000).len(), 1);
}

#[test]
fn idle_fleet_alerts_when_visible_work_waits_and_all_workers_are_idle() {
    let (boss, mut boss_meta) = non_loop_session("boss", "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = non_loop_session("worker", "idle");
    let (done_worker, done_meta) =
        self_exited_session_with_status("done-worker", Some("running"), "done");
    let mut input = input_with_config(
        vec![boss, worker, done_worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta, "done-worker": done_meta } }),
        json!({
            "idleFleetDwellMs": 0,
            "idleFleetReminderTicks": 2,
            "idleFleetCooldownMs": 0
        }),
    );
    input["runtimeExchange"] = json!({
        "tasks": [{ "id": "task-1", "status": "pending", "description": "queue up work" }]
    });

    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    let send = sends
        .iter()
        .find(|send| send.kind == LoopSendKind::IdleFleet)
        .unwrap_or_else(|| panic!("idle fleet send missing: {sends:?}"));
    assert!(send.text.contains("fleet appears idle"));
    assert!(send.text.contains("task task-1"));
    assert!(send.text.contains("worker"));
    assert!(send.text.contains("done-worker"));
}

#[test]
fn idle_fleet_alerts_for_work_assigned_to_agent_that_already_stopped() {
    let (boss, mut boss_meta) = non_loop_session("boss", "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = non_loop_session("worker", "done");
    let mut input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({
            "idleFleetDwellMs": 0,
            "idleFleetReminderTicks": 2,
            "idleFleetCooldownMs": 0
        }),
    );
    input["runtimeExchange"] = json!({
        "tasks": [{
            "id": "task-ack",
            "status": "in_progress",
            "assignedTo": "worker",
            "description": "already acked"
        }]
    });

    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    let send = sends
        .iter()
        .find(|send| send.kind == LoopSendKind::IdleFleet)
        .unwrap_or_else(|| panic!("idle fleet send missing: {sends:?}"));
    assert!(send.text.contains("task task-ack"));
    assert!(send.text.contains("assigned-owner-idle"));
}

#[test]
fn idle_fleet_does_not_alert_for_momentary_idle_trough_before_dwell() {
    let (boss, mut boss_meta) = non_loop_session("boss", "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = non_loop_session("worker", "idle");
    let mut input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({
            "idleFleetDwellMs": 30_000,
            "idleFleetReminderTicks": 2,
            "idleFleetCooldownMs": 0
        }),
    );
    input["runtimeExchange"] = json!({
        "tasks": [{ "id": "task-1", "status": "pending", "description": "queue up work" }]
    });

    let mut watcher = LoopWatcher::new();
    assert!(watcher.plan_sends(&input, NOW).is_empty());
    assert!(watcher.plan_sends(&input, NOW + 29_999).is_empty());
    assert_eq!(watcher.plan_sends(&input, NOW + 30_000).len(), 1);
}

#[test]
fn idle_fleet_does_not_alert_when_workers_are_active_or_when_no_work_waits() {
    let (boss, mut boss_meta) = non_loop_session("boss", "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = non_loop_session("worker", "running");
    let mut input = input_with_config(
        vec![boss.clone(), worker],
        json!({ "sessions": { "boss": boss_meta.clone(), "worker": worker_meta } }),
        json!({
            "idleFleetDwellMs": 0,
            "idleFleetReminderTicks": 1,
            "idleFleetCooldownMs": 0
        }),
    );
    input["runtimeExchange"] = json!({
        "tasks": [{ "id": "task-1", "status": "pending", "description": "queue up work" }]
    });

    let mut watcher = LoopWatcher::new();
    assert!(
        watcher.plan_sends(&input, NOW).is_empty(),
        "a genuinely active worker means the fleet is not idle"
    );

    let (idle_worker, idle_meta) = non_loop_session("worker", "idle");
    let no_work_input = input_with_config(
        vec![boss, idle_worker],
        json!({ "sessions": { "boss": boss_meta, "worker": idle_meta } }),
        json!({
            "idleFleetDwellMs": 0,
            "idleFleetReminderTicks": 1,
            "idleFleetCooldownMs": 0
        }),
    );
    assert!(
        watcher.plan_sends(&no_work_input, NOW + 1).is_empty(),
        "an idle fleet with nothing visible to do must stay quiet"
    );
}

#[test]
fn idle_fleet_reminder_respects_unchanged_level_cadence() {
    let (boss, mut boss_meta) = non_loop_session("boss", "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = non_loop_session("worker", "idle");
    let mut input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({
            "idleFleetDwellMs": 0,
            "idleFleetReminderTicks": 2,
            "idleFleetCooldownMs": 0
        }),
    );
    input["runtimeExchange"] = json!({
        "tasks": [{ "id": "task-1", "status": "pending", "description": "queue up work" }]
    });

    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].kind, LoopSendKind::IdleFleet);
    watcher.commit_send_result(&sends[0], NOW, LoopDeliveryOutcome::Delivered);

    assert!(
        watcher.plan_sends(&input, NOW + 1).is_empty(),
        "unchanged idle-fleet level must not fire every tick"
    );
    let reminder = watcher.plan_sends(&input, NOW + 2);
    assert_eq!(reminder.len(), 1);
    assert_eq!(reminder[0].kind, LoopSendKind::IdleFleet);
}

#[test]
fn reconciliation_does_not_alert_for_unowned_work_without_idle_capacity() {
    let (boss, mut boss_meta) = looping_session("boss", "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, mut worker_meta) = looping_session("worker", "running");
    worker_meta["derived"] = json!({ "activity": "running", "attention": "normal" });
    let mut input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({
            "nudgeCooldownMs": 0,
            "stoppedDwellMs": 0,
            "reconciliationReminderTicks": 1,
            "reconciliationCooldownMs": 0
        }),
    );
    input["runtimeExchange"] = json!({
        "tasks": [{
            "id": "task-1",
            "status": "pending",
            "description": "wire the widget"
        }]
    });

    let mut watcher = LoopWatcher::new();
    assert!(
        watcher.plan_sends(&input, NOW).is_empty(),
        "unowned visible work alone is not enough; reconciliation needs idle watched capacity"
    );
}

#[test]
fn unpausing_loop_alerts_restores_stopped_agent_reminders() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta.clone() } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
    );
    let pause_key =
        loop_pause_key_from_loop_metadata(&worker_meta["loop"]).expect("active loop pause key");

    let mut watcher = LoopWatcher::new();
    watcher.pause_loop_alerts(
        "worker",
        pause_key,
        NOW,
        LoopAlertPauseProvenance::default(),
    );
    assert!(watcher.unpause_loop_alerts("worker").is_some());
    let mut ok = |_: &LoopSend| true;
    assert_eq!(watcher.scan(&input, NOW + 1, &mut ok).len(), 1);
}

#[test]
fn stale_pause_for_recycled_session_id_is_gc_d_and_does_not_mute_new_loop_episode() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, mut worker_meta) = looping_session("worker", "idle");
    let old_pause_key =
        loop_pause_key_from_loop_metadata(&worker_meta["loop"]).expect("active loop pause key");
    worker_meta["loop"]["since"] = json!("2026-09-09T00:01:00.000Z");
    worker_meta["loop"]["goal"] = json!("different work");
    worker_meta["loop"]["source"] = json!("task");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    watcher.pause_loop_alerts(
        "worker",
        old_pause_key,
        NOW,
        LoopAlertPauseProvenance::default(),
    );
    let mut ok = |_: &LoopSend| true;
    assert_eq!(
        watcher.scan(&input, NOW + 1, &mut ok).len(),
        1,
        "a stale pause from an older loop episode must not mute a recycled session id"
    );
    assert!(watcher.paused_loop_alert("worker").is_none());
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

#[test]
fn a_looped_agent_that_dies_raises_a_dead_loop_check_after_dwell() {
    let (boss, mut boss_meta) = looping_session_with_status("boss", Some("running"), "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session_with_status("worker", Some("offline"), "running");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({
            "nudgeCooldownMs": 0,
            "stoppedDwellMs": 30_000,
            "unchangedReminderTicks": 2
        }),
    );

    let mut watcher = LoopWatcher::new();
    assert!(
        watcher.plan_sends(&input, NOW).is_empty(),
        "a death candidate must continuously dwell before the overseer is alerted"
    );
    assert!(watcher.plan_sends(&input, NOW + 29_999).is_empty());

    let sends = watcher.plan_sends(&input, NOW + 30_000);
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].session_id, "boss");
    assert_eq!(sends[0].kind, LoopSendKind::OverseerBriefing);
    assert!(briefing_mentions(&sends[0], "worker"));
    assert!(sends[0].text.contains("[dead/offline]"));
    assert!(sends[0].text.contains("dead/offline agent"));
    assert!(!sends[0].text.contains("[completed/self-reported]"));
    assert!(!sends[0].text.contains("[stopped/idle]"));
    watcher.commit_send_result(&sends[0], NOW + 30_000, LoopDeliveryOutcome::Delivered);

    assert!(
        watcher.plan_sends(&input, NOW + 30_001).is_empty(),
        "an unchanged dead candidate must not alert on every tick"
    );
    assert_eq!(
        watcher.plan_sends(&input, NOW + 30_002).len(),
        1,
        "dead candidates reuse the stopped reminder cadence after the initial report"
    );
}

#[test]
fn a_looped_agent_that_is_idle_raises_a_distinct_stopped_loop_check() {
    let (boss, mut boss_meta) = looping_session_with_status("boss", Some("running"), "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session_with_status("worker", Some("idle"), "idle");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(sends.len(), 1);
    assert!(briefing_mentions(&sends[0], "worker"));
    assert!(sends[0].text.contains("appear to have stopped:"));
    assert!(
        sends[0]
            .text
            .contains("decide whether it stopped prematurely")
    );
    assert!(!sends[0].text.contains("[dead/offline]"));
    assert!(!sends[0].text.contains("dead/offline agent"));
    assert!(!sends[0].text.contains("[completed/self-reported]"));
    assert!(!sends[0].text.contains("self-reported a loop exit"));
}

#[test]
fn a_looped_agent_that_self_reports_done_raises_completion_notification_once() {
    let state_dir = temp_state_dir("self-reported-done");
    let path = loop_watcher_state_path(&state_dir);
    let (boss, mut boss_meta) = looping_session_with_status("boss", Some("running"), "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = self_exited_session_with_status("worker", Some("offline"), "done");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0, "unchangedReminderTicks": 1 }),
    );

    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].session_id, "boss");
    assert_eq!(sends[0].kind, LoopSendKind::LoopExit);
    assert!(briefing_mentions(&sends[0], "worker"));
    assert!(sends[0].text.contains("self-reported a loop exit"));
    assert!(sends[0].text.contains("[completed/self-reported]"));
    assert!(sends[0].text.contains("self-reported done"));
    assert!(sends[0].text.contains("goal: ship it"));
    assert!(!sends[0].text.contains("[dead/offline]"));
    assert!(!sends[0].text.contains("appear to have stopped:"));
    watcher.commit_send_result(&sends[0], NOW, LoopDeliveryOutcome::Delivered);

    assert!(
        watcher.plan_sends(&input, NOW + 1).is_empty(),
        "self-reported completion is an edge and must not repeat on the next scan"
    );
    assert!(
        watcher.plan_sends(&input, NOW + 60_000).is_empty(),
        "self-reported completion must not use the unchanged stopped/dead reminder cadence"
    );
    save_loop_watcher_state(&path, &watcher).expect("save loop exit edge state");
    let mut restarted = load_loop_watcher_state(&path).expect("reload loop exit edge state");
    assert!(
        restarted.plan_sends(&input, NOW + 60_001).is_empty(),
        "self-reported completion must stay one-shot after watcher state reload"
    );
    let _ = fs::remove_dir_all(state_dir);
}

#[test]
fn spooled_loop_self_report_replay_with_same_report_id_does_not_re_notify() {
    let (boss, mut boss_meta) = looping_session_with_status("boss", Some("running"), "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, mut worker_meta) =
        self_exited_session_with_status("worker", Some("offline"), "done");
    worker_meta["loopLastAction"]["reportId"] = json!("loop-self-report-123");
    let input = input_with_config(
        vec![boss.clone(), worker.clone()],
        json!({ "sessions": { "boss": boss_meta.clone(), "worker": worker_meta.clone() } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].kind, LoopSendKind::LoopExit);
    assert!(briefing_mentions(&sends[0], "worker"));
    watcher.commit_send_result(&sends[0], NOW, LoopDeliveryOutcome::Delivered);

    worker_meta["loopLastAction"]["at"] = json!("2026-09-09T00:11:00.000Z");
    let replayed = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
    );
    assert!(
        watcher.plan_sends(&replayed, NOW + 1).is_empty(),
        "a spooled replay of an already-surfaced report must deliver state without re-notifying"
    );
}

#[test]
fn self_report_that_first_surfaces_on_replay_notifies_once() {
    let (boss, mut boss_meta) = looping_session_with_status("boss", Some("running"), "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, mut worker_meta) =
        self_exited_session_with_status("worker", Some("offline"), "done");
    worker_meta["loopLastAction"]["reportId"] = json!("loop-self-report-replayed");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].kind, LoopSendKind::LoopExit);
    assert!(sends[0].text.contains("self-reported done"));
    watcher.commit_send_result(&sends[0], NOW, LoopDeliveryOutcome::Delivered);
    assert!(
        watcher.plan_sends(&input, NOW + 1).is_empty(),
        "the first successful surface of a replayed report must remain one-shot"
    );
}

#[test]
fn self_report_with_indeterminate_surface_identity_still_notifies_on_replay() {
    let (boss, mut boss_meta) = looping_session_with_status("boss", Some("running"), "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, mut worker_meta) =
        self_exited_session_with_status("worker", Some("offline"), "done");
    let input = input_with_config(
        vec![boss.clone(), worker.clone()],
        json!({ "sessions": { "boss": boss_meta.clone(), "worker": worker_meta.clone() } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(sends.len(), 1);
    watcher.commit_send_result(&sends[0], NOW, LoopDeliveryOutcome::Delivered);

    worker_meta["loopLastAction"]["at"] = json!("2026-09-09T00:11:00.000Z");
    let replayed = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
    );
    let replay_sends = watcher.plan_sends(&replayed, NOW + 1);
    assert_eq!(replay_sends.len(), 1);
    assert_eq!(replay_sends[0].kind, LoopSendKind::LoopExit);
    assert!(
        replay_sends[0].text.contains("self-reported done"),
        "without a stable reportId the watcher cannot prove this was surfaced, so it must notify"
    );
}

#[test]
fn a_looped_agent_that_self_reports_block_raises_blocked_notification_once() {
    let (boss, mut boss_meta) = looping_session_with_status("boss", Some("running"), "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = self_exited_session_with_status("worker", Some("running"), "block");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].kind, LoopSendKind::LoopExit);
    assert!(briefing_mentions(&sends[0], "worker"));
    assert!(sends[0].text.contains("[blocked/self-reported]"));
    assert!(sends[0].text.contains("self-reported block"));
    assert!(sends[0].text.contains("For each blocked agent"));
    watcher.commit_send_result(&sends[0], NOW, LoopDeliveryOutcome::Delivered);
    assert!(watcher.plan_sends(&input, NOW + 1).is_empty());
}

#[test]
fn a_momentary_offline_blip_must_not_report_death_before_dwell() {
    let (boss, mut boss_meta) = looping_session_with_status("boss", Some("running"), "busy");
    boss_meta["overseer"] = json!(true);
    let (offline_worker, worker_meta) =
        looping_session_with_status("worker", Some("offline"), "running");
    let (running_worker, _) = looping_session_with_status("worker", Some("running"), "running");
    let metadata = json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } });
    let config = json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 30_000 });

    let mut watcher = LoopWatcher::new();
    let offline_input = input_with_config(
        vec![boss.clone(), offline_worker.clone()],
        metadata.clone(),
        config.clone(),
    );
    assert!(watcher.plan_sends(&offline_input, NOW).is_empty());

    let recovered_input = input_with_config(
        vec![boss.clone(), running_worker],
        metadata.clone(),
        config.clone(),
    );
    assert!(
        watcher.plan_sends(&recovered_input, NOW + 10).is_empty(),
        "recovering before dwell should clear the death level"
    );

    let offline_again = input_with_config(vec![boss, offline_worker], metadata, config);
    assert!(
        watcher.plan_sends(&offline_again, NOW + 30_000).is_empty(),
        "a later offline blip starts a fresh dwell window instead of inheriting the cleared one"
    );
}

#[test]
fn indeterminate_liveness_does_not_silently_become_dead() {
    let (boss, mut boss_meta) = looping_session_with_status("boss", Some("running"), "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session_with_status("worker", None, "running");
    let (completed_worker, completed_worker_meta) =
        self_exited_session_with_status("completed-worker", None, "done");
    let input = input_with_config(
        vec![boss, worker, completed_worker],
        json!({ "sessions": {
            "boss": boss_meta,
            "worker": worker_meta,
            "completed-worker": completed_worker_meta
        } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    assert!(
        watcher.plan_sends(&input, NOW).is_empty(),
        "missing liveness is a third outcome, not an offline/dead or completed candidate"
    );
}

#[test]
fn scan_records_capture_decisions_without_a_delivery_attempt() {
    let (boss, mut boss_meta) = looping_session_with_status("boss", Some("running"), "busy");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session_with_status("worker", Some("running"), "running");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    watcher.record_scan_result(
        &input,
        NOW,
        &sends,
        vec![LoopScanIndeterminate {
            session_id: "probe-failed".into(),
            reason: "read live activity failed".into(),
        }],
    );

    let record = watcher.last_scan_record().expect("scan record");
    assert_eq!(record.raw_candidate_count, 0);
    assert_eq!(record.planned_send_count, 0);
    assert_eq!(record.indeterminate.len(), 1);
    assert_eq!(record.indeterminate[0].session_id, "probe-failed");

    let state = watcher.loop_alert_state(NOW);
    assert_eq!(state["recentScans"][0]["plannedSendCount"], 0);
    assert_eq!(
        state["recentScans"][0]["indeterminate"][0]["reason"],
        "read live activity failed"
    );
}

mod task_inputs {
    use aimux::project_service::loop_watcher_task::{
        LOOP_WATCH_SESSION_STATUSES, NUDGEABLE_SESSION_STATUSES, apply_live_activity_override,
        build_scan_input, is_scribe, mark_live_activity_indeterminate,
    };
    use serde_json::json;

    #[test]
    fn loop_watcher_sees_offline_sessions_but_does_not_treat_them_as_nudgeable() {
        // The scan input needs offline sessions as data so death can be
        // reported, but delivery targets still require a live window.
        assert_eq!(
            LOOP_WATCH_SESSION_STATUSES,
            ["starting", "running", "idle", "offline"]
        );
        assert!(LOOP_WATCH_SESSION_STATUSES.contains(&"offline"));
        assert!(!LOOP_WATCH_SESSION_STATUSES.contains(&"graveyard"));
        assert!(!LOOP_WATCH_SESSION_STATUSES.contains(&"exited"));

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

        let input = build_scan_input(sessions, &metadata, &[], json!({}), json!({}), json!([]));
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
        let input = build_scan_input(
            vec![],
            &json!({}),
            &pending,
            json!({}),
            json!({}),
            json!([]),
        );
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
            json!({}),
            json!([]),
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
            json!({}),
            json!([]),
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

    #[test]
    fn live_activity_probe_failure_makes_only_that_session_indeterminate() {
        use aimux::loop_watcher::{LoopSend, LoopWatcher};

        let mut boss_meta = json!({
            "overseer": true,
            "derived": { "activity": "busy", "attention": "normal" }
        });
        boss_meta["loop"] = json!({ "active": false });
        let metadata = json!({ "sessions": {
            "boss": boss_meta,
            "probe-failed": {
                "loop": { "active": true, "since": "2026-09-09T00:00:00.000Z", "goal": "stale candidate" },
                "derived": { "activity": "done", "attention": "normal" }
            },
            "worker": {
                "loop": { "active": true, "since": "2026-09-09T00:00:00.000Z", "goal": "ship it" },
                "derived": { "activity": "done", "attention": "normal" }
            }
        }});
        let mut input = build_scan_input(
            vec![
                json!({ "id": "boss", "tool": "claude", "status": "running" }),
                json!({ "id": "probe-failed", "tool": "codex", "status": "running" }),
                json!({ "id": "worker", "tool": "codex", "status": "running" }),
            ],
            &metadata,
            &[],
            json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
            json!({}),
            json!([]),
        );

        mark_live_activity_indeterminate(&mut input, "probe-failed", "read live activity failed");

        let mut watcher = LoopWatcher::new();
        let mut ok = |_: &LoopSend| true;
        let sends = watcher.scan(&input, super::NOW, &mut ok);
        assert_eq!(sends.len(), 1);
        assert!(sends[0].text.contains("- worker"));
        assert!(!sends[0].text.contains("probe-failed"));
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
