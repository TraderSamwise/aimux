use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

const NOW: &str = "2026-06-01T00:00:00.000Z";
const NOW_MS: i64 = 1_780_272_000_000;

pub fn run_multiplexer_worktrees_settlement_contract_case(input: &Value) -> Value {
    let mut host = SettlementHost::new(input);
    match str_field(input, "api").as_str() {
        "handleWorktreeInputKey" => host.handle_worktree_input_key(&str_field(input, "data")),
        "beginWorktreeRemoval" => {
            let name = if input.get("worktreeName").is_some() {
                str_field(input, "worktreeName")
            } else {
                str_field(input, "name")
            };
            host.begin_worktree_removal(
                &str_field(input, "path"),
                &name,
                int_field(input, "oldIdx"),
            );
        }
        "beginWorktreeRemovals" => {
            for removal in array_field(input, "removals").unwrap_or_default() {
                let name = if removal.get("worktreeName").is_some() {
                    str_field(&removal, "worktreeName")
                } else {
                    str_field(&removal, "name")
                };
                host.begin_worktree_removal(
                    &str_field(&removal, "path"),
                    &name,
                    int_field(&removal, "oldIdx"),
                );
            }
        }
        "handleWorktreeRemoveConfirmKey" => {
            host.handle_worktree_remove_confirm_key(&str_field(input, "data"))
        }
        api => panic!("unknown worktrees settlement contract api: {api}"),
    }
    if let Some(after) = input.get("afterInvoke") {
        host.apply_after_invoke(after);
    }
    for action in array_field(input, "afterInvokeActions").unwrap_or_default() {
        host.apply_after_invoke_action(&action);
    }
    host.flush(int_field(input, "flushTurns").max(0));
    host.snapshot()
}

#[derive(Debug)]
struct PendingEntry {
    value: Option<String>,
    token: Option<i64>,
    seed: Option<Value>,
}

#[derive(Debug)]
struct SettlementHost {
    mode: String,
    dashboard_input_epoch: i64,
    worktree_input_buffer: String,
    worktree_remove_confirm: Value,
    worktree_removal_job: Value,
    worktree_removal_jobs: BTreeMap<String, Value>,
    dashboard_state: Value,
    dashboard_raw_worktree_groups_cache: Vec<Value>,
    dashboard_worktree_groups_cache: Vec<Value>,
    dashboard_operation_failures_cache: Vec<Value>,
    footer_flash: Value,
    footer_flash_ticks: Value,
    pending: BTreeMap<String, PendingEntry>,
    next_token: i64,
    post_steps: Vec<Value>,
    refresh_steps: Vec<Value>,
    calls: Map<String, Value>,
    pending_async: Vec<PendingAsync>,
    wait_ms: i64,
}

#[derive(Debug)]
enum PendingAsync {
    Create {
        name: String,
        path: String,
        token: i64,
        lifecycle_epoch: i64,
        status: AsyncStatus,
    },
    Remove {
        path: String,
        name: String,
        token: i64,
        status: AsyncStatus,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum AsyncStatus {
    Posted,
    PostFailed(String),
}

impl SettlementHost {
    fn new(input: &Value) -> Self {
        let host = input.get("host").unwrap_or(&Value::Null);
        let raw = array_field(host, "dashboardRawWorktreeGroupsCache").unwrap_or_else(|| {
            array_field(host, "dashboardWorktreeGroupsCache").unwrap_or_default()
        });
        let mut state = Self {
            mode: str_field_default(host, "mode", "dashboard"),
            dashboard_input_epoch: int_field(host, "dashboardInputEpoch"),
            worktree_input_buffer: str_field(host, "worktreeInputBuffer"),
            worktree_remove_confirm: host
                .get("worktreeRemoveConfirm")
                .cloned()
                .unwrap_or(Value::Null),
            worktree_removal_job: Value::Null,
            worktree_removal_jobs: BTreeMap::new(),
            dashboard_state: host
                .get("dashboardState")
                .cloned()
                .unwrap_or_else(|| json!({ "worktreeNavOrder": [], "focusedWorktreePath": null })),
            dashboard_raw_worktree_groups_cache: raw,
            dashboard_worktree_groups_cache: Vec::new(),
            dashboard_operation_failures_cache: array_field(
                host,
                "dashboardOperationFailuresCache",
            )
            .unwrap_or_default(),
            footer_flash: Value::Null,
            footer_flash_ticks: Value::Null,
            pending: BTreeMap::new(),
            next_token: 0,
            post_steps: array_field(host, "postSteps")
                .unwrap_or_else(|| vec![json!({ "type": "resolve" })]),
            refresh_steps: array_field(host, "refreshSteps").unwrap_or_default(),
            calls: empty_calls(),
            pending_async: Vec::new(),
            wait_ms: int_field(input, "waitMs"),
        };
        if let Some(jobs) = array_field(host, "worktreeRemovalJobs") {
            for job in jobs {
                let path = str_field(&job, "path");
                state.worktree_removal_jobs.insert(path, job);
            }
        }
        state.set_current_worktree_removal_job();
        state.recompute_worktrees();
        state
    }

    fn handle_worktree_input_key(&mut self, data: &str) {
        let mut text = String::new();
        for ch in data.chars() {
            if matches!(ch, '\r' | '\n') {
                if !text.is_empty() {
                    self.worktree_input_buffer.push_str(&text);
                    self.call("redrawDashboardWithOverlay", vec![]);
                    text.clear();
                }
                self.create_worktree_from_input();
                return;
            }
            if !ch.is_control() {
                text.push(ch);
            }
        }
        if !text.is_empty() {
            self.worktree_input_buffer.push_str(&text);
            self.call("redrawDashboardWithOverlay", vec![]);
        }
    }

    fn create_worktree_from_input(&mut self) {
        self.call("clearDashboardOverlay", vec![]);
        let name = self.worktree_input_buffer.trim().to_owned();
        if name.is_empty() {
            self.call("restoreDashboardAfterOverlayDismiss", vec![]);
            return;
        }
        let path = format!("/repo/.aimux/worktrees/{name}");
        let token = self.set_worktree_action(
            &path,
            "creating",
            json!({
                "worktreeSeed": {
                    "name": name,
                    "branch": name,
                    "path": path,
                    "createdAt": NOW,
                    "status": "offline",
                    "isBare": false,
                    "sessions": [],
                    "services": [],
                }
            }),
        );
        self.reapply_pending();
        set_field(
            &mut self.dashboard_state,
            "focusedWorktreePath",
            json!(path),
        );
        self.call("dashboardUiStateStoreMarkSelectionDirty", vec![]);
        self.set_nav_order_from_groups();
        let lifecycle_epoch = self.dashboard_input_epoch;
        self.call("renderDashboard", vec![]);
        self.call(
            "postToProjectService",
            vec![
                json!("/worktrees/create"),
                json!({ "name": name }),
                json!({ "timeoutMs": 180000 }),
            ],
        );
        let status = match self.next_post_step() {
            Some(error) => AsyncStatus::PostFailed(error),
            None => AsyncStatus::Posted,
        };
        self.pending_async.push(PendingAsync::Create {
            name,
            path,
            token,
            lifecycle_epoch,
            status,
        });
    }

    fn handle_worktree_remove_confirm_key(&mut self, data: &str) {
        if !(data.contains('\r') || data.contains('\n')) || self.worktree_remove_confirm.is_null() {
            return;
        }
        let confirm = std::mem::replace(&mut self.worktree_remove_confirm, Value::Null);
        self.call("clearDashboardOverlay", vec![]);
        let path = str_field(&confirm, "path");
        let name = str_field(&confirm, "name");
        let old_idx = nav_index(&self.dashboard_state, &path);
        self.begin_worktree_removal(&path, &name, old_idx);
    }

    fn begin_worktree_removal(&mut self, path: &str, name: &str, old_idx: i64) {
        let job = json!({
            "path": path,
            "name": name,
            "startedAt": NOW_MS,
            "oldIdx": old_idx,
            "stderr": "",
        });
        self.worktree_removal_jobs.insert(path.to_owned(), job);
        self.set_current_worktree_removal_job();
        let seed = self
            .dashboard_worktree_groups_cache
            .iter()
            .find(|group| str_field(group, "path") == path)
            .cloned()
            .unwrap_or_else(|| json!({ "path": path, "name": name }));
        let token = self.set_worktree_action(path, "graveyarding", json!({ "worktreeSeed": seed }));
        self.reapply_pending();
        self.call("renderDashboard", vec![]);
        self.call(
            "postToProjectService",
            vec![
                json!("/worktrees/graveyard"),
                json!({ "path": path }),
                json!({ "timeoutMs": 180000 }),
            ],
        );
        let status = match self.next_post_step() {
            Some(error) => AsyncStatus::PostFailed(error),
            None => AsyncStatus::Posted,
        };
        self.pending_async.push(PendingAsync::Remove {
            path: path.to_owned(),
            name: name.to_owned(),
            token,
            status,
        });
    }

    fn flush(&mut self, requested_turns: i64) {
        let turns = if requested_turns == 0 {
            100
        } else {
            requested_turns
        };
        for _ in 0..turns {
            if self.pending_async.is_empty() {
                return;
            };
            let task = self.pending_async.remove(0);
            match task {
                PendingAsync::Create {
                    name,
                    path,
                    token,
                    lifecycle_epoch,
                    status,
                } => self.flush_create(name, path, token, lifecycle_epoch, status, turns),
                PendingAsync::Remove {
                    path,
                    name,
                    token,
                    status,
                } => self.flush_remove(path, name, token, status, turns),
            }
        }
    }

    fn flush_create(
        &mut self,
        name: String,
        path: String,
        token: i64,
        lifecycle_epoch: i64,
        status: AsyncStatus,
        turns: i64,
    ) {
        match status {
            AsyncStatus::Posted => {
                let mut refreshed = self.refresh_dashboard_model();
                let mut saw_unavailable_refresh = !refreshed;
                if turns <= 1 {
                    self.reapply_pending();
                    self.call("renderDashboard", vec![]);
                    return;
                }
                if self.has_create_failure(&path) {
                    self.footer_flash = json!("worktree creating is still settling");
                    self.footer_flash_ticks = json!(4);
                    self.call("renderDashboard", vec![]);
                    self.call(
                        "dashboardPendingActionsGetWorktreeAction",
                        vec![json!(path)],
                    );
                    if !self.clear_worktree_action_if_token(&path, token) {
                        return;
                    }
                    self.call("dashboardUiStateStoreMarkSelectionDirty", vec![]);
                    self.call(
                        "showDashboardError",
                        vec![
                            json!(format!("Failed to create \"{name}\"")),
                            json!([format!("Path: {path}"), "Error: branch already exists"]),
                        ],
                    );
                    return;
                }
                while !self.has_rendered_real_worktree(&path) && self.wait_ms > 0 {
                    if refreshed
                        && self.mode == "dashboard"
                        && self.dashboard_input_epoch == lifecycle_epoch
                    {
                        self.reapply_pending();
                        self.call("renderDashboard", vec![]);
                    }
                    if self.refresh_steps.is_empty() {
                        break;
                    }
                    refreshed = self.refresh_dashboard_model();
                    saw_unavailable_refresh = saw_unavailable_refresh || !refreshed;
                    if self.has_create_failure(&path) {
                        break;
                    }
                }
                if self.has_create_failure(&path) {
                    if saw_unavailable_refresh {
                        self.footer_flash = json!("worktree creating is still settling");
                        self.footer_flash_ticks = json!(4);
                        self.call("renderDashboard", vec![]);
                        self.reapply_pending();
                        self.call("renderDashboard", vec![]);
                        self.call(
                            "dashboardPendingActionsGetWorktreeAction",
                            vec![json!(path)],
                        );
                        return;
                    }
                    self.footer_flash = json!("worktree creating is still settling");
                    self.footer_flash_ticks = json!(4);
                    self.call("renderDashboard", vec![]);
                    self.call(
                        "dashboardPendingActionsGetWorktreeAction",
                        vec![json!(path)],
                    );
                    if !self.clear_worktree_action_if_token(&path, token) {
                        return;
                    }
                    self.call("dashboardUiStateStoreMarkSelectionDirty", vec![]);
                    self.call(
                        "showDashboardError",
                        vec![
                            json!(format!("Failed to create \"{name}\"")),
                            json!([format!("Path: {path}"), "Error: branch already exists"]),
                        ],
                    );
                    return;
                }
                if !self.has_rendered_real_worktree(&path) {
                    if self.mode == "dashboard"
                        && self.dashboard_input_epoch == lifecycle_epoch
                        && refreshed
                    {
                        self.reapply_pending();
                        self.call("renderDashboard", vec![]);
                    }
                    return;
                }
                self.clear_worktree_action_if_token(&path, token);
                self.refresh_dashboard_model();
                if self.mode == "dashboard" && self.dashboard_input_epoch == lifecycle_epoch {
                    set_field(
                        &mut self.dashboard_state,
                        "focusedWorktreePath",
                        json!(path),
                    );
                    self.call("dashboardUiStateStoreMarkSelectionDirty", vec![]);
                    self.call("renderDashboard", vec![]);
                }
            }
            AsyncStatus::PostFailed(message) => {
                if !self.clear_worktree_action_if_token(&path, token) {
                    return;
                }
                self.refresh_dashboard_model();
                if self.dashboard_input_epoch != lifecycle_epoch {
                    return;
                }
                if self.has_create_failure(&path) {
                    set_field(
                        &mut self.dashboard_state,
                        "focusedWorktreePath",
                        json!(path),
                    );
                    self.call("dashboardUiStateStoreMarkSelectionDirty", vec![]);
                    self.call(
                        "showDashboardError",
                        vec![
                            json!(format!("Failed to create \"{name}\"")),
                            json!([format!("Path: {path}"), format!("Error: {message}")]),
                        ],
                    );
                }
            }
        }
    }

    fn flush_remove(
        &mut self,
        path: String,
        name: String,
        token: i64,
        status: AsyncStatus,
        _turns: i64,
    ) {
        match status {
            AsyncStatus::Posted => {
                let mut polls = 0;
                loop {
                    self.refresh_dashboard_model();
                    polls += 1;
                    if !self.raw_has_worktree(&path) {
                        if self.mode != "dashboard" && self.wait_ms > 0 {
                            self.call(
                                "dashboardPendingActionsGetWorktreeAction",
                                vec![json!(path)],
                            );
                        }
                        self.clear_worktree_action_if_token(&path, token);
                        if self.mode == "dashboard" {
                            self.finish_worktree_removal_success(&path, &name);
                        } else {
                            self.worktree_removal_jobs.remove(&path);
                            self.set_current_worktree_removal_job();
                            self.set_nav_order_from_groups();
                        }
                        break;
                    }
                    if self.mode != "dashboard" && self.wait_ms > 0 && polls >= 2 {
                        self.worktree_removal_jobs.remove(&path);
                        self.set_current_worktree_removal_job();
                        self.call(
                            "dashboardPendingActionsGetWorktreeAction",
                            vec![json!(path)],
                        );
                        break;
                    }
                    if self.refresh_steps.is_empty() || self.wait_ms <= 0 {
                        if self.mode != "dashboard" {
                            self.call(
                                "dashboardPendingActionsGetWorktreeAction",
                                vec![json!(path)],
                            );
                        }
                        break;
                    }
                }
            }
            AsyncStatus::PostFailed(message) => {
                self.clear_worktree_action_if_token(&path, token);
                if let Some(job) = self.worktree_removal_jobs.get_mut(&path)
                    && let Value::Object(object) = job
                {
                    object.insert("stderr".to_owned(), json!(format!("\n{message}")));
                }
                self.finish_worktree_removal(&path, &name, &message);
            }
        }
    }

    fn finish_worktree_removal_success(&mut self, path: &str, name: &str) {
        let old_idx = self
            .worktree_removal_jobs
            .get(path)
            .and_then(|job| job.get("oldIdx"))
            .and_then(Value::as_i64)
            .unwrap_or(-1);
        self.worktree_removal_jobs.remove(path);
        self.set_current_worktree_removal_job();
        self.footer_flash = json!(format!("Graveyarded: {name}"));
        self.footer_flash_ticks = json!(3);
        self.set_nav_order_from_groups();
        if let Some(object) = self.dashboard_state.as_object_mut()
            && object
                .get("focusedWorktreePath")
                .and_then(Value::as_str)
                .is_none_or(|focused| focused == path)
        {
            let next_focus = self
                .dashboard_worktree_groups_cache
                .get(old_idx.max(0) as usize)
                .or_else(|| self.dashboard_worktree_groups_cache.last())
                .and_then(|group| group.get("path"))
                .cloned();
            if let Some(next_focus) = next_focus {
                object.insert("focusedWorktreePath".to_owned(), next_focus);
            } else {
                object.remove("focusedWorktreePath");
            }
        }
        self.call("renderDashboard", vec![]);
    }

    fn finish_worktree_removal(&mut self, path: &str, name: &str, message: &str) {
        self.worktree_removal_jobs.remove(path);
        self.set_current_worktree_removal_job();
        self.footer_flash = json!(format!("Failed: {message}"));
        self.footer_flash_ticks = json!(5);
        self.call(
            "showDashboardError",
            vec![
                json!(format!("Failed to graveyard \"{name}\"")),
                json!([
                    format!("Path: {path}"),
                    format!("Error: {message}"),
                    message
                ]),
            ],
        );
        self.call("renderDashboard", vec![]);
    }

    fn apply_after_invoke(&mut self, after: &Value) {
        if let Some(epoch) = after.get("dashboardInputEpoch").and_then(Value::as_i64) {
            self.dashboard_input_epoch = epoch;
        }
        if let Some(mode) = after.get("mode").and_then(Value::as_str) {
            self.mode = mode.to_owned();
        }
    }

    fn apply_after_invoke_action(&mut self, action: &Value) {
        match str_field(action, "type").as_str() {
            "setHostField" => match str_field(action, "field").as_str() {
                "mode" => self.mode = str_field(action, "value"),
                "dashboardInputEpoch" => {
                    self.dashboard_input_epoch = action
                        .get("value")
                        .and_then(Value::as_i64)
                        .unwrap_or_default();
                }
                field => panic!("unknown worktree afterInvoke host field: {field}"),
            },
            "setFocusedWorktreePath" => set_field(
                &mut self.dashboard_state,
                "focusedWorktreePath",
                json!(str_field(action, "path")),
            ),
            "setPendingWorktreeAction" => {
                self.set_worktree_action(
                    &str_field(action, "path"),
                    &str_field(action, "value"),
                    json!({}),
                );
            }
            kind => panic!("unknown worktree afterInvoke action: {kind}"),
        }
    }

    fn refresh_dashboard_model(&mut self) -> bool {
        self.call(
            "refreshDashboardModelFromService",
            vec![json!(true), json!({ "allowInactive": true })],
        );
        let Some(step) = self.refresh_steps.first().cloned() else {
            return true;
        };
        self.refresh_steps.remove(0);
        if let Some(worktrees) = array_field(&step, "worktrees") {
            self.dashboard_raw_worktree_groups_cache = worktrees;
            self.recompute_worktrees();
        }
        step.get("result").and_then(Value::as_bool).unwrap_or(true)
    }

    fn set_worktree_action(&mut self, path: &str, kind: &str, opts: Value) -> i64 {
        self.next_token += 1;
        self.call(
            "dashboardPendingActionsSetWorktreeAction",
            vec![json!(path), json!(kind), opts.clone()],
        );
        let key = format!("worktree:{path}");
        let seed = opts
            .get("worktreeSeed")
            .cloned()
            .or_else(|| self.pending.get(&key).and_then(|entry| entry.seed.clone()));
        self.pending.insert(
            key,
            PendingEntry {
                value: Some(kind.to_owned()),
                token: Some(self.next_token),
                seed,
            },
        );
        self.next_token
    }

    fn clear_worktree_action_if_token(&mut self, path: &str, token: i64) -> bool {
        self.call(
            "dashboardPendingActionsClearWorktreeActionIfToken",
            vec![json!(path), json!(token)],
        );
        if let Some(entry) = self.pending.get_mut(&format!("worktree:{path}"))
            && entry.token == Some(token)
        {
            entry.value = None;
            entry.token = None;
            entry.seed = None;
            self.reapply_pending();
            return true;
        }
        false
    }

    fn reapply_pending(&mut self) {
        self.call("reapplyDashboardPendingActions", vec![]);
        self.recompute_worktrees();
    }

    fn recompute_worktrees(&mut self) {
        let mut seen = Vec::new();
        let mut groups = Vec::new();
        for item in &self.dashboard_raw_worktree_groups_cache {
            let mut item = item.clone();
            let path = item.get("path").and_then(Value::as_str).unwrap_or_default();
            seen.push(pending_key(path));
            if let Some(entry) = self.pending_for_path(path)
                && let Some(kind) = &entry.value
                && let Value::Object(object) = &mut item
            {
                object.insert("pending".to_owned(), json!(true));
                object.insert("pendingAction".to_owned(), json!(kind));
                object.insert("optimistic".to_owned(), json!(true));
            }
            groups.push(item);
        }
        for (key, entry) in &self.pending {
            if entry.value.is_none() || seen.contains(key) {
                continue;
            }
            if let Some(mut seed) = entry.seed.clone() {
                if let Value::Object(object) = &mut seed {
                    object.insert("pending".to_owned(), json!(true));
                    object.insert(
                        "pendingAction".to_owned(),
                        json!(entry.value.as_ref().unwrap()),
                    );
                    object.insert("optimistic".to_owned(), json!(true));
                }
                groups.push(seed);
            }
        }
        groups.sort_by_key(|group| std::cmp::Reverse(worktree_sort_key(group)));
        self.dashboard_worktree_groups_cache = groups;
        self.set_nav_order_from_groups();
    }

    fn set_nav_order_from_groups(&mut self) {
        let order = self
            .dashboard_worktree_groups_cache
            .iter()
            .map(|group| group.get("path").cloned().unwrap_or(Value::Null))
            .collect::<Vec<_>>();
        set_field(
            &mut self.dashboard_state,
            "worktreeNavOrder",
            Value::Array(order),
        );
    }

    fn has_create_failure(&self, path: &str) -> bool {
        self.dashboard_worktree_groups_cache.iter().any(|group| {
            same_worktree_path(&str_field(group, "path"), path)
                && group.get("operationFailure").is_some()
        }) || self
            .dashboard_operation_failures_cache
            .iter()
            .any(|failure| {
                str_field(failure, "targetKind") == "worktree"
                    && str_field(failure, "operation") == "create"
                    && same_worktree_path(&str_field(failure, "worktreePath"), path)
            })
    }

    fn has_rendered_real_worktree(&self, path: &str) -> bool {
        self.dashboard_raw_worktree_groups_cache
            .iter()
            .any(|group| {
                same_worktree_path(&str_field(group, "path"), path)
                    && !group
                        .get("pending")
                        .and_then(Value::as_bool)
                        .unwrap_or_default()
            })
    }

    fn pending_for_path(&self, path: &str) -> Option<&PendingEntry> {
        self.pending
            .iter()
            .find(|(key, _entry)| {
                key.strip_prefix("worktree:")
                    .is_some_and(|pending_path| same_worktree_path(pending_path, path))
            })
            .map(|(_key, entry)| entry)
    }

    fn raw_has_worktree(&self, path: &str) -> bool {
        self.dashboard_raw_worktree_groups_cache
            .iter()
            .any(|group| str_field(group, "path") == path)
    }

    fn next_post_step(&mut self) -> Option<String> {
        let step = if self.post_steps.is_empty() {
            json!({ "type": "resolve" })
        } else {
            self.post_steps.remove(0)
        };
        (str_field(&step, "type") == "reject").then(|| str_field(&step, "message"))
    }

    fn set_current_worktree_removal_job(&mut self) {
        self.worktree_removal_job = self
            .worktree_removal_jobs
            .values()
            .last()
            .cloned()
            .unwrap_or(Value::Null);
    }

    fn snapshot(&self) -> Value {
        json!({
            "mode": self.mode,
            "dashboardInputEpoch": self.dashboard_input_epoch,
            "worktreeInputBuffer": self.worktree_input_buffer,
            "worktreeRemoveConfirm": self.worktree_remove_confirm,
            "worktreeRemovalJob": self.worktree_removal_job,
            "worktreeRemovalJobs": self.worktree_removal_jobs.values().cloned().collect::<Vec<_>>(),
            "dashboardState": self.dashboard_state,
            "dashboardRawWorktreeGroupsCache": self.dashboard_raw_worktree_groups_cache,
            "dashboardWorktreeGroupsCache": self.dashboard_worktree_groups_cache,
            "dashboardOperationFailuresCache": self.dashboard_operation_failures_cache,
            "footerFlash": self.footer_flash,
            "footerFlashTicks": self.footer_flash_ticks,
            "pendingActions": self.pending.iter().map(|(key, entry)| {
                json!({ "key": key, "value": entry.value })
            }).collect::<Vec<_>>(),
            "calls": self.calls,
        })
    }

    fn call(&mut self, name: &str, args: Vec<Value>) {
        self.calls
            .entry(name.to_owned())
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .expect("call log entries stay arrays")
            .push(Value::Array(args));
    }
}

fn empty_calls() -> Map<String, Value> {
    [
        "clearDashboardOverlay",
        "restoreDashboardAfterOverlayDismiss",
        "renderDashboard",
        "redrawDashboardWithOverlay",
        "showDashboardError",
        "refreshDashboardModelFromService",
        "postToProjectService",
        "reapplyDashboardPendingActions",
        "dashboardUiStateStoreMarkSelectionDirty",
        "dashboardPendingActionsSetWorktreeAction",
        "dashboardPendingActionsClearWorktreeAction",
        "dashboardPendingActionsClearWorktreeActionIfToken",
        "dashboardPendingActionsGetWorktreeAction",
    ]
    .into_iter()
    .map(|name| (name.to_owned(), Value::Array(Vec::new())))
    .collect()
}

fn worktree_sort_key(value: &Value) -> String {
    if value.get("path").is_none() {
        return format!("z:{NOW}");
    }
    format!(
        "a:{}",
        value
            .get("createdAt")
            .and_then(Value::as_str)
            .unwrap_or("0")
    )
}

fn nav_index(state: &Value, path: &str) -> i64 {
    state
        .get("worktreeNavOrder")
        .and_then(Value::as_array)
        .and_then(|order| {
            order
                .iter()
                .position(|candidate| candidate.as_str() == Some(path))
        })
        .map(|index| index as i64)
        .unwrap_or(-1)
}

fn set_field(value: &mut Value, field: &str, next: Value) {
    if let Value::Object(object) = value {
        object.insert(field.to_owned(), next);
    }
}

fn array_field(value: &Value, field: &str) -> Option<Vec<Value>> {
    value.get(field).and_then(Value::as_array).cloned()
}

fn str_field(value: &Value, field: &str) -> String {
    str_field_default(value, field, "")
}

fn str_field_default(value: &Value, field: &str, default: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or(default)
        .to_owned()
}

fn int_field(value: &Value, field: &str) -> i64 {
    value.get(field).and_then(Value::as_i64).unwrap_or_default()
}

fn pending_key(path: &str) -> String {
    format!("worktree:{}", canonical_fixture_worktree_path(path))
}

fn same_worktree_path(left: &str, right: &str) -> bool {
    canonical_fixture_worktree_path(left) == canonical_fixture_worktree_path(right)
}

fn canonical_fixture_worktree_path(path: &str) -> String {
    path.strip_prefix("/canonical-worktrees/")
        .map(|suffix| format!("/repo/.aimux/worktrees/{suffix}"))
        .unwrap_or_else(|| path.to_owned())
}
