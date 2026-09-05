use crate::daemon::json::ExposeFocusRequest;
use crate::daemon_state::load_metadata_state;
use crate::paths::PathResolver;
use crate::project_catalog::{hidden_project_tmp_dirs, list_registered_desktop_projects};
use crate::project_service::expose_ordering::{
    ExposeOrderingOptions, ExposeSublabel, assign_worktree_tones, dashboard_worktree_order_paths,
    expose_tile_context_for_item, order_expose_items,
};
use crate::project_service::switchable_agents::{
    AgentListScope, SwitchableContext, SwitchableListOptions, agent_status_chip,
    list_switchable_agent_items, serialize_fast_control_item, topology_switchable_entries,
};
use crate::project_service::usage::load_last_used_state;
use crate::runtime_topology::{read_runtime_topology, runtime_topology_path};
use crate::tmux::{select_window_argv, switch_client_argv, switch_client_to_target_argv};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

pub trait DaemonExposeFocusRuntime {
    fn open_target(
        &mut self,
        target: &Value,
        current_client_session: Option<&str>,
        client_tty: Option<&str>,
    ) -> Result<Value, String>;
}

pub struct SystemDaemonExposeFocusRuntime;

impl DaemonExposeFocusRuntime for SystemDaemonExposeFocusRuntime {
    fn open_target(
        &mut self,
        target: &Value,
        current_client_session: Option<&str>,
        client_tty: Option<&str>,
    ) -> Result<Value, String> {
        let window_id = target_string_field(target, "windowId")
            .ok_or_else(|| "target window id is missing".to_owned())?;
        let window_index = target_number_field(target, "windowIndex").unwrap_or_default();
        let argv = if let Some(client_tty) = client_tty {
            switch_client_to_target_argv(client_tty, window_id)
        } else if let Some(current_client_session) = current_client_session {
            switch_client_argv(current_client_session, window_index, None)
        } else {
            select_window_argv(window_id)
        };
        run_tmux_argv(argv, format!("failed to focus window {window_id}"))?;
        let focus_mode = if client_tty.is_some() {
            "client-tty"
        } else if current_client_session.is_some() {
            "linked-client-session"
        } else {
            "open-target"
        };
        Ok(json!({ "focused": true, "focusMode": focus_mode }))
    }
}

pub fn expose_items_route(
    resolver: &mut PathResolver,
    session_prefix_for_project: impl Fn(&str) -> String,
    _path: &str,
) -> Result<Value, String> {
    let items = list_all_projects_expose_items(resolver, session_prefix_for_project)?;
    let ordered = order_global_expose_items(resolver, items);
    let tones = assign_worktree_tones(&ordered, "/");
    let items = ordered
        .iter()
        .map(|item| serialize_global_expose_item(item, &tones))
        .collect::<Vec<_>>();
    Ok(json!({ "ok": true, "items": items }))
}

pub fn expose_focus_route(
    resolver: &mut PathResolver,
    session_prefix_for_project: impl Fn(&str) -> String,
    request: ExposeFocusRequest,
) -> Result<Value, String> {
    let mut runtime = SystemDaemonExposeFocusRuntime;
    expose_focus_route_with_runtime(resolver, session_prefix_for_project, request, &mut runtime)
}

pub fn expose_focus_route_with_runtime<R: DaemonExposeFocusRuntime>(
    resolver: &mut PathResolver,
    session_prefix_for_project: impl Fn(&str) -> String,
    request: ExposeFocusRequest,
    runtime: &mut R,
) -> Result<Value, String> {
    let items = list_all_projects_expose_items(resolver, session_prefix_for_project)?;
    let project_root = request.project_root.as_deref().map(normalize_path_string);
    let Some(item) = items.iter().find(|candidate| {
        target_string_field(&candidate.target, "windowId") == Some(request.window_id.as_str())
            && project_root.as_deref().is_none_or(|root| {
                candidate.project_root.as_deref().map(normalize_path_string)
                    == Some(root.to_owned())
            })
    }) else {
        return Err("window not found".to_owned());
    };
    let focus_result = runtime.open_target(
        &item.target,
        request.current_client_session.as_deref(),
        request.client_tty.as_deref(),
    )?;
    Ok(json!({
        "ok": true,
        "action": "expose-focus",
        "focused": focus_result.get("focused").and_then(Value::as_bool).unwrap_or(true),
        "focusMode": focus_result.get("focusMode").and_then(Value::as_str).unwrap_or("open-target"),
        "itemId": item.id,
        "projectId": item.project_id,
        "projectName": item.project_name,
        "projectRoot": item.project_root,
        "target": item.target,
    }))
}

pub fn list_all_projects_expose_items(
    resolver: &mut PathResolver,
    session_prefix_for_project: impl Fn(&str) -> String,
) -> Result<Vec<crate::project_service::switchable_agents::SwitchableAgentItem>, String> {
    let entries = resolver
        .list_projects()
        .map_err(|error| format!("failed to list projects: {error}"))?;
    let tmp_dirs = hidden_project_tmp_dirs(std::env::temp_dir());
    let projects = list_registered_desktop_projects(&entries, &tmp_dirs, |entry| {
        session_prefix_for_project(&entry.repo_root)
    });
    let mut items = Vec::new();
    for project in projects {
        let project_state_dir = resolver.project_state_dir_for(&project.path);
        let topology = read_runtime_topology(runtime_topology_path(&project_state_dir))?;
        if topology
            .get("sessions")
            .and_then(Value::as_array)
            .is_none_or(Vec::is_empty)
            && topology
                .get("services")
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty)
        {
            continue;
        }
        let metadata = load_metadata_state(&project_state_dir);
        let entries = topology_switchable_entries(&topology, &metadata.sessions);
        if entries.is_empty() {
            continue;
        }
        let last_used = load_last_used_state(&project_state_dir);
        let context = SwitchableContext {
            project_root: project.path.clone(),
            current_path: Some(project.path.clone()),
            current_window: None,
            current_window_id: None,
            current_client_session: None,
        };
        let options = SwitchableListOptions {
            scope: AgentListScope::All,
            raw_labels: true,
            ..SwitchableListOptions::default()
        };
        let mut project_items = list_switchable_agent_items(
            &entries,
            &metadata.sessions,
            &context,
            &options,
            &last_used,
        );
        for item in &mut project_items {
            item.project_id = Some(project.id.clone());
            item.project_name = Some(project.name.clone());
            item.project_root = Some(project.path.clone());
        }
        items.extend(project_items);
    }
    Ok(items)
}

fn order_global_expose_items(
    resolver: &mut PathResolver,
    items: Vec<crate::project_service::switchable_agents::SwitchableAgentItem>,
) -> Vec<crate::project_service::switchable_agents::SwitchableAgentItem> {
    let mut options = ExposeOrderingOptions::default();
    for item in &items {
        let Some(project_root) = item.project_root.as_deref() else {
            continue;
        };
        if options
            .worktree_order_by_project_root
            .contains_key(&normalize_path_string(project_root))
        {
            continue;
        }
        let topology_path = runtime_topology_path(resolver.project_state_dir_for(project_root));
        if let Ok(topology) = read_runtime_topology(topology_path) {
            options.worktree_order_by_project_root.insert(
                normalize_path_string(project_root),
                dashboard_worktree_order_paths(project_root, &topology),
            );
        }
    }
    order_expose_items(&items, "/", ExposeSublabel::ProjectWorktree, &options)
}

fn serialize_global_expose_item(
    item: &crate::project_service::switchable_agents::SwitchableAgentItem,
    tones: &BTreeMap<String, i64>,
) -> Value {
    let mut serialized = serialize_fast_control_item(item);
    if let Value::Object(map) = &mut serialized {
        map.insert(
            "exposeContext".into(),
            expose_tile_context_for_item(item, ExposeSublabel::ProjectWorktree, "/", tones),
        );
        if let Some(chip) = agent_status_chip(&item.metadata) {
            map.insert("exposeStatus".into(), chip);
        }
    }
    serialized
}

fn normalize_path_string(path: &str) -> String {
    normalize_path(Path::new(path))
        .to_string_lossy()
        .into_owned()
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut result = if path.is_absolute() {
        PathBuf::new()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    };
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

fn target_string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn target_number_field(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

fn run_tmux_argv(argv: Vec<String>, fallback_error: String) -> Result<(), String> {
    let output = Command::new("tmux").args(argv).output();
    match output {
        Ok(output) if output.status.success() => Ok(()),
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
            if stderr.is_empty() {
                Err(fallback_error)
            } else {
                Err(stderr)
            }
        }
        Err(error) => Err(format!("{fallback_error}: {error}")),
    }
}
