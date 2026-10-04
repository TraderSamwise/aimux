use crate::atomic_write::{quarantine_corrupt_file, write_json_atomic};
use crate::runtime_topology::{
    read_runtime_topology, runtime_topology_path, update_runtime_topology,
};
use crate::runtime_topology_services::upsert_topology_services;
use crate::tmux::{TmuxManagedWindow, TmuxRuntimeManager, TmuxTarget};
use crate::tmux_runtime_stop::{TmuxRuntimeStopManager, stop_project_tmux_runtime};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

pub trait ServiceStateSnapshotRuntime {
    fn list_project_managed_windows(
        &mut self,
        project_root: &Path,
    ) -> Result<Vec<TmuxManagedWindow>, String>;
    fn display_message(&mut self, format: &str, target: &str) -> Option<String>;
    fn is_window_alive(&mut self, target: &TmuxTarget) -> Result<bool, String>;
    fn refresh_status(&mut self) {}
    fn path_exists(&mut self, path: &str) -> bool {
        Path::new(path).exists()
    }
}

impl ServiceStateSnapshotRuntime for TmuxRuntimeManager {
    fn list_project_managed_windows(
        &mut self,
        project_root: &Path,
    ) -> Result<Vec<TmuxManagedWindow>, String> {
        TmuxRuntimeManager::list_project_managed_windows(self, project_root)
    }

    fn display_message(&mut self, format: &str, target: &str) -> Option<String> {
        TmuxRuntimeManager::display_message(self, format, Some(target))
    }

    fn is_window_alive(&mut self, target: &TmuxTarget) -> Result<bool, String> {
        TmuxRuntimeManager::is_window_alive(self, target)
    }

    fn refresh_status(&mut self) {
        TmuxRuntimeManager::refresh_status(self);
    }
}

pub fn merge_service_snapshots(
    existing: Option<&Value>,
    snapshots: &[Value],
    cwd: &str,
    saved_at: &str,
) -> Value {
    let snapshots = Value::Array(snapshots.to_vec());
    merge_runtime_snapshots(existing, Some(&snapshots), cwd, saved_at)
}

pub fn merge_runtime_snapshots(
    existing: Option<&Value>,
    snapshots: Option<&Value>,
    cwd: &str,
    saved_at: &str,
) -> Value {
    let mut services_by_id = Map::new();
    for service in snapshots.and_then(Value::as_array).into_iter().flatten() {
        if let Some(id) = service.get("id").and_then(Value::as_str) {
            let mut service = service.as_object().cloned().unwrap_or_default();
            service.remove("tmuxTarget");
            service.remove("retained");
            services_by_id.insert(id.into(), Value::Object(service));
        }
    }
    json!({
        "savedAt": saved_at,
        "cwd": existing
            .and_then(|value| value.get("cwd"))
            .and_then(Value::as_str)
            .unwrap_or(cwd),
        "services": services_by_id.into_values().collect::<Vec<_>>(),
    })
}

pub fn snapshot_project_service_windows(
    project_root: impl AsRef<Path>,
    project_state_dir: impl AsRef<Path>,
    tmux: &mut impl ServiceStateSnapshotRuntime,
) -> Result<Vec<Value>, String> {
    let project_root = project_root.as_ref();
    let graveyard_paths = worktree_graveyard_paths(project_state_dir.as_ref());
    let mut seen = BTreeSet::new();
    let mut services = Vec::new();
    for window in tmux.list_project_managed_windows(project_root)? {
        let metadata = &window.metadata;
        if string_field(metadata, "kind").as_deref() != Some("service") {
            continue;
        }
        let Some(session_id) = string_field(metadata, "sessionId") else {
            continue;
        };
        if seen.contains(&session_id) {
            continue;
        }
        if !is_window_worktree_available(metadata, &graveyard_paths, tmux) {
            continue;
        }
        if !tmux.is_window_alive(&window.target)? {
            continue;
        }
        seen.insert(session_id.clone());
        services.push(build_service_state_from_metadata(
            &session_id,
            metadata,
            &window.target,
            tmux,
        ));
    }
    Ok(services)
}

pub fn persist_project_runtime_snapshots_before_tmux_stop(
    project_root: impl AsRef<Path>,
    project_state_dir: impl AsRef<Path>,
    tmux: &mut impl ServiceStateSnapshotRuntime,
    stop_without_restore: bool,
) -> Result<Value, String> {
    persist_project_runtime_snapshots_before_tmux_stop_at(
        project_root,
        project_state_dir,
        tmux,
        &now_rfc3339()?,
        stop_without_restore,
    )
}

pub fn persist_project_runtime_snapshots_before_tmux_stop_at(
    project_root: impl AsRef<Path>,
    project_state_dir: impl AsRef<Path>,
    tmux: &mut impl ServiceStateSnapshotRuntime,
    saved_at: &str,
    stop_without_restore: bool,
) -> Result<Value, String> {
    let project_root = project_root.as_ref();
    let project_state_dir = project_state_dir.as_ref();
    // Before anything is recorded or killed: this teardown ends every pane in
    // the project, and refusing after the topology has been marked "stopped"
    // would leave running services recorded as stopped.
    assert_agents_are_restorable_before_stop(project_state_dir, stop_without_restore)?;
    let services = snapshot_project_service_windows(project_root, project_state_dir, tmux)?;
    if !services.is_empty() {
        update_runtime_topology(runtime_topology_path(project_state_dir), |mut topology| {
            upsert_topology_services(
                &mut topology,
                &services,
                "stopped",
                &project_root.to_string_lossy(),
                saved_at,
            )
        })?;
    }

    let state_path = project_state_dir.join("state.json");
    let existing = read_existing_state(&state_path)?;
    let state = merge_service_snapshots(
        existing.as_ref(),
        &services,
        &project_root.to_string_lossy(),
        saved_at,
    );
    write_json_atomic(&state_path, &state).map_err(|error| error.to_string())?;
    Ok(json!({ "sessions": [], "services": services }))
}

/// Refuse to tear a runtime down when its agents are not recorded anywhere.
///
/// The snapshot is only consulted, never rewritten: it is deliberately
/// retentive, the stop and kill routes are what remove sessions from it, and
/// rewriting here would mint a new snapshot id that the boot-stamped prompt
/// gate no longer matches -- suppressing the restore offer this protects.
///
/// A missing topology has nothing to lose and is not an error. An unreadable
/// one is: it is the record of what would die, and proceeding without it is
/// the guess that cost 37 agents on sam-strix.
/// The restorability check on its own, so a caller tearing down several
/// projects can ask about all of them before killing any of one.
pub fn assert_project_stop_is_recoverable(
    project_state_dir: &Path,
    stop_without_restore: bool,
) -> Result<(), String> {
    assert_agents_are_restorable_before_stop(project_state_dir, stop_without_restore)
}

fn assert_agents_are_restorable_before_stop(
    project_state_dir: &Path,
    stop_without_restore: bool,
) -> Result<(), String> {
    // An operator who has read the refusal and wants to stop anyway must be
    // able to. A guard on the only path that stops anything, with no way past
    // it, turns one unrecordable project into a daemon that cannot be stopped
    // at all -- and `stop` is what people reach for when things are already
    // wrong.
    if stop_without_restore {
        return Ok(());
    }
    let topology = match read_runtime_topology(runtime_topology_path(project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return Err(format!("runtime topology unreadable: {error}")),
    };
    crate::project_service::agent_restore_task::assert_agents_are_restorable(
        project_state_dir,
        &topology,
    )
}

pub fn stop_project_tmux_runtime_with_service_snapshots(
    project_root: impl AsRef<Path>,
    project_state_dir: impl AsRef<Path>,
    stop_without_restore: bool,
) -> Result<Vec<String>, String> {
    let mut tmux = TmuxRuntimeManager::new();
    stop_project_tmux_runtime_with_service_snapshots_using(
        &mut tmux,
        project_root.as_ref(),
        project_state_dir.as_ref(),
        stop_without_restore,
    )
}

/// Whether this process was told to stop even where agents could not be
/// recorded.
///
/// Read once at the boundary rather than inside the check, so a test can drive
/// the decision without mutating process-global state its siblings share.
pub fn stop_without_restore_from_env() -> bool {
    std::env::var("AIMUX_STOP_WITHOUT_RESTORE").is_ok_and(|value| value == "1")
}

pub fn stop_project_tmux_runtime_with_service_snapshots_using<T>(
    tmux: &mut T,
    project_root: &Path,
    project_state_dir: &Path,
    stop_without_restore: bool,
) -> Result<Vec<String>, String>
where
    T: TmuxRuntimeStopManager + ServiceStateSnapshotRuntime,
{
    let killed = stop_project_tmux_runtime(tmux, &project_root.to_string_lossy(), |tmux, root| {
        persist_project_runtime_snapshots_before_tmux_stop(
            Path::new(root),
            project_state_dir,
            tmux,
            stop_without_restore,
        )
        .map(|_| ())
    })?;
    tmux.refresh_status();
    Ok(killed)
}

fn build_service_state_from_metadata(
    session_id: &str,
    metadata: &Value,
    target: &TmuxTarget,
    tmux: &mut impl ServiceStateSnapshotRuntime,
) -> Value {
    let mut service = Map::new();
    service.insert("id".into(), Value::String(session_id.into()));
    for key in [
        "command",
        "args",
        "launchCommandLine",
        "worktreePath",
        "label",
        "createdAt",
    ] {
        if let Some(value) = metadata.get(key) {
            service.insert(key.into(), value.clone());
        }
    }
    if !service.contains_key("launchCommandLine")
        && let Some(command) = string_field(metadata, "command")
    {
        let args = metadata
            .get("args")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let mut parts = vec![command];
        parts.extend(
            args.into_iter()
                .filter_map(|value| value.as_str().map(str::to_owned)),
        );
        service.insert("launchCommandLine".into(), Value::String(parts.join(" ")));
    }
    let cwd = tmux
        .display_message("#{pane_current_path}", &target.window_id)
        .or_else(|| string_field(metadata, "worktreePath"));
    if let Some(cwd) = cwd {
        service.insert("cwd".into(), Value::String(cwd));
    }
    service.insert("tmuxTarget".into(), tmux_target_json(target));
    Value::Object(service)
}

fn is_window_worktree_available(
    metadata: &Value,
    graveyard_paths: &BTreeSet<String>,
    tmux: &mut impl ServiceStateSnapshotRuntime,
) -> bool {
    let Some(worktree_path) = string_field(metadata, "worktreePath") else {
        return true;
    };
    !graveyard_paths.contains(&worktree_path) && tmux.path_exists(&worktree_path)
}

fn worktree_graveyard_paths(project_state_dir: &Path) -> BTreeSet<String> {
    read_runtime_topology(runtime_topology_path(project_state_dir))
        .ok()
        .and_then(|topology| {
            topology
                .get("worktreeGraveyard")
                .and_then(Value::as_array)
                .cloned()
        })
        .into_iter()
        .flatten()
        .filter(|entry| entry.get("deletedAt").is_none_or(Value::is_null))
        .filter_map(|entry| string_field(&entry, "path"))
        .collect()
}

fn read_existing_state(path: &Path) -> Result<Option<Value>, String> {
    match fs::read_to_string(path) {
        Ok(contents) => match serde_json::from_str(&contents) {
            Ok(value) => Ok(Some(value)),
            Err(_) => {
                quarantine_corrupt_file(path);
                Ok(None)
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn tmux_target_json(target: &TmuxTarget) -> Value {
    json!({
        "sessionName": target.session_name,
        "windowId": target.window_id,
        "windowIndex": target.window_index,
        "windowName": target.window_name,
    })
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn now_rfc3339() -> Result<String, String> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|error| error.to_string())
}
