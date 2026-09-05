use aimux::daemon::core_commands::DaemonCoreCommandRuntime;
use aimux::daemon::process::handle_daemon_runtime_request;
use aimux::daemon::runtime::RealDaemonRuntime;
use aimux::daemon::status::DaemonStatusRuntime;
use aimux::daemon::text::auth::DaemonAuthTextRuntime;
use aimux::daemon_state::{
    AimuxDaemonInfo, DaemonState, MetadataApiEndpoint, ProjectServiceState, ProjectServiceStatus,
    save_daemon_state, save_metadata_endpoint,
};
use aimux::paths::PathResolver;
use serde_json::{Map, Value, json};
use std::fs::{self, remove_dir_all};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

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
fn native_daemon_core_command_ids_are_unique() {
    let fixture = RuntimeFixture::new("command-id");
    let runtime = fixture.runtime();

    assert_eq!(runtime.next_core_command_id(), "native-1");
    assert_eq!(runtime.next_core_command_id(), "native-2");
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
