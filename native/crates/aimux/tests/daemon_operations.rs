use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::http::DaemonResponseBody;
use aimux::daemon::routing::DaemonRouteResponse;
use aimux::daemon::text::operations::{
    DaemonOperationsTextRuntime, DashboardOpenRequest, RestartControlPlaneTextResult,
    route_operations_text_request,
};
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::project_api_contract::routes as project_routes;
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq)]
struct Call {
    name: &'static str,
    project_root: Option<String>,
    open: Option<DashboardOpenRequest>,
    project_roots: Vec<String>,
    include_active: bool,
    skipped: Vec<String>,
    session_name: Option<String>,
    window_id: Option<String>,
    issued_at: Option<String>,
    route_path: Option<String>,
}

impl Call {
    fn simple(name: &'static str) -> Self {
        Self {
            name,
            project_root: None,
            open: None,
            project_roots: Vec::new(),
            include_active: false,
            skipped: Vec::new(),
            session_name: None,
            window_id: None,
            issued_at: None,
            route_path: None,
        }
    }
}

#[derive(Debug, Default)]
struct FakeOperationsRuntime {
    calls: Vec<Call>,
    fail: Option<&'static str>,
    restart_failures: i64,
}

impl DaemonOperationsTextRuntime for FakeOperationsRuntime {
    fn now_iso(&self) -> String {
        "now".into()
    }

    fn resolve_project_root(&self, value: &str) -> String {
        if value.ends_with("/repo") || value == "." {
            "/repo".into()
        } else {
            format!("/resolved/{value}")
        }
    }

    fn list_project_paths_for_route(&self) -> Vec<String> {
        vec!["/repo".into(), "/stale".into()]
    }

    fn is_git_project_root(&self, project_root: &str) -> bool {
        project_root != "/stale"
    }

    fn doctor_versions_report(&mut self) -> Result<(Value, String), String> {
        self.calls.push(Call::simple("versions"));
        if self.fail == Some("versions") {
            return Err("versions failed".into());
        }
        Ok((
            json!({ "generatedAt": "now", "projects": [] }),
            "Runtime Coherence\n  ok".into(),
        ))
    }

    fn doctor_disk_report(
        &mut self,
        project_roots: Vec<String>,
        include_active_measurement: bool,
        skipped_stale_project_roots: Vec<String>,
        _generated_at: String,
    ) -> Result<(Value, String), String> {
        self.calls.push(Call {
            name: "disk",
            project_roots: project_roots.clone(),
            include_active: include_active_measurement,
            skipped: skipped_stale_project_roots.clone(),
            ..Call::simple("disk")
        });
        Ok((
            json!({
                "generatedAt": "now",
                "projects": project_roots,
                "skippedStaleProjectRoots": skipped_stale_project_roots,
                "includeActive": include_active_measurement
            }),
            "Disk Doctor\n  ok".into(),
        ))
    }

    fn doctor_tmux_report(
        &mut self,
        project_root: &str,
        session_name: Option<&str>,
        window_id: Option<&str>,
    ) -> Result<(Value, String), String> {
        self.calls.push(Call {
            name: "tmux",
            project_root: Some(project_root.into()),
            session_name: session_name.map(str::to_owned),
            window_id: window_id.map(str::to_owned),
            ..Call::simple("tmux")
        });
        if self.fail == Some("tmux") {
            return Err("tmux failed".into());
        }
        Ok((
            json!({ "ok": true, "projectRoot": project_root }),
            "Tmux Doctor\n  ok".into(),
        ))
    }

    fn repair_tmux_runtime(
        &mut self,
        project_root: &str,
        open: bool,
    ) -> Result<(Value, String), String> {
        self.calls.push(Call {
            name: "repair",
            project_root: Some(project_root.into()),
            open: open.then_some(DashboardOpenRequest {
                current_client_session: None,
                client_tty: None,
            }),
            ..Call::simple("repair")
        });
        if self.fail == Some("repair") {
            return Err("repair failed".into());
        }
        Ok((
            json!({ "ok": true, "backendReconcile": { "reconciled": [] } }),
            "Tmux Repair\n  ok".into(),
        ))
    }

    fn get_project_service_json(
        &mut self,
        project_root: &str,
        route_path: &str,
    ) -> ProjectServiceJsonResult {
        self.calls.push(Call {
            name: "get",
            project_root: Some(project_root.into()),
            route_path: Some(route_path.into()),
            ..Call::simple("get")
        });
        match route_path {
            project_routes::DIAGNOSTICS => ProjectServiceJsonResult::ok(
                project_root,
                json!({
                    "ok": true,
                    "projectRoot": project_root,
                    "runtimeExchange": {
                        "path": "/repo/.aimux/runtime-exchange.yaml",
                        "bytes": 600,
                        "counts": { "totalRecords": 10, "threads": 2, "messages": 5, "tasks": 3, "inbox": 1 },
                        "byteCounts": {
                            "totalStoredTextBytes": 120,
                            "totalOriginalTextBytes": 220,
                            "messageBodyBytes": 70,
                            "taskPromptBytes": 10,
                            "taskResultBytes": 20,
                            "taskErrorBytes": 30,
                            "compactedMessageBodies": 1,
                            "compactedTasks": 2
                        },
                        "compactableByteCounts": { "totalStoredTextBytes": 90 },
                        "retainedCounts": { "totalRecords": 8, "threads": 2, "messages": 4, "tasks": 2 },
                        "retainedByteCounts": { "totalStoredTextBytes": 100 },
                        "messageDelivery": {
                            "pendingMessageBodyBytes": 11,
                            "deliveredMessageBodyBytes": 22,
                            "noRecipientMessageBodyBytes": 33
                        },
                        "retainedMessageDelivery": {
                            "pendingMessageBodyBytes": 1,
                            "deliveredMessageBodyBytes": 2,
                            "noRecipientMessageBodyBytes": 3
                        },
                        "largestRetainedThreads": [
                            {
                                "id": "thread-1",
                                "kind": "task",
                                "status": "waiting",
                                "messageCount": 2,
                                "messageBodyBytes": 44,
                                "pendingMessageBodyBytes": 5,
                                "title": "Review"
                            }
                        ],
                        "telemetry": {
                            "reads": 9,
                            "parses": 8,
                            "compactions": 7,
                            "compactedRecords": 6,
                            "readCacheHits": 5,
                            "readCacheMisses": 4,
                            "slowReads": 3,
                            "slowReadSuppressed": 2,
                            "writes": 1,
                            "writeNoops": 0
                        }
                    }
                }),
            ),
            project_routes::DIAGNOSTICS_LIFECYCLE => ProjectServiceJsonResult::ok(
                project_root,
                json!({
                    "projectRoot": project_root,
                    "queuedCount": 2,
                    "queueLimit": 8,
                    "telemetry": {
                        "enqueued": 11,
                        "started": 10,
                        "succeeded": 9,
                        "failed": 1,
                        "released": 8,
                        "maxQueuedCount": 3,
                        "maxQueuedMs": 120,
                        "maxDurationMs": 450,
                        "rejectedConflicts": 2,
                        "rejectedQueueFull": 1,
                        "lastError": "boom"
                    },
                    "activeTargets": [
                        { "operation": "agent.spawn", "key": "session:claude-1" }
                    ]
                }),
            ),
            _ => ProjectServiceJsonResult::error(DaemonRouteResponse::text(404, "not found\n")),
        }
    }

    fn post_project_service_json(
        &mut self,
        project_root: &str,
        route_path: &str,
        body: Value,
    ) -> ProjectServiceJsonResult {
        self.calls.push(Call {
            name: "post",
            project_root: Some(project_root.into()),
            route_path: Some(route_path.into()),
            ..Call::simple("post")
        });
        assert_eq!(route_path, project_routes::runtime::COMPACT_EXCHANGE);
        assert_eq!(body, json!({}));
        ProjectServiceJsonResult::ok(
            project_root,
            json!({
                "ok": true,
                "result": {
                    "path": "/repo/.aimux/runtime-exchange.yaml",
                    "bytesBefore": 1000,
                    "bytesAfter": 600,
                    "removed": { "totalRecords": 4 },
                    "byteCounts": { "removed": { "totalStoredTextBytes": 300 } }
                },
                "runtimeExchange": {
                    "path": "/repo/.aimux/runtime-exchange.yaml",
                    "bytes": 600,
                    "counts": { "totalRecords": 10, "threads": 2, "messages": 5, "tasks": 3, "inbox": 1 },
                    "byteCounts": {
                        "totalStoredTextBytes": 120,
                        "totalOriginalTextBytes": 220,
                        "messageBodyBytes": 70,
                        "taskPromptBytes": 10,
                        "taskResultBytes": 20,
                        "taskErrorBytes": 30,
                        "compactedMessageBodies": 1,
                        "compactedTasks": 2
                    },
                    "compactableByteCounts": { "totalStoredTextBytes": 90 },
                    "retainedCounts": { "totalRecords": 8, "threads": 2, "messages": 4, "tasks": 2 },
                    "retainedByteCounts": { "totalStoredTextBytes": 100 },
                    "messageDelivery": {
                        "pendingMessageBodyBytes": 11,
                        "deliveredMessageBodyBytes": 22,
                        "noRecipientMessageBodyBytes": 33
                    },
                    "retainedMessageDelivery": {
                        "pendingMessageBodyBytes": 1,
                        "deliveredMessageBodyBytes": 2,
                        "noRecipientMessageBodyBytes": 3
                    },
                    "largestRetainedThreads": [
                        {
                            "id": "thread-1",
                            "kind": "task",
                            "status": "waiting",
                            "messageCount": 2,
                            "messageBodyBytes": 44,
                            "pendingMessageBodyBytes": 5,
                            "title": "Review"
                        }
                    ],
                    "telemetry": {
                        "reads": 9,
                        "parses": 8,
                        "compactions": 7,
                        "compactedRecords": 6,
                        "readCacheHits": 5,
                        "readCacheMisses": 4,
                        "slowReads": 3,
                        "slowReadSuppressed": 2,
                        "writes": 1,
                        "writeNoops": 0
                    }
                }
            }),
        )
    }

    fn restart_control_plane(
        &mut self,
        issued_at: &str,
        project_root: Option<&str>,
    ) -> Result<RestartControlPlaneTextResult, String> {
        self.calls.push(Call {
            name: "restart",
            project_root: project_root.map(str::to_owned),
            issued_at: Some(issued_at.into()),
            ..Call::simple("restart")
        });
        if self.fail == Some("restart") {
            return Err("aimux restart is already running".into());
        }
        Ok(RestartControlPlaneTextResult {
            restart: json!({ "summary": { "failures": self.restart_failures } }),
            text: format!("Aimux Restart\n  failures: {}", self.restart_failures),
        })
    }

    fn dashboard_reload(
        &mut self,
        project_root: &str,
        open: Option<DashboardOpenRequest>,
    ) -> Result<Value, String> {
        self.calls.push(Call {
            name: "dashboard",
            project_root: Some(project_root.into()),
            open,
            ..Call::simple("dashboard")
        });
        Ok(json!({
            "ok": true,
            "projectRoot": project_root,
            "dashboardSessionName": "aimux-test",
            "dashboardTarget": { "sessionName": "aimux-test", "windowIndex": 0, "windowId": "@2" }
        }))
    }

    fn runtime_restart(
        &mut self,
        project_root: &str,
        open: Option<DashboardOpenRequest>,
    ) -> Result<Value, String> {
        self.calls.push(Call {
            name: "runtime",
            project_root: Some(project_root.into()),
            open,
            ..Call::simple("runtime")
        });
        Ok(json!({
            "ok": true,
            "projectRoot": project_root,
            "project": { "projectRoot": project_root, "pid": 9200 },
            "tmuxSessionsKilled": ["aimux-test"],
            "dashboardSession": "aimux-test",
            "dashboardSessionName": "aimux-test",
            "dashboardTarget": { "sessionName": "aimux-test", "windowIndex": 0, "windowId": "@2" }
        }))
    }
}

fn text_body(response: DaemonRouteResponse) -> String {
    match response.body {
        DaemonResponseBody::Text(value) => value,
        other => panic!("expected text body, got {other:?}"),
    }
}

fn json_text(response: DaemonRouteResponse) -> Value {
    serde_json::from_str(&text_body(response)).expect("json text")
}

#[test]
fn doctor_exchange_route_reads_project_diagnostics_and_renders_exchange() {
    let mut runtime = FakeOperationsRuntime::default();
    let response = route_operations_text_request(
        &mut runtime,
        "GET",
        &format!("{}?project=/repo", CORE_API_ROUTES.doctor_exchange_text),
        None,
    )
    .expect("doctor exchange route");

    assert_eq!(response.status, 200);
    assert_eq!(
        text_body(response),
        concat!(
            "Project: /repo\n",
            "Path: /repo/.aimux/runtime-exchange.yaml\n",
            "Bytes: 600\n",
            "Records: total=10 threads=2 messages=5 tasks=3 inbox=1\n",
            "Text bytes: stored=120 original=220 messages=70 tasks=60 compactedMessages=1 compactedTasks=2\n",
            "Compactable text bytes: 90\n",
            "Retained records after compaction: total=8 threads=2 messages=4 tasks=2\n",
            "Retained text bytes after compaction: 100\n",
            "Message delivery bytes: pending=11 delivered=22 noRecipient=33\n",
            "Retained message delivery bytes: pending=1 delivered=2 noRecipient=3\n",
            "Large retained thread: thread-1 task/waiting messages=2 bytes=44 pendingBytes=5 title=Review\n",
            "Store: reads=9 parses=8 compactions=7 compactedRecords=6\n",
            "Cache: hits=5 misses=4 slowReads=3 suppressedSlowReadLogs=2\n",
            "Writes: total=1 noops=0\n",
        )
    );
    assert_eq!(runtime.calls[0].name, "get");
    assert_eq!(
        runtime.calls[0].route_path.as_deref(),
        Some(project_routes::DIAGNOSTICS)
    );

    let json = route_operations_text_request(
        &mut runtime,
        "GET",
        &format!(
            "{}?project=/repo&json=1",
            CORE_API_ROUTES.doctor_exchange_text
        ),
        None,
    )
    .expect("doctor exchange json route");
    assert_eq!(
        json_text(json)["path"],
        json!("/repo/.aimux/runtime-exchange.yaml")
    );
}

#[test]
fn doctor_lifecycle_route_reads_project_diagnostics_and_renders_queue() {
    let mut runtime = FakeOperationsRuntime::default();
    let response = route_operations_text_request(
        &mut runtime,
        "GET",
        &format!("{}?project=/repo", CORE_API_ROUTES.doctor_lifecycle_text),
        None,
    )
    .expect("doctor lifecycle route");

    assert_eq!(response.status, 200);
    assert_eq!(
        text_body(response),
        concat!(
            "Project: /repo\n",
            "Queue: 2/8\n",
            "Lifecycle: enqueued=11 started=10 succeeded=9 failed=1 released=8\n",
            "Max: queued=3 wait=120ms duration=450ms\n",
            "Rejected: conflicts=2 queueFull=1\n",
            "Last error: boom\n",
            "Active targets:\n",
            "  agent.spawn session:claude-1\n",
        )
    );
    assert_eq!(
        runtime.calls[0].route_path.as_deref(),
        Some(project_routes::DIAGNOSTICS_LIFECYCLE)
    );

    let json = route_operations_text_request(
        &mut runtime,
        "GET",
        &format!(
            "{}?project=/repo&json=1",
            CORE_API_ROUTES.doctor_lifecycle_text
        ),
        None,
    )
    .expect("doctor lifecycle json route");
    assert_eq!(json_text(json)["queuedCount"], json!(2));
}

#[test]
fn doctor_versions_text_and_json_routes_render_runtime_report() {
    let mut runtime = FakeOperationsRuntime::default();
    let text = route_operations_text_request(
        &mut runtime,
        "GET",
        CORE_API_ROUTES.doctor_versions_text,
        None,
    )
    .expect("versions route");
    assert_eq!(text.status, 200);
    assert_eq!(text_body(text), "Runtime Coherence\n  ok\n");

    let json = route_operations_text_request(
        &mut runtime,
        "GET",
        &format!("{}?json=1", CORE_API_ROUTES.doctor_versions_text),
        None,
    )
    .expect("versions route");
    assert_eq!(
        json_text(json),
        json!({ "generatedAt": "now", "projects": [] })
    );
}

#[test]
fn disk_doctor_uses_all_known_git_projects_or_explicit_project() {
    let mut runtime = FakeOperationsRuntime::default();
    let response =
        route_operations_text_request(&mut runtime, "GET", CORE_API_ROUTES.doctor_disk_text, None)
            .expect("disk route");
    assert_eq!(text_body(response), "Disk Doctor\n  ok\n");
    assert_eq!(runtime.calls[0].project_roots, ["/repo"]);
    assert_eq!(runtime.calls[0].skipped, ["/stale"]);
    assert!(!runtime.calls[0].include_active);

    let response = route_operations_text_request(
        &mut runtime,
        "GET",
        &format!(
            "{}?project=/repo&includeActive=1&json=1",
            CORE_API_ROUTES.doctor_disk_text
        ),
        None,
    )
    .expect("disk route");
    assert_eq!(
        json_text(response),
        json!({
            "generatedAt": "now",
            "projects": ["/repo"],
            "skippedStaleProjectRoots": [],
            "includeActive": true
        })
    );
    assert_eq!(runtime.calls[1].project_roots, ["/repo"]);
    assert!(runtime.calls[1].include_active);
}

#[test]
fn tmux_doctor_and_repair_validate_project_root_and_preserve_text_errors() {
    let mut runtime = FakeOperationsRuntime::default();
    let missing =
        route_operations_text_request(&mut runtime, "GET", CORE_API_ROUTES.doctor_tmux_text, None)
            .expect("tmux route");
    assert_eq!(missing.status, 400);
    assert_eq!(text_body(missing), "projectRoot query is required\n");

    let tmux = route_operations_text_request(
        &mut runtime,
        "GET",
        &format!(
            "{}?projectRoot=/repo&session=aimux-test&windowId=%401",
            CORE_API_ROUTES.doctor_tmux_text
        ),
        None,
    )
    .expect("tmux route");
    assert_eq!(text_body(tmux), "Tmux Doctor\n  ok\n");
    assert_eq!(runtime.calls[0].project_root.as_deref(), Some("/repo"));
    assert_eq!(runtime.calls[0].session_name.as_deref(), Some("aimux-test"));
    assert_eq!(runtime.calls[0].window_id.as_deref(), Some("@1"));

    runtime.fail = Some("repair");
    let repair = route_operations_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.repair_text,
        Some(&json!({ "projectRoot": "/repo" })),
    )
    .expect("repair route");
    assert_eq!(repair.status, 500);
    assert_eq!(text_body(repair), "Error: repair failed\n");
}

#[test]
fn repair_route_accepts_form_body_and_open_flag() {
    let mut runtime = FakeOperationsRuntime::default();
    let repair = route_operations_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.repair_text,
        Some(&json!({ "projectRoot": "/repo", "open": "1" })),
    )
    .expect("repair route");

    assert_eq!(text_body(repair), "Tmux Repair\n  ok\n");
    assert_eq!(runtime.calls[0].name, "repair");
    assert_eq!(runtime.calls[0].project_root.as_deref(), Some("/repo"));
    assert!(runtime.calls[0].open.is_some());
}

#[test]
fn repair_exchange_route_compacts_project_service_exchange_and_renders_diagnostics() {
    let mut runtime = FakeOperationsRuntime::default();
    let repair = route_operations_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.repair_exchange_text,
        Some(&json!({ "projectRoot": "/repo" })),
    )
    .expect("repair exchange route");

    assert_eq!(repair.status, 200);
    assert_eq!(
        text_body(repair),
        concat!(
            "Project: /repo\n",
            "Path: /repo/.aimux/runtime-exchange.yaml\n",
            "Bytes: 1000 -> 600\n",
            "Removed records: 4\n",
            "Removed text bytes: 300\n",
            "Project: /repo\n",
            "Path: /repo/.aimux/runtime-exchange.yaml\n",
            "Bytes: 600\n",
            "Records: total=10 threads=2 messages=5 tasks=3 inbox=1\n",
            "Text bytes: stored=120 original=220 messages=70 tasks=60 compactedMessages=1 compactedTasks=2\n",
            "Compactable text bytes: 90\n",
            "Retained records after compaction: total=8 threads=2 messages=4 tasks=2\n",
            "Retained text bytes after compaction: 100\n",
            "Message delivery bytes: pending=11 delivered=22 noRecipient=33\n",
            "Retained message delivery bytes: pending=1 delivered=2 noRecipient=3\n",
            "Large retained thread: thread-1 task/waiting messages=2 bytes=44 pendingBytes=5 title=Review\n",
            "Store: reads=9 parses=8 compactions=7 compactedRecords=6\n",
            "Cache: hits=5 misses=4 slowReads=3 suppressedSlowReadLogs=2\n",
            "Writes: total=1 noops=0\n",
        )
    );
    assert_eq!(runtime.calls[0].name, "post");
    assert_eq!(runtime.calls[0].project_root.as_deref(), Some("/repo"));
}

#[test]
fn restart_text_sets_failure_status_and_preserves_raw_errors() {
    let mut runtime = FakeOperationsRuntime {
        restart_failures: 1,
        ..FakeOperationsRuntime::default()
    };
    let failed = route_operations_text_request(
        &mut runtime,
        "POST",
        &format!("{}?project=/repo", CORE_API_ROUTES.restart_text),
        None,
    )
    .expect("restart route");
    assert_eq!(failed.status, 500);
    assert_eq!(text_body(failed), "Aimux Restart\n  failures: 1\n");
    assert_eq!(runtime.calls[0].project_root.as_deref(), Some("/repo"));
    assert_eq!(runtime.calls[0].issued_at.as_deref(), Some("now"));

    runtime.fail = Some("restart");
    let error =
        route_operations_text_request(&mut runtime, "POST", CORE_API_ROUTES.restart_text, None)
            .expect("restart route");
    assert_eq!(error.status, 500);
    assert_eq!(text_body(error), "aimux restart is already running\n");
}

#[test]
fn dashboard_reload_and_runtime_restart_parse_project_fallback_and_open_context() {
    let mut runtime = FakeOperationsRuntime::default();
    let reload = route_operations_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.dashboard_reload_text,
        Some(&json!({
            "projectRoot": "",
            "project": "/repo",
            "open": "1",
            "currentClientSession": "aimux-test-client-feedbeef",
            "clientTty": "/dev/ttys001"
        })),
    )
    .expect("dashboard route");
    assert_eq!(text_body(reload), "Reloaded dashboard for aimux-test\n");
    assert_eq!(runtime.calls[0].project_root.as_deref(), Some("/repo"));
    assert_eq!(
        runtime.calls[0].open,
        Some(DashboardOpenRequest {
            current_client_session: Some("aimux-test-client-feedbeef".into()),
            client_tty: Some("/dev/ttys001".into()),
        })
    );

    let restart = route_operations_text_request(
        &mut runtime,
        "POST",
        &format!("{}?json=1", CORE_API_ROUTES.runtime_restart_text),
        Some(&json!({ "projectRoot": "/repo" })),
    )
    .expect("runtime route");
    assert_eq!(json_text(restart)["dashboardSessionName"], "aimux-test");
    assert_eq!(runtime.calls[1].name, "runtime");
    assert!(runtime.calls[1].open.is_none());
}

#[test]
fn dashboard_reload_and_runtime_restart_require_project_root_or_project() {
    let mut runtime = FakeOperationsRuntime::default();
    let reload = route_operations_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.dashboard_reload_text,
        None,
    )
    .expect("dashboard route");
    let restart = route_operations_text_request(
        &mut runtime,
        "POST",
        CORE_API_ROUTES.runtime_restart_text,
        None,
    )
    .expect("runtime route");

    assert_eq!(reload.status, 400);
    assert_eq!(text_body(reload), "projectRoot query is required\n");
    assert_eq!(restart.status, 400);
    assert_eq!(text_body(restart), "projectRoot query is required\n");
    assert!(runtime.calls.is_empty());
}
