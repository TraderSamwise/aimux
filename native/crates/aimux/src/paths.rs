use crate::atomic_write::{quarantine_corrupt_file, write_json_atomic};
use crate::debug_logging::{LogLevel, log_at};
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

pub const PROJECTS_REGISTRY_VERSION: u8 = 1;
pub const MAX_PROJECT_REGISTRY_ENTRIES: usize = 500;
const EPHEMERAL_TEMP_PROJECT_PREFIX: &str = "aimux-";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectEntry {
    pub id: String,
    pub name: String,
    pub repo_root: String,
    pub last_seen: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectsRegistry {
    pub version: u8,
    pub projects: Vec<ProjectEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectRootStatus {
    GitCheckout,
    NotCheckout,
    Unreachable,
}

impl Default for ProjectsRegistry {
    fn default() -> Self {
        Self {
            version: PROJECTS_REGISTRY_VERSION,
            projects: Vec::new(),
        }
    }
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

    pub fn load_registry(&self) -> Result<ProjectsRegistry> {
        let path = self.projects_registry_path();
        let entries = self.load_registry_entries_raw()?;
        normalize_registry(entries, &self.process_cwd, &path)
    }

    fn load_registry_entries_raw(&self) -> Result<Vec<ProjectEntry>> {
        let path = self.projects_registry_path();
        if !path.exists() {
            return Ok(Vec::new());
        }
        let Ok(contents) = fs::read_to_string(&path) else {
            quarantine_corrupt_file(&path);
            return Ok(Vec::new());
        };
        let Ok(value) = serde_json::from_str::<Value>(&contents) else {
            quarantine_corrupt_file(&path);
            return Ok(Vec::new());
        };
        let Some(projects) = value.get("projects").and_then(Value::as_array) else {
            bail!("aimux project registry projects must be an array");
        };

        Ok(projects
            .iter()
            .filter_map(|project| serde_json::from_value::<ProjectEntry>(project.clone()).ok())
            .collect())
    }

    pub fn save_registry(&self, registry: &ProjectsRegistry) -> Result<()> {
        assert_registry_within_cap(&registry.projects, &self.projects_registry_path())?;
        let registry = ProjectsRegistry {
            version: PROJECTS_REGISTRY_VERSION,
            projects: registry.projects.clone(),
        };
        write_json_atomic(self.projects_registry_path(), &registry)?;
        Ok(())
    }

    pub fn register_project(&mut self, cwd: impl AsRef<Path>) -> Result<Option<ProjectEntry>> {
        let repo_root = self.resolve_repo_root(cwd);
        if is_ephemeral_temp_project_root_from(&repo_root, &self.process_cwd) {
            log_registry_skip(
                "ephemeral temporary project",
                &repo_root,
                &self.projects_registry_path(),
            );
            return Ok(None);
        }
        match project_root_status_from(&repo_root, &self.process_cwd) {
            ProjectRootStatus::GitCheckout => {}
            ProjectRootStatus::NotCheckout => {
                log_registry_skip(
                    "not a git checkout",
                    &repo_root,
                    &self.projects_registry_path(),
                );
                return Ok(None);
            }
            ProjectRootStatus::Unreachable => {
                log_registry_skip(
                    "project root unavailable",
                    &repo_root,
                    &self.projects_registry_path(),
                );
                return Ok(None);
            }
        }

        let project_id = compute_project_id(&repo_root);
        let entry = ProjectEntry {
            id: project_id.clone(),
            name: repo_root
                .file_name()
                .and_then(OsStr::to_str)
                .unwrap_or("")
                .to_owned(),
            repo_root: path_to_string(&repo_root),
            last_seen: iso_timestamp(SystemTime::now()),
        };
        let mut registry = self.load_registry()?;
        if let Some(index) = registry
            .projects
            .iter()
            .position(|project| project.id == project_id)
        {
            registry.projects[index] = entry.clone();
        } else {
            registry.projects.push(entry.clone());
        }
        self.save_registry(&registry)?;
        Ok(Some(entry))
    }

    pub fn list_projects(&self) -> Result<Vec<ProjectEntry>> {
        Ok(self.load_registry()?.projects)
    }

    pub fn remove_project(&self, id: &str) -> Result<()> {
        let mut registry = self.load_registry()?;
        registry.projects.retain(|project| project.id != id);
        self.save_registry(&registry)
    }

    pub fn remove_project_by_root(
        &mut self,
        cwd: impl AsRef<Path>,
    ) -> Result<Option<ProjectEntry>> {
        let repo_root = self.resolve_repo_root(cwd);
        let project_id = compute_project_id(&repo_root);
        let mut projects = self.load_registry_entries_raw()?;
        let removed = projects
            .iter()
            .position(|project| {
                project.id == project_id
                    || project_roots_equivalent(Path::new(&project.repo_root), &repo_root)
            })
            .map(|index| projects.remove(index));
        if removed.is_some() {
            let registry =
                normalize_registry(projects, &self.process_cwd, &self.projects_registry_path())?;
            self.save_registry(&registry)?;
        }
        Ok(removed)
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

pub fn is_git_project_root(repo_root: impl AsRef<Path>) -> bool {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    is_git_project_root_from(repo_root.as_ref(), &cwd)
}

pub fn require_git_project_root(repo_root: impl AsRef<Path>) -> Result<()> {
    let repo_root = repo_root.as_ref();
    if is_git_project_root(repo_root) {
        return Ok(());
    }
    bail!("{}", project_checkout_required_message(repo_root));
}

pub fn project_checkout_required_message(path: impl AsRef<Path>) -> String {
    format!(
        "{} is not a git repository. Run `git init` first, or cd into a repo.",
        path.as_ref().display()
    )
}

pub fn is_ephemeral_temp_project_root(repo_root: impl AsRef<Path>) -> bool {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    is_ephemeral_temp_project_root_from(repo_root.as_ref(), &cwd)
}

pub fn project_root_status(repo_root: impl AsRef<Path>) -> ProjectRootStatus {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    project_root_status_from(repo_root.as_ref(), &cwd)
}

fn normalize_registry(
    entries: Vec<ProjectEntry>,
    process_cwd: &Path,
    registry_path: &Path,
) -> Result<ProjectsRegistry> {
    let mut projects = Vec::new();
    let mut indexes = HashMap::new();
    for project in entries {
        if project.repo_root.trim().is_empty() {
            continue;
        }
        let repo_root = Path::new(&project.repo_root);
        if is_ephemeral_temp_project_root_from(repo_root, process_cwd) {
            log_registry_skip("ephemeral temporary project", repo_root, registry_path);
            continue;
        }
        match project_root_status_from(repo_root, process_cwd) {
            ProjectRootStatus::GitCheckout => {}
            ProjectRootStatus::NotCheckout => {
                log_registry_skip("not a git checkout", repo_root, registry_path);
                continue;
            }
            ProjectRootStatus::Unreachable => {
                log_at(
                    LogLevel::Debug,
                    "project registry retained unavailable root",
                    "project-registry",
                    Some(serde_json::json!({
                        "projectId": project.id.clone(),
                        "projectRoot": project.repo_root.clone(),
                        "registryPath": registry_path.to_string_lossy(),
                        "reason": "project root unavailable",
                    })),
                );
            }
        }
        if let Some(index) = indexes.get(&project.id).copied() {
            projects[index] = project;
        } else {
            indexes.insert(project.id.clone(), projects.len());
            projects.push(project);
        }
    }
    assert_registry_within_cap(&projects, registry_path)?;
    Ok(ProjectsRegistry {
        version: PROJECTS_REGISTRY_VERSION,
        projects,
    })
}

fn assert_registry_within_cap(projects: &[ProjectEntry], registry_path: &Path) -> Result<()> {
    if projects.len() > MAX_PROJECT_REGISTRY_ENTRIES {
        bail!(
            "aimux project registry has {} entries; cap is {}. Refusing to continue because the registry is likely polluted. Remove stale entries from {}.",
            projects.len(),
            MAX_PROJECT_REGISTRY_ENTRIES,
            registry_path.display()
        );
    }
    Ok(())
}

fn project_roots_equivalent(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn is_git_project_root_from(repo_root: &Path, process_cwd: &Path) -> bool {
    lexical_resolve(process_cwd, repo_root)
        .join(".git")
        .exists()
}

fn project_root_status_from(repo_root: &Path, process_cwd: &Path) -> ProjectRootStatus {
    let resolved = lexical_resolve(process_cwd, repo_root);
    let Ok(metadata) = fs::metadata(&resolved) else {
        return ProjectRootStatus::Unreachable;
    };
    if !metadata.is_dir() {
        return ProjectRootStatus::NotCheckout;
    }
    if is_git_project_root_from(&resolved, process_cwd) {
        ProjectRootStatus::GitCheckout
    } else {
        ProjectRootStatus::NotCheckout
    }
}

fn is_ephemeral_temp_project_root_from(repo_root: &Path, process_cwd: &Path) -> bool {
    let resolved = lexical_resolve(process_cwd, repo_root);
    resolved
        .file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name.starts_with(EPHEMERAL_TEMP_PROJECT_PREFIX))
        && temp_dirs(process_cwd)
            .iter()
            .any(|directory| resolved == *directory || resolved.starts_with(directory))
}

fn log_registry_skip(reason: &str, repo_root: &Path, registry_path: &Path) {
    log_at(
        LogLevel::Debug,
        "project registry skipped project",
        "project-registry",
        Some(serde_json::json!({
            "projectRoot": repo_root.to_string_lossy(),
            "registryPath": registry_path.to_string_lossy(),
            "reason": reason,
        })),
    );
}

fn temp_dirs(process_cwd: &Path) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    for candidate in [
        std::env::temp_dir(),
        PathBuf::from("/tmp"),
        PathBuf::from("/private/tmp"),
        PathBuf::from("/var/tmp"),
    ] {
        let resolved = lexical_resolve(process_cwd, &candidate);
        if !directories.contains(&resolved) {
            directories.push(resolved.clone());
        }
        if let Ok(canonical) = fs::canonicalize(&resolved)
            && !directories.contains(&canonical)
        {
            directories.push(canonical);
        }
    }
    directories
}

fn iso_timestamp(time: SystemTime) -> String {
    let duration = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let total_seconds = duration.as_secs();
    let days = (total_seconds / 86_400) as i64;
    let seconds_in_day = total_seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_in_day / 3_600;
    let minute = (seconds_in_day % 3_600) / 60;
    let second = seconds_in_day % 60;
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{:03}Z",
        duration.subsec_millis()
    )
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let days = days_since_epoch + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

pub fn compute_project_id(repo_root: impl AsRef<Path>) -> String {
    let repo_root = path_to_string(repo_root.as_ref());
    let mut hasher = Sha256::new();
    hasher.update(repo_root.as_bytes());
    let hex = format!("{:x}", hasher.finalize());
    let name = basename_like_node_posix(&repo_root);
    format!("{}-{}", name, &hex[..12])
}

pub fn basename_like_node_posix(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return "";
    }
    trimmed.rsplit('/').next().unwrap_or("")
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
