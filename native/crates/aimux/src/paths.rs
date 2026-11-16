use crate::async_subprocess::AsyncCommand;
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
use std::sync::{Arc, Mutex};
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
    /// Shared across clones ON PURPOSE.
    ///
    /// This used to be a plain `HashMap`, and `PathResolver` derives `Clone`,
    /// so every clone got a private copy. The daemon clones this resolver at
    /// 105 sites in the crate -- 84 in `daemon/runtime.rs` alone -- because
    /// methods like `metadata_endpoint_for_root` take `&self` while resolving
    /// needs `&mut self`. Each of those clones populated its own cache and
    /// dropped it, so the cache was WRITE-ONLY in every daemon path and the
    /// `rev-parse --git-common-dir` subprocess ran on every call rather than
    /// once per directory -- while the caller held the one global runtime
    /// mutex.
    ///
    /// Nothing outside this module ever reads the field, so sharing it changes
    /// no caller; the 105 clone sites compile untouched.
    repo_root_cache: Arc<Mutex<HashMap<PathBuf, PathBuf>>>,
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
            repo_root_cache: Arc::new(Mutex::new(HashMap::new())),
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

    /// How many directories this resolver has an answer for.
    ///
    /// Private, and visible to the test module below because that module is a
    /// child of this one. Exists so a test can ask whether the cache SURVIVES
    /// cloning, which is not observable from outside otherwise: the only other
    /// difference a shared cache makes is one fewer subprocess, and counting
    /// subprocesses needs timing or a seam, both worse than one accessor.
    #[cfg(test)]
    fn cached_repo_root_count(&self) -> usize {
        self.repo_root_cache
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .len()
    }

    /// What this resolver has cached for `key`, for tests that need the value
    /// and not just the count.
    #[cfg(test)]
    fn cached_repo_root(&self, key: &Path) -> Option<PathBuf> {
        self.repo_root_cache
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(key)
            .cloned()
    }

    pub fn resolve_repo_root(&mut self, cwd: impl AsRef<Path>) -> PathBuf {
        let resolved_cwd = lexical_resolve(&self.process_cwd, cwd.as_ref());
        if let Some(repo_root) = aimux_managed_worktree_parent(&resolved_cwd) {
            return repo_root;
        }

        // Scoped so the guard is dropped BEFORE the subprocess below. Holding
        // it across the spawn would put a second lock exactly where the first
        // one already hurts, and the cost of releasing it is at worst two
        // concurrent callers each resolving the same directory once, which is
        // harmless. A poisoned cache is recovered rather than read as empty:
        // "I could not look at the cache" is not "nothing is cached".
        {
            let cache = self
                .repo_root_cache
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if let Some(cached) = cache.get(&resolved_cwd) {
                return cached.clone();
            }
        }

        let lookup = resolve_git_repo_root(&resolved_cwd);
        if let Some(entry) = cache_entry_for(&lookup) {
            self.repo_root_cache
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .insert(resolved_cwd.clone(), entry);
        }
        match lookup {
            RepoRootLookup::Resolved(repo_root) => repo_root,
            RepoRootLookup::NotARepository | RepoRootLookup::CouldNotAsk => resolved_cwd,
        }
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

    pub fn jobs_dir(&self) -> PathBuf {
        self.global_aimux_dir().join("jobs")
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

    pub fn machine_identity_path(&self) -> PathBuf {
        self.global_aimux_dir().join("machine.json")
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
        let registry = normalize_registry(entries.clone(), &self.process_cwd, &path)?;
        if path.exists() && registry.projects != entries {
            self.save_registry(&registry)?;
        }
        Ok(registry)
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
        && has_test_isolation_marker(&resolved)
}

pub fn has_test_isolation_marker(path: impl AsRef<Path>) -> bool {
    path.as_ref()
        .join(crate::runtime_safety_guard::TEST_ISOLATION_MARKER)
        .is_file()
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

/// Three outcomes from asking where a directory's repository lives.
///
/// `Option` collapsed two of them: `.ok()?` on the spawn made "the process
/// could not run" indistinguishable from "this is not a repository", and the
/// caller treats both as "the directory is its own root". Only one of those
/// is a fact about the directory, and only one is safe to remember.
enum RepoRootLookup {
    Resolved(PathBuf),
    NotARepository,
    CouldNotAsk,
}

/// What a lookup is worth remembering, if anything.
///
/// ONLY a resolved root. I tried caching the negative answer too, reasoning
/// that otherwise the subprocess repeats forever for every directory outside a
/// repository -- and `tests/paths.rs::does_not_cache_non_git_fallback_roots`
/// failed, correctly. It resolves a directory, THEN makes its parent a
/// repository, and expects the second resolve to find the new root. A cached
/// "not a repository" makes that answer permanently wrong, and that sequence
/// is ordinary here: a client asks about a directory, then someone initialises
/// a repository around it. A repo root, by contrast, almost never stops being
/// one, which is why the positive answer is safe to keep.
///
/// The two uncached arms are still distinct facts and the enum keeps them
/// apart: "asked, and no" versus "could not ask". Collapsing them is what
/// `.ok()?` used to do, and if either ever becomes cacheable they need
/// different treatment.
///
/// Pure, so the decision is testable without making a subprocess fail -- which
/// would mean manipulating PATH, and PATH is process-global and shared with
/// every other test in this binary.
fn cache_entry_for(lookup: &RepoRootLookup) -> Option<PathBuf> {
    match lookup {
        RepoRootLookup::Resolved(repo_root) => Some(repo_root.clone()),
        RepoRootLookup::NotARepository | RepoRootLookup::CouldNotAsk => None,
    }
}

fn resolve_git_repo_root(cwd: &Path) -> RepoRootLookup {
    // Resolved once per process instead of spawned by bare name, which makes
    // the OS walk PATH on every call. The crate already has this seam and
    // AGENTS.md's Subprocess Churn section asks for it by name.
    let Ok(program) = crate::git_delivery::git_program() else {
        return RepoRootLookup::CouldNotAsk;
    };
    let output = AsyncCommand::new(program.as_os_str())
        .args(["rev-parse", "--git-common-dir"])
        .current_dir(cwd)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_COMMON_DIR")
        .output();
    // Could not ask: says nothing about the directory, so the caller must not
    // remember it.
    let Ok(output) = output else {
        return RepoRootLookup::CouldNotAsk;
    };
    if !output.status.success() {
        // It ran and said no. That IS a fact about the directory.
        return RepoRootLookup::NotARepository;
    }
    let Ok(git_common_dir) = String::from_utf8(output.stdout) else {
        return RepoRootLookup::CouldNotAsk;
    };
    let git_common_dir = git_common_dir.trim();
    if git_common_dir.is_empty() {
        return RepoRootLookup::CouldNotAsk;
    }
    let abs_git_dir = lexical_resolve(cwd, Path::new(git_common_dir));
    if let Some(repo_root) = git_common_worktree_parent(&abs_git_dir) {
        return RepoRootLookup::Resolved(repo_root);
    }
    match abs_git_dir.parent() {
        Some(parent) => RepoRootLookup::Resolved(parent.to_path_buf()),
        None => RepoRootLookup::CouldNotAsk,
    }
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

#[cfg(test)]
mod resolver_cache_tests {
    use super::PathResolver;
    use std::path::PathBuf;

    /// A throwaway repository, because the crate's own directory is not a safe
    /// subject.
    ///
    /// The first version of this test used `env!("CARGO_MANIFEST_DIR")`, which
    /// FAILS whenever the checkout sits in an aimux-managed worktree:
    /// `resolve_repo_root` short-circuits on a `.aimux/worktrees` path before
    /// the cache and so caches nothing, and the assertion message then lies
    /// about why. AGENTS.md sends agents to work in exactly such a worktree,
    /// so it would have failed for the next person and not for me -- this
    /// checkout happens to sit under `.claude/worktrees`, which does not
    /// short-circuit. It also failed in any non-repository source copy.
    struct TempRepo {
        root: PathBuf,
    }

    impl TempRepo {
        fn create(label: &str) -> Option<Self> {
            let root =
                std::env::temp_dir().join(format!("aimux-resolver-{label}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).ok()?;
            let status = std::process::Command::new("git")
                .args(["init", "--quiet"])
                .current_dir(&root)
                .status()
                .ok()?;
            if !status.success() {
                return None;
            }
            // Canonicalised because the resolver returns canonical paths and
            // the temp directory is a symlink on macOS.
            Some(Self {
                root: std::fs::canonicalize(&root).ok()?,
            })
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// Only a resolved root is remembered.
    ///
    /// The arm no behavioural test can reach: making the spawn fail needs PATH
    /// manipulation, and PATH is process-global, so a test that did it would
    /// corrupt every other test in this binary. Testing the decision directly
    /// covers all three outcomes with no I/O.
    ///
    /// Both uncached arms matter, for different reasons. "Asked, and this is
    /// not a repository" must not be cached because the directory can BECOME
    /// one -- `tests/paths.rs::does_not_cache_non_git_fallback_roots` pins
    /// exactly that sequence, and it is what caught me when I tried caching
    /// the negative answer. "Could not ask" must not be cached because it is
    /// not a fact about the directory at all.
    #[test]
    fn only_a_resolved_root_is_cached() {
        use super::{RepoRootLookup, cache_entry_for};

        let root = PathBuf::from("/repo");
        assert_eq!(
            cache_entry_for(&RepoRootLookup::Resolved(root.clone())),
            Some(root),
            "a resolved root must be remembered, or the subprocess repeats on every call"
        );
        assert_eq!(
            cache_entry_for(&RepoRootLookup::NotARepository),
            None,
            "'not a repository' was remembered, which makes the answer permanently wrong once a repository is initialised around that directory"
        );
        assert_eq!(
            cache_entry_for(&RepoRootLookup::CouldNotAsk),
            None,
            "a lookup that could not run was remembered as a fact about the directory"
        );
    }

    /// A resolver's repo-root cache survives being cloned.
    ///
    /// `PathResolver` derives `Clone`, and the daemon clones it at 105 sites
    /// in the crate -- 84 in `daemon/runtime.rs` alone -- because methods like
    /// `metadata_endpoint_for_root` take `&self` while resolving needs
    /// `&mut self`. With a plain `HashMap` every clone populated a private
    /// cache and dropped it, so the cache was write-only in every daemon path
    /// and the `rev-parse` subprocess ran on every call rather than once per
    /// directory -- while the caller held the one global runtime mutex.
    #[test]
    fn the_repo_root_cache_survives_cloning() {
        let Some(repo) = TempRepo::create("shared") else {
            eprintln!("skipping: could not create a temp repository");
            return;
        };
        let original = PathResolver::new(&repo.root, &repo.root, None);
        let mut clone = original.clone();

        let resolved = clone.resolve_repo_root(&repo.root);
        assert_eq!(
            resolved, repo.root,
            "the resolver did not report the temp repository as its own root, so this test is not exercising what it claims"
        );
        assert_eq!(
            clone.cached_repo_root_count(),
            1,
            "resolving cached {} entries instead of exactly one",
            clone.cached_repo_root_count()
        );

        assert_eq!(
            original.cached_repo_root_count(),
            1,
            "the clone cached a repo root and the original cannot see it, so every one of the daemon's resolver clones populates a cache that is immediately dropped and the subprocess repeats on every call"
        );
        // The VALUE, not just the count. A shared map holding the wrong root
        // would satisfy a count assertion perfectly.
        assert_eq!(
            original.cached_repo_root(&repo.root),
            Some(repo.root.clone()),
            "the shared cache holds the wrong value for {:?}",
            repo.root
        );
    }

    /// Two independently constructed resolvers do NOT share a cache.
    ///
    /// The inverse, and the reason the `Arc` is created per construction
    /// rather than in a static: sharing between separate resolvers would make
    /// one resolver's answers visible to another's, and nothing expects that.
    #[test]
    fn independently_constructed_resolvers_do_not_share_a_cache() {
        let Some(repo) = TempRepo::create("separate") else {
            eprintln!("skipping: could not create a temp repository");
            return;
        };
        let mut first = PathResolver::new(&repo.root, &repo.root, None);
        let second = PathResolver::new(&repo.root, &repo.root, None);

        let _ = first.resolve_repo_root(&repo.root);
        assert_eq!(
            first.cached_repo_root_count(),
            1,
            "the first resolver cached nothing, so this test is not exercising the caching path"
        );
        assert_eq!(
            second.cached_repo_root_count(),
            0,
            "a separately constructed resolver sees the first one's cache, so the sharing is process-wide rather than per-resolver"
        );
    }
}
