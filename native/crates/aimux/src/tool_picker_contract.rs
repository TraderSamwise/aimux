use aimux::dashboard_launch_options::{
    DashboardLaunchOptionsState, LaunchOptionsField, LineState, render_launch_options_overlay,
};
use aimux::dashboard_tool_picker::{
    DashboardToolPickerMode, DashboardToolPickerState, enabled_dashboard_tools,
    render_tool_picker_overlay,
};
use serde_json::{Map, Value, json};

pub fn run_tool_picker_contract_case(input: &Value) -> Value {
    match input.get("api").and_then(Value::as_str).unwrap_or_default() {
        "formatEnvDefaults" => Value::String(format_env_defaults(input.get("env"))),
        "defaultsLaunchOverride" => defaults_launch_override(value_field(input, "tool")),
        "runSelectedTool" => run_selected_tool(input),
        "showToolPicker" => show_tool_picker(input),
        "buildToolPickerOverlayOutput" => build_tool_picker_overlay_output(input),
        "buildToolOptionsOverlayOutput" => build_tool_options_overlay_output(input),
        api => panic!("unknown tool picker api: {api}"),
    }
}

fn build_tool_options_overlay_output(input: &Value) -> Value {
    let tools = enabled_dashboard_tools(&json!({
        "tools": input.get("configTools").cloned().unwrap_or_else(default_config_tools),
    }));
    let host = value_field(input, "host");
    let state = launch_options_state(value_field(host, "launchOptionsState"))
        .expect("tool options contract requires launchOptionsState");
    let selected_tool = tools.iter().find(|tool| tool.key == state.tool_key);
    Value::String(render_launch_options_overlay(
        &state,
        selected_tool,
        int_field(input, "cols", 80),
        int_field(input, "rows", 24),
    ))
}

fn build_tool_picker_overlay_output(input: &Value) -> Value {
    let tools = enabled_dashboard_tools(&json!({
        "tools": input.get("configTools").cloned().unwrap_or_else(default_config_tools),
    }));
    let host = value_field(input, "host");
    let mode = match str_field(host, "pickerMode").unwrap_or("create") {
        "fork" => DashboardToolPickerMode::Fork {
            source_session_id: str_field(host, "forkSourceSessionId")
                .unwrap_or_default()
                .to_owned(),
        },
        "switch-tool" => DashboardToolPickerMode::SwitchTool {
            session_id: str_field(host, "switchToolSourceSessionId")
                .unwrap_or_default()
                .to_owned(),
        },
        _ => DashboardToolPickerMode::Create,
    };
    let mut state = DashboardToolPickerState::with_mode(tools, mode);
    state.index = host
        .get("toolPickerIndex")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    Value::String(render_tool_picker_overlay(
        &state,
        int_field(input, "cols", 80),
        int_field(input, "rows", 24),
    ))
}

fn default_config_tools() -> Value {
    json!({
        "claude": { "command": "claude", "args": ["--base"], "enabled": true },
        "codex": { "command": "codex", "args": ["--base"], "enabled": true },
        "aider": { "command": "aider", "args": [], "enabled": true },
    })
}

fn launch_options_state(value: &Value) -> Option<DashboardLaunchOptionsState> {
    value.as_object()?;
    Some(DashboardLaunchOptionsState {
        tool_key: str_field(value, "toolKey").unwrap_or_default().to_owned(),
        args: line_state(value_field(value, "args")),
        env: line_state(value_field(value, "env")),
        active_field: match str_field(value, "activeField").unwrap_or("args") {
            "env" => LaunchOptionsField::Env,
            _ => LaunchOptionsField::Args,
        },
        error: value
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn line_state(value: &Value) -> LineState {
    LineState {
        text: str_field(value, "text").unwrap_or_default().to_owned(),
        cursor: value
            .get("cursor")
            .and_then(Value::as_u64)
            .unwrap_or_else(|| str_field(value, "text").unwrap_or_default().len() as u64)
            as usize,
    }
}

fn format_env_defaults(env: Option<&Value>) -> String {
    env.and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| {
                    format!(
                        "{key}={}",
                        quote_shell_arg(value.as_str().unwrap_or_default())
                    )
                })
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
}

fn defaults_launch_override(tool: &Value) -> Value {
    let default_args = tool
        .get("defaultArgs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let base_args = tool
        .get("args")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![json!("--base")]);
    let has_env = tool
        .get("defaultEnv")
        .and_then(Value::as_object)
        .map(|object| !object.is_empty())
        .unwrap_or(false);
    if default_args.is_empty() && !has_env {
        return Value::Null;
    }

    let mut args = base_args;
    args.extend(default_args);
    let mut output = Map::new();
    output.insert(
        "command".to_owned(),
        Value::String(str_field(tool, "command").unwrap_or("claude").to_owned()),
    );
    output.insert("args".to_owned(), Value::Array(args));
    if has_env {
        output.insert(
            "env".to_owned(),
            tool.get("defaultEnv").cloned().unwrap_or(Value::Null),
        );
    }
    Value::Object(output)
}

fn run_selected_tool(input: &Value) -> Value {
    let mut host = ContractHost::new(value_field(input, "host"));
    let tool_key = str_field(input, "toolKey").unwrap_or_default();
    let tool = value_field(input, "tool");
    let overseer = host.tool_picker_overseer;
    let scribe = host.tool_picker_scribe;
    host.tool_picker_overseer = false;
    host.tool_picker_scribe = false;
    let worktree_path = if overseer || scribe {
        None
    } else if host.mode == "dashboard" {
        host.focused_worktree_path.clone()
    } else {
        None
    };
    let override_value = input.pointer("/options/override").cloned().or_else(|| {
        let value = defaults_launch_override(tool);
        (!value.is_null()).then_some(value)
    });
    host.launch_options_state = Value::Null;

    match host.picker_mode.as_str() {
        "switch-tool" => {
            let session_id = host.switch_tool_source_session_id.clone();
            host.picker_mode = "create".into();
            host.fork_source_session_id = Value::Null;
            host.switch_tool_source_session_id = Value::Null;
            if session_id.is_null() || session_id.as_str().unwrap_or_default().is_empty() {
                host.call(
                    "showDashboardError",
                    json!([
                        "Cannot switch agent tool",
                        ["Switch source was lost before tool selection. Try again."]
                    ]),
                );
                return host.snapshot(false);
            }
            host.call(
                "switchAgentTool",
                json!([session_id, tool_key, override_value.unwrap_or(Value::Null)]),
            );
        }
        "fork" => {
            let source_session_id = host.fork_source_session_id.clone();
            host.picker_mode = "create".into();
            host.fork_source_session_id = Value::Null;
            if source_session_id.is_null()
                || source_session_id.as_str().unwrap_or_default().is_empty()
            {
                host.call(
                    "showDashboardError",
                    json!([
                        "Cannot fork session",
                        ["Fork source was lost before tool selection. Try again."]
                    ]),
                );
                return host.snapshot(false);
            }
            let command = str_field(tool, "command").unwrap_or_default();
            host.call("generateDashboardSessionId", json!([command]));
            let target_session_id = format!("{command}-generated");
            let mut request = Map::new();
            request.insert("sourceSessionId".into(), source_session_id);
            request.insert("targetToolConfigKey".into(), Value::String(tool_key.into()));
            request.insert("targetSessionId".into(), Value::String(target_session_id));
            if let Some(worktree_path) = worktree_path {
                request.insert("targetWorktreePath".into(), Value::String(worktree_path));
            }
            request.insert("open".into(), Value::Bool(false));
            if let Some(override_value) = override_value {
                request.insert("launchOverride".into(), override_value);
            }
            host.call("forkAgent", Value::Array(vec![Value::Object(request)]));
        }
        _ => {
            host.picker_mode = "create".into();
            host.fork_source_session_id = Value::Null;
            host.switch_tool_source_session_id = Value::Null;
            let command = str_field(tool, "command").unwrap_or_default();
            host.call("generateDashboardSessionId", json!([command]));
            let session_id = format!("{command}-generated");
            let override_value = override_value.unwrap_or(Value::Null);
            let launch_command = str_field(&override_value, "command").unwrap_or(command);
            let launch_args = override_value
                .get("args")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_else(|| {
                    tool.get("args")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default()
                });
            let env = override_value.get("env").cloned().unwrap_or(Value::Null);
            host.call(
                "createSession",
                json!([
                    launch_command,
                    launch_args,
                    tool.get("preambleFlag").cloned().unwrap_or(Value::Null),
                    tool_key,
                    null,
                    tool.get("sessionIdFlag").cloned().unwrap_or(Value::Null),
                    worktree_path.map(Value::String).unwrap_or(Value::Null),
                    null,
                    session_id,
                    false,
                    false,
                    null,
                    env
                ]),
            );
        }
    }
    host.snapshot(false)
}

fn show_tool_picker(input: &Value) -> Value {
    let mut host = ContractHost::new(value_field(input, "host"));
    let source_session_id = input.get("sourceSessionId").cloned().unwrap_or(Value::Null);
    let mode = input
        .pointer("/options/mode")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            if source_session_id.is_null() {
                "create".into()
            } else {
                "fork".into()
            }
        });
    host.picker_mode = mode.clone();
    host.fork_source_session_id = if mode == "fork" {
        source_session_id.clone()
    } else {
        Value::Null
    };
    host.switch_tool_source_session_id = if mode == "switch-tool" {
        source_session_id
    } else {
        Value::Null
    };
    host.tool_picker_overseer = false;
    host.tool_picker_scribe = false;
    host.tool_picker_index = Some(0);
    host.launch_options_state = Value::Null;
    host.call("openDashboardOverlay", json!(["tool-picker"]));
    host.call("redrawDashboardWithOverlay", json!([]));
    host.snapshot(true)
}

struct ContractHost {
    picker_mode: String,
    fork_source_session_id: Value,
    switch_tool_source_session_id: Value,
    tool_picker_overseer: bool,
    tool_picker_scribe: bool,
    tool_picker_index: Option<i64>,
    launch_options_state: Value,
    mode: String,
    focused_worktree_path: Option<String>,
    calls: Map<String, Value>,
}

impl ContractHost {
    fn new(host: &Value) -> Self {
        Self {
            picker_mode: str_field(host, "pickerMode").unwrap_or("create").to_owned(),
            fork_source_session_id: host
                .get("forkSourceSessionId")
                .cloned()
                .unwrap_or(Value::Null),
            switch_tool_source_session_id: host
                .get("switchToolSourceSessionId")
                .cloned()
                .unwrap_or(Value::Null),
            tool_picker_overseer: host
                .get("toolPickerOverseer")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            tool_picker_scribe: host
                .get("toolPickerScribe")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            tool_picker_index: host.get("toolPickerIndex").and_then(Value::as_i64),
            launch_options_state: host
                .get("launchOptionsState")
                .cloned()
                .unwrap_or(Value::Null),
            mode: str_field(host, "mode").unwrap_or("session").to_owned(),
            focused_worktree_path: host
                .get("focusedWorktreePath")
                .and_then(Value::as_str)
                .map(str::to_owned),
            calls: empty_calls(),
        }
    }

    fn call(&mut self, name: &str, args: Value) {
        self.calls
            .get_mut(name)
            .and_then(Value::as_array_mut)
            .expect("known call")
            .push(args);
    }

    fn snapshot(self, include_index: bool) -> Value {
        let mut output = Map::new();
        output.insert("pickerMode".into(), Value::String(self.picker_mode));
        output.insert("forkSourceSessionId".into(), self.fork_source_session_id);
        output.insert(
            "switchToolSourceSessionId".into(),
            self.switch_tool_source_session_id,
        );
        output.insert(
            "toolPickerOverseer".into(),
            Value::Bool(self.tool_picker_overseer),
        );
        output.insert(
            "toolPickerScribe".into(),
            Value::Bool(self.tool_picker_scribe),
        );
        if include_index {
            output.insert(
                "toolPickerIndex".into(),
                Value::from(self.tool_picker_index.unwrap_or(0)),
            );
        }
        output.insert("launchOptionsState".into(), self.launch_options_state);
        output.insert("calls".into(), Value::Object(self.calls));
        Value::Object(output)
    }
}

fn empty_calls() -> Map<String, Value> {
    [
        "generateDashboardSessionId",
        "switchAgentTool",
        "forkAgent",
        "createSession",
        "showDashboardError",
        "openDashboardOverlay",
        "redrawDashboardWithOverlay",
        "getViewportSize",
        "clearDashboardOverlay",
        "restoreDashboardAfterOverlayDismiss",
    ]
    .into_iter()
    .map(|name| (name.to_owned(), Value::Array(Vec::new())))
    .collect()
}

fn quote_shell_arg(arg: &str) -> String {
    if arg.is_empty() {
        return "''".to_owned();
    }
    if arg
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || "_./:=@%+,-".contains(ch))
    {
        return arg.to_owned();
    }
    format!("'{}'", arg.replace('\'', "'\\''"))
}

fn value_field<'a>(value: &'a Value, field: &str) -> &'a Value {
    value.get(field).unwrap_or(&Value::Null)
}

fn str_field<'a>(value: &'a Value, field: &str) -> Option<&'a str> {
    value.get(field).and_then(Value::as_str)
}

fn int_field(value: &Value, field: &str, fallback: usize) -> usize {
    value
        .get(field)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(fallback)
}
