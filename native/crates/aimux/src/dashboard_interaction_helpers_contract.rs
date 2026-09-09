use serde_json::{Value, json};

pub fn run_dashboard_interaction_helpers_contract_case(input: &Value) -> Value {
    let mut state = HelperState::new(input);
    let return_value = match string_field(input, "method").as_str() {
        "showOverseerOverlay" => {
            state.show_overseer_overlay();
            Value::Null
        }
        "renderOverseerOverlay" => {
            state.render_overseer_overlay();
            Value::Null
        }
        "showOverseerWatchInstructions" => {
            state.show_overseer_watch_instructions(
                input.get("selected").cloned().unwrap_or(Value::Null),
            );
            Value::Null
        }
        "renderOverseerWatchInstructions" => {
            state.render_overseer_watch_instructions();
            Value::Null
        }
        "showWorkOutlineOverlay" => {
            state.show_work_outline_overlay(input.get("sessionId").cloned());
            Value::Null
        }
        "renderWorkOutlineOverlay" => {
            state.render_work_outline_overlay();
            Value::Null
        }
        "formatRoutePreview" => {
            let recipient_ids = input
                .get("recipientIds")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter_map(|value| value.as_str().map(ToOwned::to_owned))
                .collect::<Vec<_>>();
            json!(format_route_preview(&recipient_ids))
        }
        _ => Value::Null,
    };
    state.summary(return_value)
}

struct HelperState {
    mode: String,
    overlay_kind: Value,
    overseer_watch_instructions_target: Value,
    overseer_watch_instructions_buffer: String,
    work_outline_overlay_session_id: Value,
    work_outline_overlay_entries: Vec<Value>,
    work_outline_overlay_offset: i64,
    reloaded_work_outline_overlay_entries: Option<Vec<Value>>,
    load_work_outline_result: bool,
    footer_flash: Value,
    footer_flash_ticks: i64,
    calls: Vec<Value>,
}

impl HelperState {
    fn new(input: &Value) -> Self {
        Self {
            mode: string_field_default(input, "mode", "dashboard"),
            overlay_kind: input.get("overlayKind").cloned().unwrap_or(Value::Null),
            overseer_watch_instructions_target: input
                .get("overseerWatchInstructionsTarget")
                .cloned()
                .unwrap_or(Value::Null),
            overseer_watch_instructions_buffer: string_field_default(
                input,
                "overseerWatchInstructionsBuffer",
                "draft",
            ),
            work_outline_overlay_session_id: input
                .get("workOutlineOverlaySessionId")
                .cloned()
                .unwrap_or(Value::Null),
            work_outline_overlay_entries: array_field(input, "workOutlineOverlayEntries"),
            work_outline_overlay_offset: input
                .get("workOutlineOverlayOffset")
                .and_then(Value::as_i64)
                .unwrap_or(7),
            reloaded_work_outline_overlay_entries: input
                .get("reloadedWorkOutlineOverlayEntries")
                .and_then(Value::as_array)
                .cloned(),
            load_work_outline_result: input
                .get("loadWorkOutlineResult")
                .and_then(Value::as_bool)
                .unwrap_or(true),
            footer_flash: Value::Null,
            footer_flash_ticks: 0,
            calls: Vec::new(),
        }
    }

    fn summary(&self, return_value: Value) -> Value {
        json!({
            "returnValue": return_value,
            "overlayKind": self.overlay_kind,
            "overseerWatchInstructionsTarget": self.overseer_watch_instructions_target,
            "overseerWatchInstructionsBuffer": self.overseer_watch_instructions_buffer,
            "workOutlineOverlaySessionId": self.work_outline_overlay_session_id,
            "workOutlineOverlayOffset": self.work_outline_overlay_offset,
            "workOutlineOverlayEntries": self.work_outline_overlay_entries,
            "footerFlash": self.footer_flash,
            "footerFlashTicks": self.footer_flash_ticks,
            "calls": self.calls,
        })
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }

    fn open_dashboard_overlay(&mut self, kind: &str) {
        self.overlay_kind = json!(kind);
        self.call("openDashboardOverlay", vec![json!(kind)]);
    }

    fn show_overseer_overlay(&mut self) {
        self.open_dashboard_overlay("overseer");
        self.call("renderOverseerOverlay", vec![]);
    }

    fn render_overseer_overlay(&mut self) {
        self.call("redrawDashboardWithOverlay", vec![]);
    }

    fn show_overseer_watch_instructions(&mut self, selected: Value) {
        self.overseer_watch_instructions_target = selected;
        self.overseer_watch_instructions_buffer.clear();
        self.open_dashboard_overlay("overseer-watch-instructions");
        self.call("renderOverseerWatchInstructions", vec![]);
    }

    fn render_overseer_watch_instructions(&mut self) {
        self.call("redrawDashboardWithOverlay", vec![]);
    }

    fn load_work_outline_overlay_entries(&mut self) -> bool {
        self.call("loadWorkOutlineOverlayEntries", vec![]);
        if !self.load_work_outline_result {
            return false;
        }
        if let Some(entries) = &self.reloaded_work_outline_overlay_entries {
            self.work_outline_overlay_entries = entries.clone();
        }
        true
    }

    fn show_work_outline_overlay(&mut self, session_id: Option<Value>) {
        self.work_outline_overlay_session_id = session_id.unwrap_or(Value::Null);
        self.work_outline_overlay_offset = 0;
        if !self.load_work_outline_overlay_entries() {
            return;
        }
        self.open_dashboard_overlay("work-outline");
        self.call("renderWorkOutlineOverlay", vec![]);
    }

    fn render_work_outline_overlay(&mut self) {
        if self.mode == "dashboard" {
            self.call("redrawDashboardWithOverlay", vec![]);
        }
    }
}

fn format_route_preview(recipient_ids: &[String]) -> String {
    if recipient_ids.is_empty() {
        return String::new();
    }
    let preview = recipient_ids
        .iter()
        .take(2)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let remainder = if recipient_ids.len() > 2 {
        format!(", +{}", recipient_ids.len() - 2)
    } else {
        String::new()
    };
    format!(" [{}: {preview}{remainder}]", recipient_ids.len())
}

fn array_field(input: &Value, key: &str) -> Vec<Value> {
    input
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_field(input: &Value, key: &str) -> String {
    input
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn string_field_default(input: &Value, key: &str, default: &str) -> String {
    input
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or(default)
        .to_owned()
}
