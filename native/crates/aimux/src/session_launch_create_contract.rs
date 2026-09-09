use serde_json::{Value, json};

pub fn run_session_launch_create_contract_case(api: &str, input: &Value) -> Value {
    let mut state = CreateSessionState::new(input);
    state.run(api, input)
}

struct CreateSessionState {
    sessions: Vec<Value>,
    active_index: i64,
    started_in_dashboard: bool,
    mode: String,
    targets: Vec<Value>,
    tool_keys: Vec<Value>,
    original_args: Vec<Value>,
    worktree_paths: Vec<Value>,
    calls: Vec<Value>,
}

impl CreateSessionState {
    fn new(input: &Value) -> Self {
        let host = value_field(input, "host");
        Self {
            sessions: array_field(host, "sessions")
                .into_iter()
                .map(|session| session_summary(&session))
                .collect(),
            active_index: int_field(host, "activeIndex").unwrap_or(0),
            started_in_dashboard: bool_field(host, "startedInDashboard"),
            mode: string_field(host, "mode").unwrap_or_else(|| "session".into()),
            targets: Vec::new(),
            tool_keys: Vec::new(),
            original_args: Vec::new(),
            worktree_paths: Vec::new(),
            calls: Vec::new(),
        }
    }

    fn run(&mut self, api: &str, input: &Value) -> Value {
        let call = value_field(input, "call");
        let command = string_field(call, "command").unwrap_or_default();
        let args = array_field(call, "args");
        let tool_config_key = string_field(call, "toolConfigKey");
        let worktree_path = string_field(call, "worktreePath");
        let session_id = string_field(call, "sessionIdOverride").unwrap_or_else(|| command.clone());
        if self
            .sessions
            .iter()
            .any(|session| string_field(session, "id").as_deref() == Some(session_id.as_str()))
        {
            return self.output(
                Value::Null,
                Value::String(format!("Session \"{session_id}\" already exists")),
            );
        }

        let tool_cfg = tool_config_key
            .as_deref()
            .and_then(|key| value_field(value_field(input, "config"), "tools").get(key));
        let is_configured_tool_command = tool_cfg
            .and_then(|tool| string_field(tool, "command"))
            .as_deref()
            == Some(command.as_str());
        let executable = command_executable(&command);
        let is_configured_claude = is_configured_tool_command && executable == "claude";
        let is_configured_codex = is_configured_tool_command && executable == "codex";
        let is_claude_resume =
            is_configured_claude && should_skip_claude_session_id_injection(&args);
        let backend_session_id = string_field(call, "backendSessionIdOverride")
            .or_else(|| {
                is_configured_claude
                    .then(|| extract_backend_session_id_from_args(&args))
                    .flatten()
            })
            .or_else(|| {
                is_configured_codex
                    .then(|| extract_backend_session_id_from_args(&args))
                    .flatten()
            });
        let suppress_startup_preamble = bool_field(call, "suppressStartupPreamble");
        let preamble = if suppress_startup_preamble {
            String::new()
        } else {
            self.call(
                "sessionBootstrap.buildSessionPreamble",
                vec![build_preamble_options(
                    &session_id,
                    &command,
                    worktree_path.as_deref(),
                    string_field(call, "extraPreamble").as_deref(),
                    call.get("team"),
                )],
            );
            string_field(input, "preamble").unwrap_or_default()
        };

        self.call(
            "sessionBootstrap.ensurePlanFile",
            vec![
                Value::String(session_id.clone()),
                Value::String(command.clone()),
                worktree_path
                    .clone()
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            ],
        );

        let mut final_args = args.clone();
        let preamble_flag = array_field(call, "preambleFlag");
        if is_configured_tool_command
            && !suppress_startup_preamble
            && !preamble_flag.is_empty()
            && !preamble.trim().is_empty()
        {
            final_args.extend(preamble_flag);
            final_args.push(Value::String(preamble.clone()));
        }
        if is_configured_codex
            && !suppress_startup_preamble
            && !preamble.trim().is_empty()
            && tool_cfg
                .and_then(|tool| tool.get("developerInstructionsConfigKey"))
                .and_then(Value::as_str)
                .is_some()
        {
            final_args = inject_codex_developer_instruction_values(
                &final_args,
                "developer_instructions",
                &preamble,
            );
        }
        let session_id_flag = array_field(call, "sessionIdFlag");
        if is_configured_tool_command
            && !is_claude_resume
            && !session_id_flag.is_empty()
            && let Some(backend_id) = backend_session_id.as_deref()
        {
            for flag in session_id_flag {
                final_args.push(Value::String(
                    flag.as_str()
                        .unwrap_or_default()
                        .replace("{sessionId}", backend_id),
                ));
            }
        }
        if is_configured_tool_command
            && !suppress_startup_preamble
            && !preamble_flag_is_empty(call)
            && !preamble.is_empty()
        {
            self.call(
                "sessionBootstrap.finalizePreamble",
                vec![
                    Value::String(command.clone()),
                    Value::String(preamble.clone()),
                ],
            );
        }

        let launch_command;
        if is_configured_codex {
            let mut wrapped_args = vec![
                Value::String("-c".into()),
                Value::String("features.hooks=true".into()),
                Value::String("--dangerously-bypass-hook-trust".into()),
            ];
            wrapped_args.extend(final_args);
            (launch_command, final_args) = managed_env_args(
                &command,
                wrapped_args,
                &session_id,
                tool_config_key.as_deref(),
                true,
                value_field(call, "launchEnv"),
            );
        } else if is_configured_claude {
            let mut claude_args = vec![
                Value::String("--settings".into()),
                Value::String("<REPO>/home/projects/aimux-session-launch-create/claude-settings/<SESSION>.json".into()),
            ];
            claude_args.extend(final_args);
            (launch_command, final_args) = managed_env_args(
                &command,
                claude_args,
                &session_id,
                tool_config_key.as_deref(),
                false,
                value_field(call, "launchEnv"),
            );
        } else if value_field(call, "launchEnv").is_object() {
            (launch_command, final_args) = managed_env_args(
                &command,
                final_args,
                &session_id,
                tool_config_key.as_deref(),
                false,
                value_field(call, "launchEnv"),
            );
        } else {
            launch_command = command.clone();
        }

        let async_launch = api == "createSessionAsync";
        self.call(
            if async_launch {
                "tmuxRuntimeManager.ensureProjectSessionAsync"
            } else {
                "tmuxRuntimeManager.ensureProjectSession"
            },
            vec![Value::String("/private<REPO>".into())],
        );
        self.call("getSessionLabel", vec![Value::String(session_id.clone())]);
        self.call(
            if async_launch {
                "tmuxRuntimeManager.createWindowAsync"
            } else {
                "tmuxRuntimeManager.createWindow"
            },
            vec![
                Value::String("aimux-test".into()),
                Value::String(command.clone()),
                worktree_path
                    .clone()
                    .map(Value::String)
                    .unwrap_or(Value::Null),
                Value::String(launch_command),
                Value::Array(final_args.clone()),
                json!({ "detached": bool_field(call, "detachedInTmux") }),
            ],
        );
        self.call(
            if async_launch {
                "tmuxRuntimeManager.clearTargetHistoryAsync"
            } else {
                "tmuxRuntimeManager.clearTargetHistory"
            },
            vec![target_json()],
        );
        self.register_session(
            &session_id,
            &command,
            &args,
            tool_config_key.as_deref(),
            worktree_path.as_deref(),
            call.get("team"),
        );

        if async_launch {
            self.call(
                "buildTmuxWindowMetadata",
                vec![
                    Value::String(session_id.clone()),
                    Value::String(command.clone()),
                ],
            );
            self.call(
                "tmuxRuntimeManager.setWindowMetadataAsync",
                vec![
                    target_json(),
                    build_metadata(
                        &session_id,
                        &command,
                        tool_config_key.as_deref(),
                        backend_session_id.as_deref(),
                        worktree_path.as_deref(),
                        call.get("team"),
                    ),
                ],
            );
            if bool_field(input, "failAsyncMetadata") {
                self.rollback_session(&session_id);
                self.call("updateContextWatcherSessions", vec![]);
                self.call("tmuxRuntimeManager.killWindowAsync", vec![target_json()]);
                return self.output(Value::Null, Value::String("metadata write failed".into()));
            }
            self.call(
                "tmuxRuntimeManager.applyManagedAgentWindowPolicyAsync",
                vec![
                    target_json(),
                    tool_config_key
                        .clone()
                        .map(Value::String)
                        .unwrap_or(Value::Null),
                ],
            );
        } else {
            self.call(
                "syncTmuxWindowMetadata",
                vec![Value::String(session_id.clone())],
            );
        }

        self.set_session_backend(&session_id, backend_session_id.as_deref());
        self.active_index = self.sessions.len().saturating_sub(1) as i64;
        if self.started_in_dashboard && self.mode == "dashboard" {
            self.call("invalidateDesktopStateSnapshot", vec![]);
            self.call("refreshLocalDashboardModel", vec![]);
            self.call("updateWorktreeSessions", vec![]);
            if !is_project_control(call.get("team")) {
                self.call(
                    "preferDashboardEntrySelection",
                    vec![
                        Value::String("session".into()),
                        Value::String(session_id.clone()),
                        worktree_path
                            .clone()
                            .map(Value::String)
                            .unwrap_or(Value::Null),
                    ],
                );
            }
            self.call("renderCurrentDashboardView", vec![]);
        }
        self.call("saveState", vec![]);
        self.output(
            session_summary(&json!({
                "id": session_id,
                "command": command,
                "backendSessionId": backend_session_id,
                "exited": false,
            })),
            Value::Null,
        )
    }

    fn register_session(
        &mut self,
        session_id: &str,
        command: &str,
        args: &[Value],
        tool_config_key: Option<&str>,
        worktree_path: Option<&str>,
        team: Option<&Value>,
    ) {
        self.sessions.push(session_summary(&json!({
            "id": session_id,
            "command": command,
            "backendSessionId": null,
            "exited": false,
        })));
        self.targets.push(json!([session_id, target_json()]));
        if let Some(tool) = tool_config_key {
            self.tool_keys.push(json!([session_id, tool]));
        }
        self.original_args.push(json!([session_id, args]));
        self.worktree_paths
            .push(json!([session_id, worktree_path.unwrap_or("<REPO>")]));
        self.call(
            "registerManagedSession",
            vec![
                session_summary(&json!({
                    "id": session_id,
                    "command": command,
                    "backendSessionId": null,
                    "exited": false,
                })),
                Value::Array(args.to_vec()),
                tool_config_key
                    .map(|value| Value::String(value.to_owned()))
                    .unwrap_or(Value::Null),
                worktree_path
                    .map(|value| Value::String(value.to_owned()))
                    .unwrap_or(Value::Null),
                Value::Null,
                Value::String("<TIMESTAMP>".into()),
                team.cloned().unwrap_or(Value::Null),
            ],
        );
    }

    fn rollback_session(&mut self, session_id: &str) {
        self.sessions
            .retain(|session| string_field(session, "id").as_deref() != Some(session_id));
        self.targets
            .retain(|entry| entry.get(0).and_then(Value::as_str) != Some(session_id));
        self.tool_keys
            .retain(|entry| entry.get(0).and_then(Value::as_str) != Some(session_id));
        self.original_args
            .retain(|entry| entry.get(0).and_then(Value::as_str) != Some(session_id));
        self.worktree_paths
            .retain(|entry| entry.get(0).and_then(Value::as_str) != Some(session_id));
    }

    fn set_session_backend(&mut self, session_id: &str, backend_session_id: Option<&str>) {
        for session in &mut self.sessions {
            if string_field(session, "id").as_deref() == Some(session_id)
                && let Some(object) = session.as_object_mut()
            {
                object.insert(
                    "backendSessionId".into(),
                    backend_session_id
                        .map(|value| Value::String(value.to_owned()))
                        .unwrap_or(Value::Null),
                );
            }
        }
    }

    fn output(&self, result: Value, error: Value) -> Value {
        json!({
            "result": result,
            "error": error,
            "host": {
                "activeIndex": self.active_index,
                "sessions": self.sessions,
                "targets": self.targets,
                "toolKeys": self.tool_keys,
                "originalArgs": self.original_args,
                "worktreePaths": self.worktree_paths,
            },
            "calls": self.calls,
        })
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }
}

fn managed_env_args(
    command: &str,
    args: Vec<Value>,
    session_id: &str,
    tool_config_key: Option<&str>,
    codex: bool,
    launch_env: &Value,
) -> (String, Vec<Value>) {
    let mut env_args = vec![
        Value::String("-i".into()),
        Value::String("AIMUX_DAEMON_PORT=43190".into()),
        Value::String("AIMUX_ENV=production".into()),
        Value::String("AIMUX_HOME=<REPO>/home".into()),
        Value::String(if codex {
            "TERM=tmux-256color".into()
        } else {
            "TERM=xterm-256color".into()
        }),
    ];
    if let Some(extra) = launch_env.as_object()
        && let Some(value) = extra.get("CLAUDE_YOLO").and_then(Value::as_str)
    {
        env_args.push(Value::String(format!("CLAUDE_YOLO={value}")));
    }
    if codex || command == "claude" {
        env_args.push(Value::String(
            "AIMUX_METADATA_ENDPOINT_FILE=<REPO>/home/projects/aimux-session-launch-create/metadata-api.txt".into(),
        ));
        env_args.push(Value::String(format!("AIMUX_SESSION_ID={session_id}")));
        if codex {
            env_args.push(Value::String("AIMUX_PROJECT_ROOT=/private<REPO>".into()));
        }
        env_args.push(Value::String(format!(
            "AIMUX_TOOL={}",
            tool_config_key.unwrap_or(command)
        )));
    }
    env_args.push(Value::String(command.into()));
    env_args.extend(args);
    ("env".into(), env_args)
}

fn build_preamble_options(
    session_id: &str,
    command: &str,
    worktree_path: Option<&str>,
    extra_preamble: Option<&str>,
    team: Option<&Value>,
) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("sessionId".into(), Value::String(session_id.into()));
    object.insert("command".into(), Value::String(command.into()));
    if let Some(worktree_path) = worktree_path {
        object.insert("worktreePath".into(), Value::String(worktree_path.into()));
    }
    if let Some(extra_preamble) = extra_preamble {
        object.insert("extraPreamble".into(), Value::String(extra_preamble.into()));
    }
    object.insert("includeAimuxPreamble".into(), Value::Bool(true));
    if let Some(team) = team
        && !team.is_null()
    {
        object.insert("team".into(), team.clone());
    }
    Value::Object(object)
}

fn inject_codex_developer_instruction_values(
    args: &[Value],
    key: &str,
    preamble: &str,
) -> Vec<Value> {
    let strings = args
        .iter()
        .map(|arg| arg.as_str().unwrap_or_default().to_owned())
        .collect::<Vec<_>>();
    let insertion_index = first_codex_positional_arg_index(&strings);
    let mut output = Vec::with_capacity(args.len() + 2);
    output.extend(args[..insertion_index].iter().cloned());
    output.push(Value::String("-c".into()));
    output.push(Value::String(format!("{key}={}", json!(preamble))));
    output.extend(args[insertion_index..].iter().cloned());
    output
}

fn first_codex_positional_arg_index(args: &[String]) -> usize {
    let options_with_value = [
        "-a",
        "--add-dir",
        "--ask-for-approval",
        "-c",
        "--cd",
        "--config",
        "-i",
        "--image",
        "--local-provider",
        "-m",
        "--model",
        "-p",
        "--profile",
        "--remote",
        "--remote-auth-token-env",
        "-s",
        "--sandbox",
    ];
    let mut skip_next = false;
    for (index, arg) in args.iter().enumerate() {
        if skip_next {
            skip_next = false;
            continue;
        }
        if arg == "--" {
            return index;
        }
        if arg.starts_with("--") {
            let (name, has_value) = arg
                .split_once('=')
                .map_or((arg.as_str(), false), |(name, _)| (name, true));
            if options_with_value.contains(&name) && !has_value {
                skip_next = true;
            }
            continue;
        }
        if arg.starts_with('-') {
            if options_with_value.contains(&arg.as_str()) {
                skip_next = true;
            }
            continue;
        }
        return index;
    }
    args.len()
}

fn should_skip_claude_session_id_injection(args: &[Value]) -> bool {
    args.iter().filter_map(Value::as_str).any(|arg| {
        arg == "--resume"
            || arg.starts_with("--resume=")
            || arg == "--session-id"
            || arg.starts_with("--session-id=")
            || arg == "--continue"
            || arg == "-c"
    })
}

fn extract_backend_session_id_from_args(args: &[Value]) -> Option<String> {
    let values = args.iter().filter_map(Value::as_str).collect::<Vec<_>>();
    for (index, arg) in values.iter().enumerate() {
        if (*arg == "--session-id" || *arg == "--resume")
            && values
                .get(index + 1)
                .is_some_and(|value| !value.trim().is_empty() && !value.trim().starts_with('-'))
        {
            return values.get(index + 1).map(|value| value.trim().to_owned());
        }
        if let Some(value) = arg
            .strip_prefix("--session-id=")
            .or_else(|| arg.strip_prefix("--resume="))
            && !value.trim().is_empty()
            && !value.trim().starts_with('-')
        {
            return Some(value.trim().to_owned());
        }
    }
    None
}

fn preamble_flag_is_empty(call: &Value) -> bool {
    array_field(call, "preambleFlag").is_empty()
}

fn is_project_control(team: Option<&Value>) -> bool {
    matches!(
        team.and_then(|value| value.get("role"))
            .and_then(Value::as_str),
        Some("overseer" | "scribe")
    )
}

fn command_executable(command: &str) -> String {
    command
        .rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or(command)
        .to_owned()
}

fn build_metadata(
    session_id: &str,
    command: &str,
    tool_config_key: Option<&str>,
    backend_session_id: Option<&str>,
    worktree_path: Option<&str>,
    team: Option<&Value>,
) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("kind".into(), Value::String("agent".into()));
    object.insert("sessionId".into(), Value::String(session_id.into()));
    object.insert("command".into(), Value::String(command.into()));
    object.insert(
        "toolConfigKey".into(),
        Value::String(tool_config_key.unwrap_or(command).into()),
    );
    if let Some(backend_session_id) = backend_session_id {
        object.insert(
            "backendSessionId".into(),
            Value::String(backend_session_id.into()),
        );
    }
    if let Some(team) = team
        && !team.is_null()
    {
        object.insert("team".into(), team.clone());
    }
    if let Some(worktree_path) = worktree_path {
        object.insert("worktreePath".into(), Value::String(worktree_path.into()));
    }
    object.insert("createdAt".into(), Value::String("<ISO_DATE>".into()));
    Value::Object(object)
}

fn target_json() -> Value {
    json!({ "sessionName": "aimux-test", "windowId": "@1", "windowName": "agent" })
}

fn session_summary(session: &Value) -> Value {
    json!({
        "id": session.get("id").cloned().unwrap_or(Value::Null),
        "command": session.get("command").cloned().unwrap_or(Value::Null),
        "backendSessionId": session.get("backendSessionId").cloned().unwrap_or(Value::Null),
        "exited": session.get("exited").cloned().unwrap_or(Value::Null),
    })
}

fn value_field<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or(&Value::Null)
}

fn array_field(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool) == Some(true)
}

fn int_field(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}
