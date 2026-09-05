use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    pub id: String,
    pub name: String,
    pub repo_root: String,
    pub last_seen: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReadOnlyProjectPaths {
    pub repo_root: String,
    pub project_id: String,
    pub project_state_dir: String,
    pub local_aimux_dir: String,
    pub state_path: String,
    pub runtime_topology_path: String,
    pub runtime_exchange_path: String,
    pub metadata_path: String,
    pub notification_context_path: String,
    pub dashboard_operation_failures_path: String,
}

#[derive(Debug, Clone)]
pub struct PathResolver {
    process_cwd: PathBuf,
    home_dir: PathBuf,
    aimux_home_override: Option<String>,
    repo_root_cache: HashMap<PathBuf, PathBuf>,
}

impl PathResolver {
    pub fn new(
        process_cwd: impl Into<PathBuf>,
        home_dir: impl Into<PathBuf>,
        aimux_home_override: Option<String>,
    ) -> Self {
        Self {
            process_cwd: process_cwd.into(),
            home_dir: home_dir.into(),
            aimux_home_override,
            repo_root_cache: HashMap::new(),
        }
    }

    pub fn from_env() -> Self {
        Self::new(
            std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(".")),
            std::env::var("AIMUX_HOME").ok(),
        )
    }

    pub fn resolve_repo_root(&mut self, cwd: impl AsRef<Path>) -> PathBuf {
        let resolved_cwd = lexical_resolve(&self.process_cwd, cwd.as_ref());
        if let Some(repo_root) = aimux_managed_worktree_parent(&resolved_cwd) {
            return repo_root;
        }

        if let Some(cached) = self.repo_root_cache.get(&resolved_cwd) {
            return cached.clone();
        }

        if let Some(repo_root) = resolve_git_repo_root(&resolved_cwd) {
            self.repo_root_cache.insert(resolved_cwd, repo_root.clone());
            return repo_root;
        }

        resolved_cwd
    }

    pub fn project_id_for(&mut self, cwd: impl AsRef<Path>) -> String {
        compute_project_id(self.resolve_repo_root(cwd))
    }

    pub fn global_aimux_dir(&self) -> PathBuf {
        resolve_aimux_home(
            self.aimux_home_override.as_deref(),
            &self.home_dir,
            &self.process_cwd,
        )
    }

    pub fn daemon_dir(&self) -> PathBuf {
        self.global_aimux_dir().join("daemon")
    }

    pub fn auth_path(&self) -> PathBuf {
        self.global_aimux_dir().join("auth.json")
    }

    pub fn daemon_info_path(&self) -> PathBuf {
        self.daemon_dir().join("daemon.json")
    }

    pub fn hosted_dir(&self) -> PathBuf {
        self.global_aimux_dir().join("hosted")
    }

    pub fn hosted_principals_path(&self) -> PathBuf {
        self.hosted_dir().join("principals.json")
    }

    pub fn hosted_audit_path(&self) -> PathBuf {
        self.hosted_dir().join("audit.jsonl")
    }

    pub fn hosted_audit_prompts_path(&self) -> PathBuf {
        self.hosted_dir().join("audit-prompts.jsonl")
    }

    pub fn hosted_devices_path(&self) -> PathBuf {
        self.hosted_dir().join("devices.json")
    }

    pub fn hosted_lockdown_path(&self) -> PathBuf {
        self.hosted_dir().join("lockdown.json")
    }

    pub fn hosted_outbox_path(&self) -> PathBuf {
        self.hosted_dir().join("outbox.jsonl")
    }

    pub fn daemon_state_path(&self) -> PathBuf {
        self.daemon_dir().join("state.json")
    }

    pub fn daemon_logs_dir(&self) -> PathBuf {
        self.daemon_dir().join("logs")
    }

    pub fn daemon_log_path(&self) -> PathBuf {
        self.daemon_logs_dir().join("daemon.jsonl")
    }

    pub fn daemon_stdio_log_path(&self) -> PathBuf {
        self.daemon_logs_dir().join("daemon-stdio.log")
    }

    pub fn project_state_dir_for(&mut self, cwd: impl AsRef<Path>) -> PathBuf {
        self.global_aimux_dir()
            .join("projects")
            .join(self.project_id_for(cwd))
    }

    pub fn project_logs_dir_for(&mut self, cwd: impl AsRef<Path>) -> PathBuf {
        self.project_state_dir_for(cwd).join("logs")
    }

    pub fn project_log_path_for(&mut self, cwd: impl AsRef<Path>) -> PathBuf {
        self.project_logs_dir_for(cwd).join("aimux.jsonl")
    }

    pub fn project_repair_log_path_for(&mut self, cwd: impl AsRef<Path>) -> PathBuf {
        self.project_logs_dir_for(cwd).join("repairs.jsonl")
    }

    pub fn aimux_dir_for(&mut self, cwd: impl AsRef<Path>) -> PathBuf {
        self.resolve_repo_root(cwd).join(".aimux")
    }

    pub fn config_path_for(&mut self, cwd: impl AsRef<Path>) -> PathBuf {
        self.aimux_dir_for(cwd).join("config.json")
    }

    pub fn project_team_path_for(&mut self, cwd: impl AsRef<Path>) -> PathBuf {
        self.aimux_dir_for(cwd).join("team.json")
    }

    pub fn global_config_path(&self) -> PathBuf {
        self.global_aimux_dir().join("config.json")
    }

    pub fn global_team_path(&self) -> PathBuf {
        self.global_aimux_dir().join("team.json")
    }

    pub fn projects_registry_path(&self) -> PathBuf {
        self.global_aimux_dir().join("projects.json")
    }

    pub fn read_only_project_paths_for(&mut self, cwd: impl AsRef<Path>) -> ReadOnlyProjectPaths {
        let repo_root = self.resolve_repo_root(cwd);
        let project_id = compute_project_id(&repo_root);
        let project_state_dir = self.global_aimux_dir().join("projects").join(&project_id);
        let local_aimux_dir = repo_root.join(".aimux");
        ReadOnlyProjectPaths {
            repo_root: path_to_string(&repo_root),
            project_id,
            project_state_dir: path_to_string(&project_state_dir),
            local_aimux_dir: path_to_string(&local_aimux_dir),
            state_path: path_to_string(&project_state_dir.join("state.json")),
            runtime_topology_path: path_to_string(&project_state_dir.join("runtime-topology.yaml")),
            runtime_exchange_path: path_to_string(&project_state_dir.join("runtime-exchange.yaml")),
            metadata_path: path_to_string(&project_state_dir.join("metadata.json")),
            notification_context_path: path_to_string(
                &project_state_dir.join("notification-context.json"),
            ),
            dashboard_operation_failures_path: path_to_string(
                &project_state_dir.join("dashboard-operation-failures.json"),
            ),
        }
    }
}

pub fn compute_project_id(repo_root: impl AsRef<Path>) -> String {
    let repo_root = path_to_string(repo_root.as_ref());
    let mut hasher = Sha256::new();
    hasher.update(repo_root.as_bytes());
    let hex = format!("{:x}", hasher.finalize());
    let name = Path::new(&repo_root)
        .file_name()
        .and_then(OsStr::to_str)
        .unwrap_or("");
    format!("{}-{}", name, &hex[..12])
}

pub fn resolve_aimux_home(
    override_value: Option<&str>,
    home_dir: impl AsRef<Path>,
    process_cwd: impl AsRef<Path>,
) -> PathBuf {
    let home_dir = home_dir.as_ref();
    let process_cwd = process_cwd.as_ref();
    let Some(trimmed) = override_value
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return home_dir.join(".aimux");
    };
    if trimmed == "~" {
        return home_dir.to_path_buf();
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return lexical_resolve(home_dir, Path::new(rest));
    }
    lexical_resolve(process_cwd, Path::new(trimmed))
}

pub fn aimux_managed_worktree_parent(path: impl AsRef<Path>) -> Option<PathBuf> {
    let path = path.as_ref();
    let components: Vec<_> = path.components().collect();
    for index in 0..components.len().saturating_sub(2) {
        if component_is(components[index], ".aimux")
            && component_is(components[index + 1], "worktrees")
        {
            return Some(components_to_path(&components[..index]));
        }
    }
    None
}

fn resolve_git_repo_root(cwd: &Path) -> Option<PathBuf> {
    let output = Command::new("git")
        .args(["rev-parse", "--git-common-dir"])
        .current_dir(cwd)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_COMMON_DIR")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let git_common_dir = String::from_utf8(output.stdout).ok()?;
    let git_common_dir = git_common_dir.trim();
    if git_common_dir.is_empty() {
        return None;
    }
    let abs_git_dir = lexical_resolve(cwd, Path::new(git_common_dir));
    if let Some(repo_root) = git_common_worktree_parent(&abs_git_dir) {
        return Some(repo_root);
    }
    abs_git_dir.parent().map(Path::to_path_buf)
}

fn git_common_worktree_parent(path: &Path) -> Option<PathBuf> {
    let components: Vec<_> = path.components().collect();
    for index in 0..components.len().saturating_sub(2) {
        if component_is(components[index], ".git")
            && component_is(components[index + 1], "worktrees")
        {
            return Some(components_to_path(&components[..index]));
        }
    }
    None
}

fn lexical_resolve(base: &Path, path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    normalize_components(&joined)
}

fn normalize_components(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::RootDir | Component::Prefix(_) | Component::Normal(_) => out.push(component),
        }
    }
    out
}

fn component_is(component: Component<'_>, expected: &str) -> bool {
    matches!(component, Component::Normal(value) if value == OsStr::new(expected))
}

fn components_to_path(components: &[Component<'_>]) -> PathBuf {
    let mut path = PathBuf::new();
    for component in components {
        path.push(component.as_os_str());
    }
    path
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
