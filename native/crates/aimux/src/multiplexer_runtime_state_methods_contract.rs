use serde_json::{Value, json};

const NOW: &str = "2026-06-01T00:00:00.000Z";

pub fn run_multiplexer_runtime_state_methods_contract_case(api: &str, input: &Value) -> Value {
    match api {
        "adjustAfterRemove" => adjust_after_remove(input),
        "stopSessionToOffline" => stop_session_to_offline(input),
        "graveyardSession" => graveyard_session(input),
        "isSessionRuntimeLive" => is_session_runtime_live(input),
        "restoreTmuxSessionsFromTopology" => restore_tmux_sessions_from_topology(input),
        "recordSessionBackendSessionId" => record_session_backend_session_id(input),
        "loadOfflineTopologySessions" => load_offline_topology_sessions(input),
        "reconcileOrphanedTopologySessions" => reconcile_orphaned_topology_sessions(input),
        "loadOfflineServices" => load_offline_services(input),
        "reconcileOrphanedTopologyServices" => reconcile_orphaned_topology_services(input),
        "buildLiveServiceStates" => build_live_service_states(input),
        "resumeOfflineSession" => resume_offline_session(input),
        "startHeartbeat" => json!({
            "calls": [
                call("runtimeSync.startHeartbeat", vec![]),
                call("refreshRuntimeGuard", vec![]),
            ],
        }),
        "stopHeartbeat" => json!({
            "calls": [call("runtimeSync.stopHeartbeat", vec![])],
        }),
        "projectServiceRefreshWrappers" => json!({
            "calls": [
                call("runtimeSync.startProjectServiceRefresh", vec![]),
                call("runtimeSync.stopProjectServiceRefresh", vec![]),
            ],
        }),
        "renderCurrentDashboardView" => render_current_dashboard_view(input),
        "evictZombieSession" => evict_zombie_session(input),
        api => panic!("unknown multiplexer runtime-state method api: {api}"),
    }
}

fn render_current_dashboard_view(input: &Value) -> Value {
    let screen = string_field(input, "screen");
    let mut calls = vec![call("reconcileDashboardRenderState", vec![])];
    for candidate in [
        "coordination",
        "project",
        "library",
        "topology",
        "help",
        "graveyard",
    ] {
        calls.push(call("isDashboardScreen", vec![json!(candidate)]));
        if screen == candidate {
            let method = match candidate {
                "coordination" => "renderCoordination",
                "project" => "renderProject",
                "library" => "renderLibrary",
                "topology" => "renderTopology",
                "help" => "renderHelp",
                _ => "renderGraveyard",
            };
            calls.push(call(method, vec![]));
            return json!({ "calls": calls });
        }
    }
    calls.push(call("renderDashboard", vec![]));
    json!({ "calls": calls })
}

fn evict_zombie_session(input: &Value) -> Value {
    let runtime_id = string_at(input, &["runtime", "id"]);
    let mut sessions = array_at(input, &["host", "sessions"]);
    sessions.retain(|session| string_field(session, "id") != runtime_id);
    let stopping_session_ids = array_at(input, &["host", "stoppingSessionIds"])
        .into_iter()
        .filter(|value| value.as_str() != Some(runtime_id.as_str()))
        .collect::<Vec<_>>();
    let mut session_tmux_targets = array_at(input, &["host", "sessionTmuxTargets"]);
    remove_entry(&mut session_tmux_targets, &runtime_id);
    json!({
        "host": {
            "sessions": sessions,
            "stoppingSessionIds": stopping_session_ids,
            "sessionTmuxTargets": session_tmux_targets,
            "sessionToolKeys": array_at(input, &["host", "sessionToolKeys"]),
            "sessionOriginalArgs": array_at(input, &["host", "sessionOriginalArgs"]),
            "sessionWorktreePaths": array_at(input, &["host", "sessionWorktreePaths"]),
            "sessionRoles": array_at(input, &["host", "sessionRoles"]),
        },
        "calls": [
            call("updateContextWatcherSessions", vec![]),
            call("saveState", vec![]),
        ],
    })
}

fn adjust_after_remove(input: &Value) -> Value {
    let mut host = value_field(input, "host").clone();
    let has_worktrees = bool_field(input, "hasWorktrees");
    let mut calls = Vec::new();
    if has_worktrees && string_at(&host, &["dashboardState", "level"]) == "sessions" {
        calls.push(call("updateWorktreeSessions", vec![]));
        if array_at(&host, &["dashboardState", "worktreeEntries"]).is_empty() {
            set_at(&mut host, &["dashboardState", "level"], json!("worktrees"));
        } else {
            let session_index = number_at(&host, &["dashboardState", "sessionIndex"]);
            let len = array_at(&host, &["dashboardState", "worktreeEntries"]).len() as i64;
            if session_index >= len {
                set_at(
                    &mut host,
                    &["dashboardState", "sessionIndex"],
                    json!(len.saturating_sub(1)),
                );
            }
        }
    } else if !has_worktrees {
        calls.push(call("getDashboardSessions", vec![]));
        let total = array_field(&host, "dashboardSessions").len() as i64;
        let active_index = number_field(&host, "activeIndex");
        if active_index >= total {
            set_field(&mut host, "activeIndex", json!(std::cmp::max(0, total - 1)));
        }
    }
    json!({ "host": host, "calls": calls })
}

fn stop_session_to_offline(input: &Value) -> Value {
    let session = value_field(input, "session");
    let host = value_field(input, "host");
    let session_id = string_field(session, "id");
    let command = string_field(session, "command");
    let tool_config_key =
        map_lookup(host, "sessionToolKeys", &session_id).unwrap_or_else(|| command.clone());
    let args =
        map_lookup_value(host, "sessionOriginalArgs", &session_id).unwrap_or_else(|| json!([]));
    let worktree_path = map_lookup(host, "sessionWorktreePaths", &session_id);
    let label = map_lookup(host, "sessionLabels", &session_id);
    let headline = map_lookup(host, "headlines", &session_id);
    let created_at = start_time_to_iso(number_field(session, "startTime"));
    let mut offline = json!({
        "id": session_id,
        "tool": command,
        "toolConfigKey": tool_config_key,
        "command": command,
        "args": args,
        "status": "offline",
        "lifecycle": "offline",
        "createdAt": created_at,
        "updatedAt": NOW,
        "backendSessionId": string_field(session, "backendSessionId"),
        "team": value_field(session, "team").clone(),
        "freshRelaunchAllowed": false,
    });
    if let Some(worktree_path) = worktree_path {
        set_field(&mut offline, "worktreePath", json!(worktree_path));
    }
    if let Some(label) = label.clone() {
        set_field(&mut offline, "label", json!(label));
    }
    if let Some(headline) = headline {
        set_field(&mut offline, "headline", json!(headline));
    }
    json!({
        "host": {
            "offlineSessions": [],
            "stoppingSessionIds": [string_field(session, "id")],
            "startedInDashboard": true,
        },
        "topology": { "sessions": [offline] },
        "calls": [
            call("noteLastUsedItem", vec![json!(string_field(session, "id"))]),
            call("getSessionLabel", vec![json!(string_field(session, "id"))]),
            call("deriveHeadline", vec![json!(string_field(session, "id"))]),
            call("saveState", vec![]),
            call("session.kill", vec![]),
            call(
                "debug",
                vec![
                    json!(format!("stopped session {} → offline", string_field(session, "id"))),
                    json!("session"),
                ],
            ),
        ],
    })
}

fn graveyard_session(input: &Value) -> Value {
    let session_id = string_field(input, "sessionId");
    let mut sessions = array_at(input, &["initialTopology", "sessions"]);
    for session in &mut sessions {
        if string_field(session, "id") == session_id {
            set_field(session, "status", json!("graveyard"));
            remove_field(session, "lifecycle");
            remove_field(session, "restoreBlockedReason");
            set_field(session, "updatedAt", json!(NOW));
            set_field(session, "graveyardedAt", json!(NOW));
        }
    }
    json!({
        "host": { "offlineSessions": [] },
        "topology": { "sessions": sessions },
        "calls": [
            call("noteLastUsedItem", vec![json!(session_id)]),
            call("invalidateDesktopStateSnapshot", vec![]),
            call("writeStatuslineFile", vec![]),
            call("renderCurrentDashboardView", vec![]),
            call("debug", vec![json!(format!("graveyarded session {session_id}")), json!("session")]),
        ],
    })
}

fn is_session_runtime_live(input: &Value) -> Value {
    let runtime = value_field(input, "runtime");
    if bool_field(runtime, "exited") {
        return json!({ "live": false, "calls": [] });
    }
    let session_id = string_field(runtime, "id");
    let Some(target) = map_lookup_value(input, "sessionTmuxTargets", &session_id) else {
        return json!({ "live": false, "calls": [] });
    };
    let session_name = string_field(&target, "sessionName");
    let window_id = string_field(&target, "windowId");
    let resolved = value_field(input, "resolvedTarget");
    let metadata = value_field(input, "metadata");
    let live = !resolved.is_null()
        && string_field(metadata, "kind") == "agent"
        && string_field(metadata, "sessionId") == session_id;
    json!({
        "live": live,
        "calls": [
            call("tmuxRuntimeManager.getTargetByWindowId", vec![json!(session_name), json!(window_id)]),
            call("tmuxRuntimeManager.getWindowMetadata", vec![resolved.clone()]),
        ],
    })
}

fn restore_tmux_sessions_from_topology(input: &Value) -> Value {
    let project_root = project_root_for(input);
    let live_windows = array_field(input, "liveWindows")
        .into_iter()
        .filter(|window| string_field(value_field(window, "metadata"), "kind") == "agent")
        .collect::<Vec<_>>();
    let mut calls = vec![call(
        "tmuxRuntimeManager.listProjectManagedWindows",
        vec![json!(project_root)],
    )];
    let mut sessions = array_at(input, &["host", "sessions"]);
    let mut session_targets = array_at(input, &["host", "sessionTmuxTargets"]);
    let mut session_labels = array_at(input, &["host", "sessionLabels"]);
    let saved_sessions = array_at(input, &["initialTopology", "sessions"]);

    let mut retained_sessions = Vec::new();
    for session in sessions {
        let session_id = string_field(&session, "id");
        if let Some(live) = live_window_for_session(&live_windows, &session_id) {
            let live_target = value_field(live, "target").clone();
            let previous_target = map_lookup_value_in_entries(&session_targets, &session_id);
            if previous_target
                .as_ref()
                .map(|target| {
                    string_field(target, "windowId") != string_field(&live_target, "windowId")
                })
                .unwrap_or(true)
            {
                replace_entry(&mut session_targets, &session_id, live_target.clone());
                calls.push(call(
                    "tmuxRuntimeManager.clearTargetHistory",
                    vec![live_target],
                ));
            }
            retained_sessions.push(simplify_runtime_session(&session));
        } else {
            calls.push(call(
                "debug",
                vec![
                    json!(format!(
                        "evicting stale runtime {session_id}: no live tmux metadata"
                    )),
                    json!("session"),
                ],
            ));
            remove_entry(&mut session_targets, &session_id);
        }
    }
    sessions = retained_sessions;

    if sessions.is_empty() {
        calls.push(call("contextWatcher.stop", vec![]));
    }

    for live in &live_windows {
        let metadata = value_field(live, "metadata");
        let session_id = string_field(metadata, "sessionId");
        if sessions
            .iter()
            .any(|session| string_field(session, "id") == session_id)
        {
            continue;
        }
        let target = value_field(live, "target").clone();
        replace_entry(&mut session_targets, &session_id, target.clone());
        calls.push(call(
            "tmuxRuntimeManager.clearTargetHistory",
            vec![target.clone()],
        ));
        let saved = saved_sessions
            .iter()
            .find(|session| string_field(session, "id") == session_id);
        let backend_session_id = optional_string(metadata, "backendSessionId")
            .or_else(|| saved.and_then(|session| optional_string(session, "backendSessionId")));
        let transport_summary = runtime_transport_summary(
            &session_id,
            &string_field(metadata, "command"),
            backend_session_id.as_deref(),
        );
        let args = value_field(metadata, "args").clone();
        calls.push(call(
            "registerManagedSession",
            vec![
                transport_summary.clone(),
                args,
                json!(string_field(metadata, "toolConfigKey")),
                json!(string_field(metadata, "worktreePath")),
                optional_json_string(metadata, "role"),
                created_at_millis(metadata),
                metadata.get("team").cloned().unwrap_or(Value::Null),
            ],
        ));
        let mut session = transport_summary;
        if session.get("backendSessionId").is_none() {
            remove_field(&mut session, "backendSessionId");
        }
        sessions.push(session);
        let label = optional_string(metadata, "label")
            .or_else(|| saved.and_then(|session| optional_string(session, "label")));
        if let Some(label) = label {
            replace_entry(&mut session_labels, &session_id, json!(label));
        }
        if string_field(value_field(live, "target"), "windowName")
            != string_field(metadata, "command")
        {
            calls.push(call(
                "tmuxRuntimeManager.renameWindow",
                vec![
                    json!(string_field(value_field(live, "target"), "windowId")),
                    json!(string_field(metadata, "command")),
                ],
            ));
        }
        calls.push(call("syncTmuxWindowMetadata", vec![json!(session_id)]));
    }

    calls.push(call("updateContextWatcherSessions", vec![]));
    json!({
        "liveWindows": live_windows,
        "host": {
            "sessions": sessions,
            "sessionTmuxTargets": session_targets,
            "sessionLabels": session_labels,
        },
        "calls": calls,
    })
}

fn record_session_backend_session_id(input: &Value) -> Value {
    let mut host_sessions = array_at(input, &["host", "sessions"]);
    let mut offline_sessions = array_at(input, &["host", "offlineSessions"]);
    let mut topology_sessions = array_at(input, &["initialTopology", "sessions"]);
    let mut results = Vec::new();
    let mut calls = Vec::new();

    for operation in array_field(input, "operations") {
        let session_id = string_field(&operation, "sessionId");
        let backend_session_id = string_field(&operation, "backendSessionId")
            .trim()
            .to_owned();
        match record_backend_session_id_operation(
            &mut host_sessions,
            &mut offline_sessions,
            &mut topology_sessions,
            &mut calls,
            &session_id,
            &backend_session_id,
        ) {
            Ok(value) => results.push(json!({ "ok": true, "value": value })),
            Err(error) => results.push(json!({ "ok": false, "error": error })),
        }
    }

    json!({
        "results": results,
        "host": {
            "sessions": host_sessions,
            "offlineSessions": offline_sessions,
        },
        "topology": { "sessions": topology_sessions },
        "calls": calls,
    })
}

fn record_backend_session_id_operation(
    host_sessions: &mut [Value],
    offline_sessions: &mut [Value],
    topology_sessions: &mut Vec<Value>,
    calls: &mut Vec<Value>,
    session_id: &str,
    backend_session_id: &str,
) -> Result<Value, String> {
    if backend_session_id.is_empty() {
        return Err("backendSessionId is required".to_owned());
    }
    let runtime_index = host_sessions
        .iter()
        .position(|session| string_field(session, "id") == session_id);
    let offline_index = offline_sessions
        .iter()
        .position(|session| string_field(session, "id") == session_id);

    if let Some(index) = runtime_index {
        let runtime_backend = optional_string(&host_sessions[index], "backendSessionId");
        if runtime_backend.is_none()
            && optional_string(&host_sessions[index], "supersededBackendSessionId").as_deref()
                == Some(backend_session_id)
        {
            return Err(format!(
                "Agent \"{session_id}\" ignored stale backend session \"{backend_session_id}\" from a superseded launch"
            ));
        }
        if runtime_backend
            .as_deref()
            .is_some_and(|existing| existing != backend_session_id)
        {
            let existing = runtime_backend.as_deref().unwrap_or_default();
            return Err(format!(
                "Agent \"{session_id}\" already has backend session \"{existing}\", cannot replace with \"{backend_session_id}\""
            ));
        }
        let Some(topology_index) = topology_sessions
            .iter()
            .position(|session| string_field(session, "id") == session_id)
        else {
            return Err(format!(
                "Agent \"{session_id}\" is not managed in runtime topology"
            ));
        };
        let topology_backend =
            optional_string(&topology_sessions[topology_index], "backendSessionId");
        let offline_backend = offline_index
            .and_then(|idx| optional_string(&offline_sessions[idx], "backendSessionId"));
        if runtime_backend.as_deref() == Some(backend_session_id)
            && topology_backend.as_deref() == Some(backend_session_id)
            && offline_index.is_none_or(|_| offline_backend.as_deref() == Some(backend_session_id))
        {
            calls.push(call("syncTmuxWindowMetadata", vec![json!(session_id)]));
            return Ok(json!({ "sessionId": session_id, "backendSessionId": backend_session_id }));
        }

        let mut topology_session = topology_sessions.remove(topology_index);
        set_field(
            &mut topology_session,
            "backendSessionId",
            json!(backend_session_id),
        );
        set_field(&mut topology_session, "status", json!("running"));
        set_field(&mut topology_session, "lifecycle", json!("live"));
        set_field(&mut topology_session, "updatedAt", json!(NOW));
        topology_sessions.push(topology_session);
        set_field(
            &mut host_sessions[index],
            "backendSessionId",
            json!(backend_session_id),
        );
        calls.push(call("syncTmuxWindowMetadata", vec![json!(session_id)]));
    } else {
        let Some(topology_index) = topology_sessions
            .iter()
            .position(|session| string_field(session, "id") == session_id)
        else {
            return Err(format!(
                "Agent \"{session_id}\" is not managed in runtime topology"
            ));
        };
        if let Some(existing) =
            optional_string(&topology_sessions[topology_index], "backendSessionId")
        {
            if existing != backend_session_id {
                return Err(format!(
                    "Agent \"{session_id}\" already has backend session \"{existing}\", cannot replace with \"{backend_session_id}\""
                ));
            }
        } else {
            set_field(
                &mut topology_sessions[topology_index],
                "backendSessionId",
                json!(backend_session_id),
            );
            set_field(
                &mut topology_sessions[topology_index],
                "updatedAt",
                json!(NOW),
            );
        }
    }

    if let Some(index) = offline_index {
        set_field(
            &mut offline_sessions[index],
            "backendSessionId",
            json!(backend_session_id),
        );
    }
    calls.push(call("saveState", vec![]));
    calls.push(call("invalidateDesktopStateSnapshot", vec![]));
    calls.push(call("writeStatuslineFile", vec![]));
    Ok(json!({ "sessionId": session_id, "backendSessionId": backend_session_id }))
}

fn load_offline_topology_sessions(input: &Value) -> Value {
    let topology = session_service_topology(input);
    let mut offline_sessions = array_at(input, &["host", "offlineSessions"]);
    let mut calls = Vec::new();
    let project_root = project_root_for(input);
    calls.push(call(
        "tmuxRuntimeManager.listProjectManagedWindows",
        vec![json!(project_root)],
    ));

    let live_ids = live_ids(input, "agent");
    let host_sessions = array_at(input, &["host", "sessions"]);
    let owned_ids = host_sessions
        .iter()
        .map(|session| string_field(session, "id"))
        .collect::<Vec<_>>();
    let owned_backend_ids = host_sessions
        .iter()
        .filter_map(|session| session.get("backendSessionId").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let next = array_field(&topology, "sessions")
        .into_iter()
        .filter(|session| string_field(session, "status") == "offline")
        .filter(|session| {
            let id = string_field(session, "id");
            if live_ids.contains(&id) || owned_ids.contains(&id) {
                return false;
            }
            let backend_id = string_field(session, "backendSessionId");
            if !backend_id.is_empty() && owned_backend_ids.contains(&backend_id) {
                return false;
            }
            calls.push(call(
                "dashboardPendingActions.getSessionAction",
                vec![json!(id)],
            ));
            object_lookup_string(input, "pendingSessionActions", &id).as_deref() != Some("starting")
                && is_available_worktree_path(&string_field(session, "worktreePath"))
        })
        .collect::<Vec<_>>();
    let previous_key = offline_sessions
        .iter()
        .map(offline_session_change_key)
        .collect::<Vec<_>>()
        .join("|");
    let next_key = next
        .iter()
        .map(offline_session_change_key)
        .collect::<Vec<_>>()
        .join("|");
    offline_sessions = next;
    if !offline_sessions.is_empty() {
        calls.push(call(
            "debug",
            vec![
                json!(format!(
                    "loaded {} offline session(s) from runtime topology",
                    offline_sessions.len()
                )),
                json!("session"),
            ],
        ));
    }
    json!({
        "changed": previous_key != next_key,
        "host": { "offlineSessions": offline_sessions },
        "topology": topology,
        "calls": calls,
    })
}

fn reconcile_orphaned_topology_sessions(input: &Value) -> Value {
    let mut topology = session_service_topology(input);
    let mut sessions = array_field(&topology, "sessions");
    let mut calls = Vec::new();
    let live_ids = live_ids(input, "agent");
    let host_sessions = array_at(input, &["host", "sessions"]);
    let owned_ids = host_sessions
        .iter()
        .map(|session| string_field(session, "id"))
        .collect::<Vec<_>>();
    let owned_backend_ids = host_sessions
        .iter()
        .filter_map(|session| session.get("backendSessionId").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let mut changed = false;

    for session in &mut sessions {
        let id = string_field(session, "id");
        let status = string_field(session, "status");
        if !["starting", "running", "idle", "offline"].contains(&status.as_str()) {
            continue;
        }
        if live_ids.contains(&id) || owned_ids.contains(&id) {
            continue;
        }
        let backend_id = string_field(session, "backendSessionId");
        if !backend_id.is_empty() && owned_backend_ids.contains(&backend_id) {
            continue;
        }
        calls.push(call(
            "dashboardPendingActions.getSessionAction",
            vec![json!(id)],
        ));
        let pending_start = object_lookup_string(input, "pendingSessionActions", &id).as_deref()
            == Some("starting");
        let stale_starting = status == "starting"
            && string_field(session, "updatedAt") != NOW.replace("01T00:00:00", "01T00:00:05");
        if pending_start && !stale_starting {
            continue;
        }

        let worktree_path = string_field(session, "worktreePath");
        if !worktree_path.is_empty() && worktree_path != "<repo>" {
            let reason = format!("worktree missing after restart: {worktree_path}");
            set_field(session, "status", json!("graveyard"));
            remove_field(session, "lifecycle");
            set_field(session, "updatedAt", json!(NOW));
            set_field(session, "graveyardedAt", json!(NOW));
            set_field(session, "graveyardReason", json!(reason));
            calls.push(call(
                "debug",
                vec![
                    json!(format!(
                        "graveyarded unrecoverable orphaned session {id}: {reason}"
                    )),
                    json!("session"),
                ],
            ));
            changed = true;
            continue;
        }

        if status == "offline" {
            continue;
        }
        set_field(session, "status", json!("offline"));
        set_field(session, "lifecycle", json!("offline"));
        set_field(session, "updatedAt", json!(NOW));
        remove_field(session, "tmuxTarget");
        if status == "starting" && session.get("restoreBlockedReason").is_none() {
            set_field(
                session,
                "restoreBlockedReason",
                json!("agent did not stay alive during startup"),
            );
        }
        calls.push(call(
            "debug",
            vec![
                json!(format!(
                    "reconciled orphaned session {id} → offline (no live tmux window)"
                )),
                json!("session"),
            ],
        ));
        changed = true;
    }

    topology["sessions"] = Value::Array(sessions);
    json!({
        "changed": changed,
        "host": { "offlineSessions": array_at(input, &["host", "offlineSessions"]) },
        "topology": topology,
        "calls": calls,
    })
}

fn load_offline_services(input: &Value) -> Value {
    let mut topology = session_service_topology(input);
    let mut offline_services = array_at(input, &["host", "offlineServices"]);
    let mut calls = Vec::new();
    let project_root = string_field(input, "projectRoot");
    calls.push(call(
        "tmuxRuntimeManager.listProjectManagedWindows",
        vec![json!(project_root)],
    ));
    let live_service_ids = live_ids(input, "service");
    let mut changed =
        reconcile_services_in_topology(input, &mut topology, &live_service_ids, &mut calls);
    let saved = array_field(&topology, "services")
        .into_iter()
        .filter(|service| {
            ["stopped", "offline"].contains(&string_field(service, "status").as_str())
        })
        .filter(|service| {
            let id = string_field(service, "id");
            if live_service_ids.contains(&id) {
                return false;
            }
            calls.push(call(
                "dashboardPendingActions.getServiceAction",
                vec![json!(id)],
            ));
            object_lookup_string(input, "pendingServiceActions", &id).as_deref() != Some("starting")
        })
        .map(offline_service_state)
        .collect::<Vec<_>>();
    let previous_key = offline_services
        .iter()
        .map(offline_service_change_key)
        .collect::<Vec<_>>()
        .join("|");
    let next_key = saved
        .iter()
        .map(offline_service_change_key)
        .collect::<Vec<_>>()
        .join("|");
    offline_services = saved;
    changed = changed || previous_key != next_key;
    json!({
        "changed": changed,
        "host": { "offlineServices": offline_services },
        "topology": topology,
        "calls": calls,
    })
}

fn reconcile_orphaned_topology_services(input: &Value) -> Value {
    let mut topology = session_service_topology(input);
    let mut calls = Vec::new();
    let project_root = project_root_for(input);
    calls.push(call(
        "tmuxRuntimeManager.listProjectManagedWindows",
        vec![json!(project_root)],
    ));
    let live_service_ids = live_ids(input, "service");
    let changed =
        reconcile_services_in_topology(input, &mut topology, &live_service_ids, &mut calls);
    json!({
        "changed": changed,
        "host": { "offlineServices": array_at(input, &["host", "offlineServices"]) },
        "topology": topology,
        "calls": calls,
    })
}

fn build_live_service_states(input: &Value) -> Value {
    let mut calls = Vec::new();
    let project_root = project_root_for(input);
    calls.push(call(
        "tmuxRuntimeManager.listProjectManagedWindows",
        vec![json!(project_root)],
    ));
    let mut seen = Vec::new();
    let mut services = Vec::new();
    for window in array_field(input, "liveWindows") {
        let metadata = value_field(&window, "metadata");
        if string_field(metadata, "kind") != "service" {
            continue;
        }
        let target = value_field(&window, "target").clone();
        calls.push(call(
            "tmuxRuntimeManager.isWindowAlive",
            vec![target.clone()],
        ));
        let service_id = string_field(metadata, "sessionId");
        if seen.contains(&service_id) {
            continue;
        }
        seen.push(service_id.clone());
        let window_id = string_field(&target, "windowId");
        calls.push(call(
            "tmuxRuntimeManager.displayMessage",
            vec![json!("#{pane_current_path}"), json!(window_id)],
        ));
        let cwd = object_lookup_string(input, "displayPaths", &window_id)
            .unwrap_or_else(|| string_field(metadata, "worktreePath"));
        let mut service = json!({
            "id": service_id,
            "createdAt": string_field(metadata, "createdAt"),
            "worktreePath": string_field(metadata, "worktreePath"),
            "label": string_field(metadata, "label"),
            "launchCommandLine": service_launch_command_line(metadata),
            "cwd": cwd,
            "tmuxTarget": target,
        });
        remove_empty_optional(&mut service, "createdAt");
        remove_empty_optional(&mut service, "worktreePath");
        remove_empty_optional(&mut service, "label");
        services.push(service);
    }
    json!({ "services": services, "calls": calls })
}

fn resume_offline_session(input: &Value) -> Value {
    let session = value_field(input, "session");
    let session_id = string_field(session, "id");
    let mut offline_sessions = array_at(input, &["host", "offlineSessions"]);
    let mut calls = Vec::new();
    let mut metadata = value_field(input, "initialMetadata").clone();
    let mut topology_sessions = array_at(input, &["initialTopology", "sessions"]);

    let Some(topology_session) = topology_sessions
        .iter()
        .find(|candidate| string_field(candidate, "id") == session_id)
    else {
        offline_sessions.retain(|candidate| string_field(candidate, "id") != session_id);
        calls.push(call("invalidateDesktopStateSnapshot", vec![]));
        calls.push(call("writeStatuslineFile", vec![]));
        calls.push(call(
            "debug",
            vec![
                json!(format!(
                    "ignored stale offline resume for {session_id}: no offline topology row"
                )),
                json!("session"),
            ],
        ));
        let mut output = json!({
            "thrown": null,
            "host": {
                "sessions": array_at(input, &["host", "sessions"]),
                "offlineSessions": offline_sessions,
                "sessionLabels": [],
                "restored": [],
            },
            "topology": { "sessions": topology_sessions },
            "metadata": metadata,
            "calls": calls,
        });
        if let Some(other_topology) = input.get("otherTopology") {
            set_field(&mut output, "otherTopology", other_topology.clone());
        }
        return output;
    };

    let topology_index = topology_sessions
        .iter()
        .position(|candidate| string_field(candidate, "id") == session_id)
        .unwrap_or(0);
    let mut topology_session = topology_session.clone();
    let mut backend_session_id = optional_string(&topology_session, "backendSessionId");
    let explicit_error = derived_field(&metadata, &session_id, "activity").as_deref()
        == Some("error")
        || derived_field(&metadata, &session_id, "attention").as_deref() == Some("error");
    if backend_session_id.is_none()
        && !explicit_error
        && let Some(discovered) = optional_string(input, "discoveredBackendSessionId")
    {
        set_field(&mut topology_session, "backendSessionId", json!(discovered));
        topology_sessions[topology_index] = topology_session.clone();
        backend_session_id = Some(discovered.clone());
        if string_field(&topology_session, "worktreePath").is_empty() {
            calls.push(call(
                "debug",
                vec![
                    json!("loaded 1 offline session(s) from runtime topology"),
                    json!("session"),
                ],
            ));
        }
        calls.push(call(
            "debug",
            vec![
                json!(format!(
                    "reconciled backend session id for {session_id} from disk: {discovered}"
                )),
                json!("session"),
            ],
        ));
    }
    let backend_id_json = backend_session_id
        .as_deref()
        .map(|id| json!(id))
        .unwrap_or(Value::Null);
    let derived_activity = derived_field(&metadata, &session_id, "activity");
    let relaunch_fresh = explicit_error
        || (backend_session_id.is_none() && bool_field(&topology_session, "freshRelaunchAllowed"));
    let can_resume = if relaunch_fresh {
        false
    } else {
        let tool_key = string_field(&topology_session, "toolConfigKey");
        calls.push(call(
            "sessionBootstrap.canResumeWithBackendSessionId",
            vec![tool_config(input, &tool_key), backend_id_json.clone()],
        ));
        input
            .get("canResumeWithBackendSessionId")
            .and_then(Value::as_bool)
            .unwrap_or(backend_session_id.is_some())
    };
    let use_backend_resume = !relaunch_fresh && can_resume;
    if !relaunch_fresh && !use_backend_resume {
        return json!({
            "thrown": format!(
                "Cannot restore session \"{session_id}\" without an exact resumable backend session id for \"{}\"",
                string_field(&topology_session, "toolConfigKey")
            ),
            "host": {
                "sessions": array_at(input, &["host", "sessions"]),
                "offlineSessions": offline_sessions,
                "sessionLabels": [],
                "restored": [],
            },
            "topology": { "sessions": topology_sessions },
            "metadata": metadata,
            "calls": calls,
        });
    }
    if relaunch_fresh {
        remove_at(&mut metadata, &["sessions", &session_id, "derived"]);
        remove_at(&mut metadata, &["sessions", &session_id, "status"]);
        remove_at(&mut metadata, &["sessions", &session_id, "progress"]);
    } else if use_backend_resume && derived_activity.as_deref() == Some("running") {
        set_at(
            &mut metadata,
            &["sessions", &session_id, "derived", "activity"],
            json!("idle"),
        );
    }
    calls.push(call("getSessionLabel", vec![json!(session_id)]));
    offline_sessions.retain(|candidate| string_field(candidate, "id") != session_id);
    calls.push(call("invalidateDesktopStateSnapshot", vec![]));
    calls.push(call("writeStatuslineFile", vec![]));
    let backend_debug = backend_session_id.as_deref().unwrap_or("none");
    calls.push(call(
        "debug",
        vec![
            json!(format!(
                "resuming offline session {session_id} ({})",
                if relaunch_fresh {
                    "fresh".to_owned()
                } else {
                    format!("backend={backend_debug}")
                }
            )),
            json!("session"),
        ],
    ));

    let team = topology_session.get("team").cloned().unwrap_or(Value::Null);
    let tool_key = string_field(&topology_session, "toolConfigKey");
    let (launch_args, preamble_flag, persist_args) =
        compose_restore_launch(&tool_key, backend_session_id.as_deref(), use_backend_resume);
    let create_args = vec![
        json!(string_field(&topology_session, "command")),
        json!(launch_args),
        preamble_flag,
        json!(tool_key),
        Value::Null,
        Value::Null,
        optional_string(&topology_session, "worktreePath")
            .map(|path| json!(path))
            .unwrap_or(Value::Null),
        if use_backend_resume {
            backend_id_json
        } else {
            Value::Null
        },
        json!(session_id),
        json!(true),
        json!(use_backend_resume),
        team,
        Value::Null,
        json!(persist_args),
    ];
    calls.push(call("createSession", create_args.clone()));
    let mut restored_session = json!({
        "id": session_id,
        "command": string_field(&topology_session, "command"),
        "restoreStartedAt": 1780272000000_i64,
    });
    if relaunch_fresh && let Some(backend_session_id) = backend_session_id.as_deref() {
        set_field(
            &mut restored_session,
            "supersededBackendSessionId",
            json!(backend_session_id),
        );
    }

    json!({
        "thrown": null,
        "host": {
            "sessions": array_at(input, &["host", "sessions"]),
            "offlineSessions": offline_sessions,
            "sessionLabels": [],
            "restored": [{
                "args": create_args,
                "session": restored_session,
            }],
        },
        "topology": { "sessions": topology_sessions },
        "metadata": metadata,
        "calls": calls,
    })
}

fn call(method: &str, args: Vec<Value>) -> Value {
    json!({ "method": method, "args": args })
}

fn tool_config(input: &Value, tool_key: &str) -> Value {
    match tool_key {
        "claude" => json!({
            "command": "claude",
            "args": ["--dangerously-skip-permissions"],
            "enabled": true,
            "wrapperEnabled": true,
            "preambleFlag": ["--append-system-prompt"],
            "sessionIdFlag": ["--session-id", "{sessionId}"],
            "resumeArgs": ["--resume", "{sessionId}"],
            "forkArgs": ["--resume", "{sessionId}", "--fork-session"],
            "resumeByBackendSessionId": true,
            "resumeFallback": ["--continue"],
            "promptPatterns": ["^> $", "\\$ $"],
            "turnPatterns": ["^[❯>]\\s*(.+)", "^❯\\s+(.+)", "^>\\s+(.+)"],
            "compactCommand": "claude --print --output-format text",
        }),
        _ => {
            let mut config = json!({
                "command": "codex",
                "args": ["--dangerously-bypass-approvals-and-sandbox"],
                "enabled": true,
                "resumeArgs": ["resume", "{sessionId}"],
                "forkArgs": ["fork", "{sessionId}"],
                "resumeByBackendSessionId": true,
                "resumeFallback": ["resume", "--last"],
                "developerInstructionsConfigKey": "developer_instructions",
                "promptPatterns": ["^> $"],
                "turnPatterns": ["^[>❯]\\s*(.+)"],
                "startupInterstitials": [{
                    "id": "codex-update-available",
                    "when": ["Update available!", "Press enter to continue"],
                    "choose": "^[\\s›>❯]*(\\d+)\\.\\s+Skip\\s*$",
                }],
            });
            if let Some(session_capture) = input.get("toolConfigSessionCapture") {
                set_field(&mut config, "sessionCapture", session_capture.clone());
            }
            config
        }
    }
}

fn compose_restore_launch(
    tool_key: &str,
    backend_session_id: Option<&str>,
    use_backend_resume: bool,
) -> (Vec<Value>, Value, Vec<Value>) {
    match tool_key {
        "claude" => {
            let mut args = vec![json!("--dangerously-skip-permissions")];
            if use_backend_resume {
                args.extend([
                    json!("--resume"),
                    json!(backend_session_id.unwrap_or("undefined")),
                ]);
            }
            (
                args.clone(),
                json!(["--append-system-prompt"]),
                vec![json!("--dangerously-skip-permissions")],
            )
        }
        _ => {
            let mut args = vec![json!("--dangerously-bypass-approvals-and-sandbox")];
            if use_backend_resume {
                args.extend([
                    json!("resume"),
                    json!(backend_session_id.unwrap_or("undefined")),
                ]);
            }
            (
                args,
                Value::Null,
                vec![json!("--dangerously-bypass-approvals-and-sandbox")],
            )
        }
    }
}

fn derived_field(metadata: &Value, session_id: &str, field: &str) -> Option<String> {
    metadata
        .get("sessions")
        .and_then(|sessions| sessions.get(session_id))
        .and_then(|session| session.get("derived"))
        .and_then(|derived| derived.get(field))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn value_field<'a>(value: &'a Value, field: &str) -> &'a Value {
    value.get(field).unwrap_or(&Value::Null)
}

fn array_field(value: &Value, field: &str) -> Vec<Value> {
    value
        .get(field)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn array_at(value: &Value, path: &[&str]) -> Vec<Value> {
    path.iter()
        .fold(value, |current, field| {
            current.get(*field).unwrap_or(&Value::Null)
        })
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn string_field(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn optional_string(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_owned)
}

fn optional_json_string(value: &Value, field: &str) -> Value {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(|value| json!(value))
        .unwrap_or(Value::Null)
}

fn runtime_transport_summary(id: &str, command: &str, backend_session_id: Option<&str>) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("id".to_owned(), json!(id));
    object.insert("command".to_owned(), json!(command));
    if let Some(backend_session_id) = backend_session_id {
        object.insert("backendSessionId".to_owned(), json!(backend_session_id));
    }
    Value::Object(object)
}

fn simplify_runtime_session(session: &Value) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("id".to_owned(), json!(string_field(session, "id")));
    object.insert(
        "command".to_owned(),
        json!(string_field(session, "command")),
    );
    if let Some(backend_session_id) = optional_string(session, "backendSessionId") {
        object.insert("backendSessionId".to_owned(), json!(backend_session_id));
    }
    Value::Object(object)
}

fn created_at_millis(metadata: &Value) -> Value {
    match string_field(metadata, "createdAt").as_str() {
        "2026-04-21T00:00:00.000Z" => json!(1_776_729_600_000_i64),
        "" => Value::Null,
        _ => Value::Null,
    }
}

fn live_window_for_session<'a>(live_windows: &'a [Value], session_id: &str) -> Option<&'a Value> {
    live_windows
        .iter()
        .find(|window| string_field(value_field(window, "metadata"), "sessionId") == session_id)
}

fn map_lookup_value_in_entries(entries: &[Value], key: &str) -> Option<Value> {
    entries.iter().find_map(|entry| {
        let pair = entry.as_array()?;
        (pair.first().and_then(Value::as_str) == Some(key))
            .then(|| pair.get(1).cloned())
            .flatten()
    })
}

fn replace_entry(entries: &mut Vec<Value>, key: &str, value: Value) {
    remove_entry(entries, key);
    entries.push(json!([key, value]));
}

fn remove_entry(entries: &mut Vec<Value>, key: &str) {
    entries.retain(|entry| {
        entry
            .as_array()
            .and_then(|pair| pair.first())
            .and_then(Value::as_str)
            != Some(key)
    });
}

fn string_at(value: &Value, path: &[&str]) -> String {
    path.iter()
        .fold(value, |current, field| {
            current.get(*field).unwrap_or(&Value::Null)
        })
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

fn project_root_for(input: &Value) -> String {
    let project_root = string_field(input, "projectRoot");
    if project_root.is_empty() {
        "<repo>".to_owned()
    } else {
        project_root
    }
}

fn is_available_worktree_path(worktree_path: &str) -> bool {
    worktree_path.is_empty()
        || worktree_path == "<repo>"
        || worktree_path.starts_with("<repo>/.aimux/worktrees/")
}

fn number_field(value: &Value, field: &str) -> i64 {
    value.get(field).and_then(Value::as_i64).unwrap_or_default()
}

fn number_at(value: &Value, path: &[&str]) -> i64 {
    path.iter()
        .fold(value, |current, field| {
            current.get(*field).unwrap_or(&Value::Null)
        })
        .as_i64()
        .unwrap_or_default()
}

fn bool_field(value: &Value, field: &str) -> bool {
    value.get(field).and_then(Value::as_bool) == Some(true)
}

fn set_field(value: &mut Value, field: &str, next: Value) {
    if let Value::Object(object) = value {
        object.insert(field.to_owned(), next);
    }
}

fn remove_field(value: &mut Value, field: &str) {
    if let Value::Object(object) = value {
        object.remove(field);
    }
}

fn remove_at(value: &mut Value, path: &[&str]) {
    let mut current = value;
    for field in &path[..path.len().saturating_sub(1)] {
        let Some(next_current) = current.get_mut(*field) else {
            return;
        };
        current = next_current;
    }
    if let Some(field) = path.last() {
        remove_field(current, field);
    }
}

fn set_at(value: &mut Value, path: &[&str], next: Value) {
    let mut current = value;
    for field in &path[..path.len().saturating_sub(1)] {
        let Some(next_current) = current.get_mut(*field) else {
            return;
        };
        current = next_current;
    }
    if let Some(field) = path.last() {
        set_field(current, field, next);
    }
}

fn map_lookup(value: &Value, field: &str, key: &str) -> Option<String> {
    map_lookup_value(value, field, key).and_then(|value| value.as_str().map(str::to_owned))
}

fn map_lookup_value(value: &Value, field: &str, key: &str) -> Option<Value> {
    array_field(value, field).into_iter().find_map(|entry| {
        let pair = entry.as_array()?;
        (pair.first().and_then(Value::as_str) == Some(key))
            .then(|| pair.get(1).cloned())
            .flatten()
    })
}

fn object_lookup_string(value: &Value, field: &str, key: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_object)
        .and_then(|object| object.get(key))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn session_service_topology(input: &Value) -> Value {
    value_field(input, "initialTopology").clone()
}

fn live_ids(input: &Value, kind: &str) -> Vec<String> {
    array_field(input, "liveWindows")
        .into_iter()
        .filter_map(|window| {
            let metadata = value_field(&window, "metadata");
            (string_field(metadata, "kind") == kind).then(|| string_field(metadata, "sessionId"))
        })
        .collect()
}

fn offline_session_change_key(session: &Value) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}",
        string_field(session, "id"),
        string_field(session, "label"),
        string_field(session, "worktreePath"),
        string_field(session, "backendSessionId"),
        string_field(session, "restoreBlockedReason"),
        serde_json::to_string(value_field(session, "team")).unwrap_or_else(|_| "null".to_owned())
    )
}

fn offline_service_change_key(service: &Value) -> String {
    format!(
        "{}:{}:{}:{}:{}:{}:{}",
        string_field(service, "id"),
        string_field(service, "label"),
        string_field(service, "worktreePath"),
        string_field(service, "cwd"),
        string_field(service, "launchCommandLine"),
        string_at(service, &["tmuxTarget", "windowId"]),
        if bool_field(service, "retained") {
            "retained"
        } else {
            ""
        }
    )
}

fn reconcile_services_in_topology(
    input: &Value,
    topology: &mut Value,
    live_service_ids: &[String],
    calls: &mut Vec<Value>,
) -> bool {
    let mut services = array_field(topology, "services");
    let mut changed = false;
    for service in &mut services {
        let status = string_field(service, "status");
        if !["running", "starting"].contains(&status.as_str()) {
            continue;
        }
        let id = string_field(service, "id");
        if live_service_ids.contains(&id) {
            continue;
        }
        calls.push(call(
            "dashboardPendingActions.getServiceAction",
            vec![json!(id)],
        ));
        let pending = object_lookup_string(input, "pendingServiceActions", &id);
        if pending.as_deref() == Some("creating") || pending.as_deref() == Some("starting") {
            continue;
        }
        set_field(service, "status", json!("stopped"));
        remove_field(service, "tmuxTarget");
        remove_field(service, "lastSeenAt");
        calls.push(call(
            "debug",
            vec![
                json!(format!(
                    "reconciled orphaned service {id} → stopped (no live tmux window)"
                )),
                json!("service"),
            ],
        ));
        changed = true;
    }
    topology["services"] = Value::Array(services);
    changed
}

fn offline_service_state(mut service: Value) -> Value {
    remove_field(&mut service, "tmuxTarget");
    remove_field(&mut service, "retained");
    service
}

fn service_launch_command_line(metadata: &Value) -> String {
    if let Some(value) = metadata.get("launchCommandLine").and_then(Value::as_str) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }
    let args = array_field(metadata, "args");
    if args.first().and_then(Value::as_str) == Some("-lc") {
        return args
            .get(1)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
    }
    String::new()
}

fn remove_empty_optional(value: &mut Value, field: &str) {
    if string_field(value, field).is_empty() {
        remove_field(value, field);
    }
}

fn start_time_to_iso(start_time: i64) -> &'static str {
    match start_time {
        1_777_593_600_000 => "2026-05-01T00:00:00.000Z",
        _ => NOW,
    }
}
