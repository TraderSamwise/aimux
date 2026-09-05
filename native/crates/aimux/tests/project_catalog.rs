use aimux::paths::ProjectEntry;
use aimux::project_catalog::{
    hidden_project_tmp_dirs, is_git_project_root, list_registered_desktop_projects,
};
use std::fs;
use std::path::{Path, PathBuf};

fn project_entry(id: &str, name: &str, repo_root: &Path) -> ProjectEntry {
    ProjectEntry {
        id: id.into(),
        name: name.into(),
        repo_root: repo_root.to_string_lossy().into_owned(),
        last_seen: "2026-03-28T00:00:00.000Z".into(),
    }
}

fn git_project(path: &Path) {
    fs::create_dir_all(path.join(".git")).expect("create git marker");
}

struct CwdGuard {
    previous: PathBuf,
}

impl CwdGuard {
    fn enter(path: &Path) -> Self {
        let previous = std::env::current_dir().expect("read current dir");
        std::env::set_current_dir(path).expect("set current dir");
        Self { previous }
    }
}

impl Drop for CwdGuard {
    fn drop(&mut self) {
        std::env::set_current_dir(&self.previous).expect("restore current dir");
    }
}

#[test]
fn registered_desktop_projects_keep_known_projects_without_services() {
    let root = std::env::temp_dir().join(format!("aimux-rust-catalog-{}", std::process::id()));
    let project_a = root.join("work").join("project-a");
    let project_b = root.join("work").join("project-b");
    git_project(&project_a);
    git_project(&project_b);

    let entries = vec![
        project_entry("proj-b", "project-b", &project_b),
        project_entry("proj-a", "project-a", &project_a),
    ];
    let projects = list_registered_desktop_projects(
        &entries,
        &hidden_project_tmp_dirs(root.join("tmp")),
        |_| "aimux".into(),
    );

    assert_eq!(projects.len(), 2);
    assert_eq!(projects[0].id, "proj-a");
    assert_eq!(projects[0].dashboard_session_name, "aimux-proj-a");
    assert_eq!(projects[1].id, "proj-b");

    fs::remove_dir_all(&root).expect("remove temp catalog");
}

#[test]
fn hides_missing_non_git_and_tmp_aimux_projects_but_keeps_tmp_prefix_siblings() {
    let root = std::env::temp_dir().join(format!("aimux-rust-catalog-hide-{}", std::process::id()));
    let tmp_dir = root.join("tmp");
    let tmp_aimux = tmp_dir.join("aimux-agent-tracker-123");
    let tmp_sibling =
        PathBuf::from(format!("{}-sibling", tmp_dir.to_string_lossy())).join("aimux-real-project");
    let non_git = root.join("work").join("logs");
    let valid = root.join("work").join("valid");
    git_project(&tmp_aimux);
    git_project(&tmp_sibling);
    git_project(&valid);
    fs::create_dir_all(&non_git).expect("create non-git project");

    let entries = vec![
        project_entry("temp", "temp", &tmp_aimux),
        project_entry("tmp-sibling", "tmp-sibling", &tmp_sibling),
        project_entry("missing", "missing", &root.join("missing")),
        project_entry("non-git", "logs", &non_git),
        project_entry("valid", "valid", &valid),
    ];
    let projects =
        list_registered_desktop_projects(&entries, &hidden_project_tmp_dirs(&tmp_dir), |_| {
            "aimux".into()
        });
    let ids = projects
        .iter()
        .map(|project| project.id.as_str())
        .collect::<Vec<_>>();

    assert_eq!(ids, vec!["tmp-sibling", "valid"]);

    fs::remove_dir_all(&root).expect("remove temp catalog root");
}

#[test]
fn git_project_root_accepts_relative_paths_like_node_resolve() {
    let root = std::env::temp_dir().join(format!(
        "aimux-rust-catalog-relative-{}",
        std::process::id()
    ));
    let project = root.join("project");
    git_project(&project);

    let _guard = CwdGuard::enter(&root);
    assert!(is_git_project_root("project"));

    fs::remove_dir_all(&root).expect("remove relative catalog root");
}

#[test]
fn sorts_registered_projects_by_name_then_path_and_uses_project_prefixes() {
    let root = std::env::temp_dir().join(format!("aimux-rust-catalog-sort-{}", std::process::id()));
    let beta = root.join("z").join("same-name");
    let alpha = root.join("a").join("same-name");
    git_project(&beta);
    git_project(&alpha);

    let entries = vec![
        project_entry("beta", "same-name", &beta),
        project_entry("alpha", "same-name", &alpha),
    ];
    let projects = list_registered_desktop_projects(
        &entries,
        &hidden_project_tmp_dirs(root.join("tmp")),
        |entry| {
            if entry.id == "alpha" {
                "alpha-prefix".into()
            } else {
                "beta-prefix".into()
            }
        },
    );

    assert_eq!(projects[0].id, "alpha");
    assert_eq!(projects[0].dashboard_session_name, "alpha-prefix-alpha");
    assert_eq!(projects[1].id, "beta");

    fs::remove_dir_all(&root).expect("remove temp catalog");
}
