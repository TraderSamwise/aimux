use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::core_commands::DaemonCoreCommandRuntime;
use aimux::daemon::expose::{
    DaemonExposeFocusRuntime, TmuxClientInfo, expose_focus_route_with_runtime,
    open_target_for_client,
};
use aimux::daemon::json::DaemonJsonRouteRuntime;
use aimux::daemon::json::ExposeFocusRequest;
use aimux::daemon::listener::{
    DaemonRequestMetadata, handle_daemon_stream_with_metadata_and_interceptor,
};
use aimux::daemon::process::handle_daemon_runtime_request;
use aimux::daemon::runtime::{
    PROJECT_SERVICE_STARTUP_TIMEOUT_MS, ProjectServiceHealthProbe, ProjectServiceLauncher,
    ProjectServiceProcessVerifier, RealDaemonRuntime, SystemProjectServiceLauncher,
    handle_daemon_runtime_request_with_mutex,
};
use aimux::daemon::status::DaemonStatusRuntime;
use aimux::daemon::text::agents::DaemonAgentTextRuntime;
use aimux::daemon::text::auth::DaemonAuthTextRuntime;
use aimux::daemon::text::params::ProjectServiceJsonResult;
use aimux::daemon_state::{
    AimuxDaemonInfo, DaemonState, MetadataApiEndpoint, MetadataState, ProjectServiceState,
    ProjectServiceStatus, load_metadata_endpoint, save_daemon_state, save_metadata_endpoint,
    save_metadata_state,
};
use aimux::dashboard_command_spec::get_dashboard_command_spec;
use aimux::dashboard_readiness::get_runtime_owner_id;
use aimux::paths::PathResolver;
use aimux::project_api_contract::routes as project_routes;
use aimux::remote_credentials::{AimuxCredentials, load_credentials, save_credentials_at};
use aimux::runtime_coherence::{RuntimeCoherenceTmux, RuntimeCoherenceTmuxWindow};
use aimux::runtime_topology::{runtime_topology_path, write_runtime_topology};
use aimux::tmux::{
    AIMUX_TMUX_RUNTIME_CONTRACT_VERSION, TMUX_DASHBOARD_BUILD_OPTION, TMUX_DASHBOARD_OWNER_OPTION,
    TMUX_RUNTIME_CONTRACT_OPTION, TMUX_RUNTIME_OWNER_OPTION, TmuxTarget,
};
use aimux::tmux_exec_metrics::{TmuxExecMode, record_tmux_exec, reset_tmux_exec_metrics};
use aimux::tmux_expose::{ExposeScope, ExposeScopeView, ExposeSublabel};
use aimux::tmux_expose_hot_snapshot::{HotExposeScopeKey, write_hot_expose_scope_view};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, remove_dir_all};
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn native_daemon_projects_are_catalog_backed_when_services_are_cold() {
    let fixture = RuntimeFixture::new("cold-catalog");
    let project = fixture.project("cold");
    let mut resolver = fixture.resolver();
    resolver
        .register_project(&project)
        .expect("register project");
    let runtime = fixture.runtime();

    let projects = runtime.list_projects_for_route();

    assert_eq!(projects.len(), 1);
    assert_eq!(projects[0].name, "cold");
    assert_eq!(projects[0].path, project.to_string_lossy());
    assert_eq!(
        projects[0].dashboard_session_name,
        format!("aimux-{}", projects[0].id)
    );
    assert!(!projects[0].service_alive);
    assert!(projects[0].service.is_none());
    assert!(projects[0].service_endpoint.is_none());
    fixture.cleanup();
}

#[test]
fn native_daemon_projects_report_live_service_from_state_without_hiding_catalog() {
    let fixture = RuntimeFixture::new("live-catalog");
    let project = fixture.project("live");
    let mut resolver = fixture.resolver();
    let entry = resolver
        .register_project(&project)
        .expect("register project")
        .expect("project entry");
    let service = ProjectServiceState {
        project_id: entry.id.clone(),
        project_root: project.to_string_lossy().into_owned(),
        pid: std::process::id() as i32,
        started_at: "then".into(),
        updated_at: "now".into(),
        status: Some(ProjectServiceStatus::Running),
        restart_count: Some(0),
        last_restart_at: None,
        last_exit: None,
    };
    let state = DaemonState {
        version: 1,
        updated_at: Some(json!("now")),
        projects: Map::from_iter([(
            entry.id.clone(),
            serde_json::to_value(&service).expect("service json"),
        )]),
    };
    save_daemon_state(resolver.daemon_state_path(), &state).expect("daemon state");
    let endpoint = MetadataApiEndpoint {
        host: "127.0.0.1".into(),
        port: 45_901,
        pid: std::process::id() as i32,
        updated_at: "now".into(),
    };
    save_metadata_endpoint(resolver.project_state_dir_for(&project), &endpoint)
        .expect("metadata endpoint");
    let runtime = fixture.runtime();

    let projects = runtime.list_projects_for_route();

    assert_eq!(projects.len(), 1);
    assert!(projects[0].service_alive);
    assert_eq!(
        projects[0]
            .service
            .as_ref()
            .and_then(|value| value.get("pid")),
        Some(&json!(std::process::id() as i32))
    );
    assert_eq!(
        projects[0]
            .service_endpoint
            .as_ref()
            .and_then(|value| value.get("port")),
        Some(&json!(45_901))
    );
    fixture.cleanup();
}

#[test]
fn native_daemon_projects_route_reads_online_agent_count_from_live_project_service_and_caches() {
    let fixture = RuntimeFixture::new("projects-online-count");
    let project = fixture.project("live");
    let mut resolver = fixture.resolver();
    let entry = resolver
        .register_project(&project)
        .expect("register project")
        .expect("project entry");
    let server = ScriptedHttpServer::spawn(vec![json!({
        "sessions": [
            { "id": "codex-live", "status": "running" },
            { "id": "codex-offline", "status": "offline" },
            { "id": "codex-pending", "status": "offline", "pendingAction": "spawn" },
            { "id": "claude-overseer", "status": "running", "overseer": true },
            { "id": "claude-scribe", "status": "running", "team": { "role": "scribe" } }
        ],
        "teammates": [
            { "id": "teammate-live", "status": "running" },
            { "id": "teammate-exited", "status": "exited" }
        ]
    })]);
    persist_service(
        &resolver,
        &entry.id,
        &project,
        std::process::id() as i32,
        ProjectServiceStatus::Running,
    );
    save_metadata_endpoint(
        resolver.project_state_dir_for(&project),
        &MetadataApiEndpoint {
            host: "127.0.0.1".into(),
            port: server.port,
            pid: std::process::id() as i32,
            updated_at: "now".into(),
        },
    )
    .expect("metadata endpoint");
    let mut runtime = fixture.runtime();

    let first = handle_daemon_runtime_request(&mut runtime, request("GET", "/projects"));
    let first_json: Value = serde_json::from_slice(&first.body).expect("first projects json");
    assert_eq!(first.status, 200);
    assert_eq!(first_json["projects"][0]["onlineAgentCount"], json!(3));

    let second = handle_daemon_runtime_request(&mut runtime, request("GET", "/projects"));
    let second_json: Value = serde_json::from_slice(&second.body).expect("second projects json");
    assert_eq!(second.status, 200);
    assert_eq!(second_json["projects"][0]["onlineAgentCount"], json!(3));

    let requests = server.join();
    assert_eq!(requests.len(), 1);
    assert_request_path(&requests[0], "GET", project_routes::DESKTOP_STATE);
    fixture.cleanup();
}

#[test]
fn native_daemon_http_routes_health_and_projects_through_real_runtime() {
    let fixture = RuntimeFixture::new("http");
    let project = fixture.project("repo");
    let mut resolver = fixture.resolver();
    resolver
        .register_project(&project)
        .expect("register project");
    let mut runtime = fixture.runtime();

    let health = handle_daemon_runtime_request(&mut runtime, request("GET", "/health"));
    let health_json: Value = serde_json::from_slice(&health.body).expect("health json");
    assert_eq!(health.status, 200);
    assert_eq!(health_json["kind"], "aimux-daemon");
    assert_eq!(health_json["pid"], json!(fixture.info.pid));

    let projects = handle_daemon_runtime_request(&mut runtime, request("GET", "/projects"));
    let projects_json: Value = serde_json::from_slice(&projects.body).expect("projects json");
    assert_eq!(projects.status, 200);
    assert_eq!(projects_json["projects"].as_array().map(Vec::len), Some(1));
    assert_eq!(projects_json["projects"][0]["name"], "repo");
    assert_eq!(projects_json["projects"][0]["serviceAlive"], false);
    fixture.cleanup();
}

#[test]
fn native_daemon_loop_diagnostics_reports_tmux_exec_metrics_and_budget() {
    reset_tmux_exec_metrics();
    let fixture = RuntimeFixture::new("loop-diagnostics");
    let mut runtime = fixture.runtime();
    record_tmux_exec(
        &["capture-pane".to_owned(), "-p".to_owned()],
        42.0,
        TmuxExecMode::Sync,
    );

    let response = handle_daemon_runtime_request(&mut runtime, request("GET", "/diagnostics/loop"));
    let body: Value = serde_json::from_slice(&response.body).expect("diagnostics json");

    assert_eq!(response.status, 200);
    assert_eq!(body["ok"], true);
    assert_eq!(body["pid"], json!(fixture.info.pid));
    assert!(body["uptimeMs"].as_u64().is_some());
    assert_eq!(body["eventLoop"]["monitoring"], true);
    assert_eq!(body["tmuxExec"]["sync"]["count"], json!(1));
    assert_eq!(body["tmuxExec"]["sync"]["totalMs"], json!(42));
    assert_eq!(
        body["tmuxExec"]["syncByVerb"]["capture-pane"]["count"],
        json!(1)
    );
    assert_eq!(
        body["budget"]["reasons"]
            .as_array()
            .expect("budget reasons")
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>(),
        vec!["insufficient-sample"]
    );
    assert_eq!(
        body["excludes"][0],
        "expose-hot-snapshot-worker (worker thread)"
    );
    reset_tmux_exec_metrics();
    fixture.cleanup();
}

#[test]
fn native_daemon_projects_route_handles_concurrent_project_fleet_load() {
    let fixture = RuntimeFixture::new("projects-load");
    let mut resolver = fixture.resolver();
    let mut services = Map::new();
    let mut live_pids = Vec::new();
    for index in 0..12 {
        let project = fixture.project(&format!("repo-{index:02}"));
        let entry = resolver
            .register_project(&project)
            .expect("register project")
            .expect("project entry");
        let pid = 80_000 + index;
        live_pids.push(pid);
        let service = ProjectServiceState {
            project_id: entry.id.clone(),
            project_root: project.to_string_lossy().into_owned(),
            pid,
            started_at: "then".into(),
            updated_at: "now".into(),
            status: Some(ProjectServiceStatus::Running),
            restart_count: Some(0),
            last_restart_at: None,
            last_exit: None,
        };
        services.insert(
            entry.id.clone(),
            serde_json::to_value(&service).expect("service json"),
        );
        save_metadata_endpoint(
            resolver.project_state_dir_for(&project),
            &MetadataApiEndpoint {
                host: "127.0.0.1".into(),
                port: 45_000 + index as u16,
                pid,
                updated_at: "now".into(),
            },
        )
        .expect("metadata endpoint");
    }
    save_daemon_state(
        resolver.daemon_state_path(),
        &DaemonState {
            version: 1,
            updated_at: Some(json!("now")),
            projects: services,
        },
    )
    .expect("daemon state");

    let runtime = fixture.runtime_with_launcher_and_verifier(
        Arc::new(SystemProjectServiceLauncher),
        Arc::new(SlowNativeVerifier {
            live: live_pids.into_iter().collect(),
            delay: Duration::from_millis(25),
        }),
        PROJECT_SERVICE_STARTUP_TIMEOUT_MS,
    );
    let runtime = Arc::new(Mutex::new(runtime));
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind daemon listener");
    let address = listener.local_addr().expect("daemon address");
    let request_count = 60 * 5 + 1;
    let server_runtime = Arc::clone(&runtime);
    let server_join = std::thread::spawn(move || {
        let mut joins = Vec::new();
        for _ in 0..request_count {
            let (mut stream, _) = listener.accept().expect("accept daemon request");
            let request_runtime = Arc::clone(&server_runtime);
            joins.push(std::thread::spawn(move || {
                let _ = handle_daemon_stream_with_metadata_and_interceptor(
                    &mut stream,
                    DaemonRequestMetadata {
                        issued_at: "issued".into(),
                        stopping: false,
                    },
                    &mut |request, writer| {
                        if aimux::daemon::stream::maybe_handle_project_event_stream_request(
                            request, writer,
                        )
                        .map_err(|error| {
                            aimux::daemon::listener::DaemonListenerError::Io(
                                std::io::Error::other(error.to_string()),
                            )
                        })? {
                            return Ok(true);
                        }
                        aimux::daemon::stream::maybe_handle_host_agent_stream_request_with_runtime_mutex(
                            &request_runtime,
                            request,
                            writer,
                        )
                        .map_err(|error| {
                            aimux::daemon::listener::DaemonListenerError::Io(
                                std::io::Error::other(error.to_string()),
                            )
                        })
                    },
                    &mut |request| {
                        handle_daemon_runtime_request_with_mutex(&request_runtime, request)
                    },
                );
            }));
        }
        for join in joins {
            join.join().expect("daemon request thread");
        }
    });

    for _ in 0..5 {
        let (tx, rx) = mpsc::channel();
        for _ in 0..60 {
            let tx = tx.clone();
            std::thread::spawn(move || {
                tx.send(request_http(address, "/projects", Duration::from_secs(3)))
                    .expect("send project response");
            });
        }
        drop(tx);
        for _ in 0..60 {
            let response = rx
                .recv_timeout(Duration::from_secs(4))
                .expect("projects request completed under concurrent load")
                .expect("projects response");
            assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
            assert!(response.contains(r#""ok":true"#));
            assert!(response.contains(r#""serviceAlive":true"#));
        }
    }
    let health = request_http(address, "/health", Duration::from_secs(2))
        .expect("health response after load");
    assert!(health.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(health.contains(r#""kind":"aimux-daemon""#));

    server_join.join().expect("daemon server");
    fixture.cleanup();
}

#[test]
fn native_daemon_global_expose_items_hides_stale_project_topology_without_waking_cold_projects() {
    let fixture = RuntimeFixture::new("global-expose-items");
    let alpha = fixture.project("alpha");
    let beta = fixture.project("beta");
    let cold = fixture.project("cold");
    let mut resolver = fixture.resolver();
    resolver
        .register_project(&alpha)
        .expect("register alpha")
        .expect("alpha entry");
    resolver
        .register_project(&beta)
        .expect("register beta")
        .expect("beta entry");
    resolver
        .register_project(&cold)
        .expect("register cold")
        .expect("cold entry");
    let alpha_state_dir = resolver.project_state_dir_for(&alpha);
    let beta_state_dir = resolver.project_state_dir_for(&beta);
    write_runtime_topology(
        runtime_topology_path(&alpha_state_dir),
        &daemon_expose_topology(&alpha, "aimux-alpha", "alpha-agent", "@1", 1),
    )
    .expect("write alpha topology");
    write_runtime_topology(
        runtime_topology_path(&beta_state_dir),
        &daemon_expose_topology(&beta, "aimux-beta", "beta-agent", "@2", 2),
    )
    .expect("write beta topology");
    save_metadata_state(
        &alpha_state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::from([(
                "alpha-agent".into(),
                json!({ "derived": { "activity": "running", "attention": "needs_input" } }),
            )]),
        },
    )
    .expect("save alpha metadata");
    let alpha_preview = json!({
        "output": "alpha preview",
        "capturedAt": "2026-09-07T00:00:00.000Z",
        "source": "capture",
        "windowId": "@1",
    });
    write_hot_expose_scope_view(
        &alpha_state_dir,
        HotExposeScopeKey {
            project_root: alpha.to_string_lossy().into_owned(),
            scope: ExposeScope::Project,
            worktree_key: None,
            launch_window_id: None,
        },
        ExposeScopeView {
            scope: ExposeScope::Project,
            scope_label: "all worktrees".into(),
            sublabel: ExposeSublabel::Worktree,
            items: vec![json!({
                "id": "alpha-agent",
                "target": {
                    "sessionName": "aimux-alpha",
                    "windowId": "@1",
                    "windowIndex": 1,
                    "windowName": "alpha-agent",
                },
                "metadata": {},
                "label": "alpha-agent",
                "urgency": 0,
                "activity": 1,
                "recentRank": 9007199254740991_i64,
                "previewSnapshot": alpha_preview.clone(),
            })],
        },
        None,
    );
    let mut runtime = fixture.runtime();

    let response = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "GET",
            &format!("{}?includePreview=1", CORE_API_ROUTES.expose_items),
        ),
    );
    let body: Value = serde_json::from_slice(&response.body).expect("expose items json");

    assert_eq!(response.status, 200);
    assert_eq!(body["ok"], true);
    let items = body["items"].as_array().expect("items array");
    assert!(items.is_empty(), "stale windows must not be exposed");
    fixture.cleanup();
}

#[test]
fn native_daemon_expose_focus_resolves_global_item_and_delegates_tmux_focus() {
    let fixture = RuntimeFixture::new("global-expose-focus");
    let project = fixture.project("focus");
    let mut resolver = fixture.resolver();
    let entry = resolver
        .register_project(&project)
        .expect("register project")
        .expect("project entry");
    let state_dir = resolver.project_state_dir_for(&project);
    write_runtime_topology(
        runtime_topology_path(&state_dir),
        &daemon_expose_topology(&project, "aimux-focus", "focus-agent", "@7", 7),
    )
    .expect("write topology");
    let mut fake = FakeExposeFocusRuntime {
        clients: vec![TmuxClientInfo {
            tty: "/dev/ttys123".into(),
            session_name: "client-session".into(),
            window_id: "@old".into(),
            name: "client".into(),
        }],
        ..FakeExposeFocusRuntime::default()
    };

    let body = expose_focus_route_with_runtime(
        &mut resolver,
        |_| "aimux".to_owned(),
        ExposeFocusRequest {
            window_id: "@7".into(),
            project_root: Some(project.to_string_lossy().into_owned()),
            current_client_session: Some("client-session".into()),
            client_tty: Some("/dev/ttys123".into()),
        },
        &mut fake,
    )
    .expect("focus response");

    assert_eq!(body["ok"], true);
    assert_eq!(body["action"], "expose-focus");
    assert_eq!(body["focusMode"], "client-tty");
    assert_eq!(body["itemId"], "focus-agent");
    assert_eq!(body["projectId"], entry.id);
    assert_eq!(body["projectName"], "focus");
    assert_eq!(body["target"]["windowId"], "@7");
    assert_eq!(
        fake.calls,
        vec![
            json!({
                "op": "switch-client-to-target",
                "clientTty": "/dev/ttys123",
                "windowId": "@7"
            }),
            json!({ "op": "refresh-status" })
        ]
    );
    fixture.cleanup();
}

#[test]
fn native_open_target_for_client_uses_attached_client_before_linked_session() {
    let target = tmux_target("aimux-repo", "@7", 7, "codex");
    let mut fake = FakeExposeFocusRuntime {
        clients: vec![TmuxClientInfo {
            tty: "/dev/attached".into(),
            session_name: "aimux-repo-client-feedbeef".into(),
            window_id: "@7".into(),
            name: "client".into(),
        }],
        linked_targets: vec![tmux_target("client-session", "@7", 3, "codex")],
        ..FakeExposeFocusRuntime::default()
    };

    let result = open_target_for_client(&mut fake, &target, Some("client-session"), None)
        .expect("open target");

    assert_eq!(result["focusMode"], "client-tty");
    assert_eq!(
        fake.calls,
        vec![
            json!({ "op": "switch-client-to-target", "clientTty": "/dev/attached", "windowId": "@7" }),
            json!({ "op": "refresh-status" }),
        ]
    );
}

#[test]
fn native_open_target_for_client_uses_linked_session_then_attach_fallback() {
    let target = tmux_target("aimux-repo", "@7", 7, "dashboard");
    let linked = tmux_target("client-session", "@7", 3, "dashboard");
    let mut linked_fake = FakeExposeFocusRuntime {
        linked_targets: vec![linked],
        ..FakeExposeFocusRuntime::default()
    };

    let linked_result =
        open_target_for_client(&mut linked_fake, &target, Some("client-session"), None)
            .expect("linked focus");

    assert_eq!(linked_result["focusMode"], "linked-client-session");
    assert_eq!(
        linked_fake.calls,
        vec![
            json!({ "op": "switch-client", "sessionName": "client-session", "windowIndex": 3 }),
            json!({ "op": "refresh-status" }),
            json!({ "op": "send-focus-in", "windowId": "@7" }),
        ]
    );

    let mut attach_fake = FakeExposeFocusRuntime::default();
    let attach_result =
        open_target_for_client(&mut attach_fake, &target, Some("client-session"), None)
            .expect("attach focus");

    assert_eq!(attach_result["focusMode"], "open-target");
    assert_eq!(
        attach_fake.calls,
        vec![
            json!({ "op": "attach-session", "sessionName": "aimux-repo", "windowIndex": 7 }),
            json!({ "op": "refresh-status" }),
        ]
    );
}

#[test]
fn native_daemon_json_proxy_forwards_loopback_project_service_response() {
    let fixture = RuntimeFixture::new("json-proxy");
    let server = OneShotHttpServer::spawn(
        b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 22\r\n\r\n{\"ok\":true,\"value\":42}".to_vec(),
    );
    let mut runtime = fixture.runtime();

    let response = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "GET",
            &format!("/proxy/127.0.0.1/{}/health?check=1", server.port),
        ),
    );
    let response_json: Value = serde_json::from_slice(&response.body).expect("response json");

    assert_eq!(response.status, 200);
    assert_eq!(response_json, json!({ "ok": true, "value": 42 }));
    assert!(server.join().contains("GET /health?check=1 HTTP/1.1"));
    fixture.cleanup();
}

#[test]
fn native_text_reads_lazy_start_cold_project_service_before_proxying_get() {
    let fixture = RuntimeFixture::new("lazy-read");
    let project = fixture.project("lazy");
    let server = OneShotHttpServer::spawn(
        b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 13\r\n\r\n{\"agents\":[]}"
            .to_vec(),
    );
    let launcher = Arc::new(FakeLauncher::new(91_901).with_endpoint(server.port));
    let mut runtime = fixture.runtime_with_launcher_and_verifier(
        launcher.clone(),
        Arc::new(FakeProcessVerifier::native([91_901])),
        PROJECT_SERVICE_STARTUP_TIMEOUT_MS,
    );

    let result = <RealDaemonRuntime as DaemonAgentTextRuntime>::get_project_service_json(
        &mut runtime,
        &project.to_string_lossy(),
        project_routes::agents::LIST,
    );
    let ProjectServiceJsonResult::Ok { project_root, json } = result else {
        panic!("expected lazy-started project-service read, got {result:?}");
    };

    assert_eq!(project_root, project.to_string_lossy());
    assert_eq!(json, json!({ "agents": [] }));
    assert_eq!(launcher.calls(), vec![project.to_string_lossy()]);
    assert!(server.join().contains("GET /agents HTTP/1.1"));
    fixture.cleanup();
}

#[derive(Debug, Default)]
struct FakeExposeFocusRuntime {
    clients: Vec<TmuxClientInfo>,
    linked_targets: Vec<TmuxTarget>,
    calls: Vec<Value>,
}

impl DaemonExposeFocusRuntime for FakeExposeFocusRuntime {
    fn list_clients(&mut self) -> Result<Vec<TmuxClientInfo>, String> {
        Ok(self.clients.clone())
    }

    fn target_by_window_id(
        &mut self,
        session_name: &str,
        window_id: &str,
    ) -> Result<Option<TmuxTarget>, String> {
        Ok(self
            .linked_targets
            .iter()
            .find(|target| target.session_name == session_name && target.window_id == window_id)
            .cloned())
    }

    fn switch_client_to_target(&mut self, client_tty: &str, window_id: &str) -> Result<(), String> {
        self.calls.push(json!({
            "op": "switch-client-to-target",
            "clientTty": client_tty,
            "windowId": window_id,
        }));
        Ok(())
    }

    fn switch_client(&mut self, session_name: &str, window_index: i64) -> Result<(), String> {
        self.calls.push(json!({
            "op": "switch-client",
            "sessionName": session_name,
            "windowIndex": window_index,
        }));
        Ok(())
    }

    fn attach_session(
        &mut self,
        session_name: &str,
        window_index: Option<i64>,
    ) -> Result<(), String> {
        self.calls.push(json!({
            "op": "attach-session",
            "sessionName": session_name,
            "windowIndex": window_index,
        }));
        Ok(())
    }

    fn refresh_status(&mut self) {
        self.calls.push(json!({ "op": "refresh-status" }));
    }

    fn send_focus_in(&mut self, window_id: &str) -> Result<(), String> {
        self.calls
            .push(json!({ "op": "send-focus-in", "windowId": window_id }));
        Ok(())
    }
}

#[test]
fn native_daemon_binary_proxy_preserves_content_bytes_and_type() {
    let fixture = RuntimeFixture::new("binary-proxy");
    let server = OneShotHttpServer::spawn(
        b"HTTP/1.1 200 OK\r\ncontent-type: image/png\r\ncontent-length: 4\r\n\r\n\x89PNG".to_vec(),
    );
    let mut runtime = fixture.runtime();

    let response = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "GET",
            &format!("/proxy/127.0.0.1/{}/attachments/att-1/content", server.port),
        ),
    );

    assert_eq!(response.status, 200);
    assert_eq!(
        response.headers.get("content-type").map(String::as_str),
        Some("image/png")
    );
    assert_eq!(response.body, b"\x89PNG");
    assert!(
        server
            .join()
            .contains("GET /attachments/att-1/content HTTP/1.1")
    );
    fixture.cleanup();
}

#[test]
fn native_daemon_doctor_versions_reports_catalog_and_service_counts() {
    let fixture = RuntimeFixture::new("doctor-versions");
    let cold = fixture.project("cold");
    let live = fixture.project("live");
    let mut resolver = fixture.resolver();
    resolver.register_project(&cold).expect("register cold");
    let live_entry = resolver
        .register_project(&live)
        .expect("register live")
        .expect("live entry");
    persist_service(
        &resolver,
        &live_entry.id,
        &live,
        std::process::id() as i32,
        ProjectServiceStatus::Running,
    );
    let mut runtime = fixture.runtime();

    let response = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "GET",
            &format!("{}?json=1", CORE_API_ROUTES.doctor_versions_text),
        ),
    );
    let text = String::from_utf8(response.body).expect("json text");
    let report: Value = serde_json::from_str(&text).expect("report json");

    assert_eq!(response.status, 200);
    assert!(report["cliVersion"].as_str().is_some());
    assert_eq!(report["daemon"]["running"], json!(true));
    assert_eq!(report["daemon"]["projectCount"], json!(1));
    assert_eq!(report["summary"]["projects"], json!(1));
    assert_eq!(report["summary"]["needsRestart"], json!(1));
    assert_eq!(report["tmux"]["available"], json!(false));
    assert_eq!(report["projectCount"], json!(2));
    assert_eq!(report["serviceAliveCount"], json!(1));
    assert_eq!(report["daemonStateProjectCount"], json!(1));
    assert_eq!(report["catalogProjects"].as_array().map(Vec::len), Some(2));
    assert_eq!(report["projects"].as_array().map(Vec::len), Some(1));
    assert_eq!(report["projects"][0]["sources"], json!(["daemon-state"]));
    assert_eq!(report["relay"]["status"], "off");

    let text_response = handle_daemon_runtime_request(
        &mut runtime,
        request("GET", CORE_API_ROUTES.doctor_versions_text),
    );
    let body = String::from_utf8(text_response.body).expect("versions text");
    assert!(body.starts_with("Aimux Versions\n"));
    assert!(body.contains("  daemon projects: 1\n"));
    assert!(body.contains("  tmux: unavailable\n"));
    assert!(!body.contains("Runtime Coherence"));
    fixture.cleanup();
}

#[test]
fn native_daemon_doctor_versions_reports_tmux_snapshot() {
    let fixture = RuntimeFixture::new("doctor-versions-tmux");
    let project = fixture.project("live");
    let mut resolver = fixture.resolver();
    resolver
        .register_project(&project)
        .expect("register project");
    let project_root = project.to_string_lossy().into_owned();
    let session_name = aimux::tmux::project_session(&project, "aimux").session_name;
    let provider_project_root = project_root.clone();
    let provider_session_name = session_name.clone();
    let mut runtime = fixture
        .runtime()
        .with_runtime_coherence_tmux_provider(Arc::new(move || RuntimeCoherenceTmux {
            available: true,
            version: Some("tmux 3.6b".into()),
            session_names: vec![provider_session_name.clone()],
            session_options: [(
                provider_session_name.clone(),
                [(
                    "@aimux-project-root".to_owned(),
                    Some(provider_project_root.clone()),
                )]
                .into_iter()
                .collect(),
            )]
            .into_iter()
            .collect(),
            ..RuntimeCoherenceTmux::default()
        }));

    let response = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "GET",
            &format!("{}?json=1", CORE_API_ROUTES.doctor_versions_text),
        ),
    );
    let text = String::from_utf8(response.body).expect("json text");
    let report: Value = serde_json::from_str(&text).expect("report json");

    assert_eq!(response.status, 200);
    assert_eq!(report["tmux"]["available"], json!(true));
    assert_eq!(report["tmux"]["version"], json!("tmux 3.6b"));
    assert_eq!(report["tmux"]["sessionCount"], json!(1));
    assert_eq!(report["projects"][0]["projectRoot"], json!(project_root));
    assert_eq!(
        report["projects"][0]["runtime"]["sessionName"],
        json!(session_name)
    );

    let text_response = handle_daemon_runtime_request(
        &mut runtime,
        request("GET", CORE_API_ROUTES.doctor_versions_text),
    );
    let body = String::from_utf8(text_response.body).expect("versions text");
    assert!(body.contains("  tmux: tmux 3.6b\n"));
    assert!(body.contains("  tmux sessions: 1\n"));
    fixture.cleanup();
}

#[test]
fn native_daemon_doctor_versions_uses_dashboard_launch_stamp_for_current_dashboard() {
    let fixture = RuntimeFixture::new("doctor-dashboard-stamp");
    let project = fixture.project("live");
    let mut resolver = fixture.resolver();
    let entry = resolver
        .register_project(&project)
        .expect("register project")
        .expect("project entry");
    let pid = std::process::id() as i32;
    persist_service(
        &resolver,
        &entry.id,
        &project,
        pid,
        ProjectServiceStatus::Running,
    );
    save_metadata_endpoint(
        resolver.project_state_dir_for(&project),
        &MetadataApiEndpoint {
            host: "127.0.0.1".into(),
            port: 45_901,
            pid,
            updated_at: "now".into(),
        },
    )
    .expect("metadata endpoint");
    let project_root = project.to_string_lossy().into_owned();
    let session_name = aimux::tmux::project_session(&project, "aimux").session_name;
    let dashboard_stamp = get_dashboard_command_spec(&project_root)
        .expect("dashboard command spec")
        .dashboard_build_stamp;
    let runtime_owner = get_runtime_owner_id();
    let mut runtime = fixture
        .runtime()
        .with_runtime_coherence_tmux_provider(Arc::new({
            let project_root = project_root.clone();
            let session_name = session_name.clone();
            let dashboard_stamp = dashboard_stamp.clone();
            let runtime_owner = runtime_owner.clone();
            move || RuntimeCoherenceTmux {
                available: true,
                version: Some("tmux 3.6b".into()),
                session_names: vec![session_name.clone()],
                session_options: [(
                    session_name.clone(),
                    [
                        ("@aimux-project-root".to_owned(), Some(project_root.clone())),
                        (
                            TMUX_RUNTIME_OWNER_OPTION.to_owned(),
                            Some(runtime_owner.clone()),
                        ),
                        (
                            TMUX_RUNTIME_CONTRACT_OPTION.to_owned(),
                            Some(AIMUX_TMUX_RUNTIME_CONTRACT_VERSION.to_owned()),
                        ),
                    ]
                    .into_iter()
                    .collect(),
                )]
                .into_iter()
                .collect(),
                windows: [(
                    session_name.clone(),
                    vec![RuntimeCoherenceTmuxWindow {
                        id: "@73".to_owned(),
                        index: 0,
                        name: "dashboard".to_owned(),
                        active: true,
                    }],
                )]
                .into_iter()
                .collect(),
                window_options: [(
                    "@73".to_owned(),
                    [
                        (
                            TMUX_DASHBOARD_BUILD_OPTION.to_owned(),
                            Some(dashboard_stamp.clone()),
                        ),
                        (
                            TMUX_DASHBOARD_OWNER_OPTION.to_owned(),
                            Some(runtime_owner.clone()),
                        ),
                    ]
                    .into_iter()
                    .collect(),
                )]
                .into_iter()
                .collect(),
                window_alive: [("@73".to_owned(), true)].into_iter().collect(),
                pane_start_commands: BTreeMap::new(),
            }
        }));

    let response = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "GET",
            &format!("{}?json=1", CORE_API_ROUTES.doctor_versions_text),
        ),
    );
    let report: Value = serde_json::from_slice(&response.body).expect("report json");

    assert_eq!(response.status, 200);
    assert_eq!(
        report["projects"][0]["expectedDashboardBuildStamp"],
        json!(dashboard_stamp)
    );
    assert_eq!(report["projects"][0]["dashboards"][0]["status"], "ok");
    assert_eq!(report["summary"]["ok"], json!(1));
    assert_eq!(report["summary"]["needsRestart"], json!(0));
    fixture.cleanup();
}

#[test]
fn native_daemon_core_command_ids_are_unique() {
    let fixture = RuntimeFixture::new("command-id");
    let runtime = fixture.runtime();

    assert_eq!(runtime.next_core_command_id(), "native-1");
    assert_eq!(runtime.next_core_command_id(), "native-2");
    fixture.cleanup();
}

#[test]
fn ensure_project_launches_service_and_persists_starting_state() {
    let fixture = RuntimeFixture::new("ensure-launch");
    let project = fixture.project("repo");
    let launcher = Arc::new(FakeLauncher::new(87_654));
    let mut runtime =
        fixture.runtime_with_launcher(launcher.clone(), PROJECT_SERVICE_STARTUP_TIMEOUT_MS);

    let project_json = runtime
        .ensure_project(project.to_str().expect("project path"))
        .expect("ensure project");

    assert_eq!(
        launcher.calls(),
        vec![project.to_string_lossy().into_owned()]
    );
    assert_eq!(
        project_json["projectRoot"],
        json!(project.to_string_lossy())
    );
    assert_eq!(project_json["pid"], json!(87_654));
    assert_eq!(project_json["status"], "running");
    let state = fixture.resolver().load_registry().expect("registry");
    assert_eq!(state.projects.len(), 1);
    let daemon_state = fixture.runtime().daemon_state();
    assert_eq!(daemon_state.projects.len(), 1);
    assert_eq!(
        daemon_state
            .projects
            .values()
            .next()
            .and_then(|value| value.get("status")),
        Some(&json!("running"))
    );
    fixture.cleanup();
}

#[test]
fn ensure_project_refuses_cargo_test_harness_for_real_non_default_daemon_home_before_launch() {
    let fixture = RuntimeFixture::new("ensure-refuse-real-non-default");
    let project = fixture.project("repo");
    let resolver = fixture.resolver();
    fs::remove_file(
        resolver
            .global_aimux_dir()
            .join(aimux::runtime_safety_guard::TEST_ISOLATION_MARKER),
    )
    .expect("remove isolated marker to model a real daemon home");
    let launcher = Arc::new(FakeLauncher::new(87_655));
    let verifier = Arc::new(FakeProcessVerifier::native([]));
    let daemon_info = AimuxDaemonInfo {
        port: 43_191,
        ..fixture.info.clone()
    };
    let mut runtime = RealDaemonRuntime::with_project_service_launcher_and_process_verifier(
        resolver,
        daemon_info,
        launcher.clone(),
        verifier,
        PROJECT_SERVICE_STARTUP_TIMEOUT_MS,
    );

    let error = runtime
        .ensure_project(project.to_str().expect("project path"))
        .expect_err("real non-default daemon home should refuse cargo test materialization");

    assert!(error.contains("refusing to materialize cargo test harness"));
    assert!(launcher.calls().is_empty());
    fixture.cleanup();
}

#[test]
fn ensure_project_reuses_existing_live_state_without_launching() {
    let fixture = RuntimeFixture::new("ensure-reuse");
    let project = fixture.project("repo");
    let mut resolver = fixture.resolver();
    let entry = resolver
        .register_project(&project)
        .expect("register project")
        .expect("entry");
    let service = ProjectServiceState {
        project_id: entry.id.clone(),
        project_root: project.to_string_lossy().into_owned(),
        pid: std::process::id() as i32,
        started_at: "then".into(),
        updated_at: "now".into(),
        status: Some(ProjectServiceStatus::Running),
        restart_count: Some(3),
        last_restart_at: Some("restart".into()),
        last_exit: None,
    };
    save_daemon_state(
        resolver.daemon_state_path(),
        &DaemonState {
            version: 1,
            updated_at: Some(json!("now")),
            projects: Map::from_iter([(
                entry.id.clone(),
                serde_json::to_value(&service).expect("service json"),
            )]),
        },
    )
    .expect("daemon state");
    save_metadata_endpoint(
        resolver.project_state_dir_for(&project),
        &MetadataApiEndpoint {
            host: "127.0.0.1".into(),
            port: 45_903,
            pid: std::process::id() as i32,
            updated_at: "now".into(),
        },
    )
    .expect("endpoint");
    let launcher = Arc::new(FakeLauncher::new(87_655));
    let mut runtime =
        fixture.runtime_with_launcher(launcher.clone(), PROJECT_SERVICE_STARTUP_TIMEOUT_MS);

    let project_json = runtime
        .ensure_project(project.to_str().expect("project path"))
        .expect("ensure project");

    assert!(launcher.calls().is_empty());
    assert_eq!(project_json["pid"], json!(std::process::id() as i32));
    assert_eq!(project_json["status"], "running");
    assert_eq!(project_json["restartCount"], json!(3));
    fixture.cleanup();
}

#[test]
fn ensure_project_replaces_live_legacy_node_service_with_native_launch() {
    let fixture = RuntimeFixture::new("ensure-replace-node-service");
    let project = fixture.project("repo");
    let mut resolver = fixture.resolver();
    let entry = resolver
        .register_project(&project)
        .expect("register project")
        .expect("entry");
    persist_service(
        &resolver,
        &entry.id,
        &project,
        std::process::id() as i32,
        ProjectServiceStatus::Running,
    );
    save_metadata_endpoint(
        resolver.project_state_dir_for(&project),
        &MetadataApiEndpoint {
            host: "127.0.0.1".into(),
            port: 45_903,
            pid: std::process::id() as i32,
            updated_at: "now".into(),
        },
    )
    .expect("endpoint");
    let launcher = Arc::new(FakeLauncher::new(87_661));
    let verifier = Arc::new(FakeProcessVerifier::legacy_node([
        std::process::id() as i32,
        launcher.pid,
    ]));
    let mut runtime = fixture.runtime_with_launcher_and_verifier(
        launcher.clone(),
        verifier,
        PROJECT_SERVICE_STARTUP_TIMEOUT_MS,
    );

    let project_json = runtime
        .ensure_project(project.to_str().expect("project path"))
        .expect("ensure project");

    assert_eq!(
        launcher.calls(),
        vec![project.to_string_lossy().into_owned()]
    );
    assert_eq!(
        launcher.terminations(),
        vec![(std::process::id() as i32, false)]
    );
    assert_eq!(project_json["pid"], json!(87_661));
    assert_eq!(project_json["status"], "running");
    assert_eq!(
        load_metadata_endpoint(resolver.project_state_dir_for(&project))
            .as_ref()
            .map(|endpoint| endpoint.pid),
        Some(87_661),
        "legacy endpoint must be replaced by the relaunched native endpoint"
    );
    fixture.cleanup();
}

#[test]
fn ensure_project_replaces_live_previous_native_build_with_current_launch() {
    let fixture = RuntimeFixture::new("ensure-replace-old-native-service");
    let project = fixture.project("repo");
    let mut resolver = fixture.resolver();
    let entry = resolver
        .register_project(&project)
        .expect("register project")
        .expect("entry");
    persist_service(
        &resolver,
        &entry.id,
        &project,
        std::process::id() as i32,
        ProjectServiceStatus::Running,
    );
    save_metadata_endpoint(
        resolver.project_state_dir_for(&project),
        &MetadataApiEndpoint {
            host: "127.0.0.1".into(),
            port: 45_903,
            pid: std::process::id() as i32,
            updated_at: "now".into(),
        },
    )
    .expect("endpoint");
    let launcher = Arc::new(FakeLauncher::new(87_662));
    let verifier = Arc::new(FakeProcessVerifier::previous_native_build([
        std::process::id() as i32,
        launcher.pid,
    ]));
    let mut runtime = fixture.runtime_with_launcher_and_verifier(
        launcher.clone(),
        verifier,
        PROJECT_SERVICE_STARTUP_TIMEOUT_MS,
    );

    let project_json = runtime
        .ensure_project(project.to_str().expect("project path"))
        .expect("ensure project");

    assert_eq!(
        launcher.calls(),
        vec![project.to_string_lossy().into_owned()]
    );
    assert_eq!(
        launcher.terminations(),
        vec![(std::process::id() as i32, false)]
    );
    assert_eq!(project_json["pid"], json!(87_662));
    assert_eq!(project_json["status"], "running");
    assert_eq!(
        load_metadata_endpoint(resolver.project_state_dir_for(&project))
            .as_ref()
            .map(|endpoint| endpoint.pid),
        Some(87_662),
        "old native endpoint must be replaced by the relaunched endpoint"
    );
    fixture.cleanup();
}

#[test]
fn ensure_project_terminates_duplicate_project_services_for_same_project() {
    let fixture = RuntimeFixture::new("ensure-reap-duplicates");
    let project = fixture.project("repo");
    let mut resolver = fixture.resolver();
    let entry = resolver
        .register_project(&project)
        .expect("register project")
        .expect("entry");
    let keep_pid = std::process::id() as i32;
    persist_service(
        &resolver,
        &entry.id,
        &project,
        keep_pid,
        ProjectServiceStatus::Running,
    );
    save_metadata_endpoint(
        resolver.project_state_dir_for(&project),
        &MetadataApiEndpoint {
            host: "127.0.0.1".into(),
            port: 45_904,
            pid: keep_pid,
            updated_at: "now".into(),
        },
    )
    .expect("endpoint");
    let launcher = Arc::new(FakeLauncher::new(87_663));
    let verifier = Arc::new(FakeProcessVerifier::native_with_duplicates(
        [keep_pid],
        [keep_pid, 87_664, 87_665],
    ));
    let mut runtime = fixture.runtime_with_launcher_and_verifier(launcher.clone(), verifier, 0);

    let project_json = runtime
        .ensure_project(project.to_str().expect("project path"))
        .expect("ensure project");

    assert!(launcher.calls().is_empty());
    assert_eq!(project_json["pid"], json!(keep_pid));
    assert_eq!(
        launcher.terminations(),
        vec![(87_664, false), (87_665, false)]
    );
    fixture.cleanup();
}

#[test]
fn ensure_project_reports_existing_live_pid_without_endpoint_as_unhealthy() {
    let fixture = RuntimeFixture::new("ensure-wait-endpoint");
    let project = fixture.project("repo");
    let mut resolver = fixture.resolver();
    let entry = resolver
        .register_project(&project)
        .expect("register project")
        .expect("entry");
    persist_service(
        &resolver,
        &entry.id,
        &project,
        std::process::id() as i32,
        ProjectServiceStatus::Running,
    );
    let launcher = Arc::new(FakeLauncher::new(87_659));
    let mut runtime = fixture.runtime_with_launcher(launcher.clone(), 0);

    let error = runtime
        .ensure_project(project.to_str().expect("project path"))
        .expect_err("missing endpoint should fail health wait");

    assert!(launcher.calls().is_empty());
    assert!(error.contains("project service health wait timed out after 0ms"));
    assert!(error.contains(&format!("pid {}", std::process::id())));
    fixture.cleanup();
}

#[test]
fn core_projects_ensure_route_uses_native_supervision_runtime() {
    let fixture = RuntimeFixture::new("ensure-route");
    let project = fixture.project("repo");
    let launcher = Arc::new(FakeLauncher::new(87_656));
    let mut runtime =
        fixture.runtime_with_launcher(launcher.clone(), PROJECT_SERVICE_STARTUP_TIMEOUT_MS);
    let body = format!(r#"{{"projectRoot":{}}}"#, json!(project.to_string_lossy()));
    let mut request = request("POST", "/projects/ensure");
    request
        .headers
        .insert("content-type".into(), "application/json".into());
    request
        .headers
        .insert("content-length".into(), body.len().to_string());
    request.body_chunks = vec![body.into_bytes()];

    let response = handle_daemon_runtime_request(&mut runtime, request);
    let response_json: Value = serde_json::from_slice(&response.body).expect("response json");

    assert_eq!(response.status, 200);
    assert_eq!(
        response_json["project"]["projectRoot"],
        json!(project.to_string_lossy())
    );
    assert_eq!(response_json["project"]["pid"], json!(87_656));
    assert_eq!(
        launcher.calls(),
        vec![project.to_string_lossy().into_owned()]
    );
    fixture.cleanup();
}

#[test]
fn overseer_watch_spawns_overseer_loops_target_and_sends_prompt() {
    let fixture = RuntimeFixture::new("overseer-watch");
    let project = fixture.project("repo");
    let mut resolver = fixture.resolver();
    let entry = resolver
        .register_project(&project)
        .expect("register project")
        .expect("entry");
    let server = ScriptedHttpServer::spawn(vec![
        json!({ "agents": [
            { "id": "codex-1", "tool": "codex", "status": "running" }
        ]}),
        json!({ "sessionId": "claude-overseer" }),
        json!({ "agents": [
            { "id": "codex-1", "tool": "codex", "status": "running" },
            { "id": "claude-overseer", "tool": "claude", "status": "idle", "overseer": true }
        ]}),
        json!({ "ok": true }),
        json!({ "agents": [
            { "id": "codex-1", "tool": "codex", "status": "running", "loop": { "active": true, "goal": "keep going" } },
            { "id": "claude-overseer", "tool": "claude", "status": "idle", "overseer": true }
        ]}),
        json!({ "ok": true }),
    ]);
    persist_service(
        &resolver,
        &entry.id,
        &project,
        std::process::id() as i32,
        ProjectServiceStatus::Running,
    );
    save_metadata_endpoint(
        resolver.project_state_dir_for(&project),
        &MetadataApiEndpoint {
            host: "127.0.0.1".into(),
            port: server.port,
            pid: std::process::id() as i32,
            updated_at: "now".into(),
        },
    )
    .expect("endpoint");
    let launcher = Arc::new(FakeLauncher::new(87_660));
    let mut runtime =
        fixture.runtime_with_launcher(launcher.clone(), PROJECT_SERVICE_STARTUP_TIMEOUT_MS);

    let result = runtime
        .overseer_watch(
            project.to_str().expect("project path"),
            "codex-1",
            Some("keep going"),
            Some("watch CI"),
        )
        .expect("overseer watch");

    assert!(launcher.calls().is_empty());
    assert_eq!(result["projectRoot"], json!(project.to_string_lossy()));
    assert_eq!(result["sessionId"], "codex-1");
    assert_eq!(result["overseerSessionId"], "claude-overseer");
    assert_eq!(result["watchedSessionIds"], json!(["codex-1"]));
    assert_eq!(result["instructions"], "watch CI");

    let requests = server.join();
    assert_request_path(&requests[0], "GET", "/agents");
    assert_request_path(&requests[1], "POST", "/agents/spawn");
    assert_eq!(
        request_json_body(&requests[1]),
        json!({ "tool": "claude", "open": false, "overseer": true })
    );
    assert_request_path(&requests[2], "GET", "/agents");
    assert_request_path(&requests[3], "POST", "/agents/loop");
    assert_eq!(
        request_json_body(&requests[3]),
        json!({
            "sessionId": "codex-1",
            "active": true,
            "action": "add",
            "source": "dashboard",
            "updatedBy": "dashboard",
            "goal": "keep going"
        })
    );
    assert_request_path(&requests[4], "GET", "/agents");
    assert_request_path(&requests[5], "POST", "/agents/input");
    let input = request_json_body(&requests[5]);
    assert_eq!(input["sessionId"], "claude-overseer");
    let text = input["text"].as_str().expect("input text");
    assert!(text.contains("Current watch list:"));
    assert!(text.contains("- codex-1 (codex): keep going"));
    assert!(text.contains("Special instructions:\nwatch CI"));
    fixture.cleanup();
}

#[test]
fn overseer_watch_refuses_missing_agent_before_mutation() {
    let fixture = RuntimeFixture::new("overseer-watch-missing");
    let project = fixture.project("repo");
    let mut resolver = fixture.resolver();
    let entry = resolver
        .register_project(&project)
        .expect("register project")
        .expect("entry");
    let server = ScriptedHttpServer::spawn(vec![json!({ "agents": [] })]);
    persist_service(
        &resolver,
        &entry.id,
        &project,
        std::process::id() as i32,
        ProjectServiceStatus::Running,
    );
    save_metadata_endpoint(
        resolver.project_state_dir_for(&project),
        &MetadataApiEndpoint {
            host: "127.0.0.1".into(),
            port: server.port,
            pid: std::process::id() as i32,
            updated_at: "now".into(),
        },
    )
    .expect("endpoint");
    let launcher = Arc::new(FakeLauncher::new(87_663));
    let mut runtime =
        fixture.runtime_with_launcher(launcher.clone(), PROJECT_SERVICE_STARTUP_TIMEOUT_MS);

    let error = runtime
        .overseer_watch(
            project.to_str().expect("project path"),
            "missing",
            None,
            None,
        )
        .expect_err("missing agent fails");

    assert_eq!(error.status, 404);
    assert_eq!(error.error, "agent not found: missing");
    let requests = server.join();
    assert_eq!(requests.len(), 1);
    assert_request_path(&requests[0], "GET", "/agents");
    fixture.cleanup();
}

#[test]
fn overseer_watch_refuses_project_control_agent_before_mutation() {
    let fixture = RuntimeFixture::new("overseer-watch-control");
    let project = fixture.project("repo");
    let mut resolver = fixture.resolver();
    let entry = resolver
        .register_project(&project)
        .expect("register project")
        .expect("entry");
    let server = ScriptedHttpServer::spawn(vec![json!({ "agents": [
        { "id": "claude-overseer", "tool": "claude", "status": "idle", "overseer": true }
    ]})]);
    persist_service(
        &resolver,
        &entry.id,
        &project,
        std::process::id() as i32,
        ProjectServiceStatus::Running,
    );
    save_metadata_endpoint(
        resolver.project_state_dir_for(&project),
        &MetadataApiEndpoint {
            host: "127.0.0.1".into(),
            port: server.port,
            pid: std::process::id() as i32,
            updated_at: "now".into(),
        },
    )
    .expect("endpoint");
    let launcher = Arc::new(FakeLauncher::new(87_664));
    let mut runtime =
        fixture.runtime_with_launcher(launcher.clone(), PROJECT_SERVICE_STARTUP_TIMEOUT_MS);

    let error = runtime
        .overseer_watch(
            project.to_str().expect("project path"),
            "claude-overseer",
            None,
            None,
        )
        .expect_err("project control agent fails");

    assert_eq!(error.status, 400);
    assert_eq!(
        error.error,
        "cannot watch project control session: claude-overseer"
    );
    let requests = server.join();
    assert_eq!(requests.len(), 1);
    assert_request_path(&requests[0], "GET", "/agents");
    fixture.cleanup();
}

#[test]
fn stop_project_marks_service_stopped_and_removes_endpoint() {
    let fixture = RuntimeFixture::new("stop");
    let project = fixture.project("repo");
    let mut resolver = fixture.resolver();
    let entry = resolver
        .register_project(&project)
        .expect("register project")
        .expect("entry");
    persist_service(
        &resolver,
        &entry.id,
        &project,
        std::process::id() as i32,
        ProjectServiceStatus::Running,
    );
    save_metadata_endpoint(
        resolver.project_state_dir_for(&project),
        &MetadataApiEndpoint {
            host: "127.0.0.1".into(),
            port: 45_902,
            pid: std::process::id() as i32,
            updated_at: "now".into(),
        },
    )
    .expect("endpoint");
    let launcher = Arc::new(FakeLauncher::new(87_657));
    let mut runtime = fixture.runtime_with_launcher(launcher.clone(), 0);

    let stopped = runtime
        .stop_project(project.to_str().expect("project path"), false)
        .expect("stop project");

    assert_eq!(
        launcher.terminations(),
        vec![(std::process::id() as i32, false)]
    );
    assert_eq!(stopped["status"], "stopped");
    assert_eq!(stopped["lastExit"]["signal"], "SIGTERM");
    assert!(
        !resolver
            .project_state_dir_for(&project)
            .join("metadata-api.json")
            .exists()
    );
    assert_eq!(
        fixture
            .runtime()
            .daemon_state()
            .projects
            .get(&entry.id)
            .and_then(|value| value.get("status")),
        Some(&json!("stopped"))
    );
    fixture.cleanup();
}

#[cfg(unix)]
#[test]
fn stop_project_matches_service_state_by_canonical_project_root() {
    use std::os::unix::fs::symlink;

    let fixture = RuntimeFixture::new("stop-canonical");
    let project = fixture.project("repo");
    let alias = fixture.root.join("alias-repo");
    symlink(&project, &alias).expect("symlink project alias");
    let mut resolver = fixture.resolver();
    let entry = resolver
        .register_project(&project)
        .expect("register project")
        .expect("entry");
    persist_service(
        &resolver,
        &entry.id,
        &project,
        std::process::id() as i32,
        ProjectServiceStatus::Running,
    );
    let launcher = Arc::new(FakeLauncher::new(87_661));
    let mut runtime = fixture.runtime_with_launcher(launcher.clone(), 0);

    let stopped = runtime
        .stop_project(alias.to_str().expect("alias path"), false)
        .expect("stop project by alias");

    assert_eq!(
        launcher.terminations(),
        vec![(std::process::id() as i32, false)]
    );
    assert_eq!(stopped["projectId"], entry.id);
    assert_eq!(stopped["projectRoot"], json!(project.to_string_lossy()));
    assert_eq!(stopped["status"], "stopped");
    fixture.cleanup();
}

#[test]
fn restart_project_stops_then_launches_fresh_service() {
    let fixture = RuntimeFixture::new("restart");
    let project = fixture.project("repo");
    let mut resolver = fixture.resolver();
    let entry = resolver
        .register_project(&project)
        .expect("register project")
        .expect("entry");
    persist_service(
        &resolver,
        &entry.id,
        &project,
        std::process::id() as i32,
        ProjectServiceStatus::Running,
    );
    let launcher = Arc::new(FakeLauncher::new(87_658));
    let mut runtime = fixture.runtime_with_launcher(launcher.clone(), 0);

    let restarted = runtime
        .restart_project_service(project.to_str().expect("project path"), true)
        .expect("restart project");

    assert_eq!(
        launcher.terminations(),
        vec![(std::process::id() as i32, false)]
    );
    assert_eq!(
        launcher.calls(),
        vec![project.to_string_lossy().into_owned()]
    );
    assert_eq!(restarted["project"]["pid"], json!(87_658));
    assert_eq!(restarted["project"]["status"], "running");
    fixture.cleanup();
}

#[test]
fn native_daemon_auth_reports_local_logged_out_state() {
    let fixture = RuntimeFixture::new("auth");
    let runtime = fixture.runtime();

    assert_eq!(
        runtime.remote_status_text_payload()["relay"]["status"],
        "off"
    );
    assert_eq!(
        runtime
            .require_remote_credentials()
            .expect_err("credentials")
            .status,
        401
    );
    fixture.cleanup();
}

#[test]
fn native_daemon_auth_reads_and_updates_credentials() {
    let fixture = RuntimeFixture::new("auth-credentials");
    let resolver = fixture.resolver();
    save_credentials_at(resolver.auth_path(), &credentials()).expect("save credentials");
    let mut runtime = fixture.runtime();

    assert!(runtime.has_remote_credentials());
    assert_eq!(
        runtime.remote_status_text_payload()["credentials"],
        json!({ "relayUrl": "wss://relay.example", "remoteEnabled": true })
    );
    assert_eq!(
        runtime.whoami_text_payload()["credentials"],
        json!({
            "userId": "user-1",
            "relayUrl": "wss://relay.example",
            "remoteEnabled": true
        })
    );

    let disabled = DaemonCoreCommandRuntime::disable_relay(&mut runtime);
    assert_eq!(disabled["status"], "off");
    assert!(
        !load_credentials(&resolver)
            .expect("credentials")
            .remote_enabled
    );
    let enabled = DaemonCoreCommandRuntime::enable_relay_for_user_request(&mut runtime);
    assert_eq!(enabled["status"], "disconnected");
    assert!(
        load_credentials(&resolver)
            .expect("credentials")
            .remote_enabled
    );
    assert_eq!(runtime.clear_credentials(), "cleared");
    assert!(!runtime.has_remote_credentials());
    fixture.cleanup();
}

#[test]
fn native_daemon_push_acknowledges_when_relay_is_off() {
    let fixture = RuntimeFixture::new("push-relay-unavailable");
    let mut runtime = fixture.runtime();

    let result = runtime.push_notification(&json!({
        "title": "Needs input",
        "body": "codex is waiting",
        "sessionId": "codex-1"
    }));

    assert_eq!(
        result,
        json!({ "ok": true, "suppressed": true, "reason": "relay_off" })
    );
    fixture.cleanup();
}

#[derive(Debug)]
struct RuntimeFixture {
    root: PathBuf,
    home: PathBuf,
    info: AimuxDaemonInfo,
}

impl RuntimeFixture {
    fn new(label: &str) -> Self {
        let scratch_root = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".aimux-test-scratch")
            .join("rust-daemon-runtime");
        let root = scratch_root.join(format!(
            "{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = remove_dir_all(&root);
        let home = root.join("home");
        let aimux_home = home.join(".aimux");
        fs::create_dir_all(&aimux_home).expect("aimux home");
        fs::write(
            aimux_home.join(aimux::runtime_safety_guard::TEST_ISOLATION_MARKER),
            format!(
                r#"{{"ownerPid":{},"kind":"cargo-test"}}"#,
                std::process::id()
            ),
        )
        .expect("write isolated aimux home marker");
        Self {
            root,
            home,
            info: AimuxDaemonInfo {
                pid: std::process::id() as i32,
                port: 46_100,
                started_at: "then".into(),
                updated_at: "now".into(),
            },
        }
    }

    fn resolver(&self) -> PathResolver {
        PathResolver::new(
            &self.root,
            &self.home,
            Some(self.home.join(".aimux").to_string_lossy().into_owned()),
        )
    }

    fn runtime(&self) -> RealDaemonRuntime {
        RealDaemonRuntime::with_project_service_launcher_and_process_verifier(
            self.resolver(),
            self.info.clone(),
            Arc::new(SystemProjectServiceLauncher),
            Arc::new(FakeProcessVerifier::native([std::process::id() as i32])),
            PROJECT_SERVICE_STARTUP_TIMEOUT_MS,
        )
        .with_runtime_coherence_tmux_provider(Arc::new(|| RuntimeCoherenceTmux {
            available: false,
            version: None,
            ..RuntimeCoherenceTmux::default()
        }))
    }

    fn runtime_with_launcher(
        &self,
        launcher: Arc<FakeLauncher>,
        startup_timeout_ms: u64,
    ) -> RealDaemonRuntime {
        let mut live_pids = vec![std::process::id() as i32];
        live_pids.push(launcher.pid);
        self.runtime_with_launcher_and_verifier(
            launcher,
            Arc::new(FakeProcessVerifier::native(live_pids)),
            startup_timeout_ms,
        )
    }

    fn runtime_with_launcher_and_verifier(
        &self,
        launcher: Arc<dyn ProjectServiceLauncher>,
        verifier: Arc<dyn ProjectServiceProcessVerifier>,
        startup_timeout_ms: u64,
    ) -> RealDaemonRuntime {
        RealDaemonRuntime::with_project_service_launcher_and_process_verifier(
            self.resolver(),
            self.info.clone(),
            launcher,
            verifier,
            startup_timeout_ms,
        )
        .with_project_service_health_probe(Arc::new(AlwaysReadyHealthProbe))
    }

    fn project(&self, name: &str) -> PathBuf {
        let project = self.root.join(name);
        fs::create_dir_all(project.join(".git")).expect("project git");
        project
    }

    fn cleanup(self) {
        let _ = remove_dir_all(self.root);
    }
}

fn request(method: &str, path: &str) -> aimux::daemon::server::DaemonHttpRequest {
    aimux::daemon::server::DaemonHttpRequest {
        method: method.into(),
        path: path.into(),
        headers: Default::default(),
        body_chunks: Vec::new(),
        stopping: false,
        issued_at: "issued".into(),
    }
}

fn daemon_expose_topology(
    project_root: &Path,
    session_name: &str,
    session_id: &str,
    window_id: &str,
    window_index: i64,
) -> Value {
    let project_root = project_root.to_string_lossy();
    json!({
        "version": 1,
        "generatedAt": "2026-09-05T00:00:00.000Z",
        "rigs": [
            {
                "id": "rig-1",
                "name": "local",
                "projectRoot": project_root,
                "createdAt": "2026-09-05T00:00:00.000Z",
                "updatedAt": "2026-09-05T00:00:00.000Z"
            }
        ],
        "nodes": [
            {
                "id": "node-agent",
                "rigId": "rig-1",
                "logicalId": session_id,
                "toolConfigKey": "codex",
                "cwd": project_root,
                "label": session_id,
                "createdAt": "2026-09-05T00:00:00.000Z"
            }
        ],
        "edges": [],
        "bindings": [
            {
                "id": "binding-agent",
                "nodeId": "node-agent",
                "tmuxSession": session_name,
                "tmuxWindowId": window_id,
                "tmuxWindowIndex": window_index,
                "tmuxWindowName": "codex",
                "updatedAt": "2026-09-05T00:00:00.000Z"
            }
        ],
        "sessions": [
            {
                "id": session_id,
                "nodeId": "node-agent",
                "status": "running",
                "tool": "codex",
                "command": "codex",
                "worktreePath": project_root,
                "label": session_id,
                "createdAt": "2026-09-05T00:00:00.000Z",
                "updatedAt": "2026-09-05T00:00:00.000Z"
            }
        ],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    })
}

fn tmux_target(
    session_name: &str,
    window_id: &str,
    window_index: i64,
    window_name: &str,
) -> TmuxTarget {
    TmuxTarget {
        session_name: session_name.into(),
        window_id: window_id.into(),
        window_index,
        window_name: window_name.into(),
        pane_dead: Some(false),
    }
}

#[derive(Debug)]
struct FakeLauncher {
    pid: i32,
    endpoint_port: Option<u16>,
    calls: Mutex<Vec<String>>,
    terminations: Mutex<Vec<(i32, bool)>>,
}

impl FakeLauncher {
    fn new(pid: i32) -> Self {
        Self {
            pid,
            endpoint_port: Some(45_900),
            calls: Mutex::new(Vec::new()),
            terminations: Mutex::new(Vec::new()),
        }
    }

    fn with_endpoint(mut self, port: u16) -> Self {
        self.endpoint_port = Some(port);
        self
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().expect("calls").clone()
    }

    fn terminations(&self) -> Vec<(i32, bool)> {
        self.terminations.lock().expect("terminations").clone()
    }
}

impl ProjectServiceLauncher for FakeLauncher {
    fn launch(
        &self,
        _project_id: &str,
        project_root: &Path,
        project_state_dir: &Path,
    ) -> Result<i32, String> {
        self.calls
            .lock()
            .expect("calls")
            .push(project_root.to_string_lossy().into_owned());
        if let Some(port) = self.endpoint_port {
            save_metadata_endpoint(
                project_state_dir,
                &MetadataApiEndpoint {
                    host: "127.0.0.1".into(),
                    port,
                    pid: self.pid,
                    updated_at: "now".into(),
                },
            )
            .map_err(|error| error.to_string())?;
        }
        Ok(self.pid)
    }

    fn terminate(&self, service: &ProjectServiceState, force: bool) -> Result<(), String> {
        self.terminations
            .lock()
            .expect("terminations")
            .push((service.pid, force));
        Ok(())
    }
}

struct FakeProcessVerifier {
    live: BTreeSet<i32>,
    current_native: BTreeSet<i32>,
    project_service_pids: Vec<i32>,
}

impl FakeProcessVerifier {
    fn native(pids: impl IntoIterator<Item = i32>) -> Self {
        let native = pids.into_iter().collect::<BTreeSet<_>>();
        Self {
            live: native.clone(),
            current_native: native,
            project_service_pids: Vec::new(),
        }
    }

    fn legacy_node(pids: impl IntoIterator<Item = i32>) -> Self {
        Self {
            live: pids.into_iter().collect(),
            current_native: BTreeSet::new(),
            project_service_pids: Vec::new(),
        }
    }

    fn previous_native_build(pids: impl IntoIterator<Item = i32>) -> Self {
        let native = pids.into_iter().collect::<BTreeSet<_>>();
        Self {
            live: native.clone(),
            current_native: BTreeSet::new(),
            project_service_pids: Vec::new(),
        }
    }

    fn native_with_duplicates(
        current_native: impl IntoIterator<Item = i32>,
        project_service_pids: impl IntoIterator<Item = i32>,
    ) -> Self {
        let current_native = current_native.into_iter().collect::<BTreeSet<_>>();
        let project_service_pids = project_service_pids.into_iter().collect::<Vec<_>>();
        let mut live = current_native.clone();
        live.extend(project_service_pids.iter().copied());
        Self {
            live,
            current_native,
            project_service_pids,
        }
    }
}

impl ProjectServiceProcessVerifier for FakeProcessVerifier {
    fn is_live(&self, pid: i32) -> bool {
        self.live.contains(&pid)
    }

    fn is_live_native_project_service(&self, service: &ProjectServiceState) -> bool {
        self.current_native.contains(&service.pid)
    }

    fn live_project_service_pids(&self, _project_id: &str, _project_root: &str) -> Vec<i32> {
        self.project_service_pids.clone()
    }
}

struct SlowNativeVerifier {
    live: BTreeSet<i32>,
    delay: Duration,
}

impl ProjectServiceProcessVerifier for SlowNativeVerifier {
    fn is_live(&self, pid: i32) -> bool {
        self.live.contains(&pid)
    }

    fn is_live_native_project_service(&self, service: &ProjectServiceState) -> bool {
        std::thread::sleep(self.delay);
        self.live.contains(&service.pid)
    }

    fn live_project_service_pids(&self, _project_id: &str, _project_root: &str) -> Vec<i32> {
        Vec::new()
    }
}

struct AlwaysReadyHealthProbe;

impl ProjectServiceHealthProbe for AlwaysReadyHealthProbe {
    fn is_ready(&self, _endpoint: &MetadataApiEndpoint, _pid: i32) -> bool {
        true
    }
}

fn persist_service(
    resolver: &PathResolver,
    project_id: &str,
    project: &Path,
    pid: i32,
    status: ProjectServiceStatus,
) {
    let service = ProjectServiceState {
        project_id: project_id.into(),
        project_root: project.to_string_lossy().into_owned(),
        pid,
        started_at: "then".into(),
        updated_at: "now".into(),
        status: Some(status),
        restart_count: Some(0),
        last_restart_at: None,
        last_exit: None,
    };
    save_daemon_state(
        resolver.daemon_state_path(),
        &DaemonState {
            version: 1,
            updated_at: Some(json!("now")),
            projects: Map::from_iter([(
                project_id.into(),
                serde_json::to_value(service).expect("service json"),
            )]),
        },
    )
    .expect("daemon state");
}

fn credentials() -> AimuxCredentials {
    AimuxCredentials {
        version: 1,
        relay_url: "wss://relay.example".into(),
        token: "token-1".into(),
        user_id: "user-1".into(),
        created_at: "2026-09-05T00:00:00.000Z".into(),
        remote_enabled: true,
    }
}

struct OneShotHttpServer {
    port: u16,
    handle: std::thread::JoinHandle<String>,
}

impl OneShotHttpServer {
    fn spawn(response: Vec<u8>) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test listener");
        let port = listener.local_addr().expect("listener addr").port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept");
            let mut buffer = [0_u8; 4096];
            let count = stream.read(&mut buffer).expect("read request");
            stream.write_all(&response).expect("write response");
            String::from_utf8_lossy(&buffer[..count]).into_owned()
        });
        Self { port, handle }
    }

    fn join(self) -> String {
        self.handle.join().expect("server thread")
    }
}

struct ScriptedHttpServer {
    port: u16,
    handle: std::thread::JoinHandle<Vec<String>>,
}

impl ScriptedHttpServer {
    fn spawn(responses: Vec<Value>) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test listener");
        let port = listener.local_addr().expect("listener addr").port();
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let (mut stream, _) = listener.accept().expect("accept");
                let request = read_http_request(&mut stream);
                let body = response.to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                stream
                    .write_all(response.as_bytes())
                    .expect("write response");
                requests.push(request);
            }
            requests
        });
        Self { port, handle }
    }

    fn join(self) -> Vec<String> {
        self.handle.join().expect("server thread")
    }
}

fn read_http_request(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_millis(20)))
        .expect("set test request timeout");
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => buffer.extend_from_slice(&chunk[..count]),
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                break;
            }
            Err(error) => panic!("read request: {error}"),
        }
        if request_is_complete(&buffer) {
            break;
        }
    }
    String::from_utf8_lossy(&buffer).into_owned()
}

fn request_http(
    address: std::net::SocketAddr,
    path: &str,
    timeout: Duration,
) -> Result<String, String> {
    let started = std::time::Instant::now();
    let mut stream = loop {
        match TcpStream::connect(address) {
            Ok(stream) => break stream,
            Err(error)
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted)
                    && started.elapsed() < timeout =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error.to_string()),
        }
    };
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .map_err(|error| error.to_string())?;
    let mut response = String::new();
    stream
        .read_to_string(&mut response)
        .map_err(|error| error.to_string())?;
    Ok(response)
}

fn request_is_complete(buffer: &[u8]) -> bool {
    let Some(header_end) = find_header_end(buffer) else {
        return false;
    };
    let headers = String::from_utf8_lossy(&buffer[..header_end]);
    let Some(content_length) = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    }) else {
        return false;
    };
    buffer.len() >= header_end + 4 + content_length
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn assert_request_path(request: &str, method: &str, path: &str) {
    let mut parts = request.lines().next().unwrap_or_default().split(' ');
    assert_eq!(parts.next(), Some(method));
    assert_eq!(parts.next(), Some(path));
}

fn request_json_body(request: &str) -> Value {
    let body = request
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.trim())
        .unwrap_or_default();
    if body.is_empty() {
        json!({})
    } else {
        serde_json::from_str(body).expect("request JSON body")
    }
}
