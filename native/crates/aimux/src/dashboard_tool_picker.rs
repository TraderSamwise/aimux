use crate::dashboard_create::{
    DashboardAgentCreateIntent, DashboardCreateIntent, DashboardCreatePlan, plan_dashboard_create,
};
use crate::tui_render::theme::{Tone, footer_hints, pad_visible, style};
use crate::tui_render::{OverlayBoxSpec, OverlayVariant, render_overlay_box};
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardToolEntry {
    pub key: String,
    pub command: String,
    pub args: Vec<String>,
    pub default_args: Vec<String>,
    pub default_env: Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardToolPickerState {
    pub tools: Vec<DashboardToolEntry>,
    pub index: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DashboardToolPickerEffect {
    Render,
    Close,
    Create(DashboardCreatePlan),
}

impl DashboardToolPickerState {
    pub fn new(tools: Vec<DashboardToolEntry>) -> Self {
        Self { tools, index: 0 }
    }

    pub fn move_prev(&mut self) {
        self.index = self.index.saturating_sub(1);
    }

    pub fn move_next(&mut self) {
        self.index = self
            .index
            .saturating_add(1)
            .min(self.tools.len().saturating_sub(1));
    }

    pub fn select_digit(
        &mut self,
        digit: char,
        worktree_path: Option<&str>,
    ) -> DashboardToolPickerEffect {
        let Some(index) = digit
            .to_digit(10)
            .map(|value| value as usize)
            .and_then(|value| value.checked_sub(1))
        else {
            return DashboardToolPickerEffect::Render;
        };
        if index >= self.tools.len() {
            return DashboardToolPickerEffect::Render;
        }
        self.index = index;
        self.create_selected(worktree_path)
    }

    pub fn create_selected(&self, worktree_path: Option<&str>) -> DashboardToolPickerEffect {
        let Some(tool) = self.tools.get(self.index) else {
            return DashboardToolPickerEffect::Render;
        };
        DashboardToolPickerEffect::Create(plan_dashboard_create(&DashboardCreateIntent::Agent(
            DashboardAgentCreateIntent {
                tool: Some(tool.key.clone()),
                session_id: None,
                worktree_path: worktree_path.map(str::to_owned),
                launch_override: default_launch_override(tool),
                overseer: None,
                scribe: None,
            },
        )))
    }
}

pub fn enabled_dashboard_tools(config: &Value) -> Vec<DashboardToolEntry> {
    let Some(tools) = config.get("tools").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut entries = tools
        .iter()
        .filter_map(|(key, tool)| dashboard_tool_entry(key, tool))
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| (builtin_tool_order(&entry.key), entry.key.clone()));
    entries
}

pub fn render_tool_picker_overlay(
    state: &DashboardToolPickerState,
    cols: usize,
    rows: usize,
) -> String {
    let mut body = Vec::new();
    if state.tools.is_empty() {
        body.push(format!("  {}", style("No enabled tools", Tone::Muted)));
        body.push(String::new());
        body.push(footer_hints("[Esc] cancel"));
        return render_overlay_box(&OverlayBoxSpec {
            title: "Select tool",
            body: &body,
            cols,
            rows,
            variant: OverlayVariant::Red,
            icon: None,
        });
    }
    for (index, tool) in state.tools.iter().enumerate() {
        let selected = index == state.index;
        let marker = if selected {
            style("▸", Tone::Accent)
        } else {
            " ".into()
        };
        let number = style(
            &format!("[{}]", index + 1),
            if selected { Tone::Accent } else { Tone::Muted },
        );
        let name = if selected {
            style(&tool.key, Tone::Strong)
        } else {
            tool.key.clone()
        };
        body.push(format!("  {marker} {} {name}", pad_visible(&number, 4)));
    }
    body.push(String::new());
    body.push(footer_hints("[Enter/1-9] start  [Esc] cancel"));
    render_overlay_box(&OverlayBoxSpec {
        title: "Select tool",
        body: &body,
        cols,
        rows,
        variant: OverlayVariant::Blue,
        icon: None,
    })
}

fn dashboard_tool_entry(key: &str, tool: &Value) -> Option<DashboardToolEntry> {
    if tool.get("enabled").and_then(Value::as_bool) == Some(false) {
        return None;
    }
    Some(DashboardToolEntry {
        key: key.to_owned(),
        command: string_field(tool, "command")?,
        args: string_array_field(tool.get("args")),
        default_args: string_array_field(tool.get("defaultArgs")),
        default_env: tool
            .get("defaultEnv")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
    })
}

fn default_launch_override(tool: &DashboardToolEntry) -> Option<Value> {
    if tool.default_args.is_empty() && tool.default_env.is_empty() {
        return None;
    }
    let mut body = Map::new();
    body.insert(
        "args".into(),
        Value::Array(
            tool.args
                .iter()
                .chain(tool.default_args.iter())
                .map(|arg| Value::String(arg.clone()))
                .collect(),
        ),
    );
    if !tool.default_env.is_empty() {
        body.insert("env".into(), Value::Object(tool.default_env.clone()));
    }
    Some(Value::Object(body))
}

fn string_field(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn string_array_field(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn builtin_tool_order(key: &str) -> usize {
    match key {
        "claude" => 0,
        "codex" => 1,
        "aider" => 2,
        _ => 3,
    }
}
