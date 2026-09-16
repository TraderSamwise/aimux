#![cfg(unix)]

use aimux::atomic_write::write_text_atomic;
use aimux::config;
use aimux::daemon_state::{
    DaemonState, MetadataApiEndpoint, MetadataState, save_daemon_state, save_metadata_endpoint,
    save_metadata_state,
};
use aimux::debug_logging::append_rotating_jsonl;
use aimux::paths::PathResolver;
use aimux::project_api_contract::routes;
use aimux::project_service::attachments::{attachments_dir, route_attachment_request};
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::runtime_exchange::{
    empty_runtime_exchange, runtime_exchange_path, write_runtime_exchange,
};
use aimux::runtime_topology::{
    empty_runtime_topology, runtime_topology_path, write_runtime_topology,
};
use aimux::secure_permissions::{
    PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, global_aimux_excluded_executable_dirs,
    local_aimux_excluded_executable_or_source_dirs, local_aimux_sensitive_dirs,
    repair_global_aimux_home, repair_project_local_store, repair_project_state_store,
    repair_registered_project_local_stores, write_private_file_without_parent_chmod,
};
use serde_json::json;
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

static UMASK_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn sensitive_store_writes_are_private_under_permissive_umask() {
    let _lock = UMASK_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let _umask = UmaskGuard::set(0);
    let fixture = Fixture::new("writes");

    let mut resolver = PathResolver::new(
        &fixture.project,
        &fixture.home,
        Some(fixture.aimux_home.to_string_lossy().into_owned()),
    );
    config::init_project_with_resolver(&mut resolver, &fixture.project).expect("init project");
    resolver
        .register_project(&fixture.project)
        .expect("register project");
    let project_state_dir = resolver.project_state_dir_for(&fixture.project);

    write_local_project_artifacts(&fixture.project);
    write_project_state_artifacts(&project_state_dir);
    write_global_artifacts(&resolver);
    upload_and_publish_attachments(&fixture.project, &project_state_dir);

    let temp_file = fixture.root.join("tmp-sensitive-input");
    write_private_file_without_parent_chmod(&temp_file, "compact prompt").expect("temp write");

    assert_private_dir(&fixture.project.join(".aimux"));
    for dir in local_aimux_sensitive_dirs() {
        assert_private_tree(&fixture.project.join(".aimux").join(dir));
    }
    assert_private_tree(&attachments_dir(&fixture.project));
    assert_private_tree(&project_state_dir);
    assert_private_tree(&fixture.aimux_home);
    assert_private_file(&temp_file);
    assert_eq!(
        local_aimux_excluded_executable_or_source_dirs(),
        &["plugins", "worktrees"]
    );
    assert_eq!(global_aimux_excluded_executable_dirs(), &["native"]);
}

#[test]
fn upgrade_repair_restores_existing_sensitive_store_modes() {
    let _lock = UMASK_LOCK
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let _umask = UmaskGuard::set(0);
    let fixture = Fixture::new("repair");
    let mut resolver = PathResolver::new(
        &fixture.project,
        &fixture.home,
        Some(fixture.aimux_home.to_string_lossy().into_owned()),
    );
    let project_state_dir = resolver.project_state_dir_for(&fixture.project);

    let local_dir = fixture.project.join(".aimux");
    make_public_dir(&local_dir);
    for dir in local_aimux_sensitive_dirs() {
        let store = local_dir.join(dir);
        make_public_dir(&store);
        make_public_file(store.join("stale.txt"));
    }
    let worktree_executable = local_dir.join("worktrees").join("tool.sh");
    make_public_dir(worktree_executable.parent().expect("worktree parent"));
    make_mode_file(&worktree_executable, 0o755);

    let inactive_project = fixture.root.join("inactive-project");
    let inactive_local_dir = inactive_project.join(".aimux");
    make_public_dir(&inactive_local_dir);
    make_public_dir(inactive_local_dir.join("context").join("codex-old"));
    make_public_file(
        inactive_local_dir
            .join("context")
            .join("codex-old")
            .join("live.md"),
    );

    make_public_dir(&project_state_dir);
    for path in [
        project_state_dir.join("metadata.json"),
        project_state_dir.join("runtime-exchange.yaml"),
        project_state_dir.join("runtime-topology.yaml"),
        project_state_dir.join("logs").join("aimux.jsonl"),
        project_state_dir.join("recordings").join("demo.cast"),
    ] {
        if let Some(parent) = path.parent() {
            make_public_dir(parent);
        }
        make_public_file(path);
    }

    make_public_dir(&fixture.aimux_home);
    for path in [
        fixture.aimux_home.join("projects.json"),
        fixture
            .aimux_home
            .join("projects")
            .join("project")
            .join("metadata.json"),
        fixture.aimux_home.join("daemon").join("state.json"),
    ] {
        if let Some(parent) = path.parent() {
            make_public_dir(parent);
        }
        make_public_file(path);
    }
    let native_executable = fixture
        .aimux_home
        .join("native")
        .join("local-test")
        .join("aimux");
    make_public_dir(native_executable.parent().expect("native parent"));
    make_mode_file(&native_executable, 0o755);

    repair_project_local_store(&fixture.project).expect("repair local store");
    repair_registered_project_local_stores([fixture.project.as_path(), inactive_project.as_path()])
        .expect("repair registered local stores");
    repair_project_state_store(&project_state_dir).expect("repair project state");
    repair_global_aimux_home(&fixture.aimux_home).expect("repair global home");

    assert_private_dir(&local_dir);
    for dir in local_aimux_sensitive_dirs() {
        assert_private_tree(&local_dir.join(dir));
    }
    assert_private_dir(&inactive_local_dir);
    assert_private_tree(&inactive_local_dir.join("context"));
    assert_eq!(mode(&worktree_executable), 0o755);
    assert_private_tree(&project_state_dir);
    assert_private_dir(&fixture.aimux_home);
    assert_private_tree(&fixture.aimux_home.join("projects"));
    assert_private_tree(&fixture.aimux_home.join("daemon"));
    assert_private_file(&fixture.aimux_home.join("projects.json"));
    assert_eq!(mode(&native_executable), 0o755);
}

fn write_local_project_artifacts(project: &Path) {
    let local = project.join(".aimux");
    write_text_atomic(
        local.join("context").join("codex-test").join("live.md"),
        "source code",
    )
    .expect("context");
    write_text_atomic(local.join("history").join("codex-test.jsonl"), "{}\n").expect("history");
    write_text_atomic(local.join("plans").join("codex-test.md"), "plan").expect("plan");
    write_text_atomic(local.join("status").join("codex-test.md"), "status").expect("status");
    write_text_atomic(local.join("tasks").join("task.json"), "{}\n").expect("task");
    write_text_atomic(local.join("threads").join("thread.json"), "{}\n").expect("thread");
    write_text_atomic(
        local.join("recordings").join("codex-test.cast"),
        "recording",
    )
    .expect("recording");
    write_text_atomic(local.join("logs").join("project.log"), "log").expect("local log");
}

fn write_project_state_artifacts(project_state_dir: &Path) {
    let mut sessions = BTreeMap::new();
    sessions.insert("codex-test".to_owned(), json!({ "status": "running" }));
    save_metadata_state(
        project_state_dir,
        &MetadataState {
            version: 1,
            sessions,
        },
    )
    .expect("metadata");
    save_metadata_endpoint(
        project_state_dir,
        &MetadataApiEndpoint {
            host: "127.0.0.1".to_owned(),
            port: 43190,
            pid: std::process::id() as i32,
            updated_at: "2026-09-16T00:00:00Z".to_owned(),
        },
    )
    .expect("metadata endpoint");
    write_runtime_exchange(
        runtime_exchange_path(project_state_dir),
        &empty_runtime_exchange(),
    )
    .expect("runtime exchange");
    let mut topology = empty_runtime_topology();
    topology["sessions"] = json!([{
        "id": "codex-dead",
        "status": "graveyard",
        "graveyardedAt": "2026-09-16T00:00:00Z",
        "graveyardReason": "test"
    }]);
    write_runtime_topology(runtime_topology_path(project_state_dir), &topology)
        .expect("runtime topology");
    append_rotating_jsonl(project_state_dir.join("logs").join("aimux.jsonl"), "{}\n")
        .expect("project log");
}

fn write_global_artifacts(resolver: &PathResolver) {
    save_daemon_state(resolver.daemon_state_path(), &DaemonState::empty()).expect("daemon state");
}

fn upload_and_publish_attachments(project: &Path, project_state_dir: &Path) {
    let context = ProjectServiceRequestContext::with_project_state_dir(project, project_state_dir);
    let upload = route_attachment_request(
        &context,
        "POST",
        routes::ATTACHMENTS,
        Some(&json!({
            "filename": "secret.txt",
            "mimeType": "text/plain",
            "dataBase64": "c291cmNlIGNvZGU=",
            "sessionId": "codex-test"
        })),
    )
    .expect("upload route");
    assert_eq!(upload.status, 200, "upload response: {}", upload.body);
    assert!(upload.body["attachment"]["id"].as_str().is_some());

    let source = project.join("publish-source.txt");
    fs::write(&source, "publish me").expect("source attachment");
    let publish = route_attachment_request(
        &context,
        "POST",
        routes::ATTACHMENTS_PUBLISH,
        Some(&json!({
            "path": source,
            "sessionId": "codex-test",
            "mimeType": "text/plain"
        })),
    )
    .expect("publish route");
    assert_eq!(publish.status, 200, "publish response: {}", publish.body);
}

fn assert_private_tree(root: &Path) {
    assert_private_dir(root);
    for entry in fs::read_dir(root).unwrap_or_else(|error| {
        panic!("read private tree {}: {error}", root.display());
    }) {
        let path = entry.expect("tree entry").path();
        let metadata = fs::symlink_metadata(&path).expect("tree metadata");
        let file_type = metadata.file_type();
        if file_type.is_dir() {
            assert_private_tree(&path);
        } else if file_type.is_file() {
            assert_private_file(&path);
        }
    }
}

fn assert_private_dir(path: &Path) {
    assert_eq!(mode(path), PRIVATE_DIR_MODE, "dir {}", path.display());
}

fn assert_private_file(path: &Path) {
    assert_eq!(mode(path), PRIVATE_FILE_MODE, "file {}", path.display());
}

fn mode(path: &Path) -> u32 {
    fs::symlink_metadata(path)
        .unwrap_or_else(|error| panic!("metadata {}: {error}", path.display()))
        .permissions()
        .mode()
        & 0o777
}

fn make_public_dir(path: impl AsRef<Path>) {
    let path = path.as_ref();
    fs::create_dir_all(path).expect("public dir");
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("chmod public dir");
}

fn make_public_file(path: impl AsRef<Path>) {
    make_mode_file(path, 0o644);
}

fn make_mode_file(path: impl AsRef<Path>, mode: u32) {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("mode file parent");
    }
    fs::write(path, "stale").expect("mode file");
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).expect("chmod mode file");
}

struct Fixture {
    root: PathBuf,
    home: PathBuf,
    aimux_home: PathBuf,
    project: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "aimux-secure-permissions-{label}-{}-{nonce}",
            std::process::id()
        ));
        let home = root.join("home");
        let aimux_home = root.join("aimux-home");
        let project = root.join("project");
        fs::create_dir_all(project.join(".git")).expect("project git");
        Self {
            root,
            home,
            aimux_home,
            project,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

struct UmaskGuard(libc::mode_t);

impl UmaskGuard {
    fn set(mask: libc::mode_t) -> Self {
        Self(unsafe { libc::umask(mask) })
    }
}

impl Drop for UmaskGuard {
    fn drop(&mut self) {
        unsafe {
            libc::umask(self.0);
        }
    }
}
