use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

const NOW: &str = "2026-06-01T00:00:00.000Z";
const NOW_MS: i64 = 1_780_272_000_000;

pub fn run_multiplexer_worktrees_settlement_contract_case(input: &Value) -> Value {
    let mut host = SettlementHost::new(input);
    match str_field(input, "api").as_str() {
        "handleWorktreeInputKey" => host.handle_worktree_input_key(&str_field(input, "data")),
        "beginWorktreeRemoval" => host.begin_worktree_removal(
            &str_field(input, "path"),
            &str_field(input, "name"),
            int_field(input, "oldIdx"),
        ),
        "handleWorktreeRemoveConfirmKey" => {
            host.handle_worktree_remove_confirm_key(&str_field(input, "data"))
        }
        api => panic!("unknown worktrees settlement contract api: {api}"),
    }
    if let Some(after) = input.get("afterInvoke") {
        host.apply_after_invoke(after);
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
            let Some(task) = self.pending_async.pop() else {
                return;
            };
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
                self.refresh_dashboard_model();
                if turns <= 1 {
                    self.reapply_pending();
                    self.call("renderDashboard", vec![]);
                    return;
                }
                self.clear_worktree_action_if_token(&path, token);
                self.refresh_dashboard_model();
                if self.dashboard_input_epoch == lifecycle_epoch {
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
                self.clear_worktree_action_if_token(&path, token);
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
                self.refresh_dashboard_model();
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
    }

    fn refresh_dashboard_model(&mut self) {
        self.call(
            "refreshDashboardModelFromService",
            vec![json!(true), json!({ "allowInactive": true })],
        );
        let Some(step) = self.refresh_steps.first().cloned() else {
            return;
        };
        self.refresh_steps.remove(0);
        if let Some(worktrees) = array_field(&step, "worktrees") {
            self.dashboard_raw_worktree_groups_cache = worktrees;
            self.recompute_worktrees();
        }
    }

    fn set_worktree_action(&mut self, path: &str, kind: &str, opts: Value) -> i64 {
        self.next_token += 1;
        self.call(
            "dashboardPendingActionsSetWorktreeAction",
            vec![json!(path), json!(kind), opts.clone()],
        );
        let seed = opts.get("worktreeSeed").cloned();
        self.pending.insert(
            format!("worktree:{path}"),
            PendingEntry {
                value: Some(kind.to_owned()),
                token: Some(self.next_token),
                seed,
            },
        );
        self.next_token
    }

    fn clear_worktree_action_if_token(&mut self, path: &str, token: i64) {
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
        }
        self.reapply_pending();
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
            seen.push(format!("worktree:{path}"));
            if let Some(entry) = self.pending.get(&format!("worktree:{path}"))
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
            str_field(group, "path") == path && group.get("operationFailure").is_some()
        }) || self
            .dashboard_operation_failures_cache
            .iter()
            .any(|failure| {
                str_field(failure, "targetKind") == "worktree"
                    && str_field(failure, "operation") == "create"
                    && str_field(failure, "worktreePath") == path
            })
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
