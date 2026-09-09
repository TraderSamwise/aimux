use aimux::paths::{
    PathResolver, aimux_managed_worktree_parent, basename_like_node_posix, compute_project_id,
    resolve_aimux_home,
};
use serde::Deserialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathIdentityFixture {
    repo_root: String,
    project_id: String,
    managed_worktree: String,
    global_home: String,
    read_only_suffixes: ReadOnlySuffixes,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadOnlySuffixes {
    state_path: String,
    runtime_topology_path: String,
    runtime_exchange_path: String,
    metadata_path: String,
    notification_context_path: String,
    dashboard_operation_failures_path: String,
}

fn fixture() -> PathIdentityFixture {
    serde_json::from_str(include_str!(
        "../../../../testdata/contracts/v1/paths/identity.json"
    ))
    .expect("valid path identity fixture")
}

#[test]
fn computes_type_script_project_id_hash_prefix() {
    let fixture = fixture();
    assert_eq!(compute_project_id(&fixture.repo_root), fixture.project_id);
    assert_eq!(basename_like_node_posix("/tmp/foo///"), "foo");
    assert_eq!(basename_like_node_posix("/"), "");
    assert_eq!(basename_like_node_posix("C:\\foo\\bar"), "C:\\foo\\bar");
    assert_eq!(compute_project_id("/"), "-8a5edab28263");
    assert_eq!(compute_project_id("/tmp/foo///"), "foo-44b7bdd71d22");
}

#[test]
fn resolves_aimux_managed_worktrees_to_parent_project() {
    let fixture = fixture();
    assert_eq!(
        aimux_managed_worktree_parent(&fixture.managed_worktree),
        Some(PathBuf::from(&fixture.repo_root)),
    );

    let mut resolver = PathResolver::new("/", "/Users/tester", None);
    assert_eq!(
        resolver.project_id_for(&fixture.managed_worktree),
        fixture.project_id
    );
    assert_eq!(
        resolver.project_id_for(&fixture.repo_root),
        fixture.project_id
    );
}

#[test]
fn resolves_aimux_home_like_node_paths() {
    let home = Path::new("/Users/tester");
    let cwd = Path::new("/tmp/current");
    assert_eq!(
        resolve_aimux_home(None, home, cwd),
        PathBuf::from("/Users/tester/.aimux")
    );
    assert_eq!(
        resolve_aimux_home(Some("   "), home, cwd),
        PathBuf::from("/Users/tester/.aimux")
    );
    assert_eq!(
        resolve_aimux_home(Some("~"), home, cwd),
        PathBuf::from("/Users/tester")
    );
    assert_eq!(
        resolve_aimux_home(Some("~/lane"), home, cwd),
        PathBuf::from("/Users/tester/lane"),
    );
    assert_eq!(
        resolve_aimux_home(Some("relative/lane"), home, cwd),
        PathBuf::from("/tmp/current/relative/lane"),
    );
}

#[test]
fn resolves_read_only_project_paths_without_registration_side_effects() {
    let fixture = fixture();
    let mut resolver = PathResolver::new("/", "/Users/tester", Some(fixture.global_home.clone()));
    let paths = resolver.read_only_project_paths_for(&fixture.managed_worktree);

    assert_eq!(paths.repo_root, fixture.repo_root);
    assert_eq!(paths.project_id, fixture.project_id);
    assert_eq!(
        paths.project_state_dir,
        format!("{}/projects/{}", fixture.global_home, fixture.project_id),
    );
    assert_eq!(
        paths.local_aimux_dir,
        format!("{}/.aimux", fixture.repo_root)
    );
    assert!(
        paths
            .state_path
            .ends_with(&fixture.read_only_suffixes.state_path)
    );
    assert!(
        paths
            .runtime_topology_path
            .ends_with(&fixture.read_only_suffixes.runtime_topology_path)
    );
    assert!(
        paths
            .runtime_exchange_path
            .ends_with(&fixture.read_only_suffixes.runtime_exchange_path)
    );
    assert!(
        paths
            .metadata_path
            .ends_with(&fixture.read_only_suffixes.metadata_path)
    );
    assert!(
        paths
            .notification_context_path
            .ends_with(&fixture.read_only_suffixes.notification_context_path)
    );
    assert!(
        paths
            .dashboard_operation_failures_path
            .ends_with(&fixture.read_only_suffixes.dashboard_operation_failures_path)
    );
}

#[test]
fn does_not_cache_non_git_fallback_roots() {
    let root = std::env::temp_dir().join(format!("aimux-rust-paths-cache-{}", std::process::id()));
    let nested = root.join("nested");
    fs::create_dir_all(&nested).expect("create temp nested dir");
    let mut resolver = PathResolver::new("/", "/Users/tester", None);

    assert_eq!(resolver.resolve_repo_root(&nested), nested);

    let status = Command::new("git")
        .arg("init")
        .arg("-q")
        .arg(&root)
        .status()
        .expect("run git init");
    assert!(status.success());

    assert_eq!(resolver.resolve_repo_root(root.join("nested")), root);

    fs::remove_dir_all(&root).expect("remove temp repo");
}
