use crate::paths::ProjectEntry;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopProjectInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
    pub dashboard_session_name: String,
}

pub fn is_git_project_root(repo_root: impl AsRef<Path>) -> bool {
    std::fs::canonicalize(repo_root.as_ref())
        .unwrap_or_else(|_| repo_root.as_ref().to_path_buf())
        .join(".git")
        .exists()
}

pub fn hidden_project_tmp_dirs(os_tmp_dir: impl AsRef<Path>) -> Vec<PathBuf> {
    let mut dirs = vec![os_tmp_dir.as_ref().to_path_buf()];
    if let Ok(realpath) = os_tmp_dir.as_ref().canonicalize()
        && !dirs.contains(&realpath)
    {
        dirs.push(realpath);
    }
    dirs
}

pub fn should_hide_desktop_project(project_path: impl AsRef<Path>, tmp_dirs: &[PathBuf]) -> bool {
    let project_path = project_path.as_ref();
    if project_path.as_os_str().is_empty() || !project_path.exists() {
        return true;
    }
    if !is_git_project_root(project_path) {
        return true;
    }
    let name = project_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let is_tmp_project = tmp_dirs
        .iter()
        .any(|tmp_dir| project_path == tmp_dir || project_path.strip_prefix(tmp_dir).is_ok());
    is_tmp_project && name.starts_with("aimux-")
}

pub fn list_registered_desktop_projects(
    entries: &[ProjectEntry],
    tmp_dirs: &[PathBuf],
    session_prefix_for_project: impl Fn(&ProjectEntry) -> String,
) -> Vec<DesktopProjectInfo> {
    let mut projects = entries
        .iter()
        .filter(|entry| !should_hide_desktop_project(&entry.repo_root, tmp_dirs))
        .map(|entry| {
            let session_prefix = session_prefix_for_project(entry);
            DesktopProjectInfo {
                id: entry.id.clone(),
                name: entry.name.clone(),
                path: entry.repo_root.clone(),
                last_seen: Some(entry.last_seen.clone()),
                dashboard_session_name: format!("{session_prefix}-{}", entry.id),
            }
        })
        .collect::<Vec<_>>();
    projects.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.path.cmp(&b.path)));
    projects
}
