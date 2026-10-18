use aimux::core_cli::{CoreCliAction, CoreCliContext, CoreLoopActorContext, classify_core_cli};
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::text::collaboration::{
    DaemonCollaborationTextRuntime, route_collaboration_text_request,
};
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::loop_watcher::{LoopSend, LoopWatcher};
use aimux::project_api_contract::routes;
use aimux::project_service::desktop_state::{
    DesktopStateInput, build_desktop_state_with_live_window_ids,
};
use aimux::project_service::router::{ProjectServiceRequestContext, route_project_service_request};
use aimux::project_service::runtime_exchange::{
    empty_runtime_exchange, runtime_exchange_path, try_read_runtime_exchange,
    write_runtime_exchange,
};
use serde_json::{Value, json};

mod support;

const THREAD_ID: &str = "thread-obligation";
const NOW: i64 = 1_788_000_000_000;

fn context(isolation: &support::TestIsolation) -> ProjectServiceRequestContext {
    let project = isolation.root().join("repo");
    let state = isolation.root().join("state");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(&state).unwrap();
    isolation
        .project_context(&project, &state)
        .with_desktop_state(json!({
            "sessions": [], "teammates": [], "services": []
        }))
}

fn exchange_with_thread(status: &str) -> Value {
    let mut exchange = empty_runtime_exchange();
    exchange["threads"] = json!([{
        "id": THREAD_ID, "title": "Inspect the outstanding decision", "kind": "conversation",
        "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z",
        "createdBy": "user", "participants": ["user", "reviewer"], "status": status,
        "waitingOn": ["user"], "unreadBy": ["user"], "lastMessageId": "message-obligation"
    }]);
    exchange["messages"] = json!([{
        "id": "message-obligation", "threadId": THREAD_ID, "ts": "2026-01-01T00:00:00.000Z",
        "from": "reviewer", "to": ["user"], "kind": "request", "body": "Please decide",
        "deliveredTo": []
    }]);
    exchange
}

fn save(context: &ProjectServiceRequestContext, exchange: &Value) {
    write_runtime_exchange(runtime_exchange_path(context.project_state_dir()), exchange).unwrap();
}

fn worklist(context: &ProjectServiceRequestContext) -> Value {
    let response =
        route_project_service_request(context, "GET", routes::COORDINATION_WORKLIST, None);
    assert_eq!(response.status, 200, "{}", response.body);
    response.body["worklist"].clone()
}

fn planned_alerts(worklist: Value, exchange: Value) -> Vec<LoopSend> {
    let input = json!({
        "sessions": [
            {"id": "overseer", "tool": "claude", "status": "running"},
            {"id": "available", "tool": "codex", "status": "running"}
        ],
        "metadata": {"sessions": {
            "overseer": {"overseer": true, "derived": {"activity": "busy", "attention": "normal"}},
            "available": {
                "loop": {"active": true, "goal": "Inspect incoming work", "since": "2026-01-01T00:00:00.000Z"},
                "derived": {"activity": "idle", "attention": "normal"}
            }
        }},
        "config": {
            "stoppedDwellMs": 60_000, "reconciliationDwellMs": 0,
            "reconciliationCooldownMs": 0, "idleFleetDwellMs": 0, "idleFleetCooldownMs": 0
        },
        "runtimeExchange": exchange, "coordinationWorklist": worklist, "pendingInteractions": []
    });
    LoopWatcher::new().plan_sends(&input, NOW)
}

#[test]
fn closing_a_thread_clears_waiting_and_stops_the_real_worklist_alert() {
    let isolation = support::TestIsolation::new("worklist-close");
    let context = context(&isolation);
    save(&context, &exchange_with_thread("waiting"));
    assert!(!planned_alerts(worklist(&context), exchange_with_thread("waiting")).is_empty());

    let closed = route_project_service_request(
        &context,
        "POST",
        routes::threads::STATUS,
        Some(&json!({"threadId": THREAD_ID, "status": "closed"})),
    );
    assert_eq!(closed.status, 200, "{}", closed.body);
    assert_eq!(closed.body["thread"]["waitingOn"], json!([]));
    let seen = route_project_service_request(
        &context,
        "POST",
        routes::threads::MARK_SEEN,
        Some(&json!({"threadId": THREAD_ID, "session": "user"})),
    );
    assert_eq!(seen.status, 200);
    let exchange =
        try_read_runtime_exchange(runtime_exchange_path(context.project_state_dir())).unwrap();
    assert_eq!(exchange["threads"][0]["status"], "closed");
    assert!(
        worklist(&context)["needsYou"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(planned_alerts(worklist(&context), exchange).is_empty());
}

#[test]
fn terminal_threads_with_stale_waiting_and_delivery_are_handled_while_open_work_still_alerts() {
    let isolation = support::TestIsolation::new("worklist-terminal-history");
    let context = context(&isolation);
    for status in ["closed", "done", "abandoned"] {
        let exchange = exchange_with_thread(status);
        save(&context, &exchange);
        let list = worklist(&context);
        assert!(
            list["needsYou"].as_array().unwrap().is_empty(),
            "{status}: {list}"
        );
        let row = &list["items"][0];
        assert_eq!(row["key"], format!("t:{THREAD_ID}"));
        assert_eq!(row["actionable"], false, "{status}");
        assert_eq!(row["thread"]["pendingDeliveries"], 0, "{status}");
        assert_eq!(row["thread"]["stateLabel"], status, "{status}");
        assert!(planned_alerts(list, exchange).is_empty(), "{status}");
    }
    let open = exchange_with_thread("waiting");
    save(&context, &open);
    assert!(
        !worklist(&context)["needsYou"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(!planned_alerts(worklist(&context), open).is_empty());
}

#[test]
fn terminal_obligations_agree_across_worklist_desktop_and_derived_waits() {
    let isolation = support::TestIsolation::new("worklist-terminal-surface-parity");
    let context = context(&isolation);
    let project = context.project_root().to_string_lossy().into_owned();
    let topology = json!({
        "version": 1, "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [{"id": "rig", "projectRoot": project}],
        "nodes": [{"id": "node-reviewer", "rigId": "rig", "logicalId": "reviewer", "toolConfigKey": "codex", "cwd": project}],
        "sessions": [{"id": "reviewer", "nodeId": "node-reviewer", "status": "offline", "command": "codex", "worktreePath": project}],
        "bindings": [], "services": [], "worktrees": []
    });
    let metadata = std::collections::BTreeMap::new();
    let windows = support::live_windows("aimux-test", &[]);
    for status in ["waiting", "closed", "done", "abandoned"] {
        let terminal = status != "waiting";
        let mut exchange = exchange_with_thread(status);
        exchange["threads"][0]["owner"] = json!("reviewer");
        exchange["threads"][0]["waitingOn"] = json!(["reviewer"]);
        exchange["messages"][0]["to"] = json!(["reviewer"]);
        save(&context, &exchange);
        let response = route_project_service_request(
            &context,
            "POST",
            routes::threads::MARK_SEEN,
            Some(&json!({"threadId": THREAD_ID, "session": "reviewer"})),
        );
        assert_eq!(response.status, 200, "{}", response.body);
        let exchange =
            try_read_runtime_exchange(runtime_exchange_path(context.project_state_dir())).unwrap();
        let list = worklist(&context);
        let desktop = build_desktop_state_with_live_window_ids(
            DesktopStateInput {
                project_root: project.clone(),
                topology: &topology,
                metadata_sessions: &metadata,
                exchange: &exchange,
            },
            Some(&windows),
        );
        let reviewer = desktop["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|session| session["id"] == "reviewer")
            .expect("the desktop includes the offline reviewer");
        let expected = i64::from(!terminal);
        assert_eq!(
            list["needsYou"].as_array().unwrap().len() as i64,
            expected,
            "{status}: {list}"
        );
        for field in [
            "threadWaitingCount",
            "threadWaitingOnMeCount",
            "threadWaitingOnThemCount",
            "threadPendingCount",
            "workflowOnMeCount",
        ] {
            assert_eq!(reviewer[field], expected, "{status} {field}: {reviewer}");
        }
        assert_eq!(
            exchange["waits"][0]["status"],
            if terminal { "satisfied" } else { "waiting" },
            "{status}: {exchange}"
        );
        assert_eq!(
            exchange["inbox"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["participantId"] == "reviewer" && row["state"] == "waiting"),
            !terminal,
            "{status}: {}",
            exchange["inbox"]
        );
        assert!(
            exchange["inbox"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["participantId"] == "user" && row["state"] == "unread"),
            "terminal closure preserves unread history: {status}"
        );
    }
}

#[test]
fn explicit_waiting_cannot_keep_a_terminal_thread_actionable() {
    let isolation = support::TestIsolation::new("worklist-terminal-explicit-wait");
    let context = context(&isolation);
    for status in ["closed", "done", "abandoned"] {
        save(&context, &exchange_with_thread("waiting"));
        let response = route_project_service_request(
            &context,
            "POST",
            routes::threads::STATUS,
            Some(&json!({"threadId": THREAD_ID, "status": status, "waitingOn": ["user"]})),
        );
        assert_eq!(response.status, 200);
        assert_eq!(response.body["thread"]["waitingOn"], json!([]), "{status}");
    }
}

struct ProjectRouteAdapter<'a>(&'a ProjectServiceRequestContext);

impl DaemonCollaborationTextRuntime for ProjectRouteAdapter<'_> {
    fn get_project_service_json(&mut self, project: &str, path: &str) -> ProjectServiceJsonResult {
        let response = route_project_service_request(self.0, "GET", path, None);
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
        _: &str,
        _: &str,
        _: Value,
        _: Option<u64>,
    ) -> ProjectServiceJsonResult {
        panic!("thread show must remain read-only")
    }
}

fn cli_show(context: &ProjectServiceRequestContext, id: &str) -> DaemonRouteResponse {
    let project = context.project_root().to_string_lossy().into_owned();
    let cli = CoreCliContext {
        current_working_dir: project.clone(),
        current_project_root: project,
        daemon_running: true,
        has_credentials: false,
        loop_actor: CoreLoopActorContext::default(),
    };
    let plan = classify_core_cli(&["thread", "show", id], &cli).unwrap();
    let CoreCliAction::TextRoute { path, body } = plan.action else {
        panic!("thread show must use the daemon text route");
    };
    route_collaboration_text_request(
        &mut ProjectRouteAdapter(context),
        "GET",
        &path,
        body.as_ref(),
    )
    .unwrap()
}

#[test]
fn the_thread_id_advertised_by_the_loop_briefing_resolves_through_the_cli_route() {
    let isolation = support::TestIsolation::new("worklist-advertised-id");
    let context = context(&isolation);
    let exchange = exchange_with_thread("waiting");
    save(&context, &exchange);
    let alerts = planned_alerts(worklist(&context), exchange);
    let advertised = alerts
        .iter()
        .flat_map(|send| send.text.lines())
        .find_map(|line| {
            line.strip_prefix("- thread ")
                .and_then(|tail| tail.split_whitespace().next())
        })
        .expect("the real briefing advertises the thread");
    let shown = cli_show(&context, advertised);
    assert_eq!(shown.status, 200, "advertised id {advertised}: {shown:?}");
    assert_eq!(advertised, THREAD_ID);
    assert_eq!(cli_show(&context, "thread-absent").status, 404);
}

#[test]
fn thread_and_worklist_reads_distinguish_empty_actionable_and_unreadable_state() {
    let isolation = support::TestIsolation::new("worklist-read-outcomes");
    let context = context(&isolation);
    assert!(
        worklist(&context)["needsYou"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(cli_show(&context, THREAD_ID).status, 404);
    save(&context, &exchange_with_thread("waiting"));
    assert!(
        !worklist(&context)["needsYou"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(cli_show(&context, THREAD_ID).status, 200);

    let path = runtime_exchange_path(context.project_state_dir());
    for legacy in [
        "version: 1\ngeneratedAt: now\n",
        "version: 1\ngeneratedAt: now\ntasks: [{id: legacy-task}]\n",
        "version: 1\ngeneratedAt: now\ntasks: [{id: legacy-task, status: null, assignedTo: null}]\n",
    ] {
        std::fs::write(&path, legacy).unwrap();
        assert!(
            worklist(&context)["needsYou"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(cli_show(&context, THREAD_ID).status, 404, "{legacy}");
    }
    for raw in [
        "{",
        "version: 1\ngeneratedAt: now\nthreads: {}\n",
        "version: 1\ngeneratedAt: now\nthreads: [null]\n",
        "version: 1\ngeneratedAt: now\ntasks: {}\n",
        "version: 1\ngeneratedAt: now\ntasks: [null]\n",
        "version: 1\ngeneratedAt: now\ntasks: [{}]\n",
        "version: 1\ngeneratedAt: now\ntasks: [{id: task, status: []}]\n",
        "version: 1\ngeneratedAt: now\ntasks: [{id: task, assignedTo: {}}]\n",
    ] {
        std::fs::write(&path, raw).unwrap();
        let response =
            route_project_service_request(&context, "GET", routes::COORDINATION_WORKLIST, None);
        assert_eq!(
            response.status, 500,
            "unreadable source became work or empty: {raw}: {}",
            response.body
        );
        assert!(response.body["error"].as_str().is_some());
        assert!(response.body.get("worklist").is_none());
        assert_eq!(cli_show(&context, THREAD_ID).status, 500, "{raw}");
    }
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    let response =
        route_project_service_request(&context, "GET", routes::COORDINATION_WORKLIST, None);
    assert_eq!(response.status, 500, "{}", response.body);
    assert_eq!(cli_show(&context, THREAD_ID).status, 500);
}
