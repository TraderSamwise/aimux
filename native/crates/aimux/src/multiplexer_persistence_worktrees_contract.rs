use serde_json::{json, Map, Value};

const NOW: &str = "2026-06-01T00:00:00.000Z";

pub fn run_multiplexer_persistence_worktrees_contract_case(api: &str, input: &Value) -> Value {
    let mut state = PersistenceWorktreeState::new(input);
    match api {
        "createDesktopWorktree" => state.create_desktop_worktree(),
        "removeDesktopWorktree" => state.remove_desktop_worktree(),
        "graveyardDesktopWorktree" => state.graveyard_desktop_worktree(),
        "resurrectGraveyardWorktree" => state.resurrect_graveyard_worktree(),
        "deleteGraveyardWorktree" => state.delete_graveyard_worktree(),
        api => panic!("unknown multiplexer persistence worktrees api: {api}"),
    }
}

#[derive(Debug)]
struct PersistenceWorktreeState<'a> {
    input: &'a Value,
    topology: Value,
    offline_sessions: Vec<Value>,
    offline_services: Vec<Value>,
    pending_worktree_create_paths: Vec<Value>,
    pending_worktree_removal_paths: Vec<Value>,
    dashboard_worktree_actions: Vec<Value>,
    footer_flash: Value,
    footer_flash_ticks: Value,
    operation_failures: Vec<Value>,
    calls: Vec<Value>,
}

impl<'a> PersistenceWorktreeState<'a> {
    fn new(input: &'a Value) -> Self {
        let topology = input
            .get("initialTopology")
            .cloned()
            .unwrap_or_else(empty_topology_snapshot);
        Self {
            input,
            topology,
            offline_sessions: array_field(input, "offlineSessions"),
            offline_services: array_field(input, "offlineServices"),
            pending_worktree_create_paths: Vec::new(),
            pending_worktree_removal_paths: Vec::new(),
            dashboard_worktree_actions: Vec::new(),
            footer_flash: Value::Null,
            footer_flash_ticks: Value::Null,
            operation_failures: Vec::new(),
            calls: Vec::new(),
        }
    }

    fn create_desktop_worktree(&mut self) -> Value {
        let project_root = string_field(self.input, "projectRoot");
        let name = string_field(self.input, "name");
        let path = string_field(self.input, "path");
        self.call("listDesktopWorktrees", vec![]);

        if array_field(self.input, "worktrees").iter().any(|worktree| {
            string_field(worktree, "path") == path
                && !bool_field(worktree, "pending")
                && worktree.get("operationFailure").is_none()
        }) {
            let message = format!("Worktree \"{name}\" already exists");
            self.record_operation_failure(
                "create",
                &format!("Failed to create worktree \"{name}\""),
                &message,
                &path,
                &name,
            );
            self.call(
                "publishAlert",
                vec![json!({
                    "kind": "task_failed",
                    "title": format!("Failed to create worktree \"{name}\""),
                    "message": message,
                    "worktreePath": path,
                    "dedupeKey": format!("dashboard-operation-failed:worktree:create:{path}:Worktree \"{name}\" already exists"),
                })],
            );
            self.refresh_dashboard_worktree_projection();
            return self.error(format!("Worktree \"{name}\" already exists"));
        }

        self.pending_worktree_create_paths.push(json!(path));
        let seed = json!({
            "name": name,
            "branch": name,
            "path": path,
            "createdAt": NOW,
            "status": "offline",
            "isBare": false,
            "sessions": [],
            "services": [],
        });
        self.set_worktree_action(&path, "creating", seed);
        replace_by_path(
            &mut self.topology["worktrees"],
            &path,
            json!({
                "id": stable_worktree_id(&path),
                "path": path,
                "name": name,
                "status": "creating",
                "branch": name,
                "createdAt": NOW,
            }),
        );
        self.call("invalidateDesktopStateSnapshot", vec![]);
        self.call("refreshLocalDashboardModel", vec![]);
        let immediate = json!({
            "host": self.host_snapshot(),
            "topology": self.topology,
        });

        replace_by_path(
            &mut self.topology["worktrees"],
            &path,
            json!({
                "id": stable_worktree_id(&path),
                "path": path,
                "name": name,
                "status": "active",
                "branch": name,
                "basePath": project_root,
                "createdAt": NOW,
            }),
        );
        self.footer_flash = json!(format!("Created: {name}"));
        self.footer_flash_ticks = json!(3);
        self.pending_worktree_create_paths.clear();
        self.clear_worktree_action(&path);
        self.call("invalidateDesktopStateSnapshot", vec![]);
        self.call("refreshLocalDashboardModel", vec![]);
        self.call("metadataServer.notifyChange", vec![]);

        json!({
            "ok": true,
            "returned": { "path": path, "status": "creating" },
            "immediate": immediate,
            "completion": { "ok": true, "returned": { "path": path, "status": "created" } },
            "host": self.host_snapshot(),
            "topology": self.topology,
            "operationFailures": self.operation_failures,
        })
    }

    fn remove_desktop_worktree(&mut self) -> Value {
        let project_root = string_field(self.input, "projectRoot");
        let path = string_field(self.input, "path");
        self.set_remove_pending(&path);
        self.call("syncSessionsFromTopology", vec![]);

        if !bool_field(self.input, "checkoutExists") {
            retain_not_path(&mut self.topology["worktrees"], &path);
            retain_not_path(&mut self.topology["sessions"], &path);
            retain_not_path(&mut self.topology["services"], &path);
            self.offline_sessions
                .retain(|session| string_field(session, "worktreePath") != path);
            self.offline_services
                .retain(|service| string_field(service, "worktreePath") != path);
            self.call("saveState", vec![]);
            self.finish_remove_success(&path);
            return self.ok(json!({ "path": path, "status": "removed" }));
        }

        self.call("listDesktopWorktrees", vec![]);
        let worktrees = array_field(self.input, "worktrees");
        let Some(matching) = worktrees
            .iter()
            .find(|worktree| string_field(worktree, "path") == path)
            .cloned()
        else {
            let message = format!("Worktree \"{path}\" not found");
            self.finish_remove_failure(&path, &message);
            return self.error(message);
        };
        if let Some(attached) = self.attached_live_session(&path) {
            let name = string_field(&matching, "name");
            let label = string_field(&attached, "label");
            let session_id = string_field(&attached, "id");
            let actor = if label.is_empty() { session_id } else { label };
            let message = format!("Cannot remove \"{name}\" while agent \"{actor}\" is attached");
            self.finish_remove_failure(&path, &message);
            return self.error(message);
        }

        replace_by_path(
            &mut self.topology["worktrees"],
            &path,
            json!({
                "id": stable_worktree_id(&path),
                "path": path,
                "name": string_field(&matching, "name"),
                "status": "removing",
                "branch": string_field(&matching, "branch"),
                "createdAt": optional_string(&matching, "createdAt").unwrap_or_else(|| NOW.to_owned()),
            }),
        );
        self.detach_worktree_services(&project_root, &path);
        self.offline_sessions
            .retain(|session| string_field(session, "worktreePath") != path);
        self.offline_services
            .retain(|service| string_field(service, "worktreePath") != path);
        retain_not_path(&mut self.topology["sessions"], &path);
        retain_not_path(&mut self.topology["services"], &path);
        retain_not_path(&mut self.topology["worktrees"], &path);
        self.call("saveState", vec![]);
        self.finish_remove_success(&path);
        self.ok(json!({ "path": path, "status": "removed" }))
    }

    fn graveyard_desktop_worktree(&mut self) -> Value {
        let project_root = string_field(self.input, "projectRoot");
        let path = string_field(self.input, "path");
        self.call("listDesktopWorktrees", vec![]);
        let worktrees = array_field(self.input, "worktrees");
        let Some(matching) = worktrees
            .iter()
            .find(|worktree| string_field(worktree, "path") == path)
            .cloned()
        else {
            return self.error(format!("Worktree \"{path}\" not found"));
        };
        if let Some(attached) = self.attached_live_session(&path) {
            let name = string_field(&matching, "name");
            let label = string_field(&attached, "label");
            let session_id = string_field(&attached, "id");
            return self.error(format!(
                "Cannot graveyard \"{name}\" while agent \"{}\" is attached",
                if label.is_empty() { session_id } else { label }
            ));
        }

        self.stop_worktree_services_for_graveyard(&project_root, &path);
        let worktree = json!({
            "id": stable_worktree_id(&path),
            "path": path,
            "name": string_field(&matching, "name"),
            "status": "graveyard",
            "branch": string_field(&matching, "branch"),
            "createdAt": optional_string(&matching, "createdAt").unwrap_or_else(|| NOW.to_owned()),
            "removedAt": NOW,
        });
        replace_by_path(&mut self.topology["worktrees"], &path, worktree);
        let graveyard_entry = json!({
            "id": stable_graveyard_id(&path),
            "worktreeId": stable_worktree_id(&path),
            "path": path,
            "name": string_field(&matching, "name"),
            "branch": string_field(&matching, "branch"),
            "graveyardedAt": NOW,
            "reason": "user-requested",
        });
        replace_by_path(
            &mut self.topology["visibleGraveyard"],
            &path,
            graveyard_entry.clone(),
        );
        replace_by_path(&mut self.topology["allGraveyard"], &path, graveyard_entry);
        self.call("saveState", vec![]);
        self.call("invalidateDesktopStateSnapshot", vec![]);
        self.call("refreshLocalDashboardModel", vec![]);
        self.call("metadataServer.notifyChange", vec![]);
        self.ok(json!({ "path": path, "status": "graveyarded" }))
    }

    fn resurrect_graveyard_worktree(&mut self) -> Value {
        let path = string_field(self.input, "path");
        if !bool_field(self.input, "checkoutExists") {
            return self.error(format!(
                "Cannot resurrect worktree \"{path}\" because the checkout is missing"
            ));
        }
        let Some(entry) = array_field(&self.topology, "visibleGraveyard")
            .into_iter()
            .find(|entry| string_field(entry, "path") == path)
        else {
            return self.error(format!("Graveyard worktree \"{path}\" not found"));
        };
        let worktree_id = optional_string(&entry, "worktreeId");
        let mut worktrees = array_field(&self.topology, "worktrees");
        if let Some(index) = worktrees.iter().position(|worktree| {
            optional_string(worktree, "id") == worktree_id
                || optional_string(worktree, "path").as_deref() == Some(path.as_str())
        }) {
            let mut worktree = worktrees.remove(index);
            set_string(&mut worktree, "path", &path);
            if worktree.get("name").is_none() {
                set_string(&mut worktree, "name", &string_field(&entry, "name"));
            }
            if worktree.get("branch").is_none() {
                set_string(&mut worktree, "branch", &string_field(&entry, "branch"));
            }
            set_string(&mut worktree, "status", "active");
            remove_key(&mut worktree, "removedAt");
            worktrees.push(worktree);
        } else {
            worktrees.push(json!({
                "id": stable_worktree_id(&path),
                "path": path,
                "name": string_field(&entry, "name"),
                "status": "active",
                "branch": string_field(&entry, "branch"),
                "createdAt": string_field(&entry, "graveyardedAt"),
            }));
        }
        self.topology["worktrees"] = Value::Array(worktrees);
        retain_not_path(&mut self.topology["visibleGraveyard"], &path);
        retain_not_path(&mut self.topology["allGraveyard"], &path);
        self.call("invalidateDesktopStateSnapshot", vec![]);
        self.call("refreshLocalDashboardModel", vec![]);
        self.call("metadataServer.notifyChange", vec![]);
        self.ok(json!({ "path": path, "status": "active" }))
    }

    fn delete_graveyard_worktree(&mut self) -> Value {
        let path = string_field(self.input, "path");
        if !array_field(&self.topology, "visibleGraveyard")
            .iter()
            .any(|entry| string_field(entry, "path") == path)
        {
            return self.error(format!("Graveyard worktree \"{path}\" not found"));
        }
        if bool_field(self.input, "checkoutExists") {
            return self.error("existing checkout deletion is outside this fixture".to_owned());
        }
        self.offline_sessions
            .retain(|session| string_field(session, "worktreePath") != path);
        self.offline_services
            .retain(|service| string_field(service, "worktreePath") != path);
        retain_not_path(&mut self.topology["worktrees"], &path);
        retain_not_path(&mut self.topology["sessions"], &path);
        retain_not_path(&mut self.topology["services"], &path);
        retain_not_path(&mut self.topology["visibleGraveyard"], &path);
        mark_graveyard_deleted(&mut self.topology["allGraveyard"], &path);
        self.call("saveState", vec![]);
        self.call("invalidateDesktopStateSnapshot", vec![]);
        self.call("refreshLocalDashboardModel", vec![]);
        self.call("metadataServer.notifyChange", vec![]);
        self.ok(json!({ "path": path, "status": "removed" }))
    }

    fn stop_worktree_services_for_graveyard(&mut self, project_root: &str, path: &str) {
        self.call(
            "tmuxRuntimeManager.listProjectManagedWindows",
            vec![json!(project_root)],
        );
        for window in array_field(self.input, "managedWindows") {
            let metadata = value_field(&window, "metadata");
            if string_field(metadata, "kind") != "service"
                || string_field(metadata, "worktreePath") != path
            {
                continue;
            }
            let service_id = string_field(metadata, "sessionId");
            self.call("noteLastUsedItem", vec![json!(service_id)]);
            self.call(
                "tmuxRuntimeManager.killWindow",
                vec![value_field(&window, "target").clone()],
            );
            let service_state = service_state_from_metadata(metadata, path);
            replace_by_id(
                &mut self.offline_services,
                &service_id,
                service_state.clone(),
            );
            let mut topology_service = service_state;
            set_string(&mut topology_service, "status", "stopped");
            replace_by_id_value(
                &mut self.topology["services"],
                &service_id,
                topology_service,
            );
        }
    }

    fn detach_worktree_services(&mut self, project_root: &str, path: &str) {
        self.call(
            "tmuxRuntimeManager.listProjectManagedWindows",
            vec![json!(project_root)],
        );
        for window in array_field(self.input, "managedWindows") {
            let metadata = value_field(&window, "metadata");
            if string_field(metadata, "kind") != "service"
                || string_field(metadata, "worktreePath") != path
            {
                continue;
            }
            let service_id = string_field(metadata, "sessionId");
            self.call("noteLastUsedItem", vec![json!(service_id)]);
            self.call(
                "tmuxRuntimeManager.killWindow",
                vec![value_field(&window, "target").clone()],
            );
        }
        self.offline_services
            .retain(|service| string_field(service, "worktreePath") != path);
        retain_not_path(&mut self.topology["services"], path);
    }

    fn attached_live_session(&mut self, path: &str) -> Option<Value> {
        let pairs = array_field(self.input, "sessionWorktreePaths");
        let live_ids = array_field(self.input, "liveSessionIds")
            .into_iter()
            .filter_map(|id| id.as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        for session in array_field(self.input, "sessions") {
            let session_id = string_field(&session, "id");
            let session_path_matches = pairs.iter().any(|pair| {
                pair.as_array().is_some_and(|pair| {
                    pair.first().and_then(Value::as_str) == Some(session_id.as_str())
                        && pair.get(1).and_then(Value::as_str) == Some(path)
                })
            });
            if !session_path_matches {
                continue;
            }
            self.call("isSessionRuntimeLive", vec![session.clone()]);
            if live_ids.contains(&session_id) {
                return Some(session);
            }
        }
        None
    }

    fn ok(&self, returned: Value) -> Value {
        json!({
            "ok": true,
            "returned": returned,
            "completion": Value::Null,
            "host": self.host_snapshot(),
            "topology": self.topology,
            "operationFailures": self.operation_failures,
        })
    }

    fn error(&self, error: String) -> Value {
        json!({
            "ok": false,
            "error": error,
            "host": self.host_snapshot(),
            "topology": self.topology,
            "operationFailures": self.operation_failures,
        })
    }

    fn host_snapshot(&self) -> Value {
        json!({
            "offlineSessions": self.offline_sessions,
            "offlineServices": self.offline_services,
            "footerFlash": self.footer_flash,
            "footerFlashTicks": self.footer_flash_ticks,
            "pendingWorktreeCreatePaths": self.pending_worktree_create_paths,
            "pendingWorktreeRemovalPaths": self.pending_worktree_removal_paths,
            "dashboardWorktreeActions": self.dashboard_worktree_actions,
            "calls": self.calls,
        })
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }

    fn set_worktree_action(&mut self, path: &str, kind: &str, worktree_seed: Value) {
        let entry = json!({
            "path": path,
            "kind": kind,
            "timeoutMs": 180000,
            "worktreeSeed": worktree_seed,
        });
        self.dashboard_worktree_actions.push(entry);
        self.call(
            "dashboardPendingActions.setWorktreeAction",
            vec![
                json!(path),
                json!(kind),
                json!({ "worktreeSeed": worktree_seed, "timeoutMs": 180000 }),
            ],
        );
    }

    fn clear_worktree_action(&mut self, path: &str) {
        self.dashboard_worktree_actions
            .retain(|entry| string_field(entry, "path") != path);
        self.call(
            "dashboardPendingActions.clearWorktreeAction",
            vec![json!(path)],
        );
    }

    fn set_remove_pending(&mut self, path: &str) {
        self.call("listDesktopWorktrees", vec![]);
        let worktree_seed = array_field(self.input, "worktrees")
            .into_iter()
            .find(|worktree| string_field(worktree, "path") == path)
            .map(|worktree| {
                json!({
                    "name": string_field(&worktree, "name"),
                    "branch": string_field(&worktree, "branch"),
                    "path": path,
                    "createdAt": string_field(&worktree, "createdAt"),
                    "status": "offline",
                    "sessions": [],
                    "services": [],
                })
            });
        self.pending_worktree_removal_paths.push(json!(path));
        self.set_worktree_action(path, "removing", worktree_seed.unwrap_or(Value::Null));
        self.refresh_dashboard_worktree_projection();
    }

    fn refresh_dashboard_worktree_projection(&mut self) {
        self.call("invalidateDesktopStateSnapshot", vec![]);
        self.call("refreshLocalDashboardModel", vec![]);
        self.call("metadataServer.notifyChange", vec![]);
    }

    fn finish_remove_success(&mut self, path: &str) {
        self.pending_worktree_removal_paths
            .retain(|existing| existing.as_str() != Some(path));
        self.clear_worktree_action(path);
        self.refresh_dashboard_worktree_projection();
    }

    fn finish_remove_failure(&mut self, path: &str, message: &str) {
        let name = path.rsplit('/').next().unwrap_or(path);
        self.record_operation_failure(
            "remove",
            &format!("Failed to remove worktree \"{name}\""),
            message,
            path,
            name,
        );
        self.footer_flash = json!(format!("Failed: {message}"));
        self.footer_flash_ticks = json!(5);
        self.call(
            "publishAlert",
            vec![json!({
                "kind": "task_failed",
                "title": format!("Failed to remove worktree \"{name}\""),
                "message": message,
                "worktreePath": path,
                "dedupeKey": format!("dashboard-operation-failed:worktree:remove:{path}:{message}"),
            })],
        );
        self.pending_worktree_removal_paths
            .retain(|existing| existing.as_str() != Some(path));
        self.clear_worktree_action(path);
        self.refresh_dashboard_worktree_projection();
    }

    fn record_operation_failure(
        &mut self,
        operation: &str,
        title: &str,
        message: &str,
        worktree_path: &str,
        worktree_name: &str,
    ) {
        self.operation_failures.push(json!({
            "id": format!("<operation-failure-id:{}>", self.operation_failures.len() + 1),
            "targetKind": "worktree",
            "operation": operation,
            "title": title,
            "message": message,
            "worktreePath": worktree_path,
            "worktreeName": worktree_name,
            "createdAt": NOW,
        }));
    }
}

fn service_state_from_metadata(metadata: &Value, path: &str) -> Value {
    let mut service = Map::new();
    service.insert("id".into(), json!(string_field(metadata, "sessionId")));
    for key in ["command", "args", "launchCommandLine", "label", "createdAt"] {
        if let Some(value) = metadata.get(key) {
            service.insert(key.into(), value.clone());
        }
    }
    service.insert("worktreePath".into(), json!(path));
    service.insert("cwd".into(), json!(path));
    Value::Object(service)
}

fn empty_topology_snapshot() -> Value {
    json!({
        "worktrees": [],
        "visibleGraveyard": [],
        "allGraveyard": [],
        "sessions": [],
        "services": [],
    })
}

fn array_field(value: &Value, field: &str) -> Vec<Value> {
    value
        .get(field)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn value_field<'a>(value: &'a Value, field: &str) -> &'a Value {
    value.get(field).unwrap_or(&Value::Null)
}

fn optional_string(value: &Value, field: &str) -> Option<String> {
    value.get(field).and_then(Value::as_str).map(str::to_owned)
}

fn string_field(value: &Value, field: &str) -> String {
    optional_string(value, field).unwrap_or_default()
}

fn bool_field(value: &Value, field: &str) -> bool {
    value.get(field).and_then(Value::as_bool) == Some(true)
}

fn set_string(value: &mut Value, field: &str, next: &str) {
    if let Value::Object(object) = value {
        object.insert(field.to_owned(), json!(next));
    }
}

fn remove_key(value: &mut Value, field: &str) {
    if let Value::Object(object) = value {
        object.remove(field);
    }
}

fn replace_by_path(array: &mut Value, path: &str, next: Value) {
    let mut rows = array.as_array().cloned().unwrap_or_default();
    rows.retain(|row| string_field(row, "path") != path);
    rows.push(next);
    *array = Value::Array(rows);
}

fn replace_by_id(items: &mut Vec<Value>, id: &str, next: Value) {
    items.retain(|row| string_field(row, "id") != id);
    items.push(next);
}

fn replace_by_id_value(array: &mut Value, id: &str, next: Value) {
    let mut rows = array.as_array().cloned().unwrap_or_default();
    rows.retain(|row| string_field(row, "id") != id);
    rows.push(next);
    *array = Value::Array(rows);
}

fn retain_not_path(array: &mut Value, path: &str) {
    let rows = array
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|row| {
            string_field(row, "path") != path && string_field(row, "worktreePath") != path
        })
        .collect::<Vec<_>>();
    *array = Value::Array(rows);
}

fn mark_graveyard_deleted(array: &mut Value, path: &str) {
    if let Some(rows) = array.as_array_mut() {
        for row in rows {
            if string_field(row, "path") == path {
                set_string(row, "deletedAt", NOW);
            }
        }
    }
}

fn stable_worktree_id(path: &str) -> String {
    format!("<worktree-id:{path}>")
}

fn stable_graveyard_id(path: &str) -> String {
    format!("<worktree-graveyard-id:{path}>")
}
