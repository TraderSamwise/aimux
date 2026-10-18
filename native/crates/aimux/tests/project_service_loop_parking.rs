use aimux::async_runtime::{block_on_named, init_process_runtime};
use aimux::core_cli::{CoreCliAction, CoreCliContext, CoreLoopActorContext, classify_core_cli};
use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::text::agents::{
    DaemonAgentTextRuntime, ProjectServicePostOptions, route_agent_text_request,
};
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::daemon_state::{MetadataState, load_metadata_state, save_metadata_state};
use aimux::loop_watcher::{LoopDeliveryOutcome, LoopSendKind, LoopWatcher};
use aimux::project_api_contract::routes;
use aimux::project_service::coordination_worklist::{
    build_coordination_thread_entries, build_coordination_view,
};
use aimux::project_service::loop_watcher_task::{
    LoopWatcherTask, loop_delivery_queue, stopped_metadata_session_ids,
};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::runtime_exchange::{
    runtime_exchange_path, try_read_runtime_exchange, write_runtime_exchange,
};
use aimux::project_service::scheduler::PeriodicTask;
use aimux::runtime_topology::{
    coerce_runtime_topology, list_topology_session_states, read_runtime_topology,
    runtime_topology_path, write_runtime_topology,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

mod support;

const NOW: i64 = 1_788_000_000_000;
const WORKER: &str = "codex-parked";

fn topology() -> Value {
    coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-10-18T00:00:00.000Z",
        "rigs": [{
            "id": "rig-1", "name": "aimux", "projectRoot": "/repo",
            "createdAt": "2026-10-18T00:00:00.000Z", "updatedAt": "2026-10-18T00:00:00.000Z"
        }],
        "nodes": [
            { "id": "node-boss", "rigId": "rig-1", "logicalId": "boss", "toolConfigKey": "codex", "createdAt": "2026-10-18T00:00:00.000Z" },
            { "id": "node-worker", "rigId": "rig-1", "logicalId": WORKER, "toolConfigKey": "codex", "createdAt": "2026-10-18T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "binding-boss", "nodeId": "node-boss", "tmuxSession": "aimux-repo", "tmuxWindowId": "@1", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-10-18T00:00:00.000Z" },
            { "id": "binding-worker", "nodeId": "node-worker", "tmuxSession": "aimux-repo", "tmuxWindowId": "@2", "tmuxWindowIndex": 2, "tmuxWindowName": "codex", "updatedAt": "2026-10-18T00:00:00.000Z" }
        ],
        "sessions": [
            { "id": "boss", "nodeId": "node-boss", "status": "running", "command": "codex", "createdAt": "2026-10-18T00:00:00.000Z", "updatedAt": "2026-10-18T00:00:00.000Z" },
            { "id": WORKER, "nodeId": "node-worker", "status": "running", "command": "codex", "createdAt": "2026-10-18T00:00:00.000Z", "updatedAt": "2026-10-18T00:00:00.000Z" }
        ],
        "services": [], "worktrees": [], "worktreeGraveyard": [],
        "teamRoles": [], "remoteClients": [], "lifecycleOperations": [], "exchangeRefs": []
    }))
    .expect("valid topology")
}

fn write_fixture(state_dir: &Path, worker_activity: &str) -> Value {
    std::fs::create_dir_all(state_dir).expect("create project state");
    write_runtime_topology(runtime_topology_path(state_dir), &topology()).expect("write topology");
    save_metadata_state(
        state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([
                (
                    "boss".into(),
                    json!({ "overseer": true, "derived": { "activity": "busy" } }),
                ),
                (
                    WORKER.into(),
                    json!({ "derived": { "activity": worker_activity } }),
                ),
            ]),
        },
    )
    .expect("write metadata");
    let exchange = json!({ "version": 1, "generatedAt": "2026-10-18T00:00:00.000Z", "tasks": [{
        "id": "task-existing", "status": "pending", "description": "visible queued work"
    }], "threads": [], "messages": [], "handoffs": [] });
    write_runtime_exchange(runtime_exchange_path(state_dir), &exchange).expect("write exchange");
    exchange
}

fn scan_input(state_dir: &Path, exchange: &Value) -> Value {
    json!({
        "sessions": list_topology_session_states(&read_runtime_topology(runtime_topology_path(state_dir)).expect("read scan topology"), None),
        "metadata": load_metadata_state(state_dir),
        "runtimeExchange": exchange,
        "coordinationWorklist": [],
        "pendingInteractions": [],
        "config": { "idleFleetDwellMs": 30_000, "idleFleetReminderTicks": 1, "idleFleetCooldownMs": 0 }
    })
}

fn pause(
    context: &ProjectServiceRequestContext,
) -> aimux::project_service::dispatcher::ProjectServiceDispatchResponse {
    route_project_service_request(
        context,
        "POST",
        routes::agents::LOOP_ALERTS,
        Some(
            &json!({ "sessionId": WORKER, "paused": true, "source": "human", "updatedBy": "sam", "reason": "finished agent deliberately parked" }),
        ),
    )
}

struct RealProjectRouteAdapter<'a> {
    context: &'a ProjectServiceRequestContext,
}

impl DaemonAgentTextRuntime for RealProjectRouteAdapter<'_> {
    fn resolve_project_root(&self, value: &str) -> String {
        value.to_owned()
    }

    fn get_project_service_json(&mut self, project: &str, route: &str) -> ProjectServiceJsonResult {
        let response = route_project_service_request(self.context, "GET", route, None);
        if response.status >= 400 {
            ProjectServiceJsonResult::error(DaemonRouteResponse::json(
                response.status,
                response.body,
            ))
        } else {
            ProjectServiceJsonResult::ok(project, response.body)
        }
    }

    fn post_project_service_json(
        &mut self,
        project: &str,
        route: &str,
        body: Value,
        _options: ProjectServicePostOptions,
    ) -> ProjectServiceJsonResult {
        let response = route_project_service_request(self.context, "POST", route, Some(&body));
        if response.status >= 400 {
            ProjectServiceJsonResult::error(DaemonRouteResponse::json(
                response.status,
                response.body,
            ))
        } else {
            ProjectServiceJsonResult::ok(project, response.body)
        }
    }
}

fn with_fixture(
    label: &str,
    activity: &str,
    run: impl FnOnce(&ProjectServiceRequestContext, &Path, Value),
) {
    let isolation = support::TestIsolation::new(label);
    let project = isolation.root().join("repo");
    let state = isolation.root().join("state");
    std::fs::create_dir_all(&project).expect("create project");
    let exchange = write_fixture(&state, activity);
    let context = isolation.project_context(&project, &state);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        run(&context, &state, exchange);
    }));
    drop(isolation);
    if let Err(panic) = result {
        std::panic::resume_unwind(panic);
    }
}

fn assert_idle_fleet_alarm(state: &Path, exchange: &Value) {
    let input = scan_input(state, exchange);
    let mut watcher = LoopWatcher::new();
    assert!(watcher.plan_sends(&input, NOW).is_empty());
    assert!(watcher.plan_sends(&input, NOW + 29_999).is_empty());
    let sends = watcher.plan_sends(&input, NOW + 30_000);
    assert!(
        sends
            .iter()
            .any(|send| send.kind == LoopSendKind::IdleFleet),
        "a real idle-fleet stall must still alarm: {sends:?}"
    );
}

#[test]
fn non_loop_idle_session_can_be_parked_without_reentering_managed_loop() {
    with_fixture("non-loop-parking", "idle", |context, state, exchange| {
        let response = pause(context);
        assert_eq!(
            response.status, 200,
            "parking must be possible without a managed loop: {}",
            response.body
        );
        assert_eq!(response.body["paused"], true);
        assert_eq!(response.body["parked"], true);
        let metadata = load_metadata_state(state);
        assert!(metadata.sessions[WORKER].get("loop").is_none());
        assert_eq!(
            metadata.sessions[WORKER]["loopAlertsParked"]["reason"],
            "finished agent deliberately parked"
        );

        let mut watcher = LoopWatcher::new();
        let input = scan_input(state, &exchange);
        for now in [NOW, NOW + 30_000, NOW + 90_000] {
            assert!(
                watcher
                    .plan_sends(&input, now)
                    .iter()
                    .all(|send| send.kind != LoopSendKind::IdleFleet),
                "deliberately parked capacity must remain quiet"
            );
        }
        let mut restarted = LoopWatcher::new();
        let input = scan_input(state, &exchange);
        restarted.plan_sends(&input, NOW + 100_000);
        assert!(
            restarted
                .plan_sends(&input, NOW + 130_000)
                .iter()
                .all(|send| send.kind != LoopSendKind::IdleFleet),
            "parking must survive watcher restart"
        );
    });
}

#[test]
fn unparked_stalled_non_loop_worker_still_alarms_after_dwell() {
    with_fixture("unparked-real-stall", "idle", |_, state, exchange| {
        assert_idle_fleet_alarm(state, &exchange);
    });
}

#[test]
fn cli_pause_plan_and_daemon_text_adapter_park_a_non_loop_agent() {
    with_fixture("parking-cli-route", "idle", |context, state, _| {
        let cli = CoreCliContext {
            current_working_dir: "/repo".into(),
            current_project_root: "/repo".into(),
            daemon_running: true,
            has_credentials: false,
            loop_actor: CoreLoopActorContext::default(),
        };
        let plan = classify_core_cli(
            &[
                "loop",
                "pause",
                WORKER,
                "--as-me",
                "--reason",
                "finished intentionally",
            ],
            &cli,
        )
        .expect("CLI pause plan");
        let CoreCliAction::TextRoute { path, body } = plan.action else {
            panic!("pause must use daemon text route")
        };
        assert_eq!(path, CORE_API_ROUTES.loop_pause_text);
        let mut runtime = RealProjectRouteAdapter { context };
        let response = route_agent_text_request(&mut runtime, "POST", &path, body.as_ref())
            .expect("daemon pause route");
        assert_eq!(response.status, 200, "{:?}", response.body);
        let DaemonResponseBody::Text(text) = response.body else {
            panic!("pause must return CLI text")
        };
        assert!(text.contains(WORKER));
        assert!(load_metadata_state(state).sessions[WORKER]["loopAlertsParked"].is_object());
    });
}

#[test]
fn loop_alert_state_exposes_parked_sessions_and_reports_metadata_failure() {
    with_fixture("parking-inspection", "idle", |context, state, _| {
        let empty =
            route_project_service_request(context, "GET", routes::agents::LOOP_ALERTS, None);
        assert_eq!(empty.status, 200);
        assert_eq!(empty.body["loopAlertState"]["parkedSessions"], json!([]));
        assert_eq!(pause(context).status, 200);
        let before = std::fs::read(aimux::daemon_state::metadata_state_path(state)).unwrap();
        let response =
            route_project_service_request(context, "GET", routes::agents::LOOP_ALERTS, None);
        assert_eq!(response.status, 200);
        assert_eq!(
            response.body["loopAlertState"]["parkedSessions"][0]["sessionId"],
            WORKER
        );
        assert_eq!(
            response.body["loopAlertState"]["parkedSessions"][0]["pause"]["reason"],
            "finished agent deliberately parked"
        );
        assert_eq!(
            std::fs::read(aimux::daemon_state::metadata_state_path(state)).unwrap(),
            before
        );
        std::fs::write(aimux::daemon_state::metadata_state_path(state), "{corrupt").unwrap();
        let response =
            route_project_service_request(context, "GET", routes::agents::LOOP_ALERTS, None);
        assert_eq!(response.status, 500);
        assert_eq!(response.body["reason"], "metadata-unavailable");
        assert!(response.body.get("loopAlertState").is_none());
    });
}

#[test]
fn parked_worker_rearms_for_new_assignment_without_input() {
    with_fixture(
        "parked-new-assignment",
        "idle",
        |context, state, mut exchange| {
            assert_eq!(pause(context).status, 200);
            exchange["tasks"].as_array_mut().unwrap().push(json!({
                "id": "task-new", "status": "in_progress", "assignedTo": WORKER,
                "description": "a new unfinished assignment"
            }));
            write_runtime_exchange(runtime_exchange_path(state), &exchange)
                .expect("assign new work");
            assert_idle_fleet_alarm(state, &exchange);
        },
    );
}

#[test]
fn scheduled_loop_watcher_removes_parking_when_work_resumes_before_a_later_stall() {
    with_fixture(
        "parking-scheduled-busy",
        "idle",
        |context, state, exchange| {
            assert_eq!(pause(context).status, 200);
            let mut metadata = load_metadata_state(state);
            metadata.sessions.get_mut(WORKER).unwrap()["derived"]["activity"] = json!("busy");
            save_metadata_state(state, &metadata).expect("resume worker activity");

            let mut task = LoopWatcherTask::new(Arc::new(context.clone()));
            init_process_runtime().expect("initialize scheduled task runtime");
            // aimux-async-seam: test - exercise the scheduled watcher with a known busy fleet
            block_on_named("loop-parking-test:scheduled-watcher", task.run(context))
                .expect("run scheduled loop watcher");
            let mut metadata = load_metadata_state(state);
            assert!(
                metadata.sessions[WORKER].get("loopAlertsParked").is_none(),
                "the scheduled task must durably invalidate parking after genuine resumed work"
            );
            metadata.sessions.get_mut(WORKER).unwrap()["derived"]["activity"] = json!("idle");
            save_metadata_state(state, &metadata).expect("worker stalls after new activity");
            assert_idle_fleet_alarm(state, &exchange);
        },
    );
}

#[test]
fn live_probe_selection_includes_parked_idle_sessions_but_not_ordinary_idle_sessions() {
    with_fixture(
        "parking-probe-selection",
        "idle",
        |context, state, exchange| {
            assert_eq!(pause(context).status, 200);
            let mut input = scan_input(state, &exchange);
            input["sessions"]
                .as_array_mut()
                .unwrap()
                .push(json!({ "id": "ordinary-idle", "status": "running" }));
            input["metadata"]["sessions"]["ordinary-idle"] =
                json!({ "derived": { "activity": "idle" } });
            assert_eq!(
                stopped_metadata_session_ids(&input),
                vec![WORKER.to_owned()]
            );
            input["metadata"]["sessions"][WORKER]["derived"]["activity"] = json!("busy");
            assert!(stopped_metadata_session_ids(&input).is_empty());
        },
    );
}

fn owned_thread(owner_field: &str) -> Value {
    let mut thread = json!({
        "id": "thread-only-work", "kind": "conversation", "status": "open",
        "title": "unfinished thread-only work", "participants": ["user", WORKER],
        "createdAt": "2026-10-18T00:00:00.000Z", "updatedAt": "2026-10-18T00:00:00.000Z"
    });
    thread[owner_field] = if owner_field == "owner" {
        json!(WORKER)
    } else {
        json!([WORKER])
    };
    thread
}

#[test]
fn parked_worker_rearms_when_a_new_owned_or_waiting_thread_is_the_only_work() {
    with_fixture(
        "parking-thread-only-rearm",
        "idle",
        |context, state, mut exchange| {
            exchange["tasks"] = json!([]);
            write_runtime_exchange(runtime_exchange_path(state), &exchange)
                .expect("remove unrelated backlog");
            assert_eq!(pause(context).status, 200);
            for owner_field in ["owner", "waitingOn"] {
                exchange["threads"] = json!([owned_thread(owner_field)]);
                write_runtime_exchange(runtime_exchange_path(state), &exchange)
                    .expect("assign thread-only work");
                assert_idle_fleet_alarm(state, &exchange);
            }
        },
    );
}

#[test]
fn unparked_worker_stalled_on_owned_or_waiting_thread_alarms_without_tasks() {
    with_fixture(
        "unparked-thread-only-stall",
        "idle",
        |_, state, mut exchange| {
            exchange["tasks"] = json!([]);
            for owner_field in ["owner", "waitingOn"] {
                exchange["threads"] = json!([owned_thread(owner_field)]);
                write_runtime_exchange(runtime_exchange_path(state), &exchange)
                    .expect("write thread-only work");
                assert_idle_fleet_alarm(state, &exchange);
            }
        },
    );
}

#[test]
fn parked_session_identity_does_not_silence_recycled_session_or_window() {
    with_fixture(
        "parked-recycled-identity",
        "idle",
        |context, state, exchange| {
            assert_eq!(pause(context).status, 200);
            for changed_field in ["createdAt", "windowId"] {
                let mut changed = topology();
                if changed_field == "createdAt" {
                    changed["sessions"][1]["createdAt"] = json!("2026-10-18T01:00:00.000Z");
                } else {
                    changed["bindings"][1]["tmuxWindowId"] = json!("@3");
                }
                write_runtime_topology(runtime_topology_path(state), &changed)
                    .expect("replace runtime identity");
                assert_idle_fleet_alarm(state, &exchange);
            }
        },
    );
}

#[test]
fn parking_refuses_open_owned_or_waiting_threads() {
    with_fixture(
        "parking-refuses-thread-work",
        "idle",
        |context, state, mut exchange| {
            for owner_field in ["owner", "waitingOn"] {
                let mut thread = json!({
                    "id": "thread-work", "kind": "conversation", "status": "open",
                    "title": "unfinished conversation", "participants": ["user", WORKER],
                    "createdAt": "2026-10-18T00:00:00.000Z", "updatedAt": "2026-10-18T00:00:00.000Z"
                });
                thread[owner_field] = if owner_field == "owner" {
                    json!(WORKER)
                } else {
                    json!([WORKER])
                };
                exchange["threads"] = json!([thread]);
                write_runtime_exchange(runtime_exchange_path(state), &exchange)
                    .expect("write open thread");
                let response = pause(context);
                assert_eq!(response.status, 409, "{owner_field}: {}", response.body);
                assert!(
                    response.body["error"]
                        .as_str()
                        .unwrap()
                        .contains("active owned work")
                );
            }
        },
    );
}

#[test]
fn closed_thread_with_stale_owner_does_not_prevent_deliberate_parking() {
    with_fixture(
        "parking-closed-thread",
        "idle",
        |context, state, mut exchange| {
            exchange["threads"] = json!([{
                "id": "thread-closed", "kind": "conversation", "status": "closed",
                "title": "completed conversation", "participants": ["user", WORKER],
                "owner": WORKER, "waitingOn": [WORKER],
                "createdAt": "2026-10-18T00:00:00.000Z", "updatedAt": "2026-10-18T00:00:00.000Z"
            }]);
            write_runtime_exchange(runtime_exchange_path(state), &exchange)
                .expect("write closed thread");
            let response = pause(context);
            assert_eq!(response.status, 200, "{}", response.body);
        },
    );
}

#[test]
fn unrelated_metadata_and_unassigned_work_changes_keep_parked_worker_quiet() {
    with_fixture(
        "parked-unrelated-changes",
        "done",
        |context, state, mut exchange| {
            assert_eq!(pause(context).status, 200);
            let mut metadata = load_metadata_state(state);
            metadata.sessions.get_mut(WORKER).unwrap()["label"] = json!("finished intentionally");
            metadata.sessions.get_mut(WORKER).unwrap()["updatedAt"] =
                json!("2026-10-18T01:00:00.000Z");
            save_metadata_state(state, &metadata).expect("update unrelated metadata");
            exchange["tasks"][0]["description"] = json!("a renamed unassigned backlog task");
            exchange["tasks"].as_array_mut().unwrap().push(json!({
                "id": "task-unassigned", "status": "pending", "description": "future backlog"
            }));
            let input = scan_input(state, &exchange);
            let mut watcher = LoopWatcher::new();
            for now in [NOW, NOW + 30_000, NOW + 90_000] {
                assert!(
                    watcher
                        .plan_sends(&input, now)
                        .iter()
                        .all(|send| send.kind != LoopSendKind::IdleFleet)
                );
            }
            assert!(load_metadata_state(state).sessions[WORKER]["loopAlertsParked"].is_object());
        },
    );
}

#[test]
fn explicit_unpause_clears_parking_and_rearms_idle_fleet_stall() {
    with_fixture(
        "parked-explicit-unpause",
        "idle",
        |context, state, exchange| {
            assert_eq!(pause(context).status, 200);
            let response = route_project_service_request(
                context,
                "POST",
                routes::agents::LOOP_ALERTS,
                Some(&json!({ "sessionId": WORKER, "paused": false })),
            );
            assert_eq!(response.status, 200, "{}", response.body);
            assert_eq!(response.body["cleared"], true);
            assert!(
                load_metadata_state(state).sessions[WORKER]
                    .get("loopAlertsParked")
                    .is_none()
            );
            assert_idle_fleet_alarm(state, &exchange);
        },
    );
}

#[test]
fn parking_refuses_active_owned_work_and_preserves_real_stall_alarm() {
    with_fixture(
        "parking-refuses-owned-work",
        "idle",
        |context, state, mut exchange| {
            for status in ["pending", "assigned", "in_progress", "blocked"] {
                exchange["tasks"][0]["assignedTo"] = json!(WORKER);
                exchange["tasks"][0]["status"] = json!(status);
                write_runtime_exchange(runtime_exchange_path(state), &exchange)
                    .expect("write assigned work");
                let response = pause(context);
                assert_eq!(response.status, 409, "{status}: {}", response.body);
                assert!(
                    response.body["error"]
                        .as_str()
                        .unwrap()
                        .contains("active owned work"),
                    "{}",
                    response.body
                );
                assert!(
                    load_metadata_state(state).sessions[WORKER]
                        .get("loopAlertsParked")
                        .is_none()
                );
                assert_idle_fleet_alarm(state, &exchange);
            }
        },
    );
}

#[test]
fn parking_refuses_busy_or_unknown_activity() {
    with_fixture("parking-refuses-busy", "idle", |context, state, _| {
        for activity in ["running", "busy", "waiting", "error", "unknown"] {
            let mut metadata = load_metadata_state(state);
            metadata.sessions.get_mut(WORKER).unwrap()["derived"]["activity"] = json!(activity);
            save_metadata_state(state, &metadata).expect("set activity");
            let response = pause(context);
            assert_eq!(response.status, 409, "{activity}: {}", response.body);
            assert!(
                response.body["error"]
                    .as_str()
                    .unwrap()
                    .contains("idle or done")
            );
            assert!(
                load_metadata_state(state).sessions[WORKER]
                    .get("loopAlertsParked")
                    .is_none()
            );
        }
    });
}

#[test]
fn parking_refuses_unknown_or_offline_runtime_sessions() {
    with_fixture("parking-refuses-missing", "idle", |context, state, _| {
        for status in [None, Some("offline")] {
            let mut topology = topology();
            if let Some(status) = status {
                topology["sessions"][1]["status"] = json!(status);
            } else {
                topology["sessions"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|session| session["id"] != WORKER);
            }
            write_runtime_topology(runtime_topology_path(state), &topology)
                .expect("set runtime availability");
            let response = pause(context);
            assert_eq!(response.status, 409, "{status:?}: {}", response.body);
            assert!(
                response.body["error"]
                    .as_str()
                    .unwrap()
                    .contains("runtime topology")
            );
            assert!(
                load_metadata_state(state).sessions[WORKER]
                    .get("loopAlertsParked")
                    .is_none()
            );
        }
    });
}

#[test]
fn parking_reports_inventory_failure_and_rejects_foreign_window_ownership() {
    with_fixture("parking-inventory-error", "idle", |context, state, _| {
        let mut unavailable = context.clone();
        unavailable.live_window_ids = Some(Err("injected inventory failure".into()));
        let response = pause(&unavailable);
        assert_eq!(response.status, 500);
        assert!(
            response.body["error"]
                .as_str()
                .unwrap()
                .contains("injected inventory failure")
        );
        let foreign = context
            .clone()
            .with_live_windows(support::live_windows("foreign-project", &["@1", "@2"]));
        let response = pause(&foreign);
        assert_eq!(response.status, 409);
        assert!(
            response.body["error"]
                .as_str()
                .unwrap()
                .contains("recorded tmux session")
        );
        assert!(
            load_metadata_state(state).sessions[WORKER]
                .get("loopAlertsParked")
                .is_none()
        );
    });
}

#[test]
fn parking_reports_unreadable_topology_and_exchange_without_writing_pause() {
    with_fixture("parking-storage-error", "idle", |context, state, _| {
        std::fs::write(runtime_topology_path(state), "{invalid yaml").expect("break topology");
        let response = pause(context);
        assert_eq!(response.status, 500);
        assert!(
            response.body["error"]
                .as_str()
                .unwrap()
                .contains("topology unavailable")
        );
        write_runtime_topology(runtime_topology_path(state), &topology())
            .expect("restore topology");
        std::fs::write(runtime_exchange_path(state), "{invalid json").expect("break exchange");
        let response = pause(context);
        assert_eq!(response.status, 500);
        assert!(
            response.body["error"]
                .as_str()
                .unwrap()
                .contains("runtime exchange unavailable")
        );
        assert!(
            load_metadata_state(state).sessions[WORKER]
                .get("loopAlertsParked")
                .is_none()
        );
    });
}

#[test]
fn completing_assigned_task_leaves_finished_worker_quiet_and_parkable_while_assigner_reviews() {
    with_fixture(
        "parking-completed-task",
        "idle",
        |context, state, mut exchange| {
            exchange["tasks"] = json!([]);
            write_runtime_exchange(runtime_exchange_path(state), &exchange).expect("empty backlog");
            let assigned = route_project_service_request(
                context,
                "POST",
                routes::tasks::ASSIGN,
                Some(&json!({
                    "from": "boss", "to": WORKER, "description": "finish the assigned work"
                })),
            );
            assert_eq!(assigned.status, 200, "{}", assigned.body);
            let task_id = assigned.body["task"]["id"]
                .as_str()
                .expect("assigned task id");
            let completed = route_project_service_request(
                context,
                "POST",
                routes::tasks::COMPLETE,
                Some(&json!({
                    "taskId": task_id, "from": WORKER, "body": "finished; ready for the assigner's review"
                })),
            );
            assert_eq!(completed.status, 200, "{}", completed.body);
            assert_eq!(completed.body["task"]["status"], "done");
            assert_eq!(completed.body["thread"]["owner"], WORKER);
            assert_eq!(completed.body["thread"]["waitingOn"], json!(["boss"]));
            assert_eq!(completed.body["thread"]["status"], "waiting");

            let exchange = try_read_runtime_exchange(runtime_exchange_path(state))
                .expect("read completed task exchange");
            assert_eq!(exchange["tasks"].as_array().unwrap().len(), 1);
            let mut input = scan_input(state, &exchange);
            let sessions = input["sessions"].as_array().unwrap();
            let threads = build_coordination_thread_entries(&exchange, "user");
            input["coordinationWorklist"] =
                build_coordination_view(sessions, &[], &[], &[], &threads, "user")["worklist"]
                    .clone();
            let mut watcher = LoopWatcher::new();
            for now in [NOW, NOW + 30_000, NOW + 90_000] {
                let sends = watcher.plan_sends(&input, now);
                assert!(
                    sends
                        .iter()
                        .all(|send| send.kind != LoopSendKind::IdleFleet),
                    "a completed worker is not waiting on its own completed task: {sends:?}"
                );
            }
            let parked = pause(context);
            assert_eq!(
                parked.status, 200,
                "a thread waiting for its assigner must not prevent parking its finished worker: {}",
                parked.body
            );
            assert!(load_metadata_state(state).sessions[WORKER]["loopAlertsParked"].is_object());
        },
    );
}

#[test]
fn stale_scan_cannot_erase_a_newer_deliberate_park() {
    let isolation = support::TestIsolation::new("parking-stale-scan");
    let project = isolation.root().join("repo");
    let state = isolation.root().join("state");
    std::fs::create_dir_all(&project).unwrap();
    let exchange = write_fixture(&state, "idle");
    let context = isolation.project_context(&project, &state);
    assert_eq!(pause(&context).status, 200);
    let mut stale = scan_input(&state, &exchange);
    stale["metadata"]["sessions"][WORKER]["derived"]["activity"] = json!("busy");
    let mut newer = load_metadata_state(&state).sessions[WORKER]["loopAlertsParked"].clone();
    newer["reason"] = json!("new deliberate park after the older scan");
    aimux::loop_watcher::set_parked_session_alerts(&state, WORKER, Some(newer.clone())).unwrap();
    aimux::loop_watcher::refresh_parked_session_alerts(&mut stale, &state).unwrap();
    assert_eq!(
        load_metadata_state(&state).sessions[WORKER]["loopAlertsParked"],
        newer
    );
}

fn write_self_exit(state: &Path, action: &str) {
    let mut metadata = load_metadata_state(state);
    metadata.sessions.get_mut(WORKER).unwrap()["loopLastAction"] = json!({
        "action": action, "source": "agent", "updatedBySessionId": WORKER,
        "at": "2026-10-18T00:00:00.000Z", "goal": "finished old loop work",
        "reason": "self-reported loop exit"
    });
    save_metadata_state(state, &metadata).expect("write self-exit metadata");
}

#[test]
fn parked_self_exited_agents_stay_quiet_for_fresh_and_new_overseer_recipients() {
    with_fixture(
        "parking-self-exit-quiet",
        "done",
        |context, state, exchange| {
            for action in ["done", "block"] {
                write_self_exit(state, action);
                assert_eq!(pause(context).status, 200);
                let mut input = scan_input(state, &exchange);
                let mut watcher = LoopWatcher::new();
                assert!(
                    watcher.plan_sends(&input, NOW).is_empty(),
                    "{action}: a parked self-exit must not generate a first-scan notification"
                );
                input["sessions"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({ "id": "new-overseer", "status": "running", "tool": "codex" }));
                input["metadata"]["sessions"]["new-overseer"] =
                    json!({ "overseer": true, "derived": { "activity": "busy" } });
                for now in [NOW + 1, NOW + 90_000] {
                    assert!(
                        watcher.plan_sends(&input, now).is_empty(),
                        "{action}: a new recipient must respect existing parking"
                    );
                }
                assert!(
                    LoopWatcher::new()
                        .plan_sends(&input, NOW + 120_000)
                        .is_empty(),
                    "{action}: watcher restart must preserve parked quietness"
                );
            }
        },
    );
}

#[test]
fn nonparked_self_exited_agents_still_notify_the_overseer() {
    with_fixture("unparked-self-exit-notice", "done", |_, state, exchange| {
        for action in ["done", "block"] {
            write_self_exit(state, action);
            let sends = LoopWatcher::new().plan_sends(&scan_input(state, &exchange), NOW);
            assert!(
                sends
                    .iter()
                    .any(|send| send.kind == LoopSendKind::LoopExit && send.session_id == "boss"),
                "{action}: a genuine unparked self-exit must still notify: {sends:?}"
            );
        }
    });
}

fn buffer_exit_and_idle_fleet(input: &Value) -> LoopWatcher {
    let mut watcher = LoopWatcher::new();
    watcher.plan_sends(input, NOW);
    let sends = watcher.plan_sends(input, NOW + 30_000);
    assert!(sends.iter().any(|send| send.kind == LoopSendKind::LoopExit));
    assert!(
        sends
            .iter()
            .any(|send| send.kind == LoopSendKind::IdleFleet)
    );
    for send in sends
        .iter()
        .filter(|send| matches!(send.kind, LoopSendKind::LoopExit | LoopSendKind::IdleFleet))
    {
        watcher.buffer_send(send, NOW + 30_000);
        watcher.commit_send_result(send, NOW + 30_000, LoopDeliveryOutcome::Buffered);
    }
    assert_eq!(watcher.buffered_send_count(), 2);
    watcher
}

#[test]
fn buffered_old_exit_and_idle_fleet_alerts_do_not_flush_after_parking_and_closed_work() {
    with_fixture(
        "parking-buffered-stale-alerts",
        "done",
        |context, state, mut exchange| {
            write_self_exit(state, "done");
            let watcher = buffer_exit_and_idle_fleet(&scan_input(state, &exchange));
            assert_eq!(pause(context).status, 200);
            exchange["tasks"][0]["status"] = json!("done");
            write_runtime_exchange(runtime_exchange_path(state), &exchange)
                .expect("close old queued work");
            let queue = loop_delivery_queue(
                &watcher,
                &scan_input(state, &exchange),
                vec![],
                NOW + 90_000,
                8,
            );
            assert!(
                queue.is_empty(),
                "buffered old alerts must not bypass parking or closed-work checks: {queue:?}"
            );
        },
    );
}

#[test]
fn buffered_idle_fleet_alert_does_not_flush_when_work_closed_without_parking() {
    with_fixture("buffered-closed-work", "idle", |_, state, mut exchange| {
        let input = scan_input(state, &exchange);
        let mut watcher = LoopWatcher::new();
        watcher.plan_sends(&input, NOW);
        let send = watcher
            .plan_sends(&input, NOW + 30_000)
            .into_iter()
            .find(|send| send.kind == LoopSendKind::IdleFleet)
            .expect("idle-fleet alert");
        watcher.buffer_send(&send, NOW + 30_000);
        watcher.commit_send_result(&send, NOW + 30_000, LoopDeliveryOutcome::Buffered);
        exchange["tasks"][0]["status"] = json!("done");
        let queue = loop_delivery_queue(
            &watcher,
            &scan_input(state, &exchange),
            vec![],
            NOW + 90_000,
            8,
        );
        assert!(
            queue.is_empty(),
            "closed work must invalidate an old buffered alert even with an unparked worker: {queue:?}"
        );
    });
}

#[test]
fn buffered_exit_and_idle_fleet_alerts_still_flush_for_current_unparked_conditions() {
    with_fixture("buffered-live-alerts", "done", |_, state, exchange| {
        write_self_exit(state, "done");
        let input = scan_input(state, &exchange);
        let watcher = buffer_exit_and_idle_fleet(&input);
        let queue = loop_delivery_queue(&watcher, &input, vec![], NOW + 90_000, 8);
        assert_eq!(
            queue.len(),
            2,
            "current buffered conditions must still flush: {queue:?}"
        );
        assert!(queue.iter().any(|send| send.kind == LoopSendKind::LoopExit));
        assert!(
            queue
                .iter()
                .any(|send| send.kind == LoopSendKind::IdleFleet)
        );
    });
}

#[test]
fn buffered_active_loop_briefing_cannot_resurrect_an_agent_after_loop_removal_and_parking() {
    with_fixture(
        "parking-buffered-managed-loop",
        "idle",
        |context, state, exchange| {
            let mut metadata = load_metadata_state(state);
            metadata.sessions.get_mut(WORKER).unwrap()["loop"] = json!({
                "active": true, "since": "2026-10-18T00:00:00.000Z",
                "goal": "finish the old managed loop", "source": "human"
            });
            save_metadata_state(state, &metadata).expect("start managed loop");
            let input = scan_input(state, &exchange);
            let mut watcher = LoopWatcher::new();
            let briefing = watcher
                .plan_sends(&input, NOW)
                .into_iter()
                .find(|send| send.kind == LoopSendKind::OverseerBriefing)
                .expect("stopped managed-loop briefing");
            watcher.buffer_send(&briefing, NOW);
            watcher.commit_send_result(&briefing, NOW, LoopDeliveryOutcome::Buffered);
            let queue = loop_delivery_queue(&watcher, &input, vec![], NOW + 90_000, 8);
            assert!(
                queue
                    .iter()
                    .any(|send| send.kind == LoopSendKind::OverseerBriefing),
                "a current unparked briefing must remain deliverable"
            );

            let removed = route_project_service_request(
                context,
                "POST",
                routes::agents::LOOP,
                Some(&json!({
                    "sessionId": WORKER, "active": false, "action": "done", "source": "human",
                    "reason": "old loop is finished"
                })),
            );
            assert_eq!(removed.status, 200, "{}", removed.body);
            assert_eq!(pause(context).status, 200);
            let queue = loop_delivery_queue(
                &watcher,
                &scan_input(state, &exchange),
                vec![],
                NOW + 90_000,
                8,
            );
            assert!(
                queue.is_empty(),
                "an actual buffered candidate must not bypass later deliberate parking: {queue:?}"
            );
        },
    );
}
