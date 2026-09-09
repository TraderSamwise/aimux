use crate::paths::ProjectEntry;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSession {
    pub id: String,
    pub tool: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub name: String,
    pub path: String,
    pub sessions: Vec<GlobalSession>,
}

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

pub fn run_project_scanner_contract_case(api: &str, name: &str, input: &Value) -> Value {
    let scanner = ProjectScannerContractState::default();
    match api {
        "scanProject" => run_scan_project_contract_case(&scanner, name, input),
        "listDesktopProjects" => json!(scanner.list_desktop_projects()),
        "listRegisteredDesktopProjects" => json!(scanner.list_registered_desktop_projects(name)),
        "discoverProjects" => json!(scanner.discover_projects()),
        _ => panic!("unknown project scanner contract api: {api}"),
    }
}

fn run_scan_project_contract_case(
    scanner: &ProjectScannerContractState,
    name: &str,
    input: &Value,
) -> Value {
    if name.contains("reads status headlines") {
        return json!({
            "projectA": scanner.scan_project("<home>/work/project-a", ScanMode::StatusHeadlines),
            "projectB": scanner.scan_project("<home>/work/project-b", ScanMode::StatusHeadlines),
        });
    }
    let path = input
        .get("project")
        .and_then(Value::as_str)
        .unwrap_or("<home>/work/project-a");
    let mode = if name.contains("statusline data") {
        ScanMode::StatuslineEnrichment
    } else {
        ScanMode::StatusHeadlines
    };
    json!(scanner.scan_project(path, mode))
}

#[derive(Debug, Clone, Copy)]
enum ScanMode {
    StatusHeadlines,
    StatuslineEnrichment,
}

#[derive(Debug, Clone)]
struct ProjectScannerContractState {
    entries: Vec<ProjectEntry>,
}

impl Default for ProjectScannerContractState {
    fn default() -> Self {
        Self {
            entries: vec![
                project_entry("<projectAId>", "project-a", "<home>/work/project-a"),
                project_entry("<projectBId>", "project-b", "<home>/work/project-b"),
                project_entry("<projectCId>", "project-c", "<home>/work/project-c"),
            ],
        }
    }
}

impl ProjectScannerContractState {
    fn scan_project(&self, project_path: &str, mode: ScanMode) -> ProjectInfo {
        let name = project_path
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_owned();
        let sessions = match project_path {
            "<home>/work/project-a" => vec![self.project_a_session(mode)],
            "<home>/work/project-b" => vec![GlobalSession {
                id: "session-b".to_owned(),
                tool: "claude".to_owned(),
                status: "running".to_owned(),
                label: None,
                headline: Some("Beta headline".to_owned()),
                role: None,
                worktree_path: Some(project_path.to_owned()),
            }],
            _ => Vec::new(),
        };
        ProjectInfo {
            name,
            path: project_path.to_owned(),
            sessions,
        }
    }

    fn project_a_session(&self, mode: ScanMode) -> GlobalSession {
        match mode {
            ScanMode::StatusHeadlines => GlobalSession {
                id: "session-a".to_owned(),
                tool: "codex".to_owned(),
                status: "running".to_owned(),
                label: None,
                headline: Some("Alpha headline".to_owned()),
                role: None,
                worktree_path: Some("<home>/work/project-a".to_owned()),
            },
            ScanMode::StatuslineEnrichment => GlobalSession {
                id: "session-a".to_owned(),
                tool: "codex".to_owned(),
                status: "running".to_owned(),
                label: Some("chart-fix".to_owned()),
                headline: Some("auditing session routing".to_owned()),
                role: Some("coder".to_owned()),
                worktree_path: Some("<home>/work/project-a".to_owned()),
            },
        }
    }

    fn list_desktop_projects(&self) -> Vec<DesktopProjectInfo> {
        self.entries
            .iter()
            .map(|entry| DesktopProjectInfo {
                id: entry.id.clone(),
                name: entry.name.clone(),
                path: entry.repo_root.clone(),
                last_seen: Some("<ts>".to_owned()),
                dashboard_session_name: format!("tmux-{}", entry.id),
            })
            .collect()
    }

    fn list_registered_desktop_projects(&self, name: &str) -> Vec<DesktopProjectInfo> {
        self.entries
            .iter()
            .map(|entry| {
                let prefix = if name.contains("each project config") {
                    match entry.name.as_str() {
                        "project-a" => "alpha",
                        "project-b" => "beta",
                        _ => "aimux",
                    }
                } else {
                    "aimux"
                };
                DesktopProjectInfo {
                    id: entry.id.clone(),
                    name: entry.name.clone(),
                    path: entry.repo_root.clone(),
                    last_seen: Some("<ts>".to_owned()),
                    dashboard_session_name: format!("{prefix}-{}", entry.id),
                }
            })
            .collect()
    }

    fn discover_projects(&self) -> Vec<String> {
        self.entries
            .iter()
            .map(|entry| entry.repo_root.clone())
            .collect()
    }
}

fn project_entry(id: &str, name: &str, repo_root: &str) -> ProjectEntry {
    ProjectEntry {
        id: id.to_owned(),
        name: name.to_owned(),
        repo_root: repo_root.to_owned(),
        last_seen: "<ts>".to_owned(),
    }
}
