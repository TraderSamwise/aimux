use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::core_commands::DaemonCoreCommandRuntime;
use aimux::daemon::expose::{
    DaemonExposeFocusRuntime, TmuxClientInfo, expose_focus_route_with_runtime,
    open_target_for_client,
};
use aimux::daemon::json::DaemonJsonRouteRuntime;
use aimux::daemon::json::ExposeFocusRequest;
use aimux::daemon::process::handle_daemon_runtime_request;
use aimux::daemon::runtime::{
    PROJECT_SERVICE_STARTUP_TIMEOUT_MS, ProjectServiceLauncher, ProjectServiceProcessVerifier,
    RealDaemonRuntime, SystemProjectServiceLauncher,
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
use aimux::paths::PathResolver;
use aimux::project_api_contract::routes as project_routes;
use aimux::remote_credentials::{AimuxCredentials, load_credentials, save_credentials_at};
use aimux::runtime_topology::{runtime_topology_path, write_runtime_topology};
use aimux::tmux::TmuxTarget;
use aimux::tmux_expose::{ExposeScope, ExposeScopeView, ExposeSublabel};
use aimux::tmux_expose_hot_snapshot::{HotExposeScopeKey, write_hot_expose_scope_view};
use serde_json::{Map, Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, remove_dir_all};
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
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
fn native_daemon_global_expose_items_read_project_topology_without_waking_cold_projects() {
    let fixture = RuntimeFixture::new("global-expose-items");
    let alpha = fixture.project("alpha");
    let beta = fixture.project("beta");
    let cold = fixture.project("cold");
    let mut resolver = fixture.resolver();
    let alpha_entry = resolver
        .register_project(&alpha)
        .expect("register alpha")
        .expect("alpha entry");
    let beta_entry = resolver
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
    assert_eq!(
        items
            .iter()
            .map(|item| item["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["alpha-agent", "beta-agent"]
    );
    assert_eq!(items[0]["projectId"], alpha_entry.id);
    assert_eq!(items[0]["projectName"], "alpha");
    assert_eq!(
        items[0]["projectRoot"].as_str(),
        Some(alpha.to_string_lossy().as_ref())
    );
    assert_eq!(items[0]["exposeContext"]["project"], "alpha");
    assert_eq!(items[0]["exposeContext"]["worktree"], "main");
    assert!(items[0]["exposeContext"]["tone"].as_i64().is_some());
    assert_eq!(
        items[0]["exposeStatus"],
        json!({ "kind": "needs", "label": "Needs input" })
    );
    assert_eq!(items[0]["previewSnapshot"], alpha_preview);
    assert_eq!(items[1]["projectId"], beta_entry.id);
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
    assert_eq!(report["projectCount"], json!(2));
    assert_eq!(report["serviceAliveCount"], json!(1));
    assert_eq!(report["daemonStateProjectCount"], json!(1));
    assert_eq!(report["projects"].as_array().map(Vec::len), Some(2));
    assert_eq!(report["relay"]["status"], "off");
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
    let mut runtime = fixture.runtime_with_launcher(launcher.clone(), 0);

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
    assert_eq!(project_json["status"], "starting");
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
        Some(&json!("starting"))
    );
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
    let mut runtime = fixture.runtime_with_launcher(launcher.clone(), 0);

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
    let verifier = Arc::new(FakeProcessVerifier::legacy_node(
        [std::process::id() as i32],
    ));
    let mut runtime = fixture.runtime_with_launcher_and_verifier(launcher.clone(), verifier, 0);

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
    assert_eq!(project_json["status"], "starting");
    assert!(
        load_metadata_endpoint(resolver.project_state_dir_for(&project)).is_none(),
        "legacy endpoint must be cleared before native relaunch publishes its own endpoint"
    );
    fixture.cleanup();
}

#[test]
fn ensure_project_keeps_existing_live_pid_starting_until_endpoint_exists() {
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

    let project_json = runtime
        .ensure_project(project.to_str().expect("project path"))
        .expect("ensure project");

    assert!(launcher.calls().is_empty());
    assert_eq!(project_json["pid"], json!(std::process::id() as i32));
    assert_eq!(project_json["status"], "starting");
    fixture.cleanup();
}

#[test]
fn core_projects_ensure_route_uses_native_supervision_runtime() {
    let fixture = RuntimeFixture::new("ensure-route");
    let project = fixture.project("repo");
    let launcher = Arc::new(FakeLauncher::new(87_656));
    let mut runtime = fixture.runtime_with_launcher(launcher.clone(), 0);
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
    let mut runtime = fixture.runtime_with_launcher(launcher.clone(), 0);

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
    let mut runtime = fixture.runtime();

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
    let mut runtime = fixture.runtime();

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
    assert_eq!(restarted["project"]["status"], "starting");
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
fn native_daemon_push_acknowledges_when_relay_is_unavailable() {
    let fixture = RuntimeFixture::new("push-relay-unavailable");
    let mut runtime = fixture.runtime();

    let result = runtime.push_notification(&json!({
        "title": "Needs input",
        "body": "codex is waiting",
        "sessionId": "codex-1"
    }));

    assert_eq!(
        result,
        json!({ "ok": true, "suppressed": true, "reason": "relay_unavailable" })
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
        let root = std::env::temp_dir().join(format!(
            "aimux-rust-daemon-runtime-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = remove_dir_all(&root);
        let home = root.join("home");
        fs::create_dir_all(&home).expect("home");
        Self {
            root,
            home,
            info: AimuxDaemonInfo {
                pid: std::process::id() as i32,
                port: 43_190,
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
    }

    fn runtime_with_launcher(
        &self,
        launcher: Arc<dyn ProjectServiceLauncher>,
        startup_timeout_ms: u64,
    ) -> RealDaemonRuntime {
        self.runtime_with_launcher_and_verifier(
            launcher,
            Arc::new(FakeProcessVerifier::native([std::process::id() as i32])),
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
            endpoint_port: None,
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
    native: BTreeSet<i32>,
}

impl FakeProcessVerifier {
    fn native(pids: impl IntoIterator<Item = i32>) -> Self {
        let native = pids.into_iter().collect::<BTreeSet<_>>();
        Self {
            live: native.clone(),
            native,
        }
    }

    fn legacy_node(pids: impl IntoIterator<Item = i32>) -> Self {
        Self {
            live: pids.into_iter().collect(),
            native: BTreeSet::new(),
        }
    }
}

impl ProjectServiceProcessVerifier for FakeProcessVerifier {
    fn is_live(&self, pid: i32) -> bool {
        self.live.contains(&pid)
    }

    fn is_live_native_project_service(&self, service: &ProjectServiceState) -> bool {
        self.native.contains(&service.pid)
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
