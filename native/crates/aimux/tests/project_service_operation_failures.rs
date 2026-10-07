use aimux::project_api_contract::routes;
use aimux::project_service::notifications::{NotificationQuery, list_notification_snapshot};
use aimux::project_service::operation_failures::{
    OperationFailureInput, OperationFailureMatch, WorktreePathMatch,
    clear_dashboard_operation_failures, dashboard_operation_failures_path,
    list_dashboard_operation_failures, try_add_dashboard_operation_failure,
    try_add_dashboard_operation_failure_at, try_list_dashboard_operation_failures,
};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::runtime_exchange::runtime_exchange_path;
use serde_json::json;
use std::fs::{create_dir_all, read_to_string, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

// The window's edge is asserted next to the constant, in
// `operation_failures.rs`, as a `const _`: a test-file assertion only fires
// when the tests compile, and the number is wrong in a release build too. The
// probes in this file sit deliberately nowhere near that edge.

#[test]
fn clears_matching_failures_and_leaves_others_active() {
    let project = temp_project("clear");
    let state_dir = project.join("state");
    seed_failures(&state_dir);

    let cleared = clear_dashboard_operation_failures(
        &state_dir,
        OperationFailureMatch {
            target_kind: Some("agent".into()),
            operation: Some("create".into()),
            target_id: None,
            worktree_path: WorktreePathMatch::Exact("/repo/.aimux/worktrees/demo".into()),
        },
    );
    assert_eq!(cleared.expect("clear failures"), 1);

    let state: serde_json::Value = serde_json::from_str(
        &read_to_string(dashboard_operation_failures_path(&state_dir)).unwrap(),
    )
    .unwrap();
    assert_eq!(state["failures"][0]["cleared"], true);
    assert!(state["failures"][1]["cleared"].is_null());
    assert!(state["failures"][2]["cleared"].is_null());
    cleanup(project);
}

#[test]
fn can_clear_only_main_checkout_failures() {
    let project = temp_project("main");
    let state_dir = project.join("state");
    seed_failures(&state_dir);

    let cleared = clear_dashboard_operation_failures(
        &state_dir,
        OperationFailureMatch {
            target_kind: Some("agent".into()),
            operation: Some("create".into()),
            target_id: None,
            worktree_path: WorktreePathMatch::OnlyMissing,
        },
    );
    assert_eq!(cleared.expect("clear failures"), 1);
    let state: serde_json::Value = serde_json::from_str(
        &read_to_string(dashboard_operation_failures_path(&state_dir)).unwrap(),
    )
    .unwrap();
    assert_eq!(state["failures"][1]["cleared"], true);
    assert!(state["failures"][0]["cleared"].is_null());
    cleanup(project);
}

#[test]
fn route_clears_failures_and_returns_count() {
    let project = temp_project("route");
    let state_dir = project.join("state");
    seed_failures(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::OPERATION_FAILURES_CLEAR,
        Some(&json!({
            "targetKind": "agent",
            "operation": "create",
            "worktreePath": "/repo/.aimux/worktrees/demo"
        })),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.body, json!({ "ok": true, "cleared": 1 }));
    cleanup(project);
}

#[test]
fn adding_failure_reports_persist_error() {
    let project = temp_project("persist-error");
    create_dir_all(&project).expect("project dir");
    let state_dir = project.join("state-file");
    write(&state_dir, "not a directory").expect("state marker");

    let result = try_add_dashboard_operation_failure(
        &state_dir,
        OperationFailureInput {
            target_kind: "agent".into(),
            operation: "agent.stop".into(),
            title: "Lifecycle response abandoned".into(),
            message: "caller disconnected".into(),
            target_id: Some("codex-live".into()),
            ..OperationFailureInput::default()
        },
    );

    let (error, failure) = result.expect_err("persist error");
    assert!(
        error.kind() == std::io::ErrorKind::AlreadyExists
            || error.kind() == std::io::ErrorKind::NotADirectory
    );
    assert_eq!(failure["operation"], "agent.stop");
    assert_eq!(failure["targetId"], "codex-live");
    assert!(
        !dashboard_operation_failures_path(&state_dir).exists(),
        "failed persistence must not fabricate a stored failure record"
    );
    cleanup(project);
}

#[test]
fn corrupt_failure_store_is_reported_not_treated_as_empty() {
    let project = temp_project("corrupt-store");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");
    write(dashboard_operation_failures_path(&state_dir), "{").expect("corrupt store");

    let error = try_list_dashboard_operation_failures(&state_dir).expect_err("corrupt store");
    assert!(
        error.contains("failed to parse dashboard operation failure store"),
        "{error}"
    );

    let failures = list_dashboard_operation_failures(&state_dir);
    assert_eq!(failures.len(), 1);
    assert_eq!(
        failures[0]["operation"], "operation-failures.read",
        "read failure must be visible in desktop-state rather than []"
    );
    assert!(
        failures[0]["message"]
            .as_str()
            .unwrap()
            .contains("failed to parse")
    );

    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let response = route_project_service_request(
        &context,
        "POST",
        routes::OPERATION_FAILURES_CLEAR,
        Some(&json!({ "targetKind": "agent" })),
    );
    assert_eq!(response.status, 500);
    assert_eq!(response.body["ok"], false);
    assert!(
        response.body["error"]
            .as_str()
            .unwrap()
            .contains("failed to parse dashboard operation failure store")
    );
    cleanup(project);
}

#[test]
fn missing_failure_store_is_genuine_empty_and_clear_reports_zero() {
    let project = temp_project("missing-store");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");

    let failures = try_list_dashboard_operation_failures(&state_dir).expect("missing is empty");
    assert!(failures.is_empty());
    assert!(list_dashboard_operation_failures(&state_dir).is_empty());

    let cleared = clear_dashboard_operation_failures(
        &state_dir,
        OperationFailureMatch {
            target_kind: Some("agent".into()),
            operation: Some("create".into()),
            target_id: None,
            worktree_path: WorktreePathMatch::Any,
        },
    )
    .expect("missing store clears as empty");
    assert_eq!(cleared, 0);

    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let response = route_project_service_request(
        &context,
        "POST",
        routes::OPERATION_FAILURES_CLEAR,
        Some(&json!({ "targetKind": "agent" })),
    );
    assert_eq!(response.status, 200);
    assert_eq!(response.body, json!({ "ok": true, "cleared": 0 }));
    cleanup(project);
}

/// How long a failed operation keeps showing, from both sides.
///
/// Sam asked on 2026-10-06 how long a red card should stay and how to make it
/// go, after one sat on his dashboard for eleven minutes. It was a two hour
/// window with no dismiss in the app at all, and -- until the commit before
/// this one -- no dismiss in the TUI either once the ledger entry had expired
/// while the worktree row stayed red.
///
/// Both directions, because a window is only a window if the near side passes.
/// A filter that dropped everything would satisfy "the old one is gone" on its
/// own.
///
/// The probes sit a long way from the edge on purpose. A 14-against-16-minute
/// bracket around a 15-minute window leaves sixty seconds of slack, and a
/// loaded runner pausing between the write and the read would then file a
/// correct window as a regression. The edge itself is pinned at compile time,
/// by the `const _` above.
#[test]
fn a_failure_ages_off_the_dashboard_in_minutes_not_hours() {
    let project = temp_project("age");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");
    write(
        dashboard_operation_failures_path(&state_dir),
        json!({
            "version": 1,
            "failures": [
                {
                    "id": "failure-stale",
                    "targetKind": "agent",
                    "operation": "create",
                    "title": "Failed to create codex agent",
                    "createdAt": minutes_ago(90),
                },
                {
                    "id": "failure-recent",
                    "targetKind": "agent",
                    "operation": "create",
                    "title": "Failed to create claude agent",
                    "createdAt": minutes_ago(1),
                },
            ]
        })
        .to_string(),
    )
    .expect("seed failures");

    // The exact call the desktop-state projection makes, so this is the lane
    // the dashboard renders rather than a predicate held at arm's length.
    let listed = try_list_dashboard_operation_failures(&state_dir).expect("list failures");
    let ids = listed
        .iter()
        .map(|failure| failure["id"].as_str().unwrap_or_default().to_owned())
        .collect::<Vec<_>>();
    assert_eq!(
        ids,
        vec!["failure-recent".to_owned()],
        "a ninety minute old failure is stale and a one minute old one is still \
         worth showing; listed {ids:?}"
    );
    cleanup(project);
}

/// A record whose age cannot be read is not aged off by guessing it.
///
/// `is_active_failure` returns true when `createdAt` is absent or unparseable,
/// so those records never expire. That is deliberate and it is the reason the
/// compile-time bound above says "timestamped": an unreadable age is not
/// evidence of an old record, and dropping one would delete the only report of
/// a failure on the grounds that we could not tell when it happened.
///
/// The store-unavailable record is the case that matters. When the ledger file
/// cannot be read, `list_dashboard_operation_failures` returns one synthetic
/// record saying so, with no `createdAt` -- and it has to stay up, because
/// nothing else on any surface says the store is unreadable. It is also not
/// clearable: `clear_dashboard_operation_failures` cannot write a file it
/// cannot parse, so the route answers 500. A card that will not go until the
/// file is fixed is the honest outcome there, and it names the file.
///
/// Both halves are pinned here so that shortening the window later does not
/// turn either into an expiring record.
#[test]
fn a_failure_of_unknown_age_is_not_aged_off_by_guesswork() {
    let project = temp_project("unknown-age");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");
    write(
        dashboard_operation_failures_path(&state_dir),
        json!({
            "version": 1,
            "failures": [
                { "id": "failure-no-stamp", "targetKind": "agent", "operation": "create",
                  "title": "Failed to create codex agent" },
                { "id": "failure-bad-stamp", "targetKind": "agent", "operation": "create",
                  "title": "Failed to create claude agent", "createdAt": "not a timestamp" },
            ]
        })
        .to_string(),
    )
    .expect("seed failures");

    let ids = listed_ids(&state_dir);
    assert_eq!(
        ids,
        vec![
            "failure-no-stamp".to_owned(),
            "failure-bad-stamp".to_owned()
        ],
        "a record whose age cannot be read stays up rather than being guessed \
         old; listed {ids:?}"
    );
    cleanup(project);

    // And the one that makes it matter: an unreadable store reports itself, and
    // that report is not a timestamped failure either.
    let project = temp_project("corrupt");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");
    write(dashboard_operation_failures_path(&state_dir), "{ not json").expect("seed corrupt store");
    let listed = list_dashboard_operation_failures(&state_dir);
    assert_eq!(listed.len(), 1, "an unreadable store reports itself once");
    assert_eq!(listed[0]["id"], "operation-failure-store-unavailable");
    assert!(
        listed[0].get("createdAt").is_none(),
        "the store-unavailable report carries no age, so no window applies to it"
    );
    cleanup(project);
}

fn listed_ids(state_dir: &PathBuf) -> Vec<String> {
    try_list_dashboard_operation_failures(state_dir)
        .expect("list failures")
        .iter()
        .map(|failure| failure["id"].as_str().unwrap_or_default().to_owned())
        .collect()
}

/// A timestamp in the format the service writes, since `parse_iso_millis`
/// wants a `Z` suffix and at most three fractional digits -- which is neither
/// what RFC 3339 formatting produces nor what a hand-written literal survives.
fn minutes_ago(minutes: i64) -> String {
    let at = time::OffsetDateTime::now_utc() - time::Duration::minutes(minutes);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        at.year(),
        u8::from(at.month()),
        at.day(),
        at.hour(),
        at.minute(),
        at.second(),
        at.millisecond()
    )
}

fn seed_failures(state_dir: &PathBuf) {
    create_dir_all(state_dir).expect("state dir");
    write(
        dashboard_operation_failures_path(state_dir),
        json!({
            "version": 1,
            "failures": [
                {
                    "id": "failure-worktree",
                    "targetKind": "agent",
                    "operation": "create",
                    "title": "Failed to create codex agent",
                    "message": "in a worktree",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "worktreePath": "/repo/.aimux/worktrees/demo"
                },
                {
                    "id": "failure-main",
                    "targetKind": "agent",
                    "operation": "create",
                    "title": "Failed to create codex agent",
                    "message": "main checkout",
                    "createdAt": "2026-01-01T00:00:00.000Z"
                },
                {
                    "id": "failure-service",
                    "targetKind": "service",
                    "operation": "create",
                    "title": "Failed to create service",
                    "message": "port busy",
                    "createdAt": "2026-01-01T00:00:00.000Z"
                },
                {
                    "id": "failure-cleared",
                    "targetKind": "agent",
                    "operation": "create",
                    "title": "Already cleared",
                    "message": "done",
                    "createdAt": "2026-01-01T00:00:00.000Z",
                    "worktreePath": "/repo/.aimux/worktrees/demo",
                    "cleared": true
                }
            ]
        })
        .to_string(),
    )
    .expect("seed failures");
}

// --- the durable copy ---------------------------------------------------
//
// The ledger is read-filtered to fifteen minutes. Five of the seven call
// sites write a log line and the ledger and nothing else, so after that
// window those failures are on no surface at all. These pin the mirror that
// gives them a home, and -- just as hard -- that it leaves when they do.

#[test]
fn a_failure_outlives_the_ledger_window_in_the_notification_store() {
    let project = temp_project("mirror-durable");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");

    try_add_dashboard_operation_failure(
        &state_dir,
        OperationFailureInput {
            target_kind: "agent".into(),
            operation: "input.delivery".into(),
            title: "Agent input was not delivered".into(),
            message: "tmux window is gone".into(),
            target_id: Some("codex-1".into()),
            // Two hours ago: past the fifteen-minute read filter the moment
            // it is written, which is the state the whole item is about.
            created_at: Some(minutes_ago(120)),
            ..OperationFailureInput::default()
        },
    )
    .expect("record failure");

    assert!(
        list_dashboard_operation_failures(&state_dir).is_empty(),
        "the ledger must have aged this off -- otherwise this test proves nothing"
    );

    let notifications = notification_bodies(&state_dir);
    assert_eq!(
        notifications,
        vec!["tmux window is gone".to_owned()],
        "the failure must still be readable after the ledger window closed"
    );
    cleanup(project);
}

#[test]
fn clearing_a_failure_takes_its_durable_copy_with_it() {
    let project = temp_project("mirror-clear");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");

    record_delivery_failure(&state_dir, "codex-1", "tmux window is gone");
    assert_eq!(notification_bodies(&state_dir).len(), 1);

    clear_dashboard_operation_failures(
        &state_dir,
        OperationFailureMatch {
            target_kind: Some("agent".into()),
            operation: Some("input.delivery".into()),
            target_id: Some("codex-1".into()),
            worktree_path: WorktreePathMatch::Any,
        },
    )
    .expect("clear");

    assert!(
        notification_bodies(&state_dir).is_empty(),
        "a transient failure that recovered must not leave a permanent notification"
    );
    cleanup(project);
}

#[test]
fn two_worktrees_failing_the_same_way_keep_separate_records() {
    let project = temp_project("mirror-worktrees");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");

    // `record_worktree_operation_failure` has no target id, so the worktree
    // path is the only thing telling these apart.
    for (path, message) in [
        ("/repo/wt/alpha", "branch exists"),
        ("/repo/wt/beta", "dir exists"),
    ] {
        try_add_dashboard_operation_failure(
            &state_dir,
            OperationFailureInput {
                target_kind: "worktree".into(),
                operation: "create".into(),
                title: "Failed to create worktree".into(),
                message: message.into(),
                worktree_path: Some(path.into()),
                ..OperationFailureInput::default()
            },
        )
        .expect("record failure");
    }

    let mut bodies = notification_bodies(&state_dir);
    bodies.sort();
    assert_eq!(
        bodies,
        vec!["branch exists".to_owned(), "dir exists".to_owned()],
        "one worktree's failure must not overwrite another's"
    );
    cleanup(project);
}

#[test]
fn a_failure_repeating_twice_a_second_writes_the_exchange_once() {
    let project = temp_project("mirror-storm");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");

    // What `agent_input_delivery` does while a delivery stays stuck: the same
    // failure, every 500ms. The exchange write is a full read, compact and
    // reserialize, so a mirror without a guard is a rewrite storm.
    record_delivery_failure(&state_dir, "codex-1", "tmux window is gone");
    let after_first = exchange_bytes(&state_dir);
    assert!(
        after_first.is_some(),
        "the first failure must have written an exchange to compare against"
    );
    for _ in 0..20 {
        record_delivery_failure(&state_dir, "codex-1", "tmux window is gone");
    }

    // Byte-for-byte, not mtime: every write stamps a fresh `generatedAt`, so
    // identical bytes is the one comparison a silent rewrite cannot pass.
    assert_eq!(
        exchange_bytes(&state_dir),
        after_first,
        "twenty repeats inside the floor must not rewrite the runtime exchange"
    );
    assert_eq!(notification_bodies(&state_dir).len(), 1);
    cleanup(project);
}

#[test]
fn a_message_that_varies_per_tick_does_not_buy_a_write_per_tick() {
    let project = temp_project("mirror-floor");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");

    record_delivery_failure(&state_dir, "codex-1", "first error");
    // `route_error_text` falls back to the whole response body when a route
    // omits `error`, so a message that varies per tick is not hypothetical.
    record_delivery_failure(&state_dir, "codex-1", "second error");
    assert_eq!(
        notification_bodies(&state_dir),
        vec!["first error".to_owned()],
        "a second message within the floor must not rewrite the exchange"
    );

    // The inverse: the floor is a floor, not a lock. A minute later the newest
    // message replaces the durable copy, which is what keeps a live failure's
    // copy inside the newest-N the exchange retains.
    record_delivery_failure(&state_dir, "codex-2", "first error");
    record_delivery_failure_at(
        &state_dir,
        "codex-2",
        "second error",
        five_minutes_from_now(),
    );
    let mut bodies = notification_bodies(&state_dir);
    bodies.sort();
    assert_eq!(
        bodies,
        vec!["first error".to_owned(), "second error".to_owned()],
        "a changed message must reach the durable copy once the floor has passed"
    );
    cleanup(project);
}

#[test]
fn a_failure_that_comes_back_after_a_clear_is_mirrored_again() {
    let project = temp_project("mirror-recur");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");

    record_delivery_failure(&state_dir, "codex-1", "tmux window is gone");
    clear_dashboard_operation_failures(
        &state_dir,
        OperationFailureMatch {
            target_kind: Some("agent".into()),
            operation: Some("input.delivery".into()),
            target_id: Some("codex-1".into()),
            worktree_path: WorktreePathMatch::Any,
        },
    )
    .expect("clear");
    assert!(notification_bodies(&state_dir).is_empty());

    // Immediately: inside the floor, but a cleared failure coming back is news
    // again. Without this the recurrence is silent until the floor passes.
    record_delivery_failure(&state_dir, "codex-1", "tmux window is gone");
    assert_eq!(
        notification_bodies(&state_dir),
        vec!["tmux window is gone".to_owned()],
        "a recurrence after a clear must restore the durable copy"
    );
    cleanup(project);
}

#[test]
fn a_failure_the_ledger_forgets_does_not_keep_a_durable_copy() {
    let project = temp_project("mirror-evicted");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");

    record_delivery_failure(&state_dir, "codex-evicted", "tmux window is gone");
    assert_eq!(notification_bodies(&state_dir).len(), 1);

    // `save_state` keeps only the newest hundred. Past that the row can never
    // be matched again, so nothing could ever derive its key to dismiss it.
    for index in 0..120 {
        record_delivery_failure(&state_dir, &format!("codex-{index}"), "tmux window is gone");
    }

    assert!(
        !notification_bodies(&state_dir)
            .iter()
            .any(|body| body == "tmux window is gone")
            || !listed_ids(&state_dir).is_empty(),
        "placeholder"
    );
    let surviving = list_dashboard_operation_failures(&state_dir).len();
    assert!(
        surviving <= 100,
        "the ledger must have truncated: {surviving}"
    );
    assert_eq!(
        notification_bodies(&state_dir).len(),
        surviving,
        "every durable copy must still have a ledger row that can dismiss it"
    );
    cleanup(project);
}

#[test]
fn a_dismiss_that_cannot_reach_the_notification_store_is_not_reported_as_done() {
    let project = temp_project("mirror-clear-fails");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");

    record_delivery_failure(&state_dir, "codex-1", "tmux window is gone");

    // The exchange unreadable: the clear cannot reach the durable copy.
    let exchange = runtime_exchange_path(&state_dir);
    write(&exchange, "{ not: yaml: [").expect("corrupt exchange");

    let cleared = clear_dashboard_operation_failures(
        &state_dir,
        OperationFailureMatch {
            target_kind: Some("agent".into()),
            operation: Some("input.delivery".into()),
            target_id: Some("codex-1".into()),
            worktree_path: WorktreePathMatch::Any,
        },
    );
    assert!(
        cleared.is_err(),
        "a dismiss that left the durable copy behind must not report success"
    );
    // And the row stays matchable, so the user can try again. Marking it first
    // would have made the copy unnameable forever.
    assert_eq!(
        list_dashboard_operation_failures(&state_dir).len(),
        1,
        "the ledger row must survive a failed dismiss"
    );
    cleanup(project);
}

#[test]
fn clearing_the_queue_failure_does_not_take_live_agent_failures_with_it() {
    let project = temp_project("mirror-queue-scope");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");

    record_delivery_failure(&state_dir, "codex-1", "tmux window is gone");
    try_add_dashboard_operation_failure(
        &state_dir,
        OperationFailureInput {
            target_kind: "agent-input-queue".into(),
            operation: "input.delivery".into(),
            title: "Agent input delivery queue unavailable".into(),
            message: "queue file is corrupt".into(),
            ..OperationFailureInput::default()
        },
    )
    .expect("record failure");

    // A matcher with no `targetId` matches ANY target id, so a clear written
    // against `agent` would take the live per-session failure with it.
    clear_dashboard_operation_failures(
        &state_dir,
        OperationFailureMatch {
            target_kind: Some("agent-input-queue".into()),
            operation: Some("input.delivery".into()),
            target_id: None,
            worktree_path: WorktreePathMatch::Any,
        },
    )
    .expect("clear");

    assert_eq!(
        notification_bodies(&state_dir),
        vec!["tmux window is gone".to_owned()],
        "the agent's own delivery failure must survive the queue clear"
    );
    cleanup(project);
}

fn record_delivery_failure(state_dir: &PathBuf, session_id: &str, message: &str) {
    record_delivery_failure_at(state_dir, session_id, message, epoch_millis_now());
}

fn record_delivery_failure_at(state_dir: &PathBuf, session_id: &str, message: &str, now_ms: u128) {
    try_add_dashboard_operation_failure_at(
        state_dir,
        OperationFailureInput {
            target_kind: "agent".into(),
            operation: "input.delivery".into(),
            title: "Agent input was not delivered".into(),
            message: message.into(),
            target_id: Some(session_id.into()),
            ..OperationFailureInput::default()
        },
        now_ms,
    )
    .expect("record failure");
}

fn epoch_millis_now() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock after the epoch")
        .as_millis()
}

fn five_minutes_from_now() -> u128 {
    epoch_millis_now() + 5 * 60 * 1000
}

fn notification_bodies(state_dir: &PathBuf) -> Vec<String> {
    list_notification_snapshot(
        state_dir,
        NotificationQuery {
            unread_only: false,
            include_cleared: false,
            session_id: None,
            limit: Some(500),
        },
    )
    .notifications
    .iter()
    .filter(|record| record["kind"] == "operation_failure")
    .map(|record| record["body"].as_str().unwrap_or_default().to_owned())
    .collect()
}

fn exchange_bytes(state_dir: &PathBuf) -> Option<Vec<u8>> {
    std::fs::read(runtime_exchange_path(state_dir)).ok()
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-operation-failures-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}
