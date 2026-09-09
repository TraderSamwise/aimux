use serde_json::{Map, Value, json};
use std::path::Path;

use crate::atomic_write::write_json_atomic;
use crate::project_service::dispatcher::ProjectServiceDispatchResponse;
use crate::project_service::router::ProjectServiceRequestContext;
use crate::runtime_topology::{
    read_runtime_topology, runtime_topology_path, update_runtime_topology,
};
use crate::shell_hooks::{
    wrap_command_with_shell_integration, wrap_interactive_shell_with_integration,
};
use crate::tmux::{MANAGED_TMUX_AGENT_WINDOW_OPTIONS, TmuxTarget, project_session};

use super::json_helpers::*;
use super::runtime_adapter::ProjectLifecycleRuntime;
use super::{
    binding_window_id, ensure_rig, existing_node_created_at, json_error, lifecycle_response,
    live_window_id_for_service, map_topology_array, now_iso, read_json_object, short_id,
    suppress_next_shell_reports, upsert_array_item,
};

pub(super) fn route_service_create(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let service_id =
        trimmed_string(body.get("serviceId")).unwrap_or_else(|| format!("service-{}", short_id()));
    let command_line = trimmed_string(body.get("command"))
        .or_else(|| trimmed_string(body.get("commandLine")))
        .unwrap_or_default();
    launch_service(
        context,
        ServiceLaunchInput {
            service_id,
            launch_command_line: command_line,
            worktree_path: trimmed_string(body.get("worktreePath")),
            cwd: None,
            label: None,
            created_at: None,
        },
        runtime,
        "service.create",
    )
}

pub(super) fn route_service_resume(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(service_id) = trimmed_string(body.get("serviceId")) else {
        return json_error(400, "serviceId is required");
    };
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(service) = find_by_id(&topology, "services", &service_id) else {
        return json_error(404, format!("Service \"{service_id}\" not found"));
    };
    if matches!(
        string_field(&service, "status").as_str(),
        "running" | "starting"
    ) {
        return lifecycle_response(
            json!({ "serviceId": service_id, "status": "running" }),
            "service.resume",
            "service",
            Some(&service_id),
        );
    }
    let node = service_node(&topology, &service);
    let stale_window_id = binding_window_id(&topology, &string_field(&service, "nodeId"));
    if let Some(window_id) = stale_window_id {
        let _ = runtime.kill_window(&window_id);
    }
    launch_service(
        context,
        ServiceLaunchInput {
            service_id,
            launch_command_line: trimmed_string(service.get("launchCommandLine"))
                .or_else(|| service_launch_command_line(&service))
                .unwrap_or_default(),
            worktree_path: trimmed_string(service.get("worktreePath")),
            cwd: trimmed_string(service.get("cwd")).or_else(|| {
                node.as_ref()
                    .and_then(|node| trimmed_string(node.get("cwd")))
            }),
            label: trimmed_string(service.get("label")).or_else(|| {
                node.as_ref()
                    .and_then(|node| trimmed_string(node.get("label")))
            }),
            created_at: trimmed_string(service.get("createdAt")),
        },
        runtime,
        "service.resume",
    )
}

struct ServiceLaunchInput {
    service_id: String,
    launch_command_line: String,
    worktree_path: Option<String>,
    cwd: Option<String>,
    label: Option<String>,
    created_at: Option<String>,
}

fn launch_service(
    context: &ProjectServiceRequestContext,
    input: ServiceLaunchInput,
    runtime: &mut impl ProjectLifecycleRuntime,
    operation: &str,
) -> ProjectServiceDispatchResponse {
    let project_root = context.project_root().to_string_lossy().into_owned();
    let cwd = input
        .cwd
        .clone()
        .or_else(|| input.worktree_path.clone())
        .unwrap_or_else(|| project_root.clone());
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "zsh".to_owned());
    let label = input
        .label
        .clone()
        .unwrap_or_else(|| service_label_for_command(&input.launch_command_line));
    let command = if input.launch_command_line.is_empty() {
        "shell".to_owned()
    } else {
        shell.clone()
    };
    let (launch_command, args) = if input.launch_command_line.is_empty() {
        match wrap_interactive_shell_with_integration(
            context.project_state_dir(),
            &input.service_id,
            "service",
            &shell,
        ) {
            Ok(wrapped) => wrapped,
            Err(error) => return json_error(500, error),
        }
    } else {
        let launch_args = vec![
            "-lc".to_owned(),
            build_service_launch_script(&input.launch_command_line, &shell),
        ];
        match wrap_command_with_shell_integration(
            context.project_state_dir(),
            &input.service_id,
            "service",
            &shell,
            &launch_args,
            &shell,
        ) {
            Ok(wrapped) => wrapped,
            Err(error) => return json_error(500, error),
        }
    };
    let metadata_args = if input.launch_command_line.is_empty() {
        vec!["-l".to_owned()]
    } else {
        vec!["-lc".to_owned(), input.launch_command_line.clone()]
    };
    let session_name = project_session(&project_root, "aimux").session_name;
    if let Err(error) = runtime.ensure_project_session(context.project_root()) {
        return json_error(500, error);
    }
    let target =
        match runtime.create_window(&session_name, &label, &cwd, &launch_command, &args, true) {
            Ok(target) => target,
            Err(error) => return json_error(500, error),
        };
    let now = now_iso();
    let metadata = json!({
        "kind": "service",
        "sessionId": input.service_id,
        "command": command,
        "args": metadata_args,
        "toolConfigKey": "service",
        "createdAt": input.created_at.clone().unwrap_or_else(|| now.clone()),
        "worktreePath": input.worktree_path,
        "label": label,
        "launchCommandLine": input.launch_command_line,
    });
    if let Err(error) = runtime.set_window_metadata(&target.window_id, &metadata) {
        return json_error(500, error);
    }
    if let Err(error) = apply_service_window_policy(runtime, &target.window_id) {
        return json_error(500, error);
    }
    let project_state_dir = context.project_state_dir();
    if let Err(error) =
        update_runtime_topology(runtime_topology_path(&project_state_dir), |topology| {
            upsert_service_topology(topology, &metadata, &cwd, &target, "running", &project_root)
        })
    {
        return json_error(500, error);
    }
    if let Err(error) = commit_service_state(
        &project_state_dir,
        &project_root,
        Some(service_state_from_metadata(&metadata, &cwd, Some(&target))),
        &[],
    ) {
        return json_error(500, error);
    }
    lifecycle_response(
        json!({ "serviceId": metadata["sessionId"], "status": "running" }),
        operation,
        "service",
        metadata["sessionId"].as_str(),
    )
}

pub(super) fn route_service_stop(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(service_id) = trimmed_string(body.get("serviceId")) else {
        return json_error(400, "serviceId is required");
    };
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(service) = find_by_id(&topology, "services", &service_id) else {
        return json_error(404, format!("Service \"{service_id}\" not found"));
    };
    let window_id = live_window_id_for_service(&topology, &service);
    let result = update_runtime_topology(runtime_topology_path(&project_state_dir), |topology| {
        map_topology_array(topology, "services", |mut current| {
            if string_field(&current, "id") == service_id {
                object_insert_mut(&mut current, "status", Value::String("stopped".into()));
                object_insert_mut(&mut current, "updatedAt", Value::String(now_iso()));
            }
            current
        })
    });
    if let Err(error) = result {
        return json_error(500, error);
    }
    if let Err(error) = commit_service_state(
        &project_state_dir,
        &context.project_root().to_string_lossy(),
        Some(service_state_from_topology_service(&service, &topology)),
        &[],
    ) {
        return json_error(500, error);
    }
    suppress_next_shell_reports(&project_state_dir, &service_id, 1);
    if let Some(window_id) = window_id {
        let _ = runtime.kill_window(&window_id);
    }
    lifecycle_response(
        json!({ "serviceId": service_id, "status": "stopped" }),
        "service.stop",
        "service",
        Some(&service_id),
    )
}

pub(super) fn route_service_remove(
    context: &ProjectServiceRequestContext,
    body: &Value,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> ProjectServiceDispatchResponse {
    let Some(service_id) = trimmed_string(body.get("serviceId")) else {
        return json_error(400, "serviceId is required");
    };
    let project_state_dir = context.project_state_dir();
    let topology = match read_runtime_topology(runtime_topology_path(&project_state_dir)) {
        Ok(topology) => topology,
        Err(error) => return json_error(500, error),
    };
    let Some(service) = find_by_id(&topology, "services", &service_id) else {
        return json_error(404, format!("Service \"{service_id}\" not found"));
    };
    let node_id = string_field(&service, "nodeId");
    let window_id = live_window_id_for_service(&topology, &service).or_else(|| {
        saved_service_tmux_target(&project_state_dir, &service_id)
            .filter(|target| runtime.has_window(target))
            .map(|target| target.window_id)
    });
    let result =
        update_runtime_topology(runtime_topology_path(&project_state_dir), |mut topology| {
            let mut services = array_field(&topology, "services");
            services.retain(|service| string_field(service, "id") != service_id);
            object_insert_mut(&mut topology, "services", Value::Array(services));
            let mut bindings = array_field(&topology, "bindings");
            bindings.retain(|binding| string_field(binding, "nodeId") != node_id);
            object_insert_mut(&mut topology, "bindings", Value::Array(bindings));
            let mut nodes = array_field(&topology, "nodes");
            nodes.retain(|node| string_field(node, "id") != node_id);
            object_insert_mut(&mut topology, "nodes", Value::Array(nodes));
            object_insert_mut(&mut topology, "generatedAt", Value::String(now_iso()));
            topology
        });
    if let Err(error) = result {
        return json_error(500, error);
    }
    if let Err(error) = commit_service_state(
        &project_state_dir,
        &context.project_root().to_string_lossy(),
        None,
        std::slice::from_ref(&service_id),
    ) {
        return json_error(500, error);
    }
    if let Some(window_id) = window_id {
        let _ = runtime.kill_window(&window_id);
    }
    lifecycle_response(
        json!({ "serviceId": service_id, "status": "removed" }),
        "service.remove",
        "service",
        Some(&service_id),
    )
}

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

pub(super) fn saved_service_tmux_target(
    project_state_dir: &Path,
    service_id: &str,
) -> Option<TmuxTarget> {
    read_json_object(&project_state_dir.join("state.json"))
        .get("services")
        .and_then(Value::as_array)
        .and_then(|services| {
            services
                .iter()
                .find(|service| string_field(service, "id") == service_id)
        })
        .and_then(|service| service.get("tmuxTarget"))
        .and_then(|target| {
            Some(TmuxTarget {
                session_name: trimmed_string(target.get("sessionName"))?,
                window_id: trimmed_string(target.get("windowId"))?,
                window_index: target
                    .get("windowIndex")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                window_name: trimmed_string(target.get("windowName")).unwrap_or_default(),
                pane_dead: None,
            })
        })
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
