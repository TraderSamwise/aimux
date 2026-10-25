use aimux::loop_watcher::{
    LoopAlertPauseProvenance, LoopDeliveryOutcome, LoopScanIndeterminate, LoopSend, LoopSendKind,
    LoopWatcher, load_loop_watcher_state, loop_pause_key_from_loop_metadata,
    loop_watcher_state_path, save_loop_watcher_state,
};
use aimux::project_service::loop_watcher_task::{
    DEFAULT_RECIPIENT_WAKE_FLOOR_MS, DEFAULT_SCAN_INTERVAL_MS, DEFAULT_STOPPED_DWELL_MS,
    DEFAULT_UNCHANGED_REMINDER_TICKS,
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
    let (boss, boss_meta) = non_loop_session("boss", "idle");
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
    let (boss, boss_meta) = non_loop_session("boss", "idle");
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
    let (boss, boss_meta) = non_loop_session("boss", "idle");
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
fn aggregate_cooldowns_reset_for_recipient_state_with_a_fresh_dwell_window() {
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

    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
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
        "new recipient state must establish its own stopped dwell window"
    );
    assert_eq!(
        watcher.scan(&input, NOW + 30_001, &mut ok).len(),
        1,
        "the old aggregate cooldown cannot suppress a recipient after its new dwell window"
    );
}

#[test]
fn a_new_stopped_agent_still_alerts_immediately_after_a_failed_attempt() {
    let (boss, boss_meta) = non_loop_session("boss", "idle");
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
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
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
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
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
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
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
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
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
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
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
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
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
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
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
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
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
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
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
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
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
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
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
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
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
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
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
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
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
    assert_eq!(
        saved["recipientWatchers"]["boss"]["stoppedSince"][0]["lastAttemptedMs"],
        json!(NOW + 1)
    );
    assert_eq!(
        saved["recipientWatchers"]["boss"]["stoppedSince"][0]["lastReportedMs"],
        json!(NOW + 1)
    );
    assert_eq!(
        saved["recipientWatchers"]["boss"]["bufferedSends"],
        json!({})
    );
}

#[test]
fn global_pause_expiry_resumes_without_human_input_and_keeps_buffered_alert() {
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
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
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
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

// `task assign` sets the thread's owner and waitingOn to the assignee, but only
// a notification row carries `sessionId`. Reading its absence as unowned made
// the overseer's own assigned task threads come back at it as unowned work.
#[test]
fn an_assigned_task_thread_is_not_reported_as_unowned_work() {
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
    let worklist_item = |owner: &str| {
        json!({
            "key": "t:thread-assigned",
            "kind": "thread",
            "type": "task",
            "bucket": "awake",
            "title": "Task: wire the widget",
            "actionable": true,
            "thread": {
                "thread": {
                    "id": "thread-assigned",
                    "status": "waiting",
                    "owner": owner,
                    "waitingOn": [owner]
                },
                "messages": [],
                "pendingDeliveries": 1
            }
        })
    };

    input["coordinationWorklist"] = json!({
        "items": [worklist_item("worker")],
        "needsYou": [worklist_item("worker")],
        "tail": []
    });
    let mut watcher = LoopWatcher::new();
    assert!(
        watcher.plan_sends(&input, NOW).is_empty(),
        "a thread owned by a live agent is that agent's work, not unowned work"
    );

    // The inverse: an owner that is not in the fleet is still a real gap.
    input["coordinationWorklist"] = json!({
        "items": [worklist_item("ghost")],
        "needsYou": [worklist_item("ghost")],
        "tail": []
    });
    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].kind, LoopSendKind::Reconciliation);
    assert!(
        sends[0].text.contains("thread-assigned"),
        "a thread whose owner is gone must still surface: {}",
        sends[0].text
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
    assert!(sends[0].text.contains("Work inventory unavailable"));
    assert!(!sends[0].text.contains("Visible unowned work:"));
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
            "actionable": true,
            "thread": {"thread": {"id": "thread-open", "status": "open"}}
        }],
        "tail": []
    });

    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(sends.len(), 1);
    assert_eq!(sends[0].kind, LoopSendKind::Reconciliation);
    assert!(sends[0].text.contains("thread thread-open"));
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
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
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
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
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

/// A pause survives an edit to the agent's goal.
///
/// The key was `since\ngoal\nsource`, and `gc_stale_pauses` DELETES a pause
/// whose key no longer matches — so editing a paused agent's goal did not just
/// stop the pause applying, it erased the record, and the alerts came back with
/// nothing left to say why. `since` is the deliberate re-add, which is the only
/// thing that should end a pause.
#[test]
fn editing_a_paused_agents_goal_does_not_erase_the_pause() {
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let pause_key =
        loop_pause_key_from_loop_metadata(&worker_meta["loop"]).expect("active loop pause key");

    let mut watcher = LoopWatcher::new();
    watcher.pause_loop_alerts(
        "worker",
        pause_key,
        NOW,
        LoopAlertPauseProvenance::default(),
    );

    // The overseer gives the same loop a new goal. Same `since`: nobody re-added
    // the agent, the work it is doing was just described differently.
    let mut edited_meta = worker_meta.clone();
    edited_meta["loop"]["goal"] = json!("Y4 quiet run");
    let input = input_with_config(
        vec![boss.clone(), worker.clone()],
        json!({ "sessions": { "boss": boss_meta.clone(), "worker": edited_meta } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
    );

    // Nine, not ten: the paused-summary cadence fires on the tenth tick and
    // that send is the pause working, not a regression.
    let mut ok = |_: &LoopSend| true;
    for offset in 0..9 {
        assert!(
            watcher.scan(&input, NOW + offset, &mut ok).is_empty(),
            "a goal edit is not a re-add, so the pause must still hold"
        );
    }
}

/// And a genuine re-add does end it.
#[test]
fn re_adding_a_paused_agent_to_the_loop_ends_the_pause() {
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let pause_key =
        loop_pause_key_from_loop_metadata(&worker_meta["loop"]).expect("active loop pause key");

    let mut watcher = LoopWatcher::new();
    watcher.pause_loop_alerts(
        "worker",
        pause_key,
        NOW,
        LoopAlertPauseProvenance::default(),
    );

    let mut readded_meta = worker_meta.clone();
    readded_meta["loop"]["since"] = json!("2099-01-01T00:00:00.000Z");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": readded_meta } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
    );

    let mut ok = |_: &LoopSend| true;
    let sends = watcher.scan(&input, NOW, &mut ok);
    assert!(
        sends.iter().any(|send| send.text.contains("worker")),
        "putting the agent back on the loop is the one thing that ends its pause: {sends:#?}"
    );
}

/// The overseer's launch brief has to name the channel that starts a turn.
///
/// It listed `aimux task assign` beside `aimux spawn` under "start and
/// coordinate agents", which reads like delivery. It is not: the task is a
/// durable record and the agent sits at its prompt until something sends it
/// input. That wording is what left three codex agents idle on strix while the
/// overseer believed it had dispatched them.
#[test]
fn the_overseer_brief_says_which_command_starts_a_turn() {
    let brief = aimux::session_bootstrap::overseer_launch_preamble();

    assert!(
        brief.contains("NONE of these start a turn"),
        "the brief must say a task record is not delivery: {brief}"
    );
    assert!(
        brief.contains("`aimux input`"),
        "and must name the command that is: {brief}"
    );
    assert!(
        !brief
            .contains("`aimux task assign`, `aimux message send`, `aimux handoff send` -\n  start"),
        "task assign must not be listed as a way to start an agent"
    );
}

/// And it has to offer the lighter alternative to forgetting the agent.
///
/// `aimux loop pause` shipped months ago and the brief never mentioned it, so
/// the only move an overseer knew for "stop telling me about this one" was
/// `loop remove`, which forgets the agent entirely.
#[test]
fn the_overseer_brief_offers_pausing_instead_of_forgetting() {
    let brief = aimux::session_bootstrap::overseer_launch_preamble();

    assert!(
        brief.contains("aimux loop pause"),
        "the brief must mention pausing: {brief}"
    );
    assert!(
        brief.contains("WITHOUT unwatching"),
        "and say what makes it different from removing: {brief}"
    );
    assert!(
        brief.contains("DELIVERING work un-pauses it automatically"),
        "and that delivered work brings it back on its own: {brief}"
    );
    // `clear_loop_alert_pause_for_work` is called from
    // `deliver_prompt_to_recipients`, so a task with no prompt never reaches
    // it. The brief has to say that rather than imply any task will do -- a
    // brief that overclaims is the defect this change is fixing.
    assert!(
        brief.contains("A task with no prompt leaves it paused"),
        "and must not promise an un-pause the delivery path does not do: {brief}"
    );
}

/// A pause written before the key shrank still holds after the upgrade.
///
/// `gc_stale_pauses` DELETES a pause whose key no longer matches, and every
/// pause already on disk is `since\ngoal\nsource`. Without the migration,
/// upgrading would silently drop every live pause on the first scan — alerts
/// returning for agents somebody deliberately quieted, which is the bug this
/// change exists to fix, caused by the fix.
#[test]
fn a_pause_written_before_the_key_shrank_survives_the_upgrade() {
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let since = worker_meta["loop"]["since"].as_str().expect("a loop since");

    let directory =
        std::env::temp_dir().join(format!("aimux-pause-migration-{}", std::process::id()));
    std::fs::create_dir_all(&directory).expect("state dir");
    let path = aimux::loop_watcher::loop_watcher_state_path(&directory);

    let mut watcher = LoopWatcher::new();
    // The old shape, exactly as it sits in a file written by the last build.
    watcher.pause_loop_alerts(
        "worker",
        format!("{since}\nship the Y4 run\noverseer"),
        NOW,
        LoopAlertPauseProvenance::default(),
    );
    aimux::loop_watcher::save_loop_watcher_state(&path, &watcher).expect("save");

    let mut reloaded = load_loop_watcher_state(&path).expect("load");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
    );
    // Nine for the same reason as above: the tenth tick is the paused summary.
    let mut ok = |_: &LoopSend| true;
    for offset in 0..9 {
        assert!(
            reloaded.scan(&input, NOW + offset, &mut ok).is_empty(),
            "a pause from the previous build must not be dropped by the upgrade"
        );
    }

    let _ = std::fs::remove_dir_all(&directory);
}

/// The two pause keys are one decision spelled twice, so they are pinned
/// against each other rather than one test each.
///
/// They drifted apart once already — both carried `goal` and `source`, and the
/// doc for one of them cited this test before it existed.
#[test]
fn the_two_pause_keys_agree_for_an_active_loop() {
    let (_, meta) = looping_session("worker", "idle");
    let from_metadata =
        loop_pause_key_from_loop_metadata(&meta["loop"]).expect("an active loop has a key");

    // What a scan candidate carries for the same agent.
    let candidate = json!({
        "id": "worker",
        "loopSince": meta["loop"]["since"],
        "goal": meta["loop"]["goal"],
        "loopSource": "overseer",
    });
    assert_eq!(
        aimux::loop_watcher::loop_pause_key_from_candidate(&candidate),
        Some(from_metadata.clone()),
        "a candidate and its metadata must name the same pause"
    );

    // A goal or a source the candidate does not share must not change it.
    let other_goal = json!({
        "id": "worker",
        "loopSince": meta["loop"]["since"],
        "goal": "something else entirely",
        "loopSource": "human",
    });
    assert_eq!(
        aimux::loop_watcher::loop_pause_key_from_candidate(&other_goal),
        Some(from_metadata),
        "only the re-add signal is part of the key"
    );

    // Where they deliberately differ: the metadata side also refuses an
    // inactive loop, which a candidate has no way to say.
    let mut inactive = meta["loop"].clone();
    inactive["active"] = json!(false);
    assert_eq!(loop_pause_key_from_loop_metadata(&inactive), None);
}

/// Editing a paused agent's goal does not prompt the overseer.
///
/// PR 396 decided that only `loopSince` defines a pause -- editing a paused
/// agent's goal must not un-pause it, because `since` is the deliberate re-add
/// signal. That fixed `extract_paused_candidates` and left the paused-summary
/// signature behind: it was built from `candidate_signature`, which includes
/// the goal, so a goal edit flipped it, `due_by_change` fired, and the overseer
/// got an immediate summary about a set that had not changed. The same noise
/// the pause was supposed to stop, arriving through the other door.
///
/// The ten scans first are load-bearing. `due_by_change` requires a PREVIOUS
/// signature, and the early return on the first scans never records one -- only
/// a cadence send does. A version of this test without them passed with the fix
/// removed, because nothing could have fired either way.
#[test]
fn editing_a_paused_agents_goal_does_not_prompt_the_overseer() {
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, mut worker_meta) = looping_session("worker", "idle");
    let mut input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta.clone() } }),
        json!({ "nudgeCooldownMs": 60_000, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    let pause_key =
        loop_pause_key_from_loop_metadata(&worker_meta["loop"]).expect("active loop pause key");
    watcher.pause_loop_alerts(
        "worker",
        pause_key,
        NOW,
        LoopAlertPauseProvenance::default(),
    );

    // Ten scans so the cadence summary goes out once and records the signature
    // that `due_by_change` compares against.
    let mut cadence_sends = 0;
    for tick in 0..10 {
        cadence_sends += watcher.scan(&input, NOW + tick, &mut ok).len();
    }
    assert_eq!(
        cadence_sends, 1,
        "the cadence summary has to have gone out, or there is no signature to change"
    );

    // Now the goal is edited. The pause stands -- that is PR 396 -- so the set
    // of paused agents has not changed and the overseer has nothing to hear.
    worker_meta["loop"]["goal"] = json!("ship something else entirely");
    input["metadata"]["sessions"]["worker"] = worker_meta;
    assert!(
        watcher.scan(&input, NOW + 11, &mut ok).is_empty(),
        "a goal edit on a paused agent must not summon the overseer"
    );
}

/// But a change to WHICH agents are paused still does.
///
/// The signature is narrowed, not removed: the summary exists so the overseer
/// learns when the paused set moves, and taking one of two off the hold is
/// exactly that.
#[test]
fn a_change_to_the_paused_set_still_reaches_the_overseer() {
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (a, a_meta) = looping_session("agent-a", "idle");
    let (b, b_meta) = looping_session("agent-b", "idle");
    let (c, c_meta) = looping_session("agent-c", "idle");
    let (a_kept, b_kept, c_kept) = (a_meta.clone(), b_meta.clone(), c_meta.clone());
    let input = input_with_config(
        vec![boss, a, b, c],
        json!({ "sessions": {
            "boss": boss_meta,
            "agent-a": a_meta,
            "agent-b": b_meta,
            "agent-c": c_meta,
        }}),
        json!({ "nudgeCooldownMs": 60_000, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    for (id, meta) in [("agent-a", &a_kept), ("agent-b", &b_kept)] {
        let _ = &c_kept;
        let pause_key =
            loop_pause_key_from_loop_metadata(&meta["loop"]).expect("active loop pause key");
        watcher.pause_loop_alerts(id, pause_key, NOW, LoopAlertPauseProvenance::default());
    }
    // The same guard test one carries: without it, a cadence that stopped
    // firing here would leave ticks at eleven on the final scan, which passes
    // via `due_by_cadence` and proves nothing about the signature.
    // Counting only the paused summary: `agent-c` is a live stopped candidate
    // during the warm-up, so it draws briefings of its own.
    let mut cadence_summaries = 0;
    for tick in 0..10 {
        cadence_summaries += watcher
            .scan(&input, NOW + tick, &mut ok)
            .iter()
            .filter(|send| send.kind == LoopSendKind::PausedSummary)
            .count();
    }
    assert_eq!(
        cadence_summaries, 1,
        "the cadence summary has to have gone out, or there is no signature to change"
    );

    // The hold MOVES rather than shrinking: b comes off, c goes on. Same number
    // of paused agents, different agents -- which is the case that tells whether
    // the signature knows who is paused or only how many. A signature built
    // without the id passes a shrinking set and fails this.
    watcher.unpause_loop_alerts("agent-b");
    let pause_key =
        loop_pause_key_from_loop_metadata(&c_kept["loop"]).expect("active loop pause key");
    watcher.pause_loop_alerts(
        "agent-c",
        pause_key,
        NOW,
        LoopAlertPauseProvenance::default(),
    );
    let sends = watcher.scan(&input, NOW + 11, &mut ok);
    assert!(
        sends
            .iter()
            .any(|send| send.kind == LoopSendKind::PausedSummary),
        "the overseer has to hear that the hold moved: {sends:?}"
    );
}

/// An upgrade does not fire one spurious paused summary.
///
/// `last_paused_summary_signature` is persisted, so narrowing what goes into
/// the signature changes what a stored one means. Without a format marker the
/// first scan after an upgrade compares an old-format signature against a new
/// one, finds them different, fires `due_by_change`, and prompts the overseer
/// about a set that has not changed -- exactly the noise this change removes,
/// arriving at upgrade time. The same trap PR 396's own review caught in the
/// pause keys.
#[test]
fn an_old_format_paused_signature_does_not_fire_on_upgrade() {
    let state_dir = temp_state_dir("paused-signature-upgrade");
    let path = loop_watcher_state_path(&state_dir);
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta.clone() } }),
        json!({ "nudgeCooldownMs": 60_000, "stoppedDwellMs": 0 }),
    );

    // A state file written by the previous build: the signature carries the old
    // `paused:` shape, with the goal in it.
    fs::create_dir_all(&state_dir).expect("state dir");
    fs::write(
        &path,
        serde_json::to_string(&json!({
            "version": 1,
            "lastNudgeAt": {},
            "lastOverseerWakeAt": 0,
            "stoppedSince": [],
            "pendingSendKeys": {},
            "pausedLoopAlerts": {
                "worker": {
                    "pausedAtMs": NOW,
                    "loopKey": "2026-09-09T00:00:00.000Z",
                }
            },
            // Zero, so the CADENCE cannot fire on the scan below and
            // `due_by_change` is the only thing that could -- which is what
            // this test is about. Nine made the cadence fire and proved nothing.
            "pausedSummaryTicks": 0,
            "lastPausedSummarySignature":
                "paused:worker\u{1f}\u{1f}2026-09-09T00:00:00.000Z\u{1f}\u{1f}ship it\u{1f}",
        }))
        .expect("serialize legacy state"),
    )
    .expect("write legacy state");

    let mut restarted = load_loop_watcher_state(&path).expect("load legacy state");
    let mut ok = |_: &LoopSend| true;

    // The stored signature is dropped as unreadable rather than compared, so
    // this reads as "no previous signature" and says nothing. Kept and compared,
    // it differs from the new format and `due_by_change` fires.
    assert!(
        restarted.scan(&input, NOW + 1, &mut ok).is_empty(),
        "an upgrade must not prompt the overseer about an unchanged paused set"
    );
}

/// Sam asked for a goal on "any agent type overseer or anything". The overseer
/// used to be excluded from the scan outright, so it was the one agent that
/// could not hold one.
#[test]
fn an_overseer_with_its_own_goal_is_nudged_about_it() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let input = input_with_config(
        vec![boss],
        json!({ "sessions": { "boss": boss_meta } }),
        json!({ "nudgeCooldownMs": 60_000, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    let sends = watcher.scan(&input, NOW, &mut ok);
    assert_eq!(sends.len(), 1, "{sends:?}");
    assert_eq!(sends[0].session_id, "boss");
    assert!(
        sends[0].text.contains("managed loop"),
        "the overseer is nudged about its own goal, got {:?}",
        sends[0].text
    );
}

/// Its own goal is not news about the fleet. Being listed in a briefing it is
/// meant to act on would read as somebody else's problem.
#[test]
fn an_overseers_own_goal_is_not_briefed_to_itself_as_fleet_news() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 60_000, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    let sends = watcher.scan(&input, NOW, &mut ok);
    let briefing = sends
        .iter()
        .find(|send| briefing_mentions(send, "worker"))
        .expect("the fleet briefing still goes out");
    assert!(
        !briefing_mentions(briefing, "boss"),
        "the overseer must not appear in the list it is meant to act on: {:?}",
        briefing.text
    );
    assert!(
        sends
            .iter()
            .any(|send| send.session_id == "boss" && !briefing_mentions(send, "worker")),
        "and it still gets its own nudge: {sends:?}"
    );
}

/// A busy overseer is not interrupted: "dont ping while its not idle,
/// pointless."
#[test]
fn a_busy_overseer_is_not_nudged_about_its_goal() {
    let (boss, mut boss_meta) = looping_session_with_status("boss", Some("running"), "busy");
    boss_meta["overseer"] = json!(true);
    let input = input_with_config(
        vec![boss],
        json!({ "sessions": { "boss": boss_meta } }),
        json!({ "nudgeCooldownMs": 60_000, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert!(watcher.scan(&input, NOW, &mut ok).is_empty());
}

/// An overseer under a goal must not read as spare capacity, or the idle-fleet
/// briefing is silenced for as long as the goal lasts.
#[test]
fn an_overseer_with_a_goal_is_still_not_spare_capacity() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let input = input_with_config(
        vec![boss],
        json!({ "sessions": { "boss": boss_meta } }),
        json!({ "nudgeCooldownMs": 60_000, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    let sends = watcher.scan(&input, NOW, &mut ok);
    // One send, its own nudge -- not a reconciliation or idle-fleet report
    // that offered the overseer to itself as a worker to hand things to.
    assert_eq!(sends.len(), 1, "{sends:?}");
    assert!(
        !sends[0].text.contains("capacity"),
        "the overseer is not capacity: {:?}",
        sends[0].text
    );
}

/// The nudge used to tell every agent to run `aimux loop done`, which is the
/// one thing a user-managed goal refuses. An agent told to do the impossible
/// keeps trying; told the truth, it reports and waits.
#[test]
fn a_user_managed_goal_is_not_told_to_close_itself() {
    let (worker, mut worker_meta) = looping_session("worker", "idle");
    worker_meta["loop"]["goalKind"] = json!("user");
    let input = input_with_config(
        vec![worker],
        json!({ "sessions": { "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 60_000, "stoppedDwellMs": 0, "autoNudgeWithoutOverseer": true }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    let sends = watcher.scan(&input, NOW, &mut ok);
    let nudge = sends
        .iter()
        .find(|send| send.session_id == "worker")
        .expect("the worker is nudged");
    assert!(
        nudge.text.contains("USER-MANAGED"),
        "the agent must be told whose goal it is, got {:?}",
        nudge.text
    );
    assert!(
        !nudge.text.contains("aimux loop done"),
        "and must not be told to run the command that will be refused: {:?}",
        nudge.text
    );
}

/// An agent-managed goal keeps the instructions it always had.
#[test]
fn an_agent_managed_goal_is_still_told_how_to_close_itself() {
    let (worker, worker_meta) = looping_session("worker", "idle");
    let input = input_with_config(
        vec![worker],
        json!({ "sessions": { "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 60_000, "stoppedDwellMs": 0, "autoNudgeWithoutOverseer": true }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    let sends = watcher.scan(&input, NOW, &mut ok);
    let nudge = sends
        .iter()
        .find(|send| send.session_id == "worker")
        .expect("the worker is nudged");
    assert!(nudge.text.contains("aimux loop done"), "{:?}", nudge.text);
    assert!(!nudge.text.contains("USER-MANAGED"), "{:?}", nudge.text);
}

/// A token goal has no spend feed yet, so it says so rather than implying a
/// measurement nobody took.
#[test]
fn a_token_goal_says_the_budget_is_not_its_to_declare() {
    let (worker, mut worker_meta) = looping_session("worker", "idle");
    worker_meta["loop"]["goalKind"] = json!("tokens");
    worker_meta["loop"]["tokenBudget"] = json!(250_000);
    let input = input_with_config(
        vec![worker],
        json!({ "sessions": { "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 60_000, "stoppedDwellMs": 0, "autoNudgeWithoutOverseer": true }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    let sends = watcher.scan(&input, NOW, &mut ok);
    let nudge = sends
        .iter()
        .find(|send| send.session_id == "worker")
        .expect("the worker is nudged");
    assert!(nudge.text.contains("250000"), "{:?}", nudge.text);
    assert!(!nudge.text.contains("aimux loop done"), "{:?}", nudge.text);
}

/// The bug every other goal test was blind to, because they all pin the dwell
/// to zero: `dwelled_candidates` evicts every dwell key absent from the vec it
/// is handed, so reading the overseer's goal through a SECOND call dropped the
/// fleet's dwell state and the fleet's call dropped the overseer's. With the
/// 30s dwell the project service always inserts, nothing could ever elapse --
/// giving the overseer a goal silenced the entire watcher.
#[test]
fn an_overseer_goal_does_not_reset_the_fleets_dwell_window() {
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
    let sends = watcher.scan(&input, NOW + 30_000, &mut ok);
    assert!(
        sends.iter().any(|send| briefing_mentions(send, "worker")),
        "the fleet briefing must still elapse with an overseer goal present: {sends:?}"
    );
    assert!(
        sends
            .iter()
            .any(|send| send.session_id == "boss" && !briefing_mentions(send, "worker")),
        "and the overseer's own nudge must elapse too: {sends:?}"
    );
}

/// Pausing the overseer's alerts has to work on its own goal as well, or the
/// one agent that cannot be quieted is the one watching everything.
#[test]
fn a_paused_overseer_goal_stops_nudging() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let input = input_with_config(
        vec![boss],
        json!({ "sessions": { "boss": boss_meta } }),
        json!({ "nudgeCooldownMs": 60_000, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert_eq!(watcher.scan(&input, NOW, &mut ok).len(), 1);

    let loop_key = loop_pause_key_from_loop_metadata(
        &json!({ "active": true, "since": "2026-09-09T00:00:00.000Z" }),
    )
    .expect("pause key");
    watcher.pause_loop_alerts("boss", loop_key, NOW, LoopAlertPauseProvenance::default());
    let sends = watcher.scan(&input, NOW + 120_000, &mut ok);
    assert!(
        !sends
            .iter()
            .any(|send| send.session_id == "boss" && send.kind == LoopSendKind::DirectNudge),
        "a paused overseer goal must stop nudging: {sends:?}"
    );
}

/// A reached budget is said ONCE and then goes quiet. Reminders simply
/// stopping would be indistinguishable from the watcher failing, and the agent
/// has no other way to learn the number was hit.
#[test]
fn a_met_token_budget_is_announced_once_and_then_stops_reminding() {
    let met = |spend: u64| {
        let (worker, mut worker_meta) = looping_session("worker", "idle");
        worker_meta["loop"]["goalKind"] = json!("tokens");
        worker_meta["loop"]["tokenBudget"] = json!(10_000);
        worker_meta["tokenSpend"] = json!({ "billed": spend });
        input_with_config(
            vec![worker],
            json!({ "sessions": { "worker": worker_meta } }),
            json!({
                "nudgeCooldownMs": 0,
                "stoppedDwellMs": 0,
                "autoNudgeWithoutOverseer": true
            }),
        )
    };
    let input = met(10_000);

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    let announced = watcher.scan(&input, NOW, &mut ok);
    let notice = announced
        .iter()
        .find(|send| send.session_id == "worker")
        .expect("a reached budget must be said out loud");
    assert!(
        notice.text.contains("10000-token budget has been reached"),
        "it must name the budget it reached, got {:?}",
        notice.text
    );
    assert!(
        !notice
            .text
            .contains("You stopped, but you're in a managed loop"),
        "a reached budget is news, not another reminder: {:?}",
        notice.text
    );

    // The cooldown is zero and the dwell is zero, so anything that re-fires
    // would re-fire here.
    for tick in 1..4 {
        assert!(
            watcher
                .scan(&input, NOW + tick * 120_000, &mut ok)
                .is_empty(),
            "a met budget must be said once, not on every beat (tick {tick})"
        );
    }

    // And a budget RAISED above what was spent is a new goal to work toward,
    // not one already announced.
    let mut raised = met(10_000);
    raised["metadata"]["sessions"]["worker"]["loop"]["tokenBudget"] = json!(20_000);
    let sends = watcher.scan(&raised, NOW + 600_000, &mut ok);
    let nudge = sends
        .iter()
        .find(|send| send.session_id == "worker")
        .expect("an unmet budget reminds again");
    assert!(
        nudge.text.contains("10000 of 20000"),
        "and it reports the new standing, got {:?}",
        nudge.text
    );
}

/// The announcement is delivered as INPUT, so the agent is busy on the next
/// tick -- and a busy agent is not a candidate at all. Pruning the announced
/// key against this tick's candidates therefore dropped it the moment the
/// agent got back to work, and said the same thing again at its next stop,
/// which is exactly what the notice tells it to do. Found by review.
#[test]
fn a_met_budget_is_not_announced_again_after_the_agent_gets_back_to_work() {
    let scan_with = |activity: &str| {
        let (worker, mut worker_meta) = looping_session("worker", activity);
        worker_meta["loop"]["goalKind"] = json!("tokens");
        worker_meta["loop"]["tokenBudget"] = json!(10_000);
        worker_meta["tokenSpend"] = json!({ "billed": 10_000 });
        input_with_config(
            vec![worker],
            json!({ "sessions": { "worker": worker_meta } }),
            json!({
                "nudgeCooldownMs": 0,
                "stoppedDwellMs": 0,
                "autoNudgeWithoutOverseer": true
            }),
        )
    };

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert!(
        watcher
            .scan(&scan_with("idle"), NOW, &mut ok)
            .iter()
            .any(|send| send.session_id == "worker"),
        "said once"
    );
    // The notice itself put it back to work.
    assert!(
        watcher
            .scan(&scan_with("running"), NOW + 120_000, &mut ok)
            .is_empty(),
        "nothing while it is working"
    );
    // And when it stops again, it has already been told.
    assert!(
        watcher
            .scan(&scan_with("idle"), NOW + 240_000, &mut ok)
            .is_empty(),
        "a reached budget is said ONCE, not once per working stint"
    );
    // Several cycles, because the failing version re-fired on each of them.
    for cycle in 1..4 {
        let at = NOW + 240_000 + cycle * 240_000;
        watcher.scan(&scan_with("running"), at, &mut ok);
        assert!(
            watcher
                .scan(&scan_with("idle"), at + 120_000, &mut ok)
                .is_empty(),
            "still said once after {cycle} more working stints"
        );
    }
}

/// Under the PRODUCTION dwell and cooldown, an overseer holding its own goal
/// is nudged on a cadence, not on every tick. A review measured the failing
/// shape: with the dwell bookkeeping removed this path fired on ticks
/// [2,3,4,...,39] instead of [2,6,10,...,38], and every test stayed green
/// because none of them scanned past a delivered send.
#[test]
fn an_overseer_own_goal_nudge_keeps_to_a_cadence_at_production_dwell() {
    let (boss, mut boss_meta) = looping_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = non_loop_session("worker", "running");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({
            "nudgeCooldownMs": 60_000,
            "stoppedDwellMs": 30_000,
            "unchangedReminderTicks": 4
        }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    let mut fired = Vec::new();
    for tick in 0..40 {
        let now = NOW + tick * 15_000;
        if watcher
            .scan(&input, now, &mut ok)
            .iter()
            .any(|send| send.session_id == "boss" && send.kind == LoopSendKind::DirectNudge)
        {
            fired.push(tick);
        }
    }

    assert!(
        !fired.is_empty(),
        "the overseer's own goal must be nudged at all"
    );
    let gaps = fired
        .windows(2)
        .map(|pair| pair[1] - pair[0])
        .collect::<Vec<_>>();
    assert!(
        gaps.iter().all(|gap| *gap >= 4),
        "every gap must be at least the reminder cadence, got {fired:?}"
    );
    assert!(
        fired.len() <= 12,
        "forty ticks must not produce a nudge on nearly every one, got {fired:?}"
    );
}

/// The prune is what makes a NEW goal announceable again. Without it the key
/// of a goal that is long gone sits there for ever and the next goal with the
/// same budget is never announced. A review showed replacing the prune with a
/// no-op left every test green, so this pins it.
#[test]
fn a_goal_removed_and_set_again_is_announced_again() {
    let scan = |active: bool| {
        let (worker, mut worker_meta) = looping_session("worker", "idle");
        worker_meta["loop"]["active"] = json!(active);
        worker_meta["loop"]["goalKind"] = json!("tokens");
        worker_meta["loop"]["tokenBudget"] = json!(10_000);
        worker_meta["tokenSpend"] = json!({ "billed": 10_000 });
        input_with_config(
            vec![worker],
            json!({ "sessions": { "worker": worker_meta } }),
            json!({
                "nudgeCooldownMs": 0,
                "stoppedDwellMs": 0,
                "autoNudgeWithoutOverseer": true
            }),
        )
    };

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert!(
        watcher
            .scan(&scan(true), NOW, &mut ok)
            .iter()
            .any(|send| send.session_id == "worker"),
        "said once"
    );
    // The goal is removed, so its key is no longer a live goal.
    watcher.scan(&scan(false), NOW + 120_000, &mut ok);
    // The SAME budget set again is a new goal to be told about.
    assert!(
        watcher
            .scan(&scan(true), NOW + 240_000, &mut ok)
            .iter()
            .any(|send| send.session_id == "worker"),
        "a goal set again must be announced again, or the key of a dead goal \
         silences every later one with the same budget"
    );
}

/// Said and attempted are different things. Recording the announcement at plan
/// time meant a send that never landed was counted as delivered, and the agent
/// was never told at all.
#[test]
fn a_met_budget_whose_send_fails_is_announced_again() {
    let (worker, mut worker_meta) = looping_session("worker", "idle");
    worker_meta["loop"]["goalKind"] = json!("tokens");
    worker_meta["loop"]["tokenBudget"] = json!(10_000);
    worker_meta["tokenSpend"] = json!({ "billed": 10_000 });
    let input = input_with_config(
        vec![worker],
        json!({ "sessions": { "worker": worker_meta } }),
        json!({
            "nudgeCooldownMs": 0,
            "stoppedDwellMs": 0,
            "autoNudgeWithoutOverseer": true
        }),
    );

    let mut watcher = LoopWatcher::new();
    let mut refuse = |_: &LoopSend| false;
    assert!(
        watcher
            .scan(&input, NOW, &mut refuse)
            .iter()
            .any(|send| send.session_id == "worker"),
        "it is planned"
    );
    let mut accept = |_: &LoopSend| true;
    assert!(
        watcher
            .scan(&input, NOW + 120_000, &mut accept)
            .iter()
            .any(|send| send.session_id == "worker"),
        "and planned again, because the first one never landed"
    );
    assert!(
        watcher.scan(&input, NOW + 240_000, &mut accept).is_empty(),
        "and not a third time, now that it has"
    );
}

/// Sam's rule for every nudge, and the announcement is no exception: "dont
/// ping while its not idle, pointless". The budget is still announced, just
/// not into the middle of a turn.
#[test]
fn a_met_budget_waits_for_the_agent_to_stop_before_announcing() {
    let scan_with = |activity: &str| {
        let (worker, mut worker_meta) = looping_session("worker", activity);
        worker_meta["loop"]["goalKind"] = json!("tokens");
        worker_meta["loop"]["tokenBudget"] = json!(10_000);
        worker_meta["tokenSpend"] = json!({ "billed": 10_000 });
        input_with_config(
            vec![worker],
            json!({ "sessions": { "worker": worker_meta } }),
            json!({
                "nudgeCooldownMs": 0,
                "stoppedDwellMs": 0,
                "autoNudgeWithoutOverseer": true
            }),
        )
    };

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert!(
        watcher.scan(&scan_with("running"), NOW, &mut ok).is_empty(),
        "a working agent is not interrupted to be told its budget is spent"
    );
    assert!(
        watcher
            .scan(&scan_with("idle"), NOW + 120_000, &mut ok)
            .iter()
            .any(|send| send.session_id == "worker"),
        "and it is told once it stops"
    );
}

/// An offline session is a candidate -- that is how a dead loop gets
/// reported -- but it cannot be sent to, and "your budget is spent" delivered
/// into a window that is gone is a send that goes nowhere while being recorded
/// as said.
#[test]
fn a_met_budget_on_a_dead_session_is_not_announced_to_it() {
    let (worker, mut worker_meta) = looping_session_with_status("worker", Some("offline"), "idle");
    worker_meta["loop"]["goalKind"] = json!("tokens");
    worker_meta["loop"]["tokenBudget"] = json!(10_000);
    worker_meta["tokenSpend"] = json!({ "billed": 10_000 });
    let input = input_with_config(
        vec![worker],
        json!({ "sessions": { "worker": worker_meta } }),
        json!({
            "nudgeCooldownMs": 0,
            "stoppedDwellMs": 0,
            "autoNudgeWithoutOverseer": true
        }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert!(
        !watcher
            .scan(&input, NOW, &mut ok)
            .iter()
            .any(|send| send.session_id == "worker"),
        "nothing is sent to a session that is gone"
    );
}

#[test]
fn an_unspent_token_budget_still_reminds_and_reports_the_standing() {
    let (worker, mut worker_meta) = looping_session("worker", "idle");
    worker_meta["loop"]["goalKind"] = json!("tokens");
    worker_meta["loop"]["tokenBudget"] = json!(10_000);
    worker_meta["tokenSpend"] = json!({ "billed": 2_500 });
    let input = input_with_config(
        vec![worker],
        json!({ "sessions": { "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 60_000, "stoppedDwellMs": 0, "autoNudgeWithoutOverseer": true }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    let sends = watcher.scan(&input, NOW, &mut ok);
    let nudge = sends
        .iter()
        .find(|send| send.session_id == "worker")
        .expect("still nudged");
    assert!(nudge.text.contains("2500 of 10000"), "{:?}", nudge.text);
}

/// Unmeasured is not met, and must not read as nothing spent: aider and shell
/// report no usage at all.
#[test]
fn an_unmeasured_token_budget_says_so_instead_of_claiming_zero() {
    let (worker, mut worker_meta) = looping_session("worker", "idle");
    worker_meta["loop"]["goalKind"] = json!("tokens");
    worker_meta["loop"]["tokenBudget"] = json!(10_000);
    worker_meta["tokenSpend"] = json!({ "unmeasured": "this runtime does not report token usage" });
    let input = input_with_config(
        vec![worker],
        json!({ "sessions": { "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 60_000, "stoppedDwellMs": 0, "autoNudgeWithoutOverseer": true }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    let sends = watcher.scan(&input, NOW, &mut ok);
    let nudge = sends
        .iter()
        .find(|send| send.session_id == "worker")
        .expect("an unmeasured budget keeps reminding");
    assert!(
        nudge.text.contains("not measured"),
        "it must say it cannot check, got {:?}",
        nudge.text
    );
    assert!(!nudge.text.contains("0 of 10000"), "{:?}", nudge.text);
}

fn multiple_overseer_input(config: Value) -> Value {
    let (first, mut first_meta) = non_loop_session("control-a", "idle");
    first_meta["overseer"] = json!(true);
    let (second, mut second_meta) = non_loop_session("control-b", "idle");
    second_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    input_with_config(
        vec![first, second, worker],
        json!({ "sessions": {
            "control-a": first_meta, "control-b": second_meta, "worker": worker_meta
        }}),
        config,
    )
}

fn send_to<'a>(sends: &'a [LoopSend], recipient: &str, kind: LoopSendKind) -> &'a LoopSend {
    sends
        .iter()
        .find(|send| send.session_id == recipient && send.kind == kind)
        .unwrap_or_else(|| panic!("missing {kind:?} for {recipient}: {sends:?}"))
}

#[test]
fn every_live_overseer_receives_the_fleet_briefing() {
    let input = multiple_overseer_input(json!({ "stoppedDwellMs": 0 }));
    let sends = LoopWatcher::new().plan_sends(&input, NOW);
    assert_eq!(sends.len(), 2, "each overseer must receive the briefing");
    for recipient in ["control-a", "control-b"] {
        assert!(briefing_mentions(
            send_to(&sends, recipient, LoopSendKind::OverseerBriefing),
            "worker"
        ));
    }
}

#[test]
fn an_offline_first_overseer_cannot_hide_a_live_later_overseer() {
    let mut input = multiple_overseer_input(json!({ "stoppedDwellMs": 0 }));
    input["sessions"][0]["status"] = json!("offline");
    let sends = LoopWatcher::new().plan_sends(&input, NOW);
    assert_eq!(
        sends.len(),
        1,
        "offline overseers are data, never delivery targets"
    );
    assert_eq!(sends[0].session_id, "control-b");
    assert_eq!(sends[0].kind, LoopSendKind::OverseerBriefing);
    input["sessions"][1]["status"] = json!("offline");
    assert!(
        LoopWatcher::new().plan_sends(&input, NOW).is_empty(),
        "no live overseer keeps the default observe-only behavior"
    );
}

#[test]
fn every_overseers_own_goal_is_a_direct_nudge_and_never_fleet_capacity() {
    let mut input = multiple_overseer_input(json!({
        "stoppedDwellMs": 0, "reconciliationDwellMs": 0, "idleFleetDwellMs": 0
    }));
    input["sessions"].as_array_mut().expect("sessions").pop();
    input["metadata"]["sessions"]
        .as_object_mut()
        .expect("metadata sessions")
        .remove("worker");
    for recipient in ["control-a", "control-b"] {
        input["metadata"]["sessions"][recipient]["loop"] = json!({
            "active": true, "goal": "coordinate", "since": "2026-09-09T00:00:00.000Z"
        });
    }
    input["runtimeExchange"] = json!({ "tasks": [{ "id": "unowned", "status": "pending" }] });
    let sends = LoopWatcher::new().plan_sends(&input, NOW);
    assert_eq!(
        sends.len(),
        2,
        "control agents must never become worker capacity: {sends:?}"
    );
    for recipient in ["control-a", "control-b"] {
        let send = send_to(&sends, recipient, LoopSendKind::DirectNudge);
        assert!(send.text.contains("managed loop"));
    }
}

#[test]
fn an_unattempted_recipient_still_receives_its_briefing_after_another_succeeds_and_reload() {
    let input = multiple_overseer_input(json!({ "stoppedDwellMs": 0, "nudgeCooldownMs": 60_000 }));
    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    watcher.commit_send_result(
        send_to(&sends, "control-a", LoopSendKind::OverseerBriefing),
        NOW,
        LoopDeliveryOutcome::Delivered,
    );
    let directory = temp_state_dir("multiple-overseers-partial-delivery");
    let path = loop_watcher_state_path(&directory);
    save_loop_watcher_state(&path, &watcher).expect("save partial delivery");
    let mut watcher = load_loop_watcher_state(&path).expect("reload partial delivery");
    let sends = watcher.plan_sends(&input, NOW + 1);
    assert_eq!(
        sends.len(),
        1,
        "delivery to one recipient cannot acknowledge another's briefing"
    );
    assert_eq!(sends[0].session_id, "control-b");
    watcher.commit_send_result(
        &sends[0],
        NOW + 30_000,
        LoopDeliveryOutcome::Failed {
            error: "receiver unavailable".into(),
        },
    );
    assert!(watcher.plan_sends(&input, NOW + 30_001).is_empty());
    let first_due = watcher.plan_sends(&input, NOW + 60_000);
    assert_eq!(
        first_due.len(),
        1,
        "a failed recipient keeps its own cooldown"
    );
    assert_eq!(first_due[0].session_id, "control-a");
    watcher.commit_send_result(&first_due[0], NOW + 60_000, LoopDeliveryOutcome::Delivered);
    let second_due = watcher.plan_sends(&input, NOW + 90_000);
    assert_eq!(
        second_due.len(),
        1,
        "the failed recipient must eventually retry independently"
    );
    assert_eq!(second_due[0].session_id, "control-b");
}

#[test]
fn global_pause_buffers_identical_briefings_separately_and_preserves_each_recipient_on_reload() {
    let input = multiple_overseer_input(json!({ "stoppedDwellMs": 0, "nudgeCooldownMs": 60_000 }));
    let mut watcher = LoopWatcher::new();
    watcher.set_global_pause(NOW, NOW + 60_000, LoopAlertPauseProvenance::default());
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(sends.len(), 2);
    assert_eq!(sends[0].signature, sends[1].signature);
    for send in &sends {
        watcher.buffer_send(send, NOW);
        watcher.commit_send_result(send, NOW, LoopDeliveryOutcome::Buffered);
    }
    assert_eq!(watcher.buffered_send_count(), 2);
    assert_eq!(watcher.loop_alert_state(NOW)["bufferedCount"], 2);
    let directory = temp_state_dir("multiple-overseers-buffered");
    let path = loop_watcher_state_path(&directory);
    save_loop_watcher_state(&path, &watcher).expect("save buffers");
    let mut watcher = load_loop_watcher_state(&path).expect("reload buffers");
    watcher.clear_global_pause();
    let buffered = watcher.buffered_sends_to_deliver(8);
    assert_eq!(buffered.len(), 2);
    let first = send_to(&buffered, "control-a", LoopSendKind::OverseerBriefing);
    watcher.commit_send_result(first, NOW + 1, LoopDeliveryOutcome::Delivered);
    watcher.remove_buffered_send(first);
    let second = send_to(&buffered, "control-b", LoopSendKind::OverseerBriefing);
    watcher.commit_send_result(
        second,
        NOW + 1,
        LoopDeliveryOutcome::Failed {
            error: "unavailable".into(),
        },
    );
    assert_eq!(watcher.buffered_send_count(), 1);
    assert_eq!(
        watcher.buffered_sends_to_deliver(8)[0].session_id,
        "control-b"
    );
    watcher.commit_send_result(second, NOW + 2, LoopDeliveryOutcome::Delivered);
    watcher.remove_buffered_send(second);
    assert_eq!(watcher.buffered_send_count(), 0);
    assert!(watcher.plan_sends(&input, NOW + 3).is_empty());
}

#[test]
fn loop_exit_delivery_failure_retries_only_the_recipient_that_missed_it() {
    let mut input =
        multiple_overseer_input(json!({ "stoppedDwellMs": 0, "nudgeCooldownMs": 60_000 }));
    let (worker, worker_meta) = self_exited_session_with_status("worker", Some("offline"), "done");
    input["sessions"][2] = worker;
    input["metadata"]["sessions"]["worker"] = worker_meta;
    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(sends.len(), 2);
    watcher.commit_send_result(
        send_to(&sends, "control-a", LoopSendKind::LoopExit),
        NOW,
        LoopDeliveryOutcome::Delivered,
    );
    watcher.commit_send_result(
        send_to(&sends, "control-b", LoopSendKind::LoopExit),
        NOW,
        LoopDeliveryOutcome::Failed {
            error: "unavailable".into(),
        },
    );
    assert!(watcher.plan_sends(&input, NOW + 1).is_empty());
    let directory = temp_state_dir("multiple-overseers-loop-exit");
    let path = loop_watcher_state_path(&directory);
    save_loop_watcher_state(&path, &watcher).expect("save exit attempts");
    let mut watcher = load_loop_watcher_state(&path).expect("reload exit attempts");
    let retry = watcher.plan_sends(&input, NOW + 60_000);
    assert_eq!(
        retry.len(),
        1,
        "a successful recipient stays acknowledged while a failed one retries"
    );
    assert_eq!(retry[0].session_id, "control-b");
    assert_eq!(retry[0].kind, LoopSendKind::LoopExit);
    watcher.commit_send_result(&retry[0], NOW + 60_000, LoopDeliveryOutcome::Delivered);
    assert!(watcher.plan_sends(&input, NOW + 120_000).is_empty());
}

#[test]
fn every_overseer_receives_paused_summaries_and_reconciliation_with_independent_dwell() {
    let input = multiple_overseer_input(json!({
        "stoppedDwellMs": 60_000, "reconciliationDwellMs": 30_000,
        "reconciliationCooldownMs": 60_000
    }));
    let mut reconciliation_input = input.clone();
    reconciliation_input["runtimeExchange"] =
        json!({ "tasks": [{ "id": "unowned", "status": "pending" }] });
    let mut watcher = LoopWatcher::new();
    assert!(watcher.plan_sends(&reconciliation_input, NOW).is_empty());
    assert!(
        watcher
            .plan_sends(&reconciliation_input, NOW + 29_999)
            .is_empty()
    );
    let sends = watcher.plan_sends(&reconciliation_input, NOW + 30_000);
    for recipient in ["control-a", "control-b"] {
        send_to(&sends, recipient, LoopSendKind::Reconciliation);
    }
    watcher.commit_send_result(
        send_to(&sends, "control-a", LoopSendKind::Reconciliation),
        NOW + 30_000,
        LoopDeliveryOutcome::Delivered,
    );
    let next = watcher.plan_sends(&reconciliation_input, NOW + 30_001);
    assert_eq!(next.len(), 1);
    assert_eq!(next[0].session_id, "control-b");

    let mut watcher = LoopWatcher::new();
    watcher.pause_loop_alerts(
        "worker",
        "2026-09-09T00:00:00.000Z".into(),
        NOW,
        LoopAlertPauseProvenance::default(),
    );
    for tick in 0..9 {
        assert!(watcher.plan_sends(&input, NOW + tick).is_empty());
    }
    let summaries = watcher.plan_sends(&input, NOW + 9);
    assert_eq!(summaries.len(), 2);
    for recipient in ["control-a", "control-b"] {
        send_to(&summaries, recipient, LoopSendKind::PausedSummary);
    }
    watcher.unpause_loop_alerts("worker");
    assert!(
        watcher.plan_sends(&input, NOW + 10).is_empty(),
        "unpaused candidates must dwell afresh"
    );
}

#[test]
fn idle_fleet_summaries_reach_each_overseer_and_exclude_other_overseers_from_capacity() {
    let mut input = multiple_overseer_input(json!({ "idleFleetDwellMs": 0 }));
    input["metadata"]["sessions"]["worker"]["loop"]["active"] = json!(false);
    input["runtimeExchange"] = json!({ "tasks": [{ "id": "unowned", "status": "pending" }] });
    let sends = LoopWatcher::new().plan_sends(&input, NOW);
    assert_eq!(
        sends.len(),
        2,
        "every overseer must receive idle-fleet information"
    );
    for recipient in ["control-a", "control-b"] {
        let send = send_to(&sends, recipient, LoopSendKind::IdleFleet);
        assert!(send.text.contains("worker"));
        assert!(!send.text.contains("control-a"));
        assert!(!send.text.contains("control-b"));
    }
    input["sessions"].as_array_mut().expect("sessions").pop();
    assert!(
        LoopWatcher::new().plan_sends(&input, NOW).is_empty(),
        "overseers alone never constitute an idle worker fleet"
    );
}

fn multiple_overseer_met_token_input() -> Value {
    let mut input = multiple_overseer_input(json!({
        "stoppedDwellMs": 0, "nudgeCooldownMs": 60_000, "autoNudgeWithoutOverseer": true
    }));
    input["metadata"]["sessions"]["worker"]["loop"]["goalKind"] = json!("tokens");
    input["metadata"]["sessions"]["worker"]["loop"]["tokenBudget"] = json!(10_000);
    input["metadata"]["sessions"]["worker"]["tokenSpend"] = json!({ "billed": 10_000 });
    input
}

#[test]
fn multiple_overseers_share_exactly_one_worker_budget_notice_and_acknowledgement_across_reload() {
    let input = multiple_overseer_met_token_input();
    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(
        sends.len(),
        1,
        "worker notices belong to one outer engine, not every overseer"
    );
    assert_eq!(sends[0].session_id, "worker");
    assert_eq!(sends[0].kind, LoopSendKind::DirectNudge);
    assert!(
        sends[0]
            .text
            .contains("10000-token budget has been reached")
    );
    watcher.commit_send_result(&sends[0], NOW, LoopDeliveryOutcome::Delivered);
    assert!(watcher.plan_sends(&input, NOW + 120_000).is_empty());
    let directory = temp_state_dir("multiple-overseers-worker-budget");
    let path = loop_watcher_state_path(&directory);
    save_loop_watcher_state(&path, &watcher).expect("save delivered worker notice");
    let mut watcher = load_loop_watcher_state(&path).expect("reload delivered worker notice");
    assert!(
        watcher.plan_sends(&input, NOW + 240_000).is_empty(),
        "delivered notices stay acknowledged after reload"
    );
}

#[test]
fn a_failed_worker_budget_notice_retries_once_with_multiple_overseers() {
    let input = multiple_overseer_met_token_input();
    let mut watcher = LoopWatcher::new();
    let sends = watcher.plan_sends(&input, NOW);
    assert_eq!(sends.len(), 1);
    watcher.commit_send_result(
        &sends[0],
        NOW,
        LoopDeliveryOutcome::Failed {
            error: "unavailable".into(),
        },
    );
    let directory = temp_state_dir("multiple-overseers-failed-worker-budget");
    let path = loop_watcher_state_path(&directory);
    save_loop_watcher_state(&path, &watcher).expect("save worker notice failure");
    let mut watcher = load_loop_watcher_state(&path).expect("reload worker notice failure");
    assert!(watcher.plan_sends(&input, NOW + 1).is_empty());
    let retry = watcher.plan_sends(&input, NOW + 60_000);
    assert_eq!(retry.len(), 1);
    assert_eq!(retry[0].session_id, "worker");
    watcher.commit_send_result(&retry[0], NOW + 60_000, LoopDeliveryOutcome::Delivered);
    assert!(watcher.plan_sends(&input, NOW + 120_000).is_empty());
}

#[test]
fn a_buffered_worker_budget_notice_is_delivered_once_after_reload_and_a_new_due_reminder() {
    use aimux::project_service::loop_watcher_task::loop_delivery_queue;
    let input = multiple_overseer_met_token_input();
    let mut watcher = LoopWatcher::new();
    let planned = watcher.plan_sends(&input, NOW);
    assert_eq!(planned.len(), 1);
    watcher.buffer_send(&planned[0], NOW);
    watcher.commit_send_result(&planned[0], NOW, LoopDeliveryOutcome::Buffered);
    let directory = temp_state_dir("multiple-overseers-buffered-worker-budget");
    let path = loop_watcher_state_path(&directory);
    save_loop_watcher_state(&path, &watcher).expect("save buffered worker notice");
    let mut watcher = load_loop_watcher_state(&path).expect("reload buffered worker notice");
    let newly_due = watcher.plan_sends(&input, NOW + 60_000);
    assert_eq!(
        newly_due.len(),
        1,
        "an unacknowledged notice becomes due after cooldown"
    );
    let queue = loop_delivery_queue(&watcher, &input, newly_due, NOW + 60_000, 8);
    assert_eq!(
        queue.len(),
        1,
        "the buffered copy and new plan identify the same delivery"
    );
    watcher.commit_send_result(&queue[0], NOW + 60_000, LoopDeliveryOutcome::Delivered);
    watcher.remove_buffered_send(&queue[0]);
    assert_eq!(watcher.buffered_send_count(), 0);
    assert!(watcher.plan_sends(&input, NOW + 120_000).is_empty());
    save_loop_watcher_state(&path, &watcher).expect("save acknowledgement");
    let mut watcher = load_loop_watcher_state(&path).expect("reload acknowledgement");
    assert!(watcher.plan_sends(&input, NOW + 180_000).is_empty());
}

#[test]
fn buffered_and_new_identical_briefings_are_deduplicated_per_recipient_before_the_scan_cap() {
    use aimux::project_service::loop_watcher_task::loop_delivery_queue;
    let input = multiple_overseer_input(json!({ "stoppedDwellMs": 0, "nudgeCooldownMs": 0 }));
    let mut watcher = LoopWatcher::new();
    let planned = watcher.plan_sends(&input, NOW);
    for send in &planned {
        watcher.buffer_send(send, NOW);
        watcher.commit_send_result(send, NOW, LoopDeliveryOutcome::Buffered);
    }
    let fresh = watcher.plan_sends(&input, NOW + 1);
    assert_eq!(fresh.len(), 2);
    let extra = LoopSend {
        session_id: "later-recipient".into(),
        text: "later".into(),
        signature: "distinct".into(),
        kind: LoopSendKind::OverseerBriefing,
    };
    let mut input = input;
    input["sessions"]
        .as_array_mut()
        .expect("sessions")
        .push(json!({ "id": "later-recipient", "status": "idle", "overseer": true, "projectControl": true }));
    let mut sends = fresh;
    sends.push(extra);
    let queue = loop_delivery_queue(&watcher, &input, sends, NOW + 1, 3);
    assert_eq!(queue.len(), 3, "duplicates cannot consume the scan cap");
    assert_eq!(
        queue
            .iter()
            .map(|send| send.session_id.as_str())
            .collect::<Vec<_>>(),
        ["control-a", "control-b", "later-recipient"]
    );
    let mut another_kind = planned[0].clone();
    another_kind.kind = LoopSendKind::PausedSummary;
    let queue = loop_delivery_queue(&watcher, &input, vec![another_kind], NOW + 1, 8);
    assert_eq!(
        queue.len(),
        3,
        "different kinds with the same signature remain distinct"
    );
}

#[test]
fn automatic_worker_nudges_have_one_owner_when_no_live_overseer_exists() {
    let mut input = multiple_overseer_input(json!({
        "stoppedDwellMs": 0, "nudgeCooldownMs": 60_000, "autoNudgeWithoutOverseer": true
    }));
    let mut watcher = LoopWatcher::new();
    let supervised = watcher.plan_sends(&input, NOW);
    assert_eq!(supervised.len(), 2);
    assert!(
        supervised
            .iter()
            .all(|send| send.kind == LoopSendKind::OverseerBriefing)
    );
    for index in 0..2 {
        input["sessions"][index]["status"] = json!("offline");
    }
    let direct = watcher.plan_sends(&input, NOW + 1);
    assert_eq!(
        direct.len(),
        1,
        "one direct engine takes over when all overseers are offline"
    );
    assert_eq!(direct[0].session_id, "worker");
    assert_eq!(direct[0].kind, LoopSendKind::DirectNudge);
    watcher.commit_send_result(&direct[0], NOW + 1, LoopDeliveryOutcome::Delivered);
    assert!(watcher.plan_sends(&input, NOW + 2).is_empty());
}

#[test]
fn topology_only_overseer_identity_and_loop_only_metadata_share_one_set_with_explicit_demote_precedence()
 {
    let mut input = multiple_overseer_input(json!({ "stoppedDwellMs": 0 }));
    input["sessions"][1]["overseer"] = json!(true);
    input["sessions"][1]["projectControl"] = json!(true);
    input["metadata"]["sessions"]
        .as_object_mut()
        .expect("metadata")
        .remove("control-b");
    let sends = LoopWatcher::new().plan_sends(&input, NOW);
    assert_eq!(
        sends.len(),
        2,
        "a topology-only overseer must receive fleet briefings"
    );
    send_to(&sends, "control-b", LoopSendKind::OverseerBriefing);

    let (_, loop_only_metadata) = looping_session("control-b", "idle");
    input["metadata"]["sessions"]["control-b"] = loop_only_metadata;
    let sends = LoopWatcher::new().plan_sends(&input, NOW);
    assert_eq!(
        sends.len(),
        3,
        "loop-only metadata must retain the topology control identity"
    );
    send_to(&sends, "control-b", LoopSendKind::DirectNudge);
    for recipient in ["control-a", "control-b"] {
        let briefing = send_to(&sends, recipient, LoopSendKind::OverseerBriefing);
        assert!(briefing_mentions(briefing, "worker"));
        assert!(
            !briefing_mentions(briefing, "control-b"),
            "an overseer's own goal is never fleet news"
        );
    }

    input["metadata"]["sessions"]["control-b"]["overseer"] = json!(false);
    input["metadata"]["sessions"]["control-b"]["projectControl"] = json!(false);
    let sends = LoopWatcher::new().plan_sends(&input, NOW);
    assert_eq!(
        sends.len(),
        1,
        "explicit metadata demotion overrides old topology flags"
    );
    assert_eq!(sends[0].session_id, "control-a");
    assert!(
        briefing_mentions(&sends[0], "control-b"),
        "a demoted worker returns to fleet handling"
    );
}

fn set_budget_session_overseer(input: &mut Value, overseer: bool) {
    input["metadata"]["sessions"]["worker"]["overseer"] = json!(overseer);
    input["metadata"]["sessions"]["worker"]["projectControl"] = json!(overseer);
}

#[test]
fn delivered_token_notices_follow_the_same_session_goal_across_promotion_demotion_and_reload() {
    for initially_overseer in [false, true] {
        let mut input = multiple_overseer_met_token_input();
        set_budget_session_overseer(&mut input, initially_overseer);
        let directory = temp_state_dir(if initially_overseer {
            "budget-delivered-control-worker-control"
        } else {
            "budget-delivered-worker-control-worker"
        });
        let path = loop_watcher_state_path(&directory);
        let mut watcher = LoopWatcher::new();
        let sends = watcher.plan_sends(&input, NOW);
        assert_eq!(
            sends.len(),
            1,
            "every budget notice has one role-independent owner"
        );
        assert_eq!(sends[0].session_id, "worker");
        assert_eq!(sends[0].kind, LoopSendKind::DirectNudge);
        watcher.commit_send_result(&sends[0], NOW, LoopDeliveryOutcome::Delivered);
        for (tick, overseer) in [!initially_overseer, initially_overseer]
            .into_iter()
            .enumerate()
        {
            set_budget_session_overseer(&mut input, overseer);
            save_loop_watcher_state(&path, &watcher).expect("save before role transition");
            watcher = load_loop_watcher_state(&path).expect("reload before role transition");
            assert!(
                watcher
                    .plan_sends(&input, NOW + (tick as i64 + 1) * 120_000)
                    .is_empty(),
                "role transition cannot erase a delivered budget acknowledgement"
            );
        }
        input["metadata"]["sessions"]["worker"]["loop"]["tokenBudget"] = json!(20_000);
        input["metadata"]["sessions"]["worker"]["tokenSpend"] = json!({ "billed": 20_000 });
        let raised = watcher.plan_sends(&input, NOW + 360_000);
        assert_eq!(
            raised.len(),
            1,
            "a newly met raised budget is still announced"
        );
        assert_eq!(raised[0].session_id, "worker");
    }
}

#[test]
fn buffered_token_notices_keep_their_owner_across_promotion_demotion_and_reload() {
    use aimux::project_service::loop_watcher_task::loop_delivery_queue;
    for initially_overseer in [false, true] {
        let mut input = multiple_overseer_met_token_input();
        set_budget_session_overseer(&mut input, initially_overseer);
        let directory = temp_state_dir(if initially_overseer {
            "budget-buffered-control-worker-control"
        } else {
            "budget-buffered-worker-control-worker"
        });
        let path = loop_watcher_state_path(&directory);
        let mut watcher = LoopWatcher::new();
        let sends = watcher.plan_sends(&input, NOW);
        assert_eq!(sends.len(), 1);
        watcher.buffer_send(&sends[0], NOW);
        watcher.commit_send_result(&sends[0], NOW, LoopDeliveryOutcome::Buffered);
        assert_eq!(watcher.buffered_send_count(), 1);
        save_loop_watcher_state(&path, &watcher).expect("save pending budget notice");
        watcher = load_loop_watcher_state(&path).expect("reload pending budget notice");
        set_budget_session_overseer(&mut input, !initially_overseer);
        let fresh = watcher.plan_sends(&input, NOW + 120_000);
        assert_eq!(
            watcher.buffered_send_count(),
            1,
            "discarding an old role engine cannot discard the session's budget notice"
        );
        let queue = loop_delivery_queue(&watcher, &input, fresh, NOW + 120_000, 8);
        assert_eq!(
            queue.len(),
            1,
            "old and new plans remain one role-independent notice"
        );
        watcher.commit_send_result(&queue[0], NOW + 120_000, LoopDeliveryOutcome::Delivered);
        watcher.remove_buffered_send(&queue[0]);
        assert_eq!(watcher.buffered_send_count(), 0);
        save_loop_watcher_state(&path, &watcher).expect("save transitioned acknowledgement");
        watcher = load_loop_watcher_state(&path).expect("reload transitioned acknowledgement");
        assert!(
            watcher.plan_sends(&input, NOW + 240_000).is_empty(),
            "delivery after role transition must acknowledge the outer session owner"
        );
        set_budget_session_overseer(&mut input, initially_overseer);
        assert!(
            watcher.plan_sends(&input, NOW + 360_000).is_empty(),
            "transition back cannot reannounce the same met goal"
        );
    }
}

fn buffered_fleet_input(recipients: &[&str], cooldown_ms: i64) -> Value {
    let mut sessions = recipients
        .iter()
        .map(|id| {
            json!({
                "id": id, "status": "idle", "overseer": true, "projectControl": true
            })
        })
        .collect::<Vec<_>>();
    let (worker, worker_meta) =
        looping_session_with_status("stalled-worker", Some("running"), "idle");
    sessions.push(worker);
    input_with_config(
        sessions,
        json!({ "sessions": { "stalled-worker": worker_meta } }),
        json!({ "stoppedDwellMs": 0, "nudgeCooldownMs": cooldown_ms }),
    )
}

fn buffer_actual_fleet_notices(watcher: &mut LoopWatcher, input: &Value) -> Vec<LoopSend> {
    let sends = watcher
        .plan_sends(input, NOW)
        .into_iter()
        .filter(|send| send.kind == LoopSendKind::OverseerBriefing)
        .collect::<Vec<_>>();
    assert!(
        !sends.is_empty(),
        "the fixture must produce real fleet work"
    );
    for send in &sends {
        watcher.buffer_send(send, NOW);
        watcher.commit_send_result(send, NOW, LoopDeliveryOutcome::Buffered);
    }
    sends
}

fn move_recipient_buffer_to_root(
    watcher: &LoopWatcher,
    recipient: &str,
    label: &str,
) -> LoopWatcher {
    let directory = temp_state_dir(label);
    let path = loop_watcher_state_path(&directory);
    save_loop_watcher_state(&path, watcher).expect("save real recipient buffers");
    let mut state: Value = serde_json::from_slice(&fs::read(&path).expect("read saved watcher"))
        .expect("decode saved watcher");
    let buffers = state["recipientWatchers"][recipient]["bufferedSends"].take();
    assert!(
        !buffers
            .as_object()
            .expect("recipient buffer map")
            .is_empty()
    );
    assert!(
        state["bufferedSends"]
            .as_object()
            .expect("root buffer map")
            .is_empty()
    );
    state["recipientWatchers"][recipient]["bufferedSends"] = json!({});
    state["bufferedSends"] = buffers;
    fs::write(
        &path,
        serde_json::to_vec(&state).expect("encode legacy root fixture"),
    )
    .expect("write legacy root fixture");
    load_loop_watcher_state(&path).expect("load real candidate keys under legacy root ownership")
}

#[test]
fn production_queue_skips_eight_offline_buffers_before_its_eight_send_cap_on_every_tick() {
    use aimux::project_service::loop_watcher_task::{
        FAILED_BUFFER_RETRY_FLOOR_MS, loop_delivery_queue,
    };
    let mut watcher = LoopWatcher::new();
    let recipients = (0..9)
        .map(|index| format!("overseer-{index}"))
        .collect::<Vec<_>>();
    let recipient_refs = recipients.iter().map(String::as_str).collect::<Vec<_>>();
    let mut input = buffered_fleet_input(&recipient_refs, 0);
    assert_eq!(buffer_actual_fleet_notices(&mut watcher, &input).len(), 9);
    for index in 0..8 {
        input["sessions"][index]["status"] = json!("offline");
    }
    assert_eq!(watcher.buffered_send_count(), 9);
    let directory = temp_state_dir("queue-offline-eight-fairness");
    let path = loop_watcher_state_path(&directory);
    for tick in 0..3 {
        let at = NOW + tick * FAILED_BUFFER_RETRY_FLOOR_MS;
        let queue = loop_delivery_queue(&watcher, &input, vec![], at, 8);
        assert_eq!(
            queue.len(),
            1,
            "offline entries cannot spend the delivery cap"
        );
        assert_eq!(queue[0].session_id, "overseer-8");
        watcher.commit_send_result(
            &queue[0],
            at,
            LoopDeliveryOutcome::Failed {
                error: "temporarily unavailable".into(),
            },
        );
        assert!(
            loop_delivery_queue(&watcher, &input, vec![queue[0].clone()], at + 1, 8).is_empty(),
            "a fresh identical plan cannot bypass failed-buffer backoff"
        );
        save_loop_watcher_state(&path, &watcher).expect("persist failed buffer");
        watcher = load_loop_watcher_state(&path).expect("reload failed buffer");
    }
    input["sessions"][8]["status"] = json!("offline");
    assert!(loop_delivery_queue(&watcher, &input, vec![], NOW + 60_000, 8).is_empty());
}

#[test]
fn production_queue_rotates_after_actual_attempt_when_one_slow_failure_spends_the_tick_budget() {
    use aimux::project_service::loop_watcher_task::loop_delivery_queue;
    let input = buffered_fleet_input(&["a", "b", "c"], 60_000);
    let mut watcher = LoopWatcher::new();
    assert_eq!(buffer_actual_fleet_notices(&mut watcher, &input).len(), 3);
    let directory = temp_state_dir("queue-slow-recipient-rotation");
    let path = loop_watcher_state_path(&directory);
    let mut attempted = Vec::new();
    for tick in 0..6 {
        // Every recipient's backoff has elapsed by the next tick: this proves
        // rotation, independently of filtering the most recent failure out.
        let at = NOW + tick * 60_000;
        let queue = loop_delivery_queue(&watcher, &input, vec![], at, 8);
        assert_eq!(queue.len(), 3);
        assert_eq!(
            watcher.last_delivery_recipient(),
            attempted.last().map(String::as_str),
            "planning must not advance the actual-attempt cursor"
        );
        // Deterministic scheduler budget: only the first callback fits. A real
        // slow receiver consumes the 10s wall budget at exactly this boundary.
        let send = &queue[0];
        attempted.push(send.session_id.clone());
        watcher.commit_send_result(
            send,
            at,
            LoopDeliveryOutcome::Failed {
                error: "slow receiver exhausted scan budget".into(),
            },
        );
        save_loop_watcher_state(&path, &watcher).expect("persist fairness cursor");
        watcher = load_loop_watcher_state(&path).expect("reload fairness cursor");
    }
    assert_eq!(attempted, ["a", "b", "c", "a", "b", "c"]);
}

#[test]
fn buffered_pause_flushes_immediately_but_failed_buffers_wait_across_reload() {
    use aimux::project_service::loop_watcher_task::{
        FAILED_BUFFER_RETRY_FLOOR_MS, loop_delivery_queue,
    };
    let input = buffered_fleet_input(&["a"], 0);
    let mut watcher = LoopWatcher::new();
    let notices = buffer_actual_fleet_notices(&mut watcher, &input);
    let notice = &notices[0];
    assert_eq!(
        loop_delivery_queue(&watcher, &input, vec![], NOW + 1, 8).len(),
        1,
        "global-pause buffering does not impose failure backoff"
    );
    watcher.commit_send_result(
        notice,
        NOW + 1,
        LoopDeliveryOutcome::Failed {
            error: "unavailable".into(),
        },
    );
    let directory = temp_state_dir("queue-failure-backoff");
    let path = loop_watcher_state_path(&directory);
    save_loop_watcher_state(&path, &watcher).expect("persist backoff");
    let watcher = load_loop_watcher_state(&path).expect("reload backoff");
    assert!(loop_delivery_queue(&watcher, &input, vec![notice.clone()], NOW + 2, 8).is_empty());
    assert_eq!(
        loop_delivery_queue(
            &watcher,
            &input,
            vec![],
            NOW + 1 + FAILED_BUFFER_RETRY_FLOOR_MS,
            8
        )
        .len(),
        1
    );
}

#[test]
fn current_control_identity_filters_stale_root_and_child_fleet_buffers_but_keeps_session_budget_notice()
 {
    use aimux::project_service::loop_watcher_task::loop_delivery_queue;
    let mut input = multiple_overseer_met_token_input();
    let (stalled_worker, stalled_meta) = looping_session("stalled-worker", "idle");
    input["sessions"]
        .as_array_mut()
        .unwrap()
        .push(stalled_worker);
    input["metadata"]["sessions"]["stalled-worker"] = stalled_meta;
    let mut watcher = LoopWatcher::new();
    assert_eq!(buffer_actual_fleet_notices(&mut watcher, &input).len(), 2);
    watcher = move_recipient_buffer_to_root(&watcher, "control-a", "queue-stale-root-identity");
    let budgets = watcher.plan_sends(&input, NOW + 1);
    assert_eq!(budgets.len(), 1);
    watcher.buffer_send(&budgets[0], NOW);
    watcher.commit_send_result(&budgets[0], NOW, LoopDeliveryOutcome::Buffered);
    for id in ["control-a", "control-b"] {
        input["metadata"]["sessions"][id]["overseer"] = json!(false);
        input["metadata"]["sessions"][id]["projectControl"] = json!(false);
    }
    let queue = loop_delivery_queue(&watcher, &input, vec![], NOW + 1, 8);
    assert_eq!(
        queue.len(),
        1,
        "live former overseers cannot receive buffered fleet content"
    );
    assert_eq!(queue[0].session_id, "worker");
    assert_eq!(queue[0].kind, LoopSendKind::DirectNudge);
    watcher.commit_send_result(&queue[0], NOW + 1, LoopDeliveryOutcome::Delivered);
    watcher.remove_buffered_send(&queue[0]);
    assert!(loop_delivery_queue(&watcher, &input, vec![], NOW + 60_000, 8).is_empty());
}

#[test]
fn a_failed_root_buffer_does_not_back_off_or_get_removed_by_a_siblings_identical_child_buffer() {
    use aimux::project_service::loop_watcher_task::loop_delivery_queue;
    let input = multiple_overseer_input(json!({ "stoppedDwellMs": 0, "nudgeCooldownMs": 60_000 }));
    let mut watcher = LoopWatcher::new();
    let notices = buffer_actual_fleet_notices(&mut watcher, &input);
    let first = send_to(&notices, "control-a", LoopSendKind::OverseerBriefing);
    let second = send_to(&notices, "control-b", LoopSendKind::OverseerBriefing);
    assert_eq!(first.signature, second.signature);
    watcher = move_recipient_buffer_to_root(&watcher, "control-a", "queue-root-sibling-backoff");
    assert_eq!(watcher.buffered_send_count(), 2);
    watcher.commit_send_result(
        first,
        NOW,
        LoopDeliveryOutcome::Failed {
            error: "old root buffer failed".into(),
        },
    );
    let queue = loop_delivery_queue(&watcher, &input, vec![], NOW + 1, 8);
    assert_eq!(queue.len(), 1);
    assert_eq!(
        queue[0].session_id, "control-b",
        "a failed sibling's signature is not this recipient's backoff"
    );
    watcher.commit_send_result(second, NOW + 1, LoopDeliveryOutcome::Delivered);
    watcher.remove_buffered_send(second);
    assert_eq!(
        watcher.buffered_send_count(),
        1,
        "removing B cannot remove A's root buffer with the same signature"
    );
    let queue = loop_delivery_queue(&watcher, &input, vec![], NOW + 60_000, 8);
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0].session_id, "control-a");
}

#[test]
fn a_real_delivery_future_deadline_persists_failure_and_rotates_to_healthy_overseers() {
    use aimux::project_service::loop_watcher_task::{
        deliver_loop_send_with_budget, loop_delivery_queue,
    };
    use aimux::project_service::watcher_delivery::TickLoopBudget;
    use std::time::Duration;
    aimux::async_runtime::init_process_runtime().expect("async runtime initialized");
    // aimux-async-seam: test - drive the production future deadline and queue
    aimux::async_runtime::block_on_named("test:loop-delivery-budget-rotation", async {
        let input = buffered_fleet_input(&["a", "b", "c"], 60_000);
        let directory = temp_state_dir("actual-delivery-deadline-rotation");
        let path = loop_watcher_state_path(&directory);
        let mut watcher = LoopWatcher::new();
        assert_eq!(buffer_actual_fleet_notices(&mut watcher, &input).len(), 3);
        let queue = loop_delivery_queue(&watcher, &input, vec![], NOW, 8);
        assert_eq!(queue[0].session_id, "a");
        let budget = TickLoopBudget::new(Duration::from_millis(20));
        let outcome = tokio::time::timeout(
            Duration::from_millis(250),
            deliver_loop_send_with_budget(&queue[0], &budget, std::future::pending::<bool>()),
        )
        .await
        .expect(
            "the production scan deadline must fire before the outer scheduler cancels bookkeeping",
        );
        let LoopDeliveryOutcome::Failed { error } = &outcome else {
            panic!("a pending delivery must return a named failure: {outcome:?}");
        };
        assert!(error.contains("loop delivery to a "), "{error}");
        assert!(error.contains("remaining scan deadline"), "{error}");
        watcher.commit_send_result(&queue[0], NOW, outcome);
        assert!(budget.spent());
        save_loop_watcher_state(&path, &watcher)
            .expect("persist timed-out attempt before outer deadline");
        watcher = load_loop_watcher_state(&path).expect("reload timed-out attempt");
        assert_eq!(watcher.last_delivery_recipient(), Some("a"));
        assert!(
            !watcher.buffered_send_retry_due(&queue[0], NOW + 1, 60_000),
            "timeout must persist the same failure backoff as a returned delivery error"
        );
        let mut attempted = vec!["a".to_owned()];
        for tick in 1..3 {
            // A becomes eligible again before the next tick. The durable
            // attempt cursor, rather than only backoff, must let B and C lead.
            let at = NOW + tick * 60_000;
            let queue = loop_delivery_queue(&watcher, &input, vec![], at, 8);
            let send = &queue[0];
            let budget = TickLoopBudget::new(Duration::from_secs(1));
            let outcome =
                deliver_loop_send_with_budget(send, &budget, std::future::ready(true)).await;
            assert_eq!(outcome, LoopDeliveryOutcome::Delivered);
            attempted.push(send.session_id.clone());
            watcher.commit_send_result(send, at, outcome);
            watcher.remove_buffered_send(send);
            save_loop_watcher_state(&path, &watcher).expect("save healthy delivery");
            watcher = load_loop_watcher_state(&path).expect("reload healthy delivery");
        }
        assert_eq!(attempted, ["a", "b", "c"]);
    });
}

#[test]
fn fast_delivery_succeeds_within_the_remaining_budget_and_preparation_cannot_reset_it() {
    use aimux::project_service::loop_watcher_task::deliver_loop_send_with_budget;
    use aimux::project_service::watcher_delivery::TickLoopBudget;
    use std::time::Duration;
    aimux::async_runtime::init_process_runtime().expect("async runtime initialized");
    // aimux-async-seam: test - check production deadline success and spent inverse
    aimux::async_runtime::block_on_named("test:loop-delivery-budget-success", async {
        let input = buffered_fleet_input(&["healthy"], 0);
        let mut watcher = LoopWatcher::new();
        let sends = buffer_actual_fleet_notices(&mut watcher, &input);
        let send = &sends[0];
        let budget = TickLoopBudget::new(Duration::from_secs(1));
        assert_eq!(
            deliver_loop_send_with_budget(send, &budget, std::future::ready(true)).await,
            LoopDeliveryOutcome::Delivered
        );
        let spent_by_preparation = TickLoopBudget::new(Duration::ZERO);
        let outcome =
            deliver_loop_send_with_budget(send, &spent_by_preparation, std::future::ready(true))
                .await;
        let LoopDeliveryOutcome::Failed { error } = outcome else {
            panic!("an already spent scan cannot begin a fresh delivery allowance");
        };
        assert!(error.contains("healthy"), "{error}");
        assert!(error.contains("remaining scan deadline (0ms)"), "{error}");
    });
}

/// The measured failure: four agents, each on its own stop -> brief -> nudge ->
/// stop cycle, woke one overseer 32 times in 18 minutes. Every per-agent gate
/// was working; none of them counts wakes. Reproduced here with two agents
/// taking turns, the smallest fleet that defeats them -- each return is a
/// first report, because the brief that ended one episode also evicted the
/// dwell state that would have throttled the next.
#[test]
fn an_alternating_fleet_cannot_wake_one_overseer_faster_than_the_floor() {
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker_a, a_meta) = looping_session("worker-a", "idle");
    let (worker_b, b_meta) = looping_session("worker-b", "running");
    let mut input = input_with_config(
        vec![boss, worker_a, worker_b],
        json!({ "sessions": {
            "boss": boss_meta,
            "worker-a": a_meta,
            "worker-b": b_meta
        }}),
        // Deliberately NOT equal to the floor. With both at 60s a floor that
        // accidentally read `nudgeCooldownMs` would pass this gate, and the
        // whole point is that the per-agent cooldown cannot do this job.
        json!({
            "nudgeCooldownMs": 0,
            "stoppedDwellMs": 0,
            "unchangedReminderTicks": 4,
            "recipientWakeFloorMs": 60_000
        }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    let mut wake_times = Vec::new();
    for tick in 0..=12i64 {
        let (a, b) = if tick % 2 == 0 {
            ("idle", "running")
        } else {
            ("running", "idle")
        };
        input["metadata"]["sessions"]["worker-a"]["derived"]["activity"] = json!(a);
        input["metadata"]["sessions"]["worker-b"]["derived"]["activity"] = json!(b);
        let at = NOW + tick * 15_000;
        if !watcher.scan(&input, at, &mut ok).is_empty() {
            wake_times.push(at);
        }
    }

    for pair in wake_times.windows(2) {
        assert!(
            pair[1] - pair[0] >= 60_000,
            "two briefings landed {}ms apart: {wake_times:?}",
            pair[1] - pair[0]
        );
    }
    // The other direction matters just as much: a floor that silenced the
    // recipient entirely would pass the assertion above and lose the fleet.
    assert!(
        wake_times.len() >= 3,
        "180s of a stopped fleet must still brief the overseer: {wake_times:?}"
    );
}

/// Withholding is not dropping. The agent that was not briefed was therefore
/// not nudged, so it is still stopped and still a candidate, and the briefing
/// the floor finally allows is built fresh from whoever is due by then.
#[test]
fn a_standing_condition_withheld_by_the_floor_is_briefed_once_it_lifts() {
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({
            "nudgeCooldownMs": 0,
            "stoppedDwellMs": 0,
            "recipientWakeFloorMs": 60_000
        }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    let first = watcher.scan(&input, NOW, &mut ok);
    assert_eq!(first.len(), 1);
    assert!(briefing_mentions(&first[0], "worker"));

    assert!(
        watcher.scan(&input, NOW + 30_000, &mut ok).is_empty(),
        "inside the floor the recipient is not woken"
    );

    let after = watcher.scan(&input, NOW + 60_000, &mut ok);
    assert_eq!(after.len(), 1, "the condition is still standing");
    assert!(
        briefing_mentions(&after[0], "worker"),
        "the withheld agent must be in the briefing the floor allowed"
    );
}

/// The floor counts wakes of one recipient; a direct nudge carries the
/// recipient's OWN goal and has its own cooldown. Gating it would make the
/// overseer's own work hostage to the fleet's briefing cadence.
#[test]
fn the_wake_floor_does_not_withhold_an_overseers_own_goal_nudge() {
    let (mut boss, mut boss_meta) = looping_session("boss", "idle");
    boss["status"] = json!("running");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({
            "nudgeCooldownMs": 0,
            "stoppedDwellMs": 0,
            "recipientWakeFloorMs": 60_000
        }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    let armed = watcher.scan(&input, NOW, &mut ok);
    // The floor is armed by a DELIVERED briefing and nothing else, so without
    // this the assertions below would pass vacuously on a run that never
    // planned one.
    assert!(
        armed
            .iter()
            .any(|send| send.kind == LoopSendKind::OverseerBriefing),
        "the first scan must deliver a briefing to arm the floor: {armed:?}"
    );

    let inside_floor = watcher.scan(&input, NOW + 15_000, &mut ok);
    assert!(
        inside_floor
            .iter()
            .all(|send| send.kind != LoopSendKind::OverseerBriefing),
        "a briefing escaped the floor: {inside_floor:?}"
    );
    assert!(
        inside_floor
            .iter()
            .any(|send| send.kind == LoopSendKind::DirectNudge && send.session_id == "boss"),
        "the overseer's own goal nudge must not be withheld: {inside_floor:?}"
    );
}

/// A floor armed by ATTEMPTS rather than wakes trades a real interruption for
/// a silence nobody observes: the send failed, so the recipient learned
/// nothing, and a failed briefing is never buffered -- the next scan is its
/// only carrier.
#[test]
fn a_briefing_that_failed_to_deliver_does_not_arm_the_wake_floor() {
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({
            "nudgeCooldownMs": 0,
            "stoppedDwellMs": 0,
            "recipientWakeFloorMs": 60_000
        }),
    );

    let mut watcher = LoopWatcher::new();
    let mut fail = |_: &LoopSend| false;
    let attempted = watcher.scan(&input, NOW, &mut fail);
    assert!(
        attempted
            .iter()
            .any(|send| send.kind == LoopSendKind::OverseerBriefing),
        "the scan under test must have attempted a briefing: {attempted:?}"
    );

    let mut ok = |_: &LoopSend| true;
    let retry = watcher.scan(&input, NOW + 15_000, &mut ok);
    assert!(
        retry
            .iter()
            .any(|send| send.kind == LoopSendKind::OverseerBriefing),
        "a briefing nobody received must not space out the next one: {retry:?}"
    );
}

/// The floor withholds, and withholding happens BEFORE the global pause gets
/// to buffer. A pause that silenced its own buffer would become the permanent
/// suppression the pause design exists to prevent -- and it would get there on
/// its own, because committing a send as `Buffered` advances the same wake
/// clock the floor reads.
#[test]
fn a_global_pause_still_buffers_briefings_the_wake_floor_would_withhold() {
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({
            "nudgeCooldownMs": 0,
            "stoppedDwellMs": 0,
            "recipientWakeFloorMs": 60_000
        }),
    );

    let mut watcher = LoopWatcher::new();
    // ARM the floor first. Without this the test proves nothing: a paused scan
    // only ever commits `Buffered`, which never arms the clock, so there was no
    // floor for the pause to survive and the assertions below passed on an
    // unarmed watcher.
    let mut ok = |_: &LoopSend| true;
    let armed = watcher.scan(&input, NOW, &mut ok);
    assert!(
        armed
            .iter()
            .any(|send| send.kind == LoopSendKind::OverseerBriefing),
        "the floor must be armed before the pause, or this gate is vacuous: {armed:?}"
    );
    watcher.set_global_pause(NOW, NOW + 600_000, LoopAlertPauseProvenance::default());

    // INSIDE the armed floor the withholding is what runs, so there is nothing
    // to buffer. This is the half that makes the test about the floor at all:
    // run it only on the far side and deleting
    // `withhold_briefings_within_wake_floor` changes nothing here.
    for tick in 1..4i64 {
        let at = NOW + tick * 15_000;
        let planned = watcher.plan_sends(&input, at);
        assert!(
            !planned
                .iter()
                .any(|send| send.kind == LoopSendKind::OverseerBriefing),
            "inside the floor a paused scan must withhold, not buffer: {planned:?}"
        );
        for send in &planned {
            watcher.buffer_send(send, at);
            watcher.commit_send_result(send, at, LoopDeliveryOutcome::Buffered);
        }
    }
    assert_eq!(
        watcher.buffered_send_count(),
        0,
        "nothing is buffered while the floor still holds"
    );

    // Once it lifts, the pause takes over and buffers again -- which is the
    // contract the floor must not break, because a pause that silenced its own
    // buffer would become the permanent suppression the design rejects.
    for tick in 4..8i64 {
        let at = NOW + tick * 15_000;
        let planned = watcher.plan_sends(&input, at);
        assert!(
            planned
                .iter()
                .any(|send| send.kind == LoopSendKind::OverseerBriefing),
            "a paused scan at +{}ms produced nothing to buffer: {planned:?}",
            tick * 15_000
        );
        for send in &planned {
            watcher.buffer_send(send, at);
            watcher.commit_send_result(send, at, LoopDeliveryOutcome::Buffered);
        }
    }
    assert!(
        watcher.buffered_send_count() > 0,
        "the pause must have something to flush when it lifts"
    );
}

/// A pause buffers a briefing every scan, and the candidate set churns, so
/// each one carries a different fingerprint and the delivery queue's dedupe
/// (equal signature or equal text) never collapses them. Left alone, resuming
/// handed the overseer a run of stale partial briefings -- the pause-end burst
/// the alert design set out to avoid, arriving through the buffer instead of
/// the planner.
#[test]
fn a_pause_keeps_one_briefing_per_recipient_however_often_the_fleet_changes() {
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker_a, a_meta) = looping_session("worker-a", "idle");
    let (worker_b, b_meta) = looping_session("worker-b", "running");
    let mut input = input_with_config(
        vec![boss, worker_a, worker_b],
        json!({ "sessions": {
            "boss": boss_meta,
            "worker-a": a_meta,
            "worker-b": b_meta
        }}),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    watcher.set_global_pause(NOW, NOW + 600_000, LoopAlertPauseProvenance::default());

    let mut signatures = Vec::new();
    for tick in 0..6i64 {
        let (a, b) = if tick % 2 == 0 {
            ("idle", "running")
        } else {
            ("idle", "idle")
        };
        input["metadata"]["sessions"]["worker-a"]["derived"]["activity"] = json!(a);
        input["metadata"]["sessions"]["worker-b"]["derived"]["activity"] = json!(b);
        let at = NOW + tick * 15_000;
        for send in watcher.plan_sends(&input, at) {
            if send.kind == LoopSendKind::OverseerBriefing {
                signatures.push(send.signature.clone());
            }
            watcher.buffer_send(&send, at);
            watcher.commit_send_result(&send, at, LoopDeliveryOutcome::Buffered);
        }
    }

    let newest = signatures
        .last()
        .cloned()
        .expect("the pause must have buffered at least one briefing");
    signatures.dedup();
    assert!(
        signatures.len() > 1,
        "the fleet must actually churn, or this gate proves nothing: {signatures:?}"
    );
    let briefings = watcher
        .buffered_sends_to_deliver(8)
        .into_iter()
        .filter(|send| send.kind == LoopSendKind::OverseerBriefing)
        .collect::<Vec<_>>();
    assert_eq!(
        briefings.len(),
        1,
        "resuming must hand the overseer one current briefing, not one per \
         fingerprint: {briefings:?}"
    );
    // Which one survived is the whole point: keeping the OLDEST would satisfy
    // the count and hand the user a briefing about a fleet that has moved on.
    assert_eq!(
        briefings[0].signature, newest,
        "the surviving buffer must be the newest briefing, not the first"
    );
}

/// Collapsing the buffers must not strand the agents the dropped ones carried.
/// Buffering stamps `last_attempted_ms` on every agent a briefing named, which
/// holds that agent out of the next briefing for a cooldown -- so successive
/// pause briefings are near-disjoint and the survivor is routinely NARROWER
/// than what it replaced. An agent carried only by a dropped entry would
/// otherwise sit suppressed by a briefing that no longer exists.
#[test]
fn collapsing_pause_briefings_hands_back_the_agents_the_dropped_ones_carried() {
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker_a, a_meta) = looping_session("worker-a", "idle");
    let (worker_b, b_meta) = looping_session("worker-b", "running");
    let mut input = input_with_config(
        vec![boss, worker_a, worker_b],
        json!({ "sessions": {
            "boss": boss_meta,
            "worker-a": a_meta,
            "worker-b": b_meta
        }}),
        // A real cooldown, so a stamped agent really is held out of the next
        // briefing -- that is what makes the two buffers disjoint.
        json!({ "nudgeCooldownMs": 60_000, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    watcher.set_global_pause(NOW, NOW + 600_000, LoopAlertPauseProvenance::default());

    let first = watcher.plan_sends(&input, NOW);
    assert!(
        first.iter().any(|send| briefing_mentions(send, "worker-a")),
        "the first buffered briefing must carry worker-a: {first:?}"
    );
    for send in &first {
        watcher.buffer_send(send, NOW);
        watcher.commit_send_result(send, NOW, LoopDeliveryOutcome::Buffered);
    }

    // worker-a stays stopped the whole time; it drops out of the SECOND
    // briefing only because buffering the first one stamped it.
    input["metadata"]["sessions"]["worker-b"]["derived"]["activity"] = json!("idle");
    let second = watcher.plan_sends(&input, NOW + 15_000);
    assert!(
        second
            .iter()
            .any(|send| briefing_mentions(send, "worker-b")),
        "the second buffered briefing must carry worker-b: {second:?}"
    );
    assert!(
        !second
            .iter()
            .any(|send| briefing_mentions(send, "worker-a")),
        "worker-a must be held out by its cooldown, or this gate proves nothing: {second:?}"
    );
    for send in &second {
        watcher.buffer_send(send, NOW + 15_000);
        watcher.commit_send_result(send, NOW + 15_000, LoopDeliveryOutcome::Buffered);
    }

    watcher.clear_global_pause();
    let resumed = watcher.plan_sends(&input, NOW + 16_000);
    assert!(
        resumed
            .iter()
            .any(|send| briefing_mentions(send, "worker-a")),
        "worker-a was carried only by the dropped buffer, so dropping it must \
         hand worker-a back rather than leave it suppressed: {resumed:?}"
    );
}

/// The wake floor governs only what the planner produces. Buffered sends are
/// chained into the delivery queue without passing through it, so on the tick
/// a pause lifts a recipient could take its buffered briefing AND a freshly
/// planned one -- the wake clock is still cold, because a paused scan only
/// ever buffered. Flooring that admission cannot work in the queue builder
/// (one `now_ms` for the whole queue, clock advances later per delivery), so
/// the per-recipient dedupe carries it instead.
#[test]
fn one_recipient_cannot_take_two_briefings_in_one_delivery_tick() {
    use aimux::project_service::loop_watcher_task::loop_delivery_queue;

    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({ "nudgeCooldownMs": 0, "stoppedDwellMs": 0 }),
    );

    let mut watcher = LoopWatcher::new();
    let planned = watcher.plan_sends(&input, NOW);
    let briefing = planned
        .iter()
        .find(|send| send.kind == LoopSendKind::OverseerBriefing)
        .cloned()
        .expect("a briefing must be planned");

    // Two briefings for one recipient that the existing dedupe cannot see as
    // the same: different signature AND different text, which is exactly what
    // a buffered copy and a freshly planned one look like when the candidate
    // set moved while the pause was held.
    let stale = LoopSend {
        session_id: briefing.session_id.clone(),
        text: format!("{}\n- stale-worker (claude) @ /repo", briefing.text),
        signature: format!("{}-stale", briefing.signature),
        kind: LoopSendKind::OverseerBriefing,
    };

    let queue = loop_delivery_queue(&watcher, &input, vec![stale, briefing], NOW, 8);
    let briefings = queue
        .iter()
        .filter(|send| send.kind == LoopSendKind::OverseerBriefing && send.session_id == "boss")
        .count();
    assert_eq!(
        briefings, 1,
        "a recipient must not be woken twice in one tick: {queue:?}"
    );
}

/// What production actually runs with. Every cadence the watcher reads
/// defaults to off, so a config a test wrote itself proves nothing about the
/// shipped numbers -- this reads the same function the task does.
#[test]
fn the_shipped_loop_config_carries_a_recipient_wake_floor() {
    use aimux::project_service::loop_watcher_task::loop_config_from;

    let shipped = loop_config_from(&json!({}));
    assert_eq!(
        shipped.get("recipientWakeFloorMs").and_then(Value::as_i64),
        Some(60_000),
        "shipped loop config: {shipped}"
    );

    let overridden = loop_config_from(&json!({ "loop": { "recipientWakeFloorMs": 5_000 } }));
    assert_eq!(
        overridden
            .get("recipientWakeFloorMs")
            .and_then(Value::as_i64),
        Some(5_000),
        "an explicit floor must win: {overridden}"
    );
}

/// Every machine that upgrades into this build loads a state file written
/// before `lastBriefingWakeAt` existed. `#[serde(default)]` makes that load,
/// but default is 0, and 0 is also the value the floor treats as "never
/// briefed" -- so the upgrade must read as a dormant floor and a free first
/// briefing, not as a clock pinned at the epoch that silences the fleet until
/// 1970 plus a minute.
#[test]
fn a_state_file_written_before_the_floor_existed_loads_with_it_dormant() {
    let directory = temp_state_dir("wake-floor-legacy-load");
    let path = loop_watcher_state_path(&directory);
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({
            "nudgeCooldownMs": 0,
            "stoppedDwellMs": 0,
            "recipientWakeFloorMs": DEFAULT_RECIPIENT_WAKE_FLOOR_MS
        }),
    );

    // Arm the floor, save, then strip the field the old build never wrote --
    // at every level, because the clock that matters lives on the sub-watcher.
    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    assert!(!watcher.scan(&input, NOW, &mut ok).is_empty());
    save_loop_watcher_state(&path, &watcher).expect("save loop watcher state");
    let raw = fs::read_to_string(&path).expect("read loop watcher state");
    let stripped = raw
        .lines()
        .filter(|line| !line.contains("lastBriefingWakeAt"))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(
        raw.contains("lastBriefingWakeAt") && !stripped.contains("lastBriefingWakeAt"),
        "the fixture must actually drop the field it is named after"
    );
    fs::write(&path, &stripped).expect("write legacy loop watcher state");

    let mut legacy = load_loop_watcher_state(&path).expect("a pre-field state file must load");
    let first = legacy.scan(&input, NOW + 1_000, &mut ok);
    assert!(
        first
            .iter()
            .any(|send| send.kind == LoopSendKind::OverseerBriefing),
        "an upgraded watcher has never briefed anyone, so its first briefing \
         is free: {first:?}"
    );
    // And the floor arms normally from there, rather than staying dormant.
    let inside = legacy.scan(&input, NOW + 2_000, &mut ok);
    assert!(
        !inside
            .iter()
            .any(|send| send.kind == LoopSendKind::OverseerBriefing),
        "after the first post-upgrade briefing the floor must hold: {inside:?}"
    );
}

/// The project service reloads watcher state from disk on EVERY tick, so the
/// floor does not survive because it is held in memory -- it survives because
/// `into_watcher` restores `last_briefing_wake_at`. Nothing exercised that
/// restore, so zeroing it silently disabled the whole floor while every test
/// stayed green.
#[test]
fn the_wake_floor_survives_the_reload_that_happens_every_tick() {
    let directory = temp_state_dir("wake-floor-reload");
    let path = loop_watcher_state_path(&directory);
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (worker, worker_meta) = looping_session("worker", "idle");
    let input = input_with_config(
        vec![boss, worker],
        json!({ "sessions": { "boss": boss_meta, "worker": worker_meta } }),
        json!({
            "nudgeCooldownMs": 0,
            "stoppedDwellMs": 0,
            "recipientWakeFloorMs": DEFAULT_RECIPIENT_WAKE_FLOOR_MS
        }),
    );

    let mut watcher = LoopWatcher::new();
    let mut ok = |_: &LoopSend| true;
    let armed = watcher.scan(&input, NOW, &mut ok);
    assert!(
        armed
            .iter()
            .any(|send| send.kind == LoopSendKind::OverseerBriefing),
        "the first scan must deliver a briefing to arm the floor: {armed:?}"
    );
    save_loop_watcher_state(&path, &watcher).expect("save loop watcher state");

    // A fresh process, exactly as the scheduler does it.
    let mut restarted = load_loop_watcher_state(&path).expect("load loop watcher state");
    let inside = restarted.scan(&input, NOW + 30_000, &mut ok);
    assert!(
        !inside
            .iter()
            .any(|send| send.kind == LoopSendKind::OverseerBriefing),
        "a reload inside the floor must not hand the recipient another \
         briefing: {inside:?}"
    );
    // And the floor still LIFTS after a reload -- a restore that pinned the
    // clock forward would pass the assertion above and silence the fleet.
    let after = restarted.scan(&input, NOW + 60_000, &mut ok);
    assert!(
        after
            .iter()
            .any(|send| send.kind == LoopSendKind::OverseerBriefing),
        "the floor must still lift on the far side of a reload: {after:?}"
    );
}

/// What the floor actually trades, pinned so it is a decision rather than a
/// surprise. A standing condition costs nothing: an agent that stays stopped
/// is reported exactly as often with the floor as without it AT THE SHIPPED
/// NUMBERS. That is a boundary, not a property, and two tidy explanations of
/// it are both wrong -- measured, with this harness, steady coverage by floor:
///
/// ```text
/// floor   45s  60s  67.5s  90s  120s  180s
/// steady   12   12      4    4     6     4
/// ```
///
/// It is not "off an exact multiple of the reminder period costs coverage":
/// 120s is an exact multiple of 60s and still costs. It is not "a bigger
/// floor costs more" either: 120s scores better than 90s. The floor and
/// `unchangedReminderTicks` are two cadences that alias, because
/// `stopped_candidate_due` fires only on exact multiples of the reminder
/// count, so a withheld due tick defers a whole reminder period rather than
/// resuming when the floor lifts -- and past the boundary the two beat
/// against each other non-monotonically.
///
/// What holds is the boundary itself: coverage is untouched while the floor
/// is no larger than one reminder period, which at the shipped defaults is
/// four scans of 15s, exactly 60s. The shipped floor sits on that line. Both
/// sides of it are asserted below, so raising `recipientWakeFloorMs` shows
/// its price here rather than on a fleet.
///
/// An agent whose stop episode begins and ends inside a closed window is NOT
/// reported, and that is the intended answer -- it unstuck itself, so a later
/// briefing would describe something that had stopped being true.
///
/// An earlier version of this reasoning claimed withholding only ever delays a
/// batch and costs no agent its coverage. Measured, that is false: on a 45s
/// stopped / 45s running cycle beside a permanently stopped agent, over 48
/// scans at the production 15s cadence, the cycling agent appears in 8
/// briefings with no floor and 4 with a 60s floor. The floor is still right --
/// the four it drops had already resolved -- but the cost is real and belongs
/// in a test rather than a commit message.
#[test]
fn the_floor_bounds_the_rate_and_prices_the_coverage_it_costs() {
    let (boss, mut boss_meta) = non_loop_session("boss", "idle");
    boss_meta["overseer"] = json!(true);
    let (steady, steady_meta) = looping_session("steady", "idle");
    let (cycler, cycler_meta) = looping_session("cycler", "running");

    let run = |floor_ms: i64| {
        let mut input = input_with_config(
            vec![boss.clone(), steady.clone(), cycler.clone()],
            json!({ "sessions": {
                "boss": boss_meta.clone(),
                "steady": steady_meta.clone(),
                "cycler": cycler_meta.clone()
            }}),
            json!({
                "nudgeCooldownMs": DEFAULT_RECIPIENT_WAKE_FLOOR_MS,
                "stoppedDwellMs": DEFAULT_STOPPED_DWELL_MS,
                "unchangedReminderTicks": DEFAULT_UNCHANGED_REMINDER_TICKS,
                "recipientWakeFloorMs": floor_ms
            }),
        );
        let mut watcher = LoopWatcher::new();
        let mut ok = |_: &LoopSend| true;
        let (mut total, mut steady_seen, mut cycler_seen) = (0, 0, 0);
        for tick in 0..48i64 {
            let activity = if (tick * DEFAULT_SCAN_INTERVAL_MS) % 90_000 < 45_000 {
                "idle"
            } else {
                "running"
            };
            input["metadata"]["sessions"]["cycler"]["derived"]["activity"] = json!(activity);
            for send in watcher.scan(&input, NOW + tick * DEFAULT_SCAN_INTERVAL_MS, &mut ok) {
                if send.kind != LoopSendKind::OverseerBriefing {
                    continue;
                }
                total += 1;
                if briefing_mentions(&send, "steady") {
                    steady_seen += 1;
                }
                if briefing_mentions(&send, "cycler") {
                    cycler_seen += 1;
                }
            }
        }
        (total, steady_seen, cycler_seen)
    };

    let (unbounded_total, unbounded_steady, unbounded_cycler) = run(0);
    let (floored_total, floored_steady, floored_cycler) = run(DEFAULT_RECIPIENT_WAKE_FLOOR_MS);

    // Asserted rather than bounded. A `<=` on the cycling agent would pass if
    // the floor dropped it entirely, which is the failure this pins.
    assert_eq!(
        (unbounded_total, unbounded_steady, unbounded_cycler),
        (16, 12, 8),
        "the unfloored baseline moved; re-measure before changing the floor"
    );
    assert_eq!(
        (floored_total, floored_steady, floored_cycler),
        (12, 12, 4),
        "floored behaviour moved; the trade below is what this test exists for"
    );

    // The standing condition costs nothing. Note it is NOT that such an agent
    // is in every briefing -- unfloored, 12 of 16 briefings mention it and the
    // other 4 are about the cycling agent alone. It is that the floor removes
    // none of its coverage.
    assert_eq!(
        floored_steady, unbounded_steady,
        "a floor must not cost an agent that stays stopped any of its coverage"
    );
    // The whole cost falls on the agent that keeps unsticking itself, whose
    // episodes begin and end inside a closed window. Half its coverage, and
    // intended: those episodes had already resolved.
    assert!(
        floored_cycler < unbounded_cycler,
        "the trade this pins is real: {floored_cycler} vs {unbounded_cycler}"
    );

    // Both sides of the boundary, because the equality above is only true on
    // it. One reminder period is `unchangedReminderTicks` scans; under it and
    // on it the standing agent keeps every briefing it would have had.
    let reminder_period_ms = DEFAULT_SCAN_INTERVAL_MS * DEFAULT_UNCHANGED_REMINDER_TICKS as i64;
    assert_eq!(
        reminder_period_ms, DEFAULT_RECIPIENT_WAKE_FLOOR_MS,
        "the shipped floor is supposed to sit exactly on one reminder period; \
         if that changed, re-measure the table above before trusting it"
    );
    let (_, under_steady, _) = run(reminder_period_ms - DEFAULT_SCAN_INTERVAL_MS);
    assert_eq!(
        under_steady, unbounded_steady,
        "under the boundary the standing agent must keep all its coverage"
    );

    // And over it, it does not. Asserted on a floor one half-scan past the
    // line rather than a large one, because the cost is not proportional:
    // measured, 120s scores BETTER than 90s. A `<` on a much larger floor
    // would pass while hiding that.
    let over = reminder_period_ms + DEFAULT_SCAN_INTERVAL_MS / 2;
    let (_, over_steady, _) = run(over);
    assert!(
        over_steady < unbounded_steady,
        "past the boundary the standing agent pays too, which is the half of \
         this trade the shipped numbers hide: {over_steady} vs {unbounded_steady}"
    );
}
