use crate::terminal_key_parser::{KeyEvent, command_key, match_key, parse_keys};
use serde_json::{Value, json};

const HOTKEY_TIMEOUT_MS: i64 = 1_000;

pub fn run_hotkeys_contract_case(input: &Value) -> Value {
    let columns = input["columns"].as_u64().unwrap_or(80) as usize;
    let mut handler = HotkeyHandler::new(columns);
    let returns = input["chunks"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|chunk| {
            let raw = chunk.as_str().unwrap_or_default();
            handler
                .feed(raw.as_bytes())
                .map_or(Value::Null, Value::String)
        })
        .collect::<Vec<_>>();
    let _ = HOTKEY_TIMEOUT_MS;
    json!({
        "returns": returns,
        "actions": handler.actions,
        "writes": handler.writes,
    })
}

#[derive(Debug, Clone)]
pub struct HotkeyHandler {
    waiting_for_action: bool,
    columns: usize,
    actions: Vec<Value>,
    writes: Vec<String>,
}

impl HotkeyHandler {
    pub fn new(columns: usize) -> Self {
        Self {
            waiting_for_action: false,
            columns,
            actions: Vec::new(),
            writes: Vec::new(),
        }
    }

    pub fn feed(&mut self, data: &[u8]) -> Option<String> {
        let events = parse_keys(data);
        if events.is_empty() {
            return Some(String::from_utf8_lossy(data).into_owned());
        }
        if self.waiting_for_action {
            self.waiting_for_action = false;
            self.hide_leader_indicator();
            return self.handle_action_event(&events[0], data);
        }
        if events.len() == 1 && match_key(&events[0], "ctrl+a") {
            self.waiting_for_action = true;
            self.show_leader_indicator();
            return None;
        }
        Some(String::from_utf8_lossy(data).into_owned())
    }

    fn handle_action_event(&mut self, event: &KeyEvent, raw_data: &[u8]) -> Option<String> {
        if match_key(event, "ctrl+a") {
            self.actions.push(json!({
                "type": "passthrough",
                "data": String::from_utf8_lossy(raw_data).into_owned(),
            }));
            return None;
        }
        let key = if event.name.is_empty() {
            event.char.as_str()
        } else {
            event.name.as_str()
        };
        let lower_key = command_key(event);
        if key == "W" {
            self.actions.push(json!({ "type": "worktree-list" }));
            return None;
        }
        if key == "P" {
            self.actions.push(json!({ "type": "work-outline" }));
            return None;
        }
        match lower_key.as_str() {
            "d" => self.actions.push(json!({ "type": "dashboard" })),
            "?" => self.actions.push(json!({ "type": "help" })),
            "n" => self.actions.push(json!({ "type": "next" })),
            "i" => self.actions.push(json!({ "type": "coordination" })),
            "p" => self.actions.push(json!({ "type": "prev" })),
            "c" => self.actions.push(json!({ "type": "create" })),
            "o" => self.actions.push(json!({ "type": "create-overseer" })),
            "x" => self.actions.push(json!({ "type": "kill" })),
            "s" => self.actions.push(json!({ "type": "switcher" })),
            "w" => self.actions.push(json!({ "type": "worktree-create" })),
            "v" => self.actions.push(json!({ "type": "review" })),
            _ if ("1"..="9").contains(&key) => {
                let index = key.parse::<i64>().unwrap_or(1) - 1;
                self.actions
                    .push(json!({ "type": "focus", "index": index }));
            }
            _ => self.actions.push(json!({
                "type": "passthrough",
                "data": String::from_utf8_lossy(raw_data).into_owned(),
            })),
        }
        None
    }

    fn show_leader_indicator(&mut self) {
        let label = " ^A \u{2192} ? ";
        let col = self.columns.saturating_sub(label.chars().count());
        self.writes
            .push(format!("\x1b7\x1b[1;{col}H\x1b[7;33m{label}\x1b[0m\x1b8"));
    }

    fn hide_leader_indicator(&mut self) {
        let label = " ^A \u{2192} ? ";
        let col = self.columns.saturating_sub(label.chars().count());
        self.writes.push(format!(
            "\x1b7\x1b[1;{col}H{}\x1b8",
            " ".repeat(label.chars().count())
        ));
    }
}
