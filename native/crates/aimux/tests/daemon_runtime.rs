use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::core_commands::DaemonCoreCommandRuntime;
use aimux::daemon::process::handle_daemon_runtime_request;
use aimux::daemon::runtime::{ProjectServiceLauncher, RealDaemonRuntime};
use aimux::daemon::status::DaemonStatusRuntime;
use aimux::daemon::text::auth::DaemonAuthTextRuntime;
use aimux::daemon_state::{
    AimuxDaemonInfo, DaemonState, MetadataApiEndpoint, ProjectServiceState, ProjectServiceStatus,
    save_daemon_state, save_metadata_endpoint,
};
use aimux::paths::PathResolver;
use serde_json::{Map, Value, json};
use std::fs::{self, remove_dir_all};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

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
        RealDaemonRuntime::new(self.resolver(), self.info.clone())
    }

    fn runtime_with_launcher(
        &self,
        launcher: Arc<dyn ProjectServiceLauncher>,
        startup_timeout_ms: u64,
    ) -> RealDaemonRuntime {
        RealDaemonRuntime::with_project_service_launcher(
            self.resolver(),
            self.info.clone(),
            launcher,
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

#[derive(Debug)]
struct FakeLauncher {
    pid: i32,
    calls: Mutex<Vec<String>>,
    terminations: Mutex<Vec<(i32, bool)>>,
}

impl FakeLauncher {
    fn new(pid: i32) -> Self {
        Self {
            pid,
            calls: Mutex::new(Vec::new()),
            terminations: Mutex::new(Vec::new()),
        }
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
        _project_state_dir: &Path,
    ) -> Result<i32, String> {
        self.calls
            .lock()
            .expect("calls")
            .push(project_root.to_string_lossy().into_owned());
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
