use aimux::atomic_write::{quarantine_corrupt_file, write_json_atomic, write_text_atomic};
use aimux::paths::{MAX_PROJECT_REGISTRY_ENTRIES, PathResolver, ProjectsRegistry};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir()
            .join("rust-registry-tests")
            .join(format!("{}-{sequence}", std::process::id()));
        fs::create_dir_all(&path).expect("create test directory");
        Self(path)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn git_root(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    fs::create_dir_all(path.join(".git")).expect("create git marker");
    path.to_path_buf()
}

fn resolver(test_dir: &TestDir) -> PathResolver {
    PathResolver::new(
        &test_dir.0,
        test_dir.0.join("home"),
        Some(test_dir.0.join("global").to_string_lossy().into_owned()),
    )
}

#[test]
fn atomic_json_write_is_pretty_and_newline_terminated() {
    let test_dir = TestDir::new();
    let path = test_dir.0.join("nested/state.json");
    write_json_atomic(&path, &json!({ "version": 1, "items": ["one"] }))
        .expect("write JSON atomically");

    assert_eq!(
        fs::read_to_string(&path).expect("read JSON"),
        "{\n  \"version\": 1,\n  \"items\": [\n    \"one\"\n  ]\n}\n"
    );
    assert!(
        fs::read_dir(path.parent().expect("parent"))
            .expect("read parent")
            .all(|entry| !entry
                .expect("directory entry")
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp"))
    );
}

#[test]
fn quarantine_is_best_effort_and_preserves_corrupt_contents() {
    let test_dir = TestDir::new();
    let path = test_dir.0.join("projects.json");
    write_text_atomic(&path, "not json").expect("write corrupt file");

    let quarantined = quarantine_corrupt_file(&path).expect("quarantine existing file");
    assert!(!path.exists());
    assert!(
        quarantined
            .file_name()
            .expect("file name")
            .to_string_lossy()
            .starts_with("projects.json.corrupt-")
    );
    assert_eq!(
        fs::read_to_string(quarantined).expect("read quarantine"),
        "not json"
    );
    assert_eq!(quarantine_corrupt_file(&path), None);
}

#[test]
fn load_registry_filters_invalid_roots_and_keeps_last_duplicate_value() {
    let test_dir = TestDir::new();
    let repo_a = git_root(test_dir.0.join("repo-a"));
    let repo_b = git_root(test_dir.0.join("repo-b"));
    let non_git = test_dir.0.join("not-git");
    fs::create_dir_all(&non_git).expect("create non-git directory");
    let ephemeral = git_root(std::env::temp_dir().join(format!(
        "aimux-registry-ephemeral-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )));
    let resolver = resolver(&test_dir);
    fs::create_dir_all(resolver.global_aimux_dir()).expect("create global directory");
    let registry = json!({
        "version": 999,
        "projects": [
            null,
            { "id": "missing-root", "name": "missing", "lastSeen": "old" },
            { "id": "blank", "name": "blank", "repoRoot": "  ", "lastSeen": "old" },
            { "id": "non-git", "name": "bad", "repoRoot": non_git, "lastSeen": "old" },
            { "id": "temporary", "name": "temporary", "repoRoot": ephemeral, "lastSeen": "old" },
            { "id": "same", "name": "first", "repoRoot": repo_a, "lastSeen": "first" },
            { "id": "other", "name": "other", "repoRoot": repo_b, "lastSeen": "other" },
            { "id": "same", "name": "last", "repoRoot": repo_a, "lastSeen": "last" }
        ]
    });
    write_json_atomic(resolver.projects_registry_path(), &registry).expect("write registry");

    let loaded = resolver.load_registry().expect("load registry");
    assert_eq!(loaded.version, 1);
    assert_eq!(loaded.projects.len(), 2);
    assert_eq!(loaded.projects[0].id, "same");
    assert_eq!(loaded.projects[0].name, "last");
    assert_eq!(loaded.projects[0].last_seen, "last");
    assert_eq!(loaded.projects[1].id, "other");

    fs::remove_dir_all(ephemeral).expect("remove ephemeral repo");
}

#[test]
fn corrupt_registry_is_quarantined_and_loads_as_empty() {
    let test_dir = TestDir::new();
    let resolver = resolver(&test_dir);
    let path = resolver.projects_registry_path();
    write_text_atomic(&path, "{ nope").expect("write corrupt registry");

    assert_eq!(
        resolver.load_registry().expect("load registry"),
        ProjectsRegistry::default()
    );
    assert!(!path.exists());
    let quarantine_count = fs::read_dir(path.parent().expect("parent"))
        .expect("read global directory")
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("projects.json.corrupt-")
        })
        .count();
    assert_eq!(quarantine_count, 1);
}

#[test]
fn schema_invalid_registry_surfaces_without_quarantine() {
    let test_dir = TestDir::new();
    let resolver = resolver(&test_dir);
    let path = resolver.projects_registry_path();
    write_json_atomic(&path, &json!({ "version": 1, "projects": null }))
        .expect("write schema-invalid registry");

    let error = resolver
        .load_registry()
        .expect_err("schema-invalid registry should surface");
    assert!(
        error
            .to_string()
            .contains("aimux project registry projects must be an array")
    );
    assert!(path.exists());
    let quarantine_count = fs::read_dir(path.parent().expect("parent"))
        .expect("read global directory")
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("projects.json.corrupt-")
        })
        .count();
    assert_eq!(quarantine_count, 0);
}

#[test]
fn registry_cap_is_applied_after_filtering() {
    let test_dir = TestDir::new();
    let repo = git_root(test_dir.0.join("repo"));
    let resolver = resolver(&test_dir);
    fs::create_dir_all(resolver.global_aimux_dir()).expect("create global directory");

    let projects: Vec<_> = (0..=MAX_PROJECT_REGISTRY_ENTRIES)
        .map(|index| {
            json!({
                "id": format!("project-{index}"),
                "name": "repo",
                "repoRoot": repo,
                "lastSeen": "now"
            })
        })
        .collect();
    write_json_atomic(
        resolver.projects_registry_path(),
        &json!({ "version": 1, "projects": projects }),
    )
    .expect("write oversized registry");
    let error = resolver
        .load_registry()
        .expect_err("reject oversized registry");
    assert!(error.to_string().contains("cap is 500"));

    let invalid_projects: Vec<_> = (0..=MAX_PROJECT_REGISTRY_ENTRIES)
        .map(|index| {
            json!({
                "id": format!("invalid-{index}"),
                "name": "invalid",
                "repoRoot": test_dir.0.join(format!("missing-{index}")),
                "lastSeen": "now"
            })
        })
        .chain(std::iter::once(json!({
            "id": "valid",
            "name": "repo",
            "repoRoot": repo,
            "lastSeen": "now"
        })))
        .collect();
    write_json_atomic(
        resolver.projects_registry_path(),
        &json!({ "version": 1, "projects": invalid_projects }),
    )
    .expect("write filtered registry");
    assert_eq!(
        resolver
            .load_registry()
            .expect("load filtered registry")
            .projects
            .len(),
        1
    );
}

#[test]
fn register_project_skips_ineligible_roots_and_updates_existing_entry() {
    let test_dir = TestDir::new();
    let repo = git_root(test_dir.0.join("project-name"));
    let non_git = test_dir.0.join("plain-directory");
    fs::create_dir_all(&non_git).expect("create non-git directory");
    let ephemeral = git_root(std::env::temp_dir().join(format!(
        "aimux-register-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )));
    let mut resolver = resolver(&test_dir);

    assert_eq!(
        resolver.register_project(&non_git).expect("skip non-git"),
        None
    );
    assert_eq!(
        resolver.register_project(&ephemeral).expect("skip temp"),
        None
    );
    assert!(!resolver.projects_registry_path().exists());

    let first = resolver
        .register_project(&repo)
        .expect("register project")
        .expect("eligible project");
    assert_eq!(first.name, "project-name");
    assert_eq!(first.repo_root, repo.to_string_lossy());
    assert_eq!(first.last_seen.len(), 24);
    assert!(first.last_seen.ends_with('Z'));
    assert_eq!(&first.last_seen[4..5], "-");
    assert_eq!(&first.last_seen[7..8], "-");
    assert_eq!(&first.last_seen[10..11], "T");
    assert_eq!(&first.last_seen[19..20], ".");

    let second = resolver
        .register_project(&repo)
        .expect("update project")
        .expect("eligible project");
    assert_eq!(second.id, first.id);
    let projects = resolver.list_projects().expect("list projects");
    assert_eq!(projects.len(), 1);

    let serialized = fs::read_to_string(resolver.projects_registry_path()).expect("read registry");
    assert!(serialized.ends_with("\n"));
    let value: Value = serde_json::from_str(&serialized).expect("valid registry JSON");
    assert_eq!(value["version"], 1);

    fs::remove_dir_all(ephemeral).expect("remove ephemeral repo");
}
