use serde_json::{Map, Value, json};
use std::path::Path;

use crate::atomic_write::write_json_atomic;
use crate::tmux::{MANAGED_TMUX_AGENT_WINDOW_OPTIONS, TmuxTarget};

use super::json_helpers::*;
use super::runtime_adapter::ProjectLifecycleRuntime;
use super::{ensure_rig, existing_node_created_at, now_iso, read_json_object, upsert_array_item};

pub(super) fn apply_service_window_policy(
    runtime: &mut impl ProjectLifecycleRuntime,
    window_id: &str,
) -> Result<(), String> {
    runtime.set_window_option(window_id, "@aimux-tool", "service")?;
    runtime.set_window_option(
        window_id,
        "allow-passthrough",
        MANAGED_TMUX_AGENT_WINDOW_OPTIONS.allow_passthrough,
    )?;
    runtime.set_window_option(
        window_id,
        "aggressive-resize",
        MANAGED_TMUX_AGENT_WINDOW_OPTIONS.aggressive_resize,
    )
}

pub(super) fn upsert_service_topology(
    mut topology: Value,
    metadata: &Value,
    cwd: &str,
    target: &TmuxTarget,
    status: &str,
    project_root: &str,
) -> Value {
    let now = now_iso();
    let rig_id = ensure_rig(&mut topology, project_root, &now);
    let service_id = string_field(metadata, "sessionId");
    let node_id = format!("service:{service_id}");
    let previous_node_id = find_by_id(&topology, "services", &service_id)
        .and_then(|service| trimmed_string(service.get("nodeId")))
        .filter(|previous_node_id| previous_node_id != &node_id);
    let mut node = Map::new();
    node.insert("id".into(), Value::String(node_id.clone()));
    node.insert("rigId".into(), Value::String(rig_id.clone()));
    node.insert("logicalId".into(), Value::String(service_id.clone()));
    node.insert("role".into(), Value::String("service".into()));
    node.insert("runtime".into(), Value::String("service".into()));
    node.insert("toolConfigKey".into(), Value::String("service".into()));
    node.insert("cwd".into(), Value::String(cwd.to_owned()));
    node.insert("label".into(), metadata["label"].clone());
    node.insert(
        "createdAt".into(),
        Value::String(existing_node_created_at(&topology, &node_id).unwrap_or_else(|| now.clone())),
    );
    if let Some(previous_node_id) = &previous_node_id {
        remove_replaced_service_node(&mut topology, previous_node_id, &service_id);
    }
    upsert_array_item(&mut topology, "nodes", Value::Object(node));

    let mut service = Map::new();
    service.insert("id".into(), Value::String(service_id.clone()));
    service.insert("rigId".into(), Value::String(rig_id));
    service.insert("nodeId".into(), Value::String(node_id.clone()));
    service.insert("status".into(), Value::String(status.into()));
    service.insert("command".into(), metadata["command"].clone());
    service.insert("args".into(), metadata["args"].clone());
    service.insert(
        "launchCommandLine".into(),
        metadata["launchCommandLine"].clone(),
    );
    if let Some(worktree_path) = metadata
        .get("worktreePath")
        .cloned()
        .filter(|v| !v.is_null())
    {
        service.insert("worktreePath".into(), worktree_path);
    }
    service.insert("cwd".into(), Value::String(cwd.to_owned()));
    service.insert("label".into(), metadata["label"].clone());
    service.insert("createdAt".into(), metadata["createdAt"].clone());
    service.insert("updatedAt".into(), Value::String(now.clone()));
    service.insert("lastSeenAt".into(), Value::String(now.clone()));
    upsert_array_item(&mut topology, "services", Value::Object(service));

    upsert_array_item(
        &mut topology,
        "bindings",
        json!({
            "id": format!("tmux:service:{service_id}"),
            "nodeId": node_id,
            "tmuxSession": target.session_name,
            "tmuxWindowId": target.window_id,
            "tmuxWindowIndex": target.window_index,
            "tmuxWindowName": target.window_name,
            "updatedAt": now,
        }),
    );
    object_insert_mut(&mut topology, "generatedAt", Value::String(now_iso()));
    topology
}

fn remove_replaced_service_node(topology: &mut Value, previous_node_id: &str, service_id: &str) {
    let mut bindings = array_field(topology, "bindings");
    bindings.retain(|binding| string_field(binding, "nodeId") != previous_node_id);
    object_insert_mut(topology, "bindings", Value::Array(bindings));

    let still_used = array_field(topology, "sessions")
        .into_iter()
        .any(|session| string_field(&session, "nodeId") == previous_node_id)
        || array_field(topology, "services")
            .into_iter()
            .any(|service| {
                string_field(&service, "nodeId") == previous_node_id
                    && string_field(&service, "id") != service_id
            });
    if !still_used {
        let mut nodes = array_field(topology, "nodes");
        nodes.retain(|node| string_field(node, "id") != previous_node_id);
        object_insert_mut(topology, "nodes", Value::Array(nodes));
    }
}

pub(super) fn service_state_from_metadata(
    metadata: &Value,
    cwd: &str,
    target: Option<&TmuxTarget>,
) -> Value {
    let mut service = Map::new();
    service.insert("id".into(), metadata["sessionId"].clone());
    if let Some(created_at) = metadata
        .get("createdAt")
        .cloned()
        .filter(|value| !value.is_null())
    {
        service.insert("createdAt".into(), created_at);
    }
    if let Some(worktree_path) = metadata
        .get("worktreePath")
        .cloned()
        .filter(|value| !value.is_null())
    {
        service.insert("worktreePath".into(), worktree_path);
    }
    service.insert("cwd".into(), Value::String(cwd.to_owned()));
    if let Some(label) = metadata
        .get("label")
        .cloned()
        .filter(|value| !value.is_null())
    {
        service.insert("label".into(), label);
    }
    if let Some(launch_command_line) = metadata
        .get("launchCommandLine")
        .cloned()
        .filter(|value| !value.is_null())
    {
        service.insert("launchCommandLine".into(), launch_command_line);
    }
    if let Some(target) = target {
        service.insert("tmuxTarget".into(), tmux_target_state(target));
    }
    Value::Object(service)
}

pub(super) fn service_state_from_topology_service(service: &Value, topology: &Value) -> Value {
    let node = service_node(topology, service);
    let cwd = trimmed_string(service.get("cwd")).or_else(|| {
        node.as_ref()
            .and_then(|node| trimmed_string(node.get("cwd")))
    });
    let label = trimmed_string(service.get("label")).or_else(|| {
        node.as_ref()
            .and_then(|node| trimmed_string(node.get("label")))
    });
    let mut state = Map::new();
    state.insert("id".into(), Value::String(string_field(service, "id")));
    if let Some(created_at) = trimmed_string(service.get("createdAt")) {
        state.insert("createdAt".into(), Value::String(created_at));
    }
    if let Some(worktree_path) = trimmed_string(service.get("worktreePath")) {
        state.insert("worktreePath".into(), Value::String(worktree_path));
    }
    if let Some(cwd) = cwd {
        state.insert("cwd".into(), Value::String(cwd));
    }
    if let Some(label) = label {
        state.insert("label".into(), Value::String(label));
    }
    if let Some(launch_command_line) = trimmed_string(service.get("launchCommandLine"))
        .or_else(|| service_launch_command_line(service))
    {
        state.insert(
            "launchCommandLine".into(),
            Value::String(launch_command_line),
        );
    }
    Value::Object(state)
}

fn tmux_target_state(target: &TmuxTarget) -> Value {
    json!({
        "sessionName": target.session_name,
        "windowId": target.window_id,
        "windowIndex": target.window_index,
        "windowName": target.window_name,
    })
}

pub(super) fn commit_service_state(
    project_state_dir: &Path,
    project_root: &str,
    upsert: Option<Value>,
    remove_ids: &[String],
) -> Result<(), String> {
    let state_path = project_state_dir.join("state.json");
    let mut state = read_json_object(&state_path);
    let mut services = state
        .remove("services")
        .and_then(|services| services.as_array().cloned())
        .unwrap_or_default();
    if let Some(upsert) = upsert {
        let id = string_field(&upsert, "id");
        services.retain(|service| string_field(service, "id") != id);
        services.push(upsert);
    }
    for remove_id in remove_ids {
        services.retain(|service| string_field(service, "id") != *remove_id);
    }
    state.insert("savedAt".into(), Value::String(now_iso()));
    state.insert("cwd".into(), Value::String(project_root.to_owned()));
    state.insert("services".into(), Value::Array(services));
    write_json_atomic(state_path, &Value::Object(state)).map_err(|error| error.to_string())
}

pub(super) fn saved_service_tmux_window_id(
    project_state_dir: &Path,
    service_id: &str,
) -> Option<String> {
    read_json_object(&project_state_dir.join("state.json"))
        .get("services")
        .and_then(Value::as_array)
        .and_then(|services| {
            services
                .iter()
                .find(|service| string_field(service, "id") == service_id)
        })
        .and_then(|service| service.get("tmuxTarget"))
        .and_then(|target| trimmed_string(target.get("windowId")))
}

pub(super) fn service_node(topology: &Value, service: &Value) -> Option<Value> {
    let node_id = string_field(service, "nodeId");
    find_by_id(topology, "nodes", &node_id)
}

pub(super) fn service_launch_command_line(service: &Value) -> Option<String> {
    let args = service.get("args").and_then(Value::as_array)?;
    if args.first().and_then(Value::as_str) != Some("-lc") {
        return None;
    }
    args.get(1).and_then(Value::as_str).and_then(trimmed_owned)
}

pub(super) fn service_label_for_command(command_line: &str) -> String {
    let Some(first) = command_line.split_whitespace().next() else {
        return "shell".into();
    };
    first.rsplit('/').next().unwrap_or(first).to_owned()
}

pub(super) fn build_service_launch_script(command_line: &str, shell_path: &str) -> String {
    let trimmed = command_line.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let quoted_shell = shell_quote(shell_path);
    [
        trimmed.to_owned(),
        "_aimux_service_status=$?".into(),
        "if [ \"$_aimux_service_status\" -ne 0 ]; then".into(),
        "  printf \"\\n[aimux] Service command exited with status %s. Dropping into an interactive shell for debugging.\\n\" \"$_aimux_service_status\"".into(),
        format!("  exec {quoted_shell} -i"),
        "fi".into(),
        "exit \"$_aimux_service_status\"".into(),
    ]
    .join("; ")
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
