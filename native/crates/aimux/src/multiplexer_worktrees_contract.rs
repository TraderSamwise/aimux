use serde_json::{json, Map, Value};

pub fn run_multiplexer_worktrees_contract_case(input: &Value) -> Value {
    match input.get("api").and_then(Value::as_str).unwrap_or_default() {
        "worktreeSettlePollDelay" => Value::Array(
            input
                .get("calls")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(delay_call_output)
                .collect(),
        ),
        "showWorktreeCreatePrompt" => {
            let mut host = WorktreeHost::from_input(input);
            host.show_worktree_create_prompt();
            host.snapshot()
        }
        "handleWorktreeInputKey" => {
            let mut host = WorktreeHost::from_input(input);
            let data = input
                .get("data")
                .and_then(Value::as_str)
                .unwrap_or_default();
            host.handle_worktree_input_key(data);
            host.snapshot()
        }
        "handleWorktreeRemoveConfirmKey" => {
            let mut host = WorktreeHost::from_input(input);
            let data = input
                .get("data")
                .and_then(Value::as_str)
                .unwrap_or_default();
            host.handle_worktree_remove_confirm_key(data);
            host.snapshot()
        }
        "finishWorktreeRemoval" => {
            let mut host = WorktreeHost::from_input(input);
            let path = input
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let code = number_field(input, "code");
            host.finish_worktree_removal(path, code);
            host.snapshot()
        }
        "handleWorktreeListKey" => {
            let mut host = WorktreeHost::from_input(input);
            let data = input
                .get("data")
                .and_then(Value::as_str)
                .unwrap_or_default();
            host.handle_worktree_list_key(data);
            host.snapshot()
        }
        "showWorktreeCacheCleanupPreview" => {
            let mut host = WorktreeHost::from_input(input);
            host.show_worktree_cache_cleanup_preview(input);
            host.snapshot()
        }
        "handleWorktreeCacheCleanupConfirmKey" => {
            let mut host = WorktreeHost::from_input(input);
            let data = input
                .get("data")
                .and_then(Value::as_str)
                .unwrap_or_default();
            host.handle_worktree_cache_cleanup_confirm_key(input, data);
            host.snapshot()
        }
        api => panic!("unknown multiplexer worktrees api: {api}"),
    }
}

fn delay_call_output(call: &Value) -> Value {
    let attempt = number_field(call, "attempt");
    let base_ms = number_field(call, "baseMs");
    let max_ms = call.get("maxMs").and_then(Value::as_i64).unwrap_or(2_000);
    let delay_ms = worktree_settle_poll_delay(attempt, base_ms, max_ms);
    let mut output = call.clone();
    if let Value::Object(object) = &mut output {
        object.insert("delayMs".to_owned(), json!(delay_ms));
    }
    output
}

fn worktree_settle_poll_delay(attempt: i64, base_ms: i64, max_ms: i64) -> i64 {
    if attempt <= 2 {
        return base_ms;
    }
    let decayed = ((base_ms as f64) * 1.5_f64.powi((attempt - 2) as i32)).round() as i64;
    decayed.min(base_ms.max(max_ms))
}

fn number_field(value: &Value, field: &str) -> i64 {
    value.get(field).and_then(Value::as_i64).unwrap_or_default()
}

#[derive(Debug)]
struct WorktreeHost {
    mode: String,
    worktree_input_buffer: Option<String>,
    worktree_remove_confirm: Value,
    worktree_removal_job: Value,
    worktree_removal_jobs: Vec<Value>,
    worktree_cache_cleanup_confirm: Value,
    dashboard_busy_state: Option<Value>,
    dashboard_input_epoch: i64,
    dashboard_state: Value,
    dashboard_worktree_groups_cache: Value,
    footer_flash: Option<String>,
    footer_flash_ticks: Option<i64>,
    calls: Map<String, Value>,
}

impl WorktreeHost {
    fn from_input(input: &Value) -> Self {
        let host = input.get("host").unwrap_or(&Value::Null);
        let worktree_removal_jobs = host
            .get("worktreeRemovalJobs")
            .and_then(Value::as_array)
            .map(|jobs| {
                jobs.iter()
                    .map(|job| {
                        let mut job = job.clone();
                        if let Value::Object(object) = &mut job {
                            object.entry("startedAt").or_insert_with(|| json!(0));
                        }
                        job
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let worktree_removal_job = worktree_removal_jobs.last().cloned().unwrap_or(Value::Null);
        Self {
            mode: host
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or("dashboard")
                .to_owned(),
            worktree_input_buffer: host
                .get("worktreeInputBuffer")
                .and_then(Value::as_str)
                .map(str::to_owned),
            worktree_remove_confirm: host
                .get("worktreeRemoveConfirm")
                .cloned()
                .unwrap_or(Value::Null),
            worktree_removal_job,
            worktree_removal_jobs,
            worktree_cache_cleanup_confirm: host
                .get("worktreeCacheCleanupConfirm")
                .cloned()
                .unwrap_or(Value::Null),
            dashboard_busy_state: host.get("dashboardBusyState").cloned(),
            dashboard_input_epoch: number_field(host, "dashboardInputEpoch"),
            dashboard_state: host
                .get("dashboardState")
                .cloned()
                .unwrap_or_else(|| json!({ "worktreeNavOrder": [] })),
            dashboard_worktree_groups_cache: host
                .get("dashboardWorktreeGroupsCache")
                .cloned()
                .unwrap_or_else(|| json!([])),
            footer_flash: None,
            footer_flash_ticks: None,
            calls: empty_calls(),
        }
    }

    fn snapshot(&self) -> Value {
        let mut output = Map::new();
        output.insert("mode".to_owned(), json!(self.mode));
        if let Some(buffer) = &self.worktree_input_buffer {
            output.insert("worktreeInputBuffer".to_owned(), json!(buffer));
        }
        output.insert(
            "worktreeRemoveConfirm".to_owned(),
            self.worktree_remove_confirm.clone(),
        );
        output.insert(
            "worktreeRemovalJob".to_owned(),
            self.worktree_removal_job.clone(),
        );
        output.insert(
            "worktreeRemovalJobs".to_owned(),
            Value::Array(self.worktree_removal_jobs.clone()),
        );
        output.insert(
            "worktreeCacheCleanupConfirm".to_owned(),
            self.worktree_cache_cleanup_confirm.clone(),
        );
        if let Some(dashboard_busy_state) = &self.dashboard_busy_state {
            output.insert(
                "dashboardBusyState".to_owned(),
                dashboard_busy_state.clone(),
            );
        }
        output.insert(
            "dashboardInputEpoch".to_owned(),
            json!(self.dashboard_input_epoch),
        );
        output.insert("dashboardState".to_owned(), self.dashboard_state.clone());
        output.insert(
            "dashboardWorktreeGroupsCache".to_owned(),
            self.dashboard_worktree_groups_cache.clone(),
        );
        if let Some(footer_flash) = &self.footer_flash {
            output.insert("footerFlash".to_owned(), json!(footer_flash));
        }
        if let Some(footer_flash_ticks) = self.footer_flash_ticks {
            output.insert("footerFlashTicks".to_owned(), json!(footer_flash_ticks));
        }
        output.insert("calls".to_owned(), Value::Object(self.calls.clone()));
        Value::Object(output)
    }

    fn show_worktree_create_prompt(&mut self) {
        self.call("openDashboardOverlay", vec![json!("worktree-input")]);
        self.worktree_input_buffer = Some(String::new());
        self.render_worktree_input();
    }

    fn handle_worktree_input_key(&mut self, data: &str) {
        let events = parse_contract_keys(data);
        if events.is_empty() {
            return;
        }
        for event in events {
            match event {
                ContractKey::Escape => {
                    self.call("clearDashboardOverlay", vec![]);
                    self.call("restoreDashboardAfterOverlayDismiss", vec![]);
                    return;
                }
                ContractKey::Enter => {
                    self.call("clearDashboardOverlay", vec![]);
                    let name = self
                        .worktree_input_buffer
                        .as_deref()
                        .unwrap_or_default()
                        .trim()
                        .to_owned();
                    if name.is_empty() {
                        self.call("restoreDashboardAfterOverlayDismiss", vec![]);
                        return;
                    }
                    if self.mode != "dashboard" {
                        self.call(
                            "showDashboardError",
                            vec![
                                json!("Failed to create worktree"),
                                json!(["Worktree creation requires the project service."]),
                            ],
                        );
                        return;
                    }
                    self.call("renderDashboard", vec![]);
                    return;
                }
                ContractKey::Backspace => {
                    let buffer = self.worktree_input_buffer.get_or_insert_with(String::new);
                    buffer.pop();
                    self.render_worktree_input();
                }
                ContractKey::Text(text) => {
                    self.worktree_input_buffer
                        .get_or_insert_with(String::new)
                        .push_str(&text);
                    self.render_worktree_input();
                }
            }
        }
    }

    fn handle_worktree_remove_confirm_key(&mut self, data: &str) {
        let Some(event) = parse_contract_keys(data).into_iter().next() else {
            return;
        };
        match event {
            ContractKey::Enter => {
                let confirm = self.worktree_remove_confirm.clone();
                if !confirm.is_null() {
                    self.worktree_remove_confirm = Value::Null;
                    self.call("clearDashboardOverlay", vec![]);
                    let path = string_field(&confirm, "path");
                    let name = string_field(&confirm, "name");
                    let old_idx = self.worktree_nav_index(&path).unwrap_or(-1);
                    self.begin_worktree_removal(&path, &name, old_idx);
                }
            }
            ContractKey::Escape => {
                self.worktree_remove_confirm = Value::Null;
                self.call("clearDashboardOverlay", vec![]);
                self.call("restoreDashboardAfterOverlayDismiss", vec![]);
            }
            ContractKey::Text(text) => {
                if text == "n" {
                    self.worktree_remove_confirm = Value::Null;
                    self.call("clearDashboardOverlay", vec![]);
                    self.call("restoreDashboardAfterOverlayDismiss", vec![]);
                }
            }
            ContractKey::Backspace => {}
        }
    }

    fn begin_worktree_removal(&mut self, path: &str, name: &str, old_idx: i64) {
        if self
            .worktree_removal_jobs
            .iter()
            .any(|job| same_path(job, path))
        {
            self.footer_flash = Some(format!("Already graveyarding {name}"));
            self.footer_flash_ticks = Some(4);
            self.call(
                "showDashboardError",
                vec![
                    json!("Worktree graveyard already in progress"),
                    json!([format!(
                        "Finish graveyarding \"{name}\" before starting it again."
                    )]),
                ],
            );
            self.call("renderDashboard", vec![]);
            return;
        }
        let removal_job = json!({
            "path": path,
            "name": name,
            "startedAt": 0,
            "oldIdx": old_idx,
            "stderr": "",
        });
        self.worktree_removal_job = removal_job.clone();
        self.worktree_removal_jobs.push(removal_job);
        if self.mode != "dashboard" {
            if let Some(object) = self
                .worktree_removal_jobs
                .iter_mut()
                .find_map(|job| same_path(job, path).then(|| job.as_object_mut()).flatten())
            {
                object.insert(
                    "stderr".to_owned(),
                    json!("Worktree graveyard requires the project service."),
                );
            }
            self.finish_worktree_removal(path, 1);
        }
    }

    fn finish_worktree_removal(&mut self, path: &str, code: i64) {
        let Some(index) = self
            .worktree_removal_jobs
            .iter()
            .position(|job| same_path(job, path))
        else {
            return;
        };
        let job = self.worktree_removal_jobs.remove(index);
        self.worktree_removal_job = self
            .worktree_removal_jobs
            .last()
            .cloned()
            .unwrap_or(Value::Null);
        let stderr = string_field(&job, "stderr");
        let details = stderr
            .split('\n')
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();

        if code == 0 {
            let name = string_field(&job, "name");
            self.footer_flash = Some(format!("Graveyarded: {name}"));
            self.footer_flash_ticks = Some(3);
            let nav_order = self
                .dashboard_worktree_groups_cache
                .as_array()
                .into_iter()
                .flatten()
                .map(|worktree| json!(string_field(worktree, "path")))
                .collect::<Vec<_>>();
            set_object_field(
                &mut self.dashboard_state,
                "worktreeNavOrder",
                Value::Array(nav_order.clone()),
            );
            let focused = self
                .dashboard_state
                .get("focusedWorktreePath")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let job_path = string_field(&job, "path");
            if focused.is_empty() || focused == job_path {
                let old_idx = number_field(&job, "oldIdx");
                let next_focus = if old_idx >= 0 && (old_idx as usize) < nav_order.len() {
                    nav_order
                        .get(old_idx as usize)
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                } else {
                    nav_order.last().and_then(Value::as_str).map(str::to_owned)
                };
                if let Some(next_focus) = next_focus {
                    set_object_field(
                        &mut self.dashboard_state,
                        "focusedWorktreePath",
                        json!(next_focus),
                    );
                } else if let Value::Object(object) = &mut self.dashboard_state {
                    object.remove("focusedWorktreePath");
                }
            }
            self.call("renderDashboard", vec![]);
            return;
        }

        let message = details
            .first()
            .cloned()
            .unwrap_or_else(|| format!("worktree graveyard failed with code {code}"));
        let name = string_field(&job, "name");
        let job_path = string_field(&job, "path");
        self.footer_flash = Some(format!("Failed: {message}"));
        self.footer_flash_ticks = Some(5);
        let mut lines = vec![format!("Path: {job_path}"), format!("Error: {message}")];
        lines.extend(details);
        self.call(
            "showDashboardError",
            vec![
                json!(format!("Failed to graveyard \"{name}\"")),
                json!(lines),
            ],
        );
        self.call("renderDashboard", vec![]);
    }

    fn handle_worktree_list_key(&mut self, data: &str) {
        if matches!(
            parse_contract_keys(data).into_iter().next(),
            Some(ContractKey::Escape)
        ) {
            self.call("clearDashboardOverlay", vec![]);
            self.call("restoreDashboardAfterOverlayDismiss", vec![]);
        }
    }

    fn show_worktree_cache_cleanup_preview(&mut self, input: &Value) {
        if self.mode != "dashboard" {
            self.call(
                "showDashboardError",
                vec![
                    json!("Failed to inspect worktree caches"),
                    json!(["Worktree cache cleanup requires the project service."]),
                ],
            );
            return;
        }
        if !self
            .dashboard_busy_state
            .clone()
            .unwrap_or(Value::Null)
            .is_null()
        {
            return;
        }
        self.worktree_cache_cleanup_confirm = Value::Null;
        self.call("clearDashboardOverlay", vec![]);
        self.start_dashboard_busy(
            "Worktree Cache Cleanup",
            vec!["  Scanning inactive generated worktree caches".to_owned()],
        );
        let lifecycle_epoch = self.dashboard_input_epoch;
        self.call(
            "postToProjectService",
            vec![
                json!("/worktrees/cache-cleanup"),
                json!({ "dryRun": true, "includeActive": false }),
                json!({ "timeoutMs": 180000 }),
            ],
        );
        self.dashboard_input_epoch += number_field(input, "afterStartInputEpochDelta");
        self.clear_dashboard_busy();
        if self.dashboard_input_epoch != lifecycle_epoch {
            return;
        }
        self.worktree_cache_cleanup_confirm = value_at(input, &["postResponse", "result"]).clone();
        self.call(
            "openDashboardOverlay",
            vec![json!("worktree-cache-cleanup-confirm")],
        );
        self.call("redrawDashboardWithOverlay", vec![]);
    }

    fn handle_worktree_cache_cleanup_confirm_key(&mut self, input: &Value, data: &str) {
        let Some(event) = parse_contract_keys(data).into_iter().next() else {
            return;
        };
        let preview = self.worktree_cache_cleanup_confirm.clone();
        if preview.is_null() {
            self.call("clearDashboardOverlay", vec![]);
            self.call("restoreDashboardAfterOverlayDismiss", vec![]);
            return;
        }
        let targets = value_at(&preview, &["plan", "targets"])
            .as_array()
            .map(Vec::len)
            .unwrap_or_default();
        match event {
            ContractKey::Enter if targets == 0 => {
                self.worktree_cache_cleanup_confirm = Value::Null;
                self.call("clearDashboardOverlay", vec![]);
                self.call("restoreDashboardAfterOverlayDismiss", vec![]);
            }
            ContractKey::Enter => self.apply_worktree_cache_cleanup(input, &preview),
            ContractKey::Escape | ContractKey::Text(_) => {
                self.worktree_cache_cleanup_confirm = Value::Null;
                self.call("clearDashboardOverlay", vec![]);
                self.call("restoreDashboardAfterOverlayDismiss", vec![]);
            }
            ContractKey::Backspace => {}
        }
    }

    fn apply_worktree_cache_cleanup(&mut self, input: &Value, _preview: &Value) {
        self.worktree_cache_cleanup_confirm = Value::Null;
        self.call("clearDashboardOverlay", vec![]);
        self.start_dashboard_busy(
            "Worktree Cache Cleanup",
            vec!["  Removing inactive generated worktree caches".to_owned()],
        );
        let lifecycle_epoch = self.dashboard_input_epoch;
        self.call(
            "postToProjectService",
            vec![
                json!("/worktrees/cache-cleanup"),
                json!({ "dryRun": false, "includeActive": false }),
                json!({ "timeoutMs": 180000 }),
            ],
        );
        self.clear_dashboard_busy();
        if self.dashboard_input_epoch != lifecycle_epoch {
            return;
        }
        let result = value_at(input, &["postResponse", "result"]);
        let failed = value_at(result, &["results"])
            .as_array()
            .map(|results| {
                results
                    .iter()
                    .filter(|entry| string_field(entry, "status") == "failed")
                    .count()
            })
            .unwrap_or_default();
        let reclaimed = number_field(result, "reclaimedBytes");
        let targets = value_at(result, &["plan", "targets"])
            .as_array()
            .map(Vec::len)
            .unwrap_or_default();
        self.footer_flash = Some(format!(
            "Removed {} from {} cache item(s)",
            format_worktree_cache_bytes(reclaimed),
            targets
        ));
        self.footer_flash_ticks = Some(if failed > 0 { 6 } else { 4 });
        if failed > 0 {
            self.call(
                "showDashboardError",
                vec![
                    json!("Worktree cache cleanup finished with failures"),
                    json!([
                        format!("Removed: {}", format_worktree_cache_bytes(reclaimed)),
                        format!("Failed: {failed}")
                    ]),
                ],
            );
            return;
        }
        self.call("renderDashboard", vec![]);
    }

    fn start_dashboard_busy(&mut self, title: &str, lines: Vec<String>) {
        self.call("startDashboardBusy", vec![json!(title), json!(lines)]);
        self.dashboard_busy_state = Some(json!({ "title": title, "lines": lines }));
    }

    fn clear_dashboard_busy(&mut self) {
        self.call("clearDashboardBusy", vec![]);
        self.dashboard_busy_state = Some(Value::Null);
    }

    fn render_worktree_input(&mut self) {
        if self.mode == "dashboard" {
            self.call("redrawDashboardWithOverlay", vec![]);
        }
    }

    fn worktree_nav_index(&self, path: &str) -> Option<i64> {
        self.dashboard_state
            .get("worktreeNavOrder")
            .and_then(Value::as_array)?
            .iter()
            .position(|candidate| candidate.as_str() == Some(path))
            .map(|index| index as i64)
    }

    fn call(&mut self, name: &str, args: Vec<Value>) {
        self.calls
            .entry(name.to_owned())
            .or_insert_with(|| Value::Array(Vec::new()))
            .as_array_mut()
            .expect("contract call log entries stay arrays")
            .push(Value::Array(args));
    }
}

#[derive(Clone, Debug)]
enum ContractKey {
    Escape,
    Enter,
    Backspace,
    Text(String),
}

fn parse_contract_keys(data: &str) -> Vec<ContractKey> {
    let mut events = Vec::new();
    let mut printable = String::new();
    for ch in data.chars() {
        match ch {
            '\u{1b}' => {
                push_printable(&mut events, &mut printable);
                events.push(ContractKey::Escape);
            }
            '\r' | '\n' => {
                push_printable(&mut events, &mut printable);
                events.push(ContractKey::Enter);
            }
            '\u{8}' | '\u{7f}' => {
                push_printable(&mut events, &mut printable);
                events.push(ContractKey::Backspace);
            }
            ch if !ch.is_control() => printable.push(ch),
            _ => {
                push_printable(&mut events, &mut printable);
            }
        }
    }
    push_printable(&mut events, &mut printable);
    events
}

fn push_printable(events: &mut Vec<ContractKey>, printable: &mut String) {
    if !printable.is_empty() {
        events.push(ContractKey::Text(std::mem::take(printable)));
    }
}

fn empty_calls() -> Map<String, Value> {
    [
        "openDashboardOverlay",
        "redrawDashboardWithOverlay",
        "clearDashboardOverlay",
        "restoreDashboardAfterOverlayDismiss",
        "showDashboardError",
        "renderDashboard",
        "startDashboardBusy",
        "clearDashboardBusy",
        "postToProjectService",
        "dashboardUiStateStore.markSelectionDirty",
    ]
    .into_iter()
    .map(|name| (name.to_owned(), Value::Array(Vec::new())))
    .collect()
}

fn string_field(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn value_at<'a>(value: &'a Value, path: &[&str]) -> &'a Value {
    path.iter().fold(value, |current, field| {
        current.get(*field).unwrap_or(&Value::Null)
    })
}

fn format_worktree_cache_bytes(bytes: i64) -> String {
    if bytes.abs() < 1024 {
        return format!("{bytes}B");
    }
    format!("{:.1}KB", bytes as f64 / 1024.0)
}

fn same_path(value: &Value, path: &str) -> bool {
    value.get("path").and_then(Value::as_str) == Some(path)
}

fn set_object_field(object: &mut Value, field: &str, value: Value) {
    if let Value::Object(object) = object {
        object.insert(field.to_owned(), value);
    }
}
