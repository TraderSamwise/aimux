use crate::async_subprocess::AsyncCommand;
use crate::config::load_config_for_project;
use crate::paths::{PathResolver, ReadOnlyProjectPaths};
use crate::tmux::{is_tmux_client_session_for_host, project_session, tmux_command_from_env};
use helpers::{
    add_match, array, matches_string, normalize_path_like, object, read_json_source,
    read_yaml_source, service_canonical, session_canonical, source_roles, source_status,
    source_unavailable, source_value, source_with_value, source_without_value, string_field,
    string_path, worktree_canonical,
};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

mod helpers;

pub fn build_debug_state_report(cwd: impl AsRef<Path>, target: &str) -> Value {
    let cwd = cwd.as_ref();
    let mut resolver = PathResolver::from_env();
    let paths = resolver.read_only_project_paths_for(cwd);
    build_debug_state_report_with_inputs(&paths, target, None, None)
}

pub fn render_debug_state_report(report: &Value) -> Result<String, serde_json::Error> {
    serde_json::to_string_pretty(report)
}

pub fn build_debug_state_report_with_inputs(
    paths: &ReadOnlyProjectPaths,
    target: &str,
    tmux_windows: Option<Result<Vec<Value>, String>>,
    worktrees: Option<Result<Vec<Value>, String>>,
) -> Value {
    let mut matches = Vec::new();
    let mut seen = BTreeSet::new();

    let saved_state = filter_saved_state(
        read_json_source(&paths.state_path),
        target,
        &mut matches,
        &mut seen,
    );
    let raw_topology = read_yaml_source(&paths.runtime_topology_path);
    let raw_exchange = read_yaml_source(&paths.runtime_exchange_path);
    let runtime_topology =
        filter_runtime_topology(raw_topology.clone(), target, &mut matches, &mut seen);
    let metadata = filter_metadata(
        read_json_source(&paths.metadata_path),
        target,
        &mut matches,
        &mut seen,
    );
    let tmux = filter_tmux(tmux_windows, paths, target, &mut matches, &mut seen);
    let git_worktrees = filter_git_worktrees(worktrees, paths, target, &mut matches, &mut seen);
    let graveyard = filter_graveyard(runtime_topology.clone(), target, &mut matches, &mut seen);
    let worktree_graveyard = filter_worktree_graveyard(
        topology_worktree_graveyard_source(raw_topology),
        target,
        &mut matches,
        &mut seen,
    );
    let notifications = filter_notifications(raw_exchange, target, &mut matches, &mut seen);
    let operation_failures = filter_operation_failures(
        read_json_source(&paths.dashboard_operation_failures_path),
        target,
        &mut matches,
        &mut seen,
    );
    let (status, entity_count) = resolve_status(&matches);

    json!({
        "version": 1,
        "target": target,
        "project": {
            "repoRoot": paths.repo_root,
            "projectId": paths.project_id,
            "projectStateDir": paths.project_state_dir,
            "localAimuxDir": paths.local_aimux_dir,
        },
        "targetResolution": {
            "status": status,
            "entityCount": entity_count,
            "matches": matches,
        },
        "sourceRoles": source_roles(),
        "sources": {
            "savedState": saved_state,
            "runtimeTopology": runtime_topology,
            "metadata": metadata,
            "tmux": tmux,
            "gitWorktrees": git_worktrees,
            "graveyard": graveyard,
            "worktreeGraveyard": worktree_graveyard,
            "notifications": notifications,
            "operationFailures": operation_failures,
            "runtimeRows": source_unavailable("standalone debug-state does not attach to the live project runtime"),
            "pendingActions": source_unavailable("pending actions are in-memory dashboard state"),
            "dashboardSnapshot": source_unavailable("dashboard snapshot requires project-service/dashboard runtime"),
        },
    })
}

fn filter_saved_state(
    source: Value,
    target: &str,
    matches: &mut Vec<Value>,
    seen: &mut BTreeSet<String>,
) -> Value {
    if source_status(&source) != Some("found") {
        return source_without_value(source);
    }
    let services = array(source_value(&source).and_then(|root| root.get("services")))
        .into_iter()
        .filter(|entry| {
            let id = string_field(entry, "id");
            let worktree_path = string_field(entry, "worktreePath");
            let cwd = string_field(entry, "cwd");
            let label = string_field(entry, "label");
            let matched = matches_string(id.as_deref(), target)
                || matches_string(worktree_path.as_deref(), target)
                || matches_string(cwd.as_deref(), target)
                || matches_string(label.as_deref(), target);
            if matched {
                add_match(
                    matches,
                    seen,
                    json!({
                        "canonicalKey": service_canonical(id.as_deref(), worktree_path.as_deref()),
                        "kind": "service",
                        "source": "savedState",
                        "id": id,
                        "worktreePath": worktree_path,
                        "label": label,
                        "raw": entry,
                    }),
                );
            }
            matched
        })
        .collect::<Vec<_>>();
    source_with_value(&source, json!({ "services": services }))
}

fn filter_metadata(
    source: Value,
    target: &str,
    matches: &mut Vec<Value>,
    seen: &mut BTreeSet<String>,
) -> Value {
    if source_status(&source) != Some("found") {
        return source_without_value(source);
    }
    let sessions_record = source_value(&source)
        .and_then(|root| root.get("sessions"))
        .and_then(object);
    let mut sessions = Vec::new();
    for (session_id, entry) in sessions_record.into_iter().flat_map(|record| record.iter()) {
        let worktree_path = string_path(entry, &["context", "worktreePath"]);
        let worktree_name = string_path(entry, &["context", "worktreeName"]);
        let branch = string_path(entry, &["context", "branch"]);
        let cwd = string_path(entry, &["context", "cwd"]);
        let matched = matches_string(Some(session_id), target)
            || matches_string(worktree_path.as_deref(), target)
            || matches_string(worktree_name.as_deref(), target)
            || matches_string(branch.as_deref(), target)
            || matches_string(cwd.as_deref(), target);
        if matched {
            add_match(
                matches,
                seen,
                json!({
                    "canonicalKey": session_canonical(Some(session_id), None),
                    "kind": "session",
                    "source": "metadata",
                    "id": session_id,
                    "worktreePath": worktree_path,
                    "worktreeName": worktree_name,
                    "raw": entry,
                }),
            );
            let mut row = object(entry).cloned().unwrap_or_default();
            row.insert("sessionId".into(), Value::String(session_id.clone()));
            sessions.push(Value::Object(row));
        }
    }
    source_with_value(&source, json!({ "sessions": sessions }))
}

fn filter_runtime_topology(
    source: Value,
    target: &str,
    matches: &mut Vec<Value>,
    seen: &mut BTreeSet<String>,
) -> Value {
    if source_status(&source) != Some("found") {
        return source_without_value(source);
    }
    let topology = source_value(&source).unwrap_or(&Value::Null);
    let sessions = array(topology.get("sessions"))
        .into_iter()
        .filter(|entry| {
            let id = string_field(entry, "id");
            let backend_session_id = string_field(entry, "backendSessionId");
            let worktree_path = string_field(entry, "worktreePath");
            let label = string_field(entry, "label");
            let matched = matches_string(id.as_deref(), target)
                || matches_string(backend_session_id.as_deref(), target)
                || matches_string(worktree_path.as_deref(), target)
                || matches_string(label.as_deref(), target);
            if matched {
                add_match(
                    matches,
                    seen,
                    json!({
                        "canonicalKey": session_canonical(id.as_deref(), backend_session_id.as_deref()),
                        "kind": if backend_session_id.as_deref() == Some(target) && id.as_deref() != Some(target) {
                            "backend-session"
                        } else {
                            "session"
                        },
                        "source": "runtimeTopology",
                        "id": id,
                        "backendSessionId": backend_session_id,
                        "worktreePath": worktree_path,
                        "label": label,
                        "raw": entry,
                    }),
                );
            }
            matched
        })
        .collect::<Vec<_>>();
    let services = array(topology.get("services"))
        .into_iter()
        .filter(|entry| {
            let id = string_field(entry, "id");
            let worktree_path = string_field(entry, "worktreePath");
            let cwd = string_field(entry, "cwd");
            let label = string_field(entry, "label");
            let launch = string_field(entry, "launchCommandLine");
            let matched = matches_string(id.as_deref(), target)
                || matches_string(worktree_path.as_deref(), target)
                || matches_string(cwd.as_deref(), target)
                || matches_string(label.as_deref(), target)
                || matches_string(launch.as_deref(), target);
            if matched {
                add_match(
                    matches,
                    seen,
                    json!({
                        "canonicalKey": service_canonical(id.as_deref(), worktree_path.as_deref()),
                        "kind": "service",
                        "source": "runtimeTopology",
                        "id": id,
                        "worktreePath": worktree_path,
                        "label": label,
                        "raw": entry,
                    }),
                );
            }
            matched
        })
        .collect::<Vec<_>>();
    let worktrees = array(topology.get("worktrees"))
        .into_iter()
        .filter(|entry| {
            let name = string_field(entry, "name");
            let path = string_field(entry, "path");
            let branch = string_field(entry, "branch");
            let matched = matches_string(name.as_deref(), target)
                || matches_string(path.as_deref(), target)
                || matches_string(branch.as_deref(), target);
            if matched {
                add_match(
                    matches,
                    seen,
                    json!({
                        "canonicalKey": worktree_canonical(path.as_deref(), name.as_deref()),
                        "kind": "worktree",
                        "source": "runtimeTopology",
                        "worktreePath": path,
                        "worktreeName": name,
                        "raw": entry,
                    }),
                );
            }
            matched
        })
        .collect::<Vec<_>>();
    source_with_value(
        &source,
        json!({ "sessions": sessions, "services": services, "worktrees": worktrees }),
    )
}

fn filter_tmux(
    tmux_windows: Option<Result<Vec<Value>, String>>,
    paths: &ReadOnlyProjectPaths,
    target: &str,
    matches: &mut Vec<Value>,
    seen: &mut BTreeSet<String>,
) -> Value {
    let windows = match tmux_windows.unwrap_or_else(|| list_project_managed_windows(paths)) {
        Ok(windows) => windows,
        Err(error) => return json!({ "status": "error", "error": error }),
    };
    let filtered = windows
        .into_iter()
        .filter(|entry| {
            let metadata = entry.get("metadata").unwrap_or(&Value::Null);
            let window_name = string_path(entry, &["target", "windowName"]);
            let matched = matches_string(string_field(metadata, "sessionId").as_deref(), target)
                || matches_string(string_field(metadata, "backendSessionId").as_deref(), target)
                || matches_string(string_field(metadata, "worktreePath").as_deref(), target)
                || matches_string(string_field(metadata, "label").as_deref(), target)
                || matches_string(string_field(metadata, "launchCommandLine").as_deref(), target)
                || matches_string(window_name.as_deref(), target);
            if matched {
                let session_id = string_field(metadata, "sessionId");
                let backend_session_id = string_field(metadata, "backendSessionId");
                let worktree_path = string_field(metadata, "worktreePath");
                let label = string_field(metadata, "label");
                add_match(
                    matches,
                    seen,
                    json!({
                        "canonicalKey": if string_field(metadata, "kind").as_deref() == Some("service") {
                            service_canonical(session_id.as_deref(), worktree_path.as_deref())
                        } else {
                            session_canonical(session_id.as_deref(), backend_session_id.as_deref())
                        },
                        "kind": "tmux-window",
                        "source": "tmux",
                        "id": session_id,
                        "backendSessionId": backend_session_id,
                        "worktreePath": worktree_path,
                        "label": label,
                        "raw": entry,
                    }),
                );
            }
            matched
        })
        .collect::<Vec<_>>();
    json!({ "status": "found", "value": { "windows": filtered } })
}

fn filter_git_worktrees(
    worktrees: Option<Result<Vec<Value>, String>>,
    paths: &ReadOnlyProjectPaths,
    target: &str,
    matches: &mut Vec<Value>,
    seen: &mut BTreeSet<String>,
) -> Value {
    let worktrees = match worktrees.unwrap_or_else(|| list_git_worktrees(&paths.repo_root)) {
        Ok(worktrees) => worktrees,
        Err(error) => return json!({ "status": "error", "error": error }),
    };
    let filtered = worktrees
        .into_iter()
        .filter(|entry| {
            let name = string_field(entry, "name");
            let path = string_field(entry, "path");
            let branch = string_field(entry, "branch");
            let matched = matches_string(name.as_deref(), target)
                || matches_string(path.as_deref(), target)
                || matches_string(branch.as_deref(), target);
            if matched {
                add_match(
                    matches,
                    seen,
                    json!({
                        "canonicalKey": worktree_canonical(path.as_deref(), name.as_deref()),
                        "kind": "worktree",
                        "source": "gitWorktrees",
                        "worktreePath": path,
                        "worktreeName": name,
                        "raw": entry,
                    }),
                );
            }
            matched
        })
        .collect::<Vec<_>>();
    json!({ "status": "found", "value": { "worktrees": filtered } })
}

fn filter_graveyard(
    source: Value,
    target: &str,
    matches: &mut Vec<Value>,
    seen: &mut BTreeSet<String>,
) -> Value {
    if source_status(&source) != Some("found") {
        return source_without_value(source);
    }
    let entries = array(source_value(&source).and_then(|root| root.get("sessions")))
        .into_iter()
        .filter(|entry| {
            let status = string_field(entry, "status");
            if status.as_deref().is_some_and(|status| status != "graveyard") {
                return false;
            }
            let id = string_field(entry, "id");
            let backend_session_id = string_field(entry, "backendSessionId");
            let worktree_path = string_field(entry, "worktreePath");
            let label = string_field(entry, "label");
            let matched = matches_string(id.as_deref(), target)
                || matches_string(backend_session_id.as_deref(), target)
                || matches_string(worktree_path.as_deref(), target)
                || matches_string(label.as_deref(), target);
            if matched {
                add_match(
                    matches,
                    seen,
                    json!({
                        "canonicalKey": session_canonical(id.as_deref(), backend_session_id.as_deref()),
                        "kind": "session",
                        "source": "graveyard",
                        "id": id,
                        "backendSessionId": backend_session_id,
                        "worktreePath": worktree_path,
                        "label": label,
                        "raw": entry,
                    }),
                );
            }
            matched
        })
        .collect::<Vec<_>>();
    source_with_value(&source, json!({ "entries": entries }))
}

fn topology_worktree_graveyard_source(source: Value) -> Value {
    if source_status(&source) != Some("found") {
        return source;
    }
    let value = source_value(&source)
        .and_then(|topology| topology.get("worktreeGraveyard"))
        .cloned()
        .unwrap_or_else(|| json!([]));
    source_with_value(&source, value)
}

fn filter_worktree_graveyard(
    source: Value,
    target: &str,
    matches: &mut Vec<Value>,
    seen: &mut BTreeSet<String>,
) -> Value {
    if source_status(&source) != Some("found") {
        return source_without_value(source);
    }
    let entries = array(source_value(&source))
        .into_iter()
        .filter(|entry| {
            let name = string_field(entry, "name");
            let path = string_field(entry, "path");
            let branch = string_field(entry, "branch");
            let child_matched = array(entry.get("agents"))
                .into_iter()
                .chain(array(entry.get("services")))
                .any(|child| {
                    matches_string(string_field(&child, "id").as_deref(), target)
                        || matches_string(
                            string_field(&child, "backendSessionId").as_deref(),
                            target,
                        )
                });
            let matched = child_matched
                || matches_string(name.as_deref(), target)
                || matches_string(path.as_deref(), target)
                || matches_string(branch.as_deref(), target);
            if matched {
                add_match(
                    matches,
                    seen,
                    json!({
                        "canonicalKey": worktree_canonical(path.as_deref(), name.as_deref()),
                        "kind": "worktree",
                        "source": "worktreeGraveyard",
                        "worktreePath": path,
                        "worktreeName": name,
                        "raw": entry,
                    }),
                );
            }
            matched
        })
        .collect::<Vec<_>>();
    source_with_value(&source, json!({ "entries": entries }))
}

fn filter_notifications(
    source: Value,
    target: &str,
    matches: &mut Vec<Value>,
    seen: &mut BTreeSet<String>,
) -> Value {
    if source_status(&source) != Some("found") {
        return source_without_value(source);
    }
    let exchange = source_value(&source).unwrap_or(&Value::Null);
    let messages = array(exchange.get("messages"));
    let notifications = array(exchange.get("threads"))
        .into_iter()
        .filter(|entry| {
            let tags = entry.get("tags").and_then(Value::as_array).cloned().unwrap_or_default();
            if !tags.iter().any(|tag| tag.as_str() == Some("notification")) {
                return false;
            }
            let thread_id = string_field(entry, "id");
            let message = thread_id.as_deref().and_then(|id| {
                messages
                    .iter()
                    .find(|message| string_field(message, "threadId").as_deref() == Some(id))
            });
            let session_id = message.and_then(|message| string_path(message, &["metadata", "notificationSessionId"]));
            let target_key = message.and_then(|message| string_path(message, &["metadata", "notificationTargetKey"]));
            let id = message
                .and_then(|message| string_path(message, &["metadata", "notificationRecordId"]))
                .or(thread_id);
            let matched = matches_string(session_id.as_deref(), target)
                || matches_string(target_key.as_deref(), target)
                || matches_string(id.as_deref(), target);
            if matched {
                add_match(
                    matches,
                    seen,
                    json!({
                        "canonicalKey": format!("notification:{}", id.as_deref().or(target_key.as_deref()).or(session_id.as_deref()).unwrap_or("unknown")),
                        "kind": "notification",
                        "source": "runtimeExchange",
                        "id": id,
                        "raw": entry,
                    }),
                );
            }
            matched
        })
        .collect::<Vec<_>>();
    source_with_value(&source, json!({ "notifications": notifications }))
}

fn filter_operation_failures(
    source: Value,
    target: &str,
    matches: &mut Vec<Value>,
    seen: &mut BTreeSet<String>,
) -> Value {
    if source_status(&source) != Some("found") {
        return source_without_value(source);
    }
    let failures = array(source_value(&source).and_then(|root| root.get("failures")))
        .into_iter()
        .filter(|entry| {
            let id = string_field(entry, "id");
            let target_id = string_field(entry, "targetId");
            let worktree_path = string_field(entry, "worktreePath");
            let worktree_name = string_field(entry, "worktreeName");
            let matched = matches_string(id.as_deref(), target)
                || matches_string(target_id.as_deref(), target)
                || matches_string(worktree_path.as_deref(), target)
                || matches_string(worktree_name.as_deref(), target);
            if matched {
                add_match(
                    matches,
                    seen,
                    json!({
                        "canonicalKey": format!("operation-failure:{}", id.as_deref().or(target_id.as_deref()).or(worktree_path.as_deref()).unwrap_or("unknown")),
                        "kind": "operation-failure",
                        "source": "operationFailures",
                        "id": id,
                        "worktreePath": worktree_path,
                        "worktreeName": worktree_name,
                        "raw": entry,
                    }),
                );
            }
            matched
        })
        .collect::<Vec<_>>();
    source_with_value(&source, json!({ "failures": failures }))
}

fn resolve_status(matches: &[Value]) -> (&'static str, usize) {
    let keys = matches
        .iter()
        .filter_map(|item| item.get("canonicalKey").and_then(Value::as_str))
        .collect::<BTreeSet<_>>();
    match keys.len() {
        0 => ("missing", 0),
        1 => ("matched", 1),
        size => ("ambiguous", size),
    }
}

fn list_git_worktrees(repo_root: &str) -> Result<Vec<Value>, String> {
    let output = AsyncCommand::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(repo_root)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_COMMON_DIR")
        .output()
        .map_err(|error| format!("git worktree list failed: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut rows = Vec::new();
    let mut current: Map<String, Value> = Map::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            push_worktree_row(&mut rows, &mut current);
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            push_worktree_row(&mut rows, &mut current);
            current.insert("path".into(), Value::String(path.to_owned()));
            current.insert(
                "name".into(),
                Value::String(
                    Path::new(path)
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or(path)
                        .to_owned(),
                ),
            );
        } else if let Some(branch) = line.strip_prefix("branch ") {
            current.insert(
                "branch".into(),
                Value::String(
                    branch
                        .strip_prefix("refs/heads/")
                        .unwrap_or(branch)
                        .to_owned(),
                ),
            );
        } else if line.starts_with("HEAD ") || line == "detached" {
            if !current.contains_key("branch") {
                current.insert("branch".into(), Value::String("(detached)".to_owned()));
            }
        } else if line == "bare" {
            current.insert("isBare".into(), Value::Bool(true));
        }
    }
    push_worktree_row(&mut rows, &mut current);
    for row in &mut rows {
        if row.get("isBare").is_none() {
            row.as_object_mut()
                .expect("worktree row is object")
                .insert("isBare".into(), Value::Bool(false));
        }
    }
    Ok(rows
        .into_iter()
        .filter_map(add_worktree_created_at)
        .collect())
}

fn push_worktree_row(rows: &mut Vec<Value>, current: &mut Map<String, Value>) {
    if current.contains_key("path") {
        rows.push(Value::Object(std::mem::take(current)));
    } else {
        current.clear();
    }
}

fn add_worktree_created_at(worktree: Value) -> Option<Value> {
    let mut object = match worktree {
        Value::Object(object) => object,
        _ => Map::new(),
    };
    let path = object
        .get("path")
        .and_then(Value::as_str)
        .map(str::to_owned)?;
    let is_bare = object
        .get("isBare")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if is_bare {
        return Some(Value::Object(object));
    }
    let metadata = fs::metadata(&path).ok()?;
    let created = metadata
        .created()
        .or_else(|_| metadata.modified())
        .ok()
        .and_then(system_time_to_iso);
    if let Some(created) = created {
        object.insert("createdAt".into(), Value::String(created));
    }
    Some(Value::Object(object))
}

fn system_time_to_iso(time: std::time::SystemTime) -> Option<String> {
    let duration = time
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .ok()?;
    let timestamp = time::OffsetDateTime::from_unix_timestamp(duration.as_secs() as i64).ok()?;
    let timestamp = timestamp + time::Duration::nanoseconds(duration.subsec_nanos() as i64);
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        timestamp.year(),
        u8::from(timestamp.month()),
        timestamp.day(),
        timestamp.hour(),
        timestamp.minute(),
        timestamp.second(),
        timestamp.millisecond()
    ))
}

fn list_project_managed_windows(paths: &ReadOnlyProjectPaths) -> Result<Vec<Value>, String> {
    let session_names = list_session_names()?;
    let session_prefix = session_prefix_for_project(&paths.repo_root);
    let host_session = project_session(&paths.repo_root, &session_prefix).session_name;
    let managed_prefix = format!("{session_prefix}-");
    let requested_root = normalize_path_like(&paths.repo_root);
    let mut rows = Vec::new();
    let mut seen_window_ids = BTreeSet::new();
    for session_name in session_names {
        let include = session_name == host_session
            || is_tmux_client_session_for_host(&session_name, &host_session)
            || (session_name.starts_with(&managed_prefix)
                && session_option(&session_name, "@aimux-project-root")
                    .map(|root| normalize_path_like(&root) == requested_root)
                    .unwrap_or(false));
        if !include {
            continue;
        }
        for entry in list_managed_windows(&session_name) {
            let Some(window_id) = string_path(&entry, &["target", "windowId"]) else {
                continue;
            };
            if seen_window_ids.insert(window_id) {
                rows.push(entry);
            }
        }
    }
    Ok(rows)
}

fn session_prefix_for_project(project_root: &str) -> String {
    load_config_for_project(project_root)
        .pointer("/runtime/tmux/sessionPrefix")
        .and_then(Value::as_str)
        .filter(|prefix| !prefix.trim().is_empty())
        .unwrap_or("aimux")
        .to_owned()
}

fn list_session_names() -> Result<Vec<String>, String> {
    let output = tmux_command_from_env()
        .args(["list-sessions", "-F", "#{session_name}"])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Ok(Vec::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect())
}

fn session_option(session_name: &str, key: &str) -> Option<String> {
    let output = tmux_command_from_env()
        .args(["show-options", "-v", "-t", session_name, key])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!value.is_empty()).then_some(value)
}

fn list_managed_windows(session_name: &str) -> Vec<Value> {
    let output = tmux_command_from_env()
        .args([
            "list-windows",
            "-t",
            session_name,
            "-F",
            "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}\t#{@aimux-meta}",
        ])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(7, '\t');
            let window_id = fields.next()?.to_owned();
            let window_index = fields.next()?.parse::<i64>().ok()?;
            let window_name = fields.next()?.to_owned();
            let _active = fields.next()?;
            let _activity = fields.next()?;
            let pane_dead = fields.next()? == "1";
            let metadata_raw = fields.next().unwrap_or_default();
            let metadata = serde_json::from_str::<Value>(metadata_raw).ok()?;
            Some(json!({
                "target": {
                    "sessionName": session_name,
                    "windowId": window_id,
                    "windowIndex": window_index,
                    "windowName": window_name,
                    "paneDead": pane_dead,
                },
                "metadata": metadata,
            }))
        })
        .collect()
}
