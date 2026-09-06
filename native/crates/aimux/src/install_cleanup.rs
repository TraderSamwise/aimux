use crate::cli_launcher::get_aimux_stable_shim_path;
use crate::process_inspector::list_process_args;
use serde::Serialize;
use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_INSTALL_RETENTION_DAYS: u64 = 30;
pub const DEFAULT_INSTALL_KEEP_RECENT: usize = 10;
pub const REMOVING_SUFFIX: &str = ".aimux-removing";
const MS_PER_DAY: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallKeepReason {
    CurrentInstall,
    InUse,
    Recent,
    WithinRetention,
    ReferencesUnverified,
    Incomplete,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallCleanupCandidate {
    pub name: String,
    pub path: String,
    pub age_days: f64,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallCleanupKept {
    pub name: String,
    pub reason: InstallKeepReason,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallCleanupPlan {
    pub root: String,
    pub current_install: Option<String>,
    pub retention_days: u64,
    pub keep_recent: usize,
    pub references_complete: bool,
    pub remove: Vec<InstallCleanupCandidate>,
    pub keep: Vec<InstallCleanupKept>,
    pub reclaimable_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallReferenceText {
    pub text: Vec<String>,
    pub complete: bool,
}

pub type InstallReferenceTextFn = Box<dyn Fn() -> InstallReferenceText>;
pub type MeasureInstallSizeFn = Box<dyn Fn(&Path) -> u64>;
pub type RemoveInstallDirFn = Box<dyn Fn(&Path) -> Result<(), String>>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InstallCleanupItemStatus {
    Removed,
    DryRun,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallCleanupItemResult {
    pub name: String,
    pub status: InstallCleanupItemStatus,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallCleanupRunResult {
    pub dry_run: bool,
    pub plan: InstallCleanupPlan,
    pub results: Vec<InstallCleanupItemResult>,
    pub reclaimed_bytes: u64,
}

#[derive(Default)]
pub struct PlanInstallCleanupOptions {
    pub root: Option<String>,
    pub keep_recent: Option<usize>,
    pub retention_days: Option<u64>,
    pub now_ms: Option<u128>,
    pub stable_shim_path: Option<String>,
    pub list_reference_text: Option<InstallReferenceTextFn>,
    pub measure_size: Option<MeasureInstallSizeFn>,
}

#[derive(Default)]
pub struct RunInstallCleanupInput {
    pub dry_run: Option<bool>,
    pub limit: Option<usize>,
    pub remove_dir: Option<RemoveInstallDirFn>,
}

pub fn plan_install_cleanup(options: PlanInstallCleanupOptions) -> InstallCleanupPlan {
    let root = normalize_root(
        &options
            .root
            .unwrap_or_else(|| install_root_from_env(&std::env::vars().collect())),
    );
    let keep_recent = options.keep_recent.unwrap_or(DEFAULT_INSTALL_KEEP_RECENT);
    let retention_days = options
        .retention_days
        .unwrap_or(DEFAULT_INSTALL_RETENTION_DAYS);
    let now = options.now_ms.unwrap_or_else(now_ms);
    let stable_shim_path = options
        .stable_shim_path
        .unwrap_or_else(get_aimux_stable_shim_path);
    let measure_size = options
        .measure_size
        .unwrap_or_else(|| Box::new(directory_size));

    let names = match fs::read_dir(&root) {
        Ok(entries) => entries
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|file_type| file_type.is_dir()))
            .filter_map(|entry| entry.file_name().into_string().ok())
            .collect::<Vec<_>>(),
        Err(_) => {
            return InstallCleanupPlan {
                root,
                current_install: None,
                retention_days,
                keep_recent,
                references_complete: true,
                remove: Vec::new(),
                keep: Vec::new(),
                reclaimable_bytes: 0,
            };
        }
    };

    let current = current_install_name(&root, &stable_shim_path);
    let canonical_root = canonical(&root);
    let references = options
        .list_reference_text
        .map(|list| list())
        .unwrap_or_else(default_reference_text);
    let referenced = referenced_installs(
        &canonical_root
            .map(|canonical| vec![root.clone(), canonical])
            .unwrap_or_else(|| vec![root.clone()]),
        &references.text,
    );
    let (debris, install_names): (Vec<_>, Vec<_>) = names
        .into_iter()
        .partition(|name| name.ends_with(REMOVING_SUFFIX));

    let mut with_mtime = install_names
        .into_iter()
        .map(|name| {
            let path = Path::new(&root).join(&name);
            let mtime_ms = install_mtime(&path);
            (name, path, mtime_ms)
        })
        .collect::<Vec<_>>();
    with_mtime.sort_by(|left, right| right.2.cmp(&left.2));
    let newest = with_mtime
        .iter()
        .take(keep_recent)
        .map(|(name, _, _)| name.clone())
        .collect::<BTreeSet<_>>();

    let mut remove = debris
        .into_iter()
        .map(|name| {
            let path = Path::new(&root).join(&name);
            InstallCleanupCandidate {
                name,
                path: path.to_string_lossy().into_owned(),
                age_days: 0.0,
                size_bytes: measure_size(&path),
            }
        })
        .collect::<Vec<_>>();
    let mut keep = Vec::new();
    for (name, path, mtime_ms) in with_mtime {
        let age_days = (now as f64 - mtime_ms as f64) / MS_PER_DAY;
        if Some(name.as_str()) == current.as_deref() {
            keep.push(kept(name, InstallKeepReason::CurrentInstall));
        } else if !references.complete {
            keep.push(kept(name, InstallKeepReason::ReferencesUnverified));
        } else if !is_complete_install(&path) {
            keep.push(kept(name, InstallKeepReason::Incomplete));
        } else if referenced.contains(&name) {
            keep.push(kept(name, InstallKeepReason::InUse));
        } else if newest.contains(&name) {
            keep.push(kept(name, InstallKeepReason::Recent));
        } else if age_days < retention_days as f64 {
            keep.push(kept(name, InstallKeepReason::WithinRetention));
        } else {
            remove.push(InstallCleanupCandidate {
                name,
                path: path.to_string_lossy().into_owned(),
                age_days,
                size_bytes: measure_size(&path),
            });
        }
    }
    remove.sort_by(|left, right| right.age_days.total_cmp(&left.age_days));
    let reclaimable_bytes = remove.iter().map(|entry| entry.size_bytes).sum();
    InstallCleanupPlan {
        root,
        current_install: current,
        retention_days,
        keep_recent,
        references_complete: references.complete,
        remove,
        keep,
        reclaimable_bytes,
    }
}

pub fn run_install_cleanup(
    plan: InstallCleanupPlan,
    input: RunInstallCleanupInput,
) -> InstallCleanupRunResult {
    let dry_run = input.dry_run != Some(false);
    let remove_dir = input
        .remove_dir
        .unwrap_or_else(|| Box::new(default_remove_dir));
    let candidates = if !dry_run {
        input
            .limit
            .map(|limit| plan.remove.iter().take(limit).cloned().collect())
            .unwrap_or_else(|| plan.remove.clone())
    } else {
        plan.remove.clone()
    };
    let mut results = Vec::new();
    let mut reclaimed_bytes = 0;
    for candidate in candidates {
        if dry_run {
            results.push(item_result(
                candidate.name,
                InstallCleanupItemStatus::DryRun,
                candidate.size_bytes,
                None,
            ));
            continue;
        }
        if install_name_for(&candidate.path, &plan.root).as_deref() != Some(candidate.name.as_str())
        {
            results.push(item_result(
                candidate.name,
                InstallCleanupItemStatus::Failed,
                candidate.size_bytes,
                Some("refusing to remove a path outside the install root".to_owned()),
            ));
            continue;
        }
        match remove_dir(Path::new(&candidate.path)) {
            Ok(()) => {
                reclaimed_bytes += candidate.size_bytes;
                results.push(item_result(
                    candidate.name,
                    InstallCleanupItemStatus::Removed,
                    candidate.size_bytes,
                    None,
                ));
            }
            Err(error) => results.push(item_result(
                candidate.name,
                InstallCleanupItemStatus::Failed,
                candidate.size_bytes,
                Some(error),
            )),
        }
    }
    InstallCleanupRunResult {
        dry_run,
        plan,
        results,
        reclaimed_bytes,
    }
}

pub fn is_install_cleanup_dry_run(fix: bool) -> bool {
    !fix
}

pub fn render_install_cleanup_plan(plan: &InstallCleanupPlan) -> String {
    let mut lines = vec![
        "Aimux Installs".to_owned(),
        format!("  root: {}", plan.root),
        format!(
            "  current: {}",
            plan.current_install.as_deref().unwrap_or("unknown")
        ),
        format!("  kept: {}", plan.keep.len()),
    ];
    for (reason, count) in count_by_reason(plan) {
        lines.push(format!("    {}: {count}", keep_reason_label(&reason)));
    }
    lines.push(format!(
        "  removable: {} ({})",
        plan.remove.len(),
        format_bytes(plan.reclaimable_bytes)
    ));
    lines.push(format!(
        "  policy: keep {} newest, retain {} days",
        plan.keep_recent, plan.retention_days
    ));
    if !plan.references_complete {
        lines.extend([
            String::new(),
            "  Reference scan was incomplete, so nothing can be removed.".to_owned(),
            "  An install that could not be checked is treated as still in use.".to_owned(),
        ]);
        return lines.join("\n");
    }
    if plan.remove.is_empty() {
        lines.extend([String::new(), "  Nothing to remove.".to_owned()]);
        return lines.join("\n");
    }
    lines.extend([String::new(), "  Oldest removable:".to_owned()]);
    let mut remove = plan.remove.clone();
    remove.sort_by(|left, right| right.age_days.total_cmp(&left.age_days));
    for candidate in remove.iter().take(5) {
        lines.push(format!(
            "    {}  {}d  {}",
            candidate.name,
            candidate.age_days.round() as i64,
            format_bytes(candidate.size_bytes)
        ));
    }
    if plan.remove.len() > 5 {
        lines.push(format!("    ... and {} more", plan.remove.len() - 5));
    }
    lines.join("\n")
}

pub fn render_install_cleanup_result(result: &InstallCleanupRunResult) -> String {
    let mut lines = vec![render_install_cleanup_plan(&result.plan)];
    if result.plan.remove.is_empty() {
        return lines.join("\n");
    }
    if result.dry_run {
        lines.extend([
            String::new(),
            format!(
                "  Dry run: nothing was removed. Pass --fix to reclaim {}.",
                format_bytes(result.plan.reclaimable_bytes)
            ),
        ]);
        return lines.join("\n");
    }
    let removed = result
        .results
        .iter()
        .filter(|entry| entry.status == InstallCleanupItemStatus::Removed)
        .count();
    lines.extend([
        String::new(),
        format!(
            "  Removed {removed} installs, reclaiming {}.",
            format_bytes(result.reclaimed_bytes)
        ),
    ]);
    for failure in result
        .results
        .iter()
        .filter(|entry| entry.status == InstallCleanupItemStatus::Failed)
    {
        lines.push(format!(
            "    failed: {}: {}",
            failure.name,
            failure.error.as_deref().unwrap_or("unknown error")
        ));
    }
    lines.join("\n")
}

fn install_root_from_env(env: &std::collections::BTreeMap<String, String>) -> String {
    env.get("AIMUX_INSTALL_ROOT")
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| {
            home_dir()
                .join(".aimux/native")
                .to_string_lossy()
                .into_owned()
        })
}

fn normalize_root(root: &str) -> String {
    let trimmed = root.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn canonical(path: impl AsRef<Path>) -> Option<String> {
    fs::canonicalize(path)
        .ok()
        .map(|path| path.to_string_lossy().into_owned())
}

fn install_name_for(path: &str, root: &str) -> Option<String> {
    let prefix = if root.ends_with('/') {
        root.to_owned()
    } else {
        format!("{root}/")
    };
    let rest = path.strip_prefix(&prefix)?;
    rest.split('/')
        .next()
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

fn current_install_name(root: &str, stable_shim_path: &str) -> Option<String> {
    let resolved = canonical(stable_shim_path)?;
    let canonical_root = canonical(root);
    install_name_for(&resolved, root)
        .or_else(|| canonical_root.and_then(|root| install_name_for(&resolved, &root)))
}

fn default_reference_text() -> InstallReferenceText {
    let process_args = list_process_args()
        .into_iter()
        .map(|entry| entry.args)
        .collect::<Vec<_>>()
        .join("\n");
    let tmux = tmux_persisted_command_text();
    let text = std::iter::once(process_args)
        .chain(tmux.text)
        .filter(|chunk| !chunk.is_empty())
        .collect();
    InstallReferenceText {
        text,
        complete: tmux.complete,
    }
}

fn tmux_persisted_command_text() -> InstallReferenceText {
    if !tmux_success(&["-V"]) {
        return InstallReferenceText {
            text: Vec::new(),
            complete: true,
        };
    }
    let mut complete = true;
    let mut sources = Vec::new();
    push_tmux_output(
        &mut sources,
        &mut complete,
        &["list-panes", "-a", "-F", "#{pane_start_command}"],
    );
    push_tmux_output(&mut sources, &mut complete, &["list-keys"]);
    push_tmux_output(&mut sources, &mut complete, &["show-options", "-g"]);
    let session_names = match tmux_output(&["list-sessions", "-F", "#{session_name}"]) {
        Some(value) => value.lines().map(str::to_owned).collect::<Vec<_>>(),
        None => {
            complete = false;
            Vec::new()
        }
    };
    for session_name in session_names {
        push_tmux_output(
            &mut sources,
            &mut complete,
            &["show-options", "-t", &session_name],
        );
        push_tmux_output(
            &mut sources,
            &mut complete,
            &["show-options", "-w", "-t", &session_name],
        );
        push_tmux_output(
            &mut sources,
            &mut complete,
            &["show-hooks", "-t", &session_name],
        );
    }
    InstallReferenceText {
        text: sources
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect(),
        complete,
    }
}

fn push_tmux_output(sources: &mut Vec<String>, complete: &mut bool, args: &[&str]) {
    match tmux_output(args) {
        Some(value) => sources.push(value),
        None => *complete = false,
    }
}

fn referenced_installs(roots: &[String], text: &[String]) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for root in roots.iter().collect::<BTreeSet<_>>() {
        let prefix = if root.ends_with('/') {
            root.clone()
        } else {
            format!("{root}/")
        };
        for chunk in text {
            let mut rest = chunk.as_str();
            while let Some(index) = rest.find(&prefix) {
                let after = &rest[index + prefix.len()..];
                let name = after
                    .split(|character: char| {
                        character == '/'
                            || character.is_whitespace()
                            || character == '\''
                            || character == '"'
                    })
                    .next()
                    .unwrap_or_default();
                if !name.is_empty() {
                    names.insert(name.to_owned());
                }
                rest = &after[name.len()..];
            }
        }
    }
    names
}

fn install_mtime(path: &Path) -> u128 {
    let mut newest = mtime_ms(path).unwrap_or_default();
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            newest = newest.max(mtime_ms(entry.path()).unwrap_or_default());
        }
    }
    newest
}

fn mtime_ms(path: impl AsRef<Path>) -> Option<u128> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis())
}

fn is_complete_install(path: &Path) -> bool {
    fs::metadata(path.join("bin/aimux")).is_ok_and(|metadata| metadata.is_file())
}

fn directory_size(path: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let child = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                stack.push(child);
            } else if let Ok(metadata) = fs::symlink_metadata(child) {
                total += metadata.len();
            }
        }
    }
    total
}

fn default_remove_dir(path: &Path) -> Result<(), String> {
    let staged = if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(REMOVING_SUFFIX))
    {
        path.to_path_buf()
    } else {
        PathBuf::from(format!("{}{}", path.to_string_lossy(), REMOVING_SUFFIX))
    };
    if staged != path {
        match fs::rename(path, &staged) {
            Ok(()) => {}
            Err(_) => {
                remove_dir_all_force(path)?;
                return Ok(());
            }
        }
    }
    remove_dir_all_force(staged)
}

fn remove_dir_all_force(path: impl AsRef<Path>) -> Result<(), String> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn item_result(
    name: String,
    status: InstallCleanupItemStatus,
    size_bytes: u64,
    error: Option<String>,
) -> InstallCleanupItemResult {
    InstallCleanupItemResult {
        name,
        status,
        size_bytes,
        error,
    }
}

fn kept(name: String, reason: InstallKeepReason) -> InstallCleanupKept {
    InstallCleanupKept { name, reason }
}

fn count_by_reason(plan: &InstallCleanupPlan) -> Vec<(InstallKeepReason, usize)> {
    let mut counts = std::collections::BTreeMap::<String, (InstallKeepReason, usize)>::new();
    for entry in &plan.keep {
        let key = keep_reason_label(&entry.reason).to_owned();
        let slot = counts.entry(key).or_insert((entry.reason.clone(), 0));
        slot.1 += 1;
    }
    let mut result = counts.into_values().collect::<Vec<_>>();
    result.sort_by(|left, right| right.1.cmp(&left.1));
    result
}

fn keep_reason_label(reason: &InstallKeepReason) -> &'static str {
    match reason {
        InstallKeepReason::CurrentInstall => "current install",
        InstallKeepReason::InUse => "still referenced",
        InstallKeepReason::Recent => "among the newest",
        InstallKeepReason::WithinRetention => "inside retention",
        InstallKeepReason::ReferencesUnverified => "reference scan incomplete",
        InstallKeepReason::Incomplete => "mid-install or broken",
    }
}

fn format_bytes(bytes: u64) -> String {
    if bytes >= 1_000_000_000 {
        format!("{:.2} GB", bytes as f64 / 1_000_000_000.0)
    } else if bytes >= 1_000_000 {
        format!("{} MB", (bytes as f64 / 1_000_000.0).round() as u64)
    } else {
        format!("{bytes} B")
    }
}

fn tmux_success(args: &[&str]) -> bool {
    Command::new("tmux")
        .args(args)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn tmux_output(args: &[&str]) -> Option<String> {
    let output = Command::new("tmux").args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).to_string())
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
