use serde_json::{Value, json};

pub fn run_session_launch_migrate_switch_contract_case(api: &str, input: &Value) -> Value {
    let mut state = MigrateSwitchState::new(input);
    match api {
        "migrateAgent" => state.run_migrate(input),
        "switchAgentTool" => state.run_switch(input),
        api => panic!("unknown session launch migrate/switch api: {api}"),
    }
}

struct MigrateSwitchState {
    sessions: Vec<Value>,
    active_index: i64,
    tool_keys: Vec<Value>,
    original_args: Vec<Value>,
    worktree_paths: Vec<Value>,
    targets: Vec<Value>,
    calls: Vec<Value>,
}

impl MigrateSwitchState {
    fn new(input: &Value) -> Self {
        let host = value_field(input, "host");
        Self {
            sessions: array_field(host, "sessions")
                .into_iter()
                .map(|session| session_summary(&session))
                .collect(),
            active_index: int_field(host, "activeIndex").unwrap_or(0),
            tool_keys: array_field(host, "sessionToolKeys"),
            original_args: array_field(host, "sessionOriginalArgs"),
            worktree_paths: array_field(host, "sessionWorktreePaths"),
            targets: Vec::new(),
            calls: Vec::new(),
        }
    }

    fn run_migrate(&mut self, input: &Value) -> Value {
        let session_id = string_field(input, "sessionId").unwrap_or_default();
        let Some(session) = self.find_session(&session_id).cloned() else {
            return self.output(Value::String(format!("Session \"{session_id}\" not found")));
        };
        let command = string_field(&session, "command").unwrap_or_default();
        let tool_key = self
            .map_lookup(&self.tool_keys, &session_id)
            .unwrap_or_else(|| command.clone());
        let tool = normalized_tool(&tool_key);
        let source_worktree = self.map_lookup(&self.worktree_paths, &session_id);
        let source_cwd = source_worktree.unwrap_or_else(|| "<REPO>".into());
        let target_worktree =
            string_field(input, "targetWorktreePath").unwrap_or_else(|| "<TARGET>".into());
        let original = self
            .map_lookup_value(&self.original_args, &session_id)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        self.call(
            "sessionBootstrap.stripToolActionArgs",
            vec![tool.clone(), Value::Array(original.clone())],
        );
        let backend_id = string_field(&session, "backendSessionId");
        self.call(
            "sessionBootstrap.canResumeWithBackendSessionId",
            vec![
                tool.clone(),
                backend_id.clone().map(Value::String).unwrap_or(Value::Null),
            ],
        );
        self.call(
            "contextWatcher.syncNow",
            vec![Value::String(session_id.clone())],
        );
        self.call(
            "sessionBootstrap.readForkSourceSnapshot",
            vec![Value::String(session_id.clone())],
        );

        let use_backend = bool_field(input, "canResumeWithBackendSessionId");
        let mut migrate_args = original.clone();
        let extra_preamble = if use_backend {
            let resume_args = resume_args(&tool_key, backend_id.as_deref().unwrap_or_default());
            self.call(
                "sessionBootstrap.composeToolArgs",
                vec![
                    tool.clone(),
                    Value::Array(resume_args.clone()),
                    Value::Array(original.clone()),
                ],
            );
            migrate_args.extend(resume_args);
            format!(
                "You have been moved from {source_cwd} to {target_worktree}. Work in the new path from now on; paths in your earlier messages point at the old one."
            )
        } else {
            String::new()
        };

        self.kill_session(&session_id);
        let continuity = if use_backend {
            extra_preamble
        } else {
            let snapshot = value_field(input, "sourceSnapshot").clone();
            self.call(
                "sessionBootstrap.buildCodexMigrationContinuityPreamble",
                vec![
                    Value::String(session_id.clone()),
                    Value::String(source_cwd),
                    Value::String(target_worktree.clone()),
                    snapshot,
                ],
            );
            string_field(input, "migrationPreamble").unwrap_or_else(|| "continuity preamble".into())
        };

        let team = session
            .get("team")
            .filter(|value| !value.is_null())
            .cloned();
        self.create_relaunch(CreateRelaunch {
            session_id: &session_id,
            command: &command,
            args: migrate_args,
            tool_key: &tool_key,
            worktree_path: &target_worktree,
            backend_id: use_backend.then(|| backend_id.clone()).flatten(),
            extra_preamble: Some(continuity),
            detached: !has_preamble_flag(&tool_key),
            team,
            launch_env: Value::Null,
            persist_args: original,
        });
        self.output(Value::Null)
    }

    fn run_switch(&mut self, input: &Value) -> Value {
        let session_id = string_field(input, "sessionId").unwrap_or_default();
        let Some(session) = self.find_session(&session_id).cloned() else {
            return self.output(Value::String(format!("Session \"{session_id}\" not found")));
        };
        if bool_field(&session, "exited") {
            return self.output(Value::String(format!(
                "Session \"{session_id}\" is not live"
            )));
        }
        let target_tool = string_field(input, "targetToolConfigKey").unwrap_or_default();
        if target_tool == "missing" {
            return self.output(Value::String("Unknown tool config: missing".into()));
        }
        if target_tool == "disabled" {
            return self.output(Value::String("Tool config \"disabled\" is disabled".into()));
        }
        let source_tool = self
            .map_lookup(&self.tool_keys, &session_id)
            .or_else(|| string_field(&session, "command"))
            .unwrap_or_default();
        if source_tool == target_tool && value_field(input, "launchOverride").is_null() {
            return self.output(Value::Null);
        }

        let target_tool_cfg = normalized_tool(&target_tool);
        let launch_override = value_field(input, "launchOverride");
        let target_args = if launch_override.is_object() {
            array_field(launch_override, "args")
        } else {
            array_field(&target_tool_cfg, "args")
        };
        self.call(
            "sessionBootstrap.stripToolActionArgs",
            vec![target_tool_cfg, Value::Array(target_args.clone())],
        );
        self.call(
            "contextWatcher.syncNow",
            vec![Value::String(session_id.clone())],
        );
        self.call(
            "sessionBootstrap.readForkSourceSnapshot",
            vec![Value::String(session_id.clone())],
        );
        self.call(
            "sessionBootstrap.buildToolSwitchContinuityPreamble",
            vec![build_switch_preamble_options(
                &session_id,
                &source_tool,
                &target_tool,
                value_field(input, "sourceSnapshot"),
                string_field(input, "instruction").as_deref(),
            )],
        );
        self.kill_session(&session_id);
        let command = string_field(launch_override, "command")
            .unwrap_or_else(|| target_tool_command(&target_tool));
        let worktree_path = self
            .map_lookup(&self.worktree_paths, &session_id)
            .unwrap_or_else(|| "<REPO>".into());
        let team = session
            .get("team")
            .filter(|value| !value.is_null())
            .cloned();
        self.create_relaunch(CreateRelaunch {
            session_id: &session_id,
            command: &command,
            args: target_args.clone(),
            tool_key: &target_tool,
            worktree_path: &worktree_path,
            backend_id: None,
            extra_preamble: Some(
                string_field(input, "switchPreamble").unwrap_or_else(|| "switch continuity".into()),
            ),
            detached: true,
            team,
            launch_env: launch_override.get("env").cloned().unwrap_or(Value::Null),
            persist_args: target_args,
        });
        self.output(Value::Null)
    }

    fn create_relaunch(&mut self, launch: CreateRelaunch<'_>) {
        self.call(
            "sessionBootstrap.buildSessionPreamble",
            vec![build_session_preamble_options(
                launch.session_id,
                launch.command,
                launch.worktree_path,
                launch.extra_preamble.as_deref(),
                launch.team.as_ref(),
            )],
        );
        self.call(
            "sessionBootstrap.ensurePlanFile",
            vec![
                Value::String(launch.session_id.into()),
                Value::String(launch.command.into()),
                Value::String(launch.worktree_path.into()),
            ],
        );
        self.call(
            "tmuxRuntimeManager.ensureProjectSession",
            vec![Value::String(format!("/private{}", launch.worktree_path))],
        );
        self.call(
            "getSessionLabel",
            vec![Value::String(launch.session_id.into())],
        );
        self.call(
            "tmuxRuntimeManager.createWindow",
            vec![
                Value::String("aimux-test".into()),
                Value::String("agent".into()),
                Value::String(launch.worktree_path.into()),
                Value::String("env".into()),
                Value::Array(launch_args(&launch)),
                json!({ "detached": launch.detached }),
            ],
        );
        self.call("tmuxRuntimeManager.clearTargetHistory", vec![target_json()]);
        self.sessions.push(session_summary(&json!({
            "id": launch.session_id,
            "command": launch.command,
            "backendSessionId": launch.backend_id,
            "exited": false,
            "team": launch.team,
        })));
        self.targets.push(json!([launch.session_id, target_json()]));
        upsert_pair(
            &mut self.tool_keys,
            launch.session_id,
            Value::String(launch.tool_key.into()),
        );
        upsert_pair(
            &mut self.original_args,
            launch.session_id,
            Value::Array(launch.persist_args.clone()),
        );
        upsert_pair(
            &mut self.worktree_paths,
            launch.session_id,
            Value::String(launch.worktree_path.into()),
        );
        self.call(
            "registerManagedSession",
            vec![
                session_summary(&json!({
                    "id": launch.session_id,
                    "command": launch.command,
                    "backendSessionId": null,
                    "exited": false,
                    "team": null,
                })),
                Value::Array(launch.persist_args),
                Value::String(launch.tool_key.into()),
                Value::String(launch.worktree_path.into()),
                Value::Null,
                Value::String("<TIMESTAMP>".into()),
                launch.team.unwrap_or(Value::Null),
            ],
        );
        self.call(
            "syncTmuxWindowMetadata",
            vec![Value::String(launch.session_id.into())],
        );
        self.active_index = self.sessions.len().saturating_sub(1) as i64;
        self.call("saveState", vec![]);
    }

    fn kill_session(&mut self, session_id: &str) {
        self.call(&format!("session.{session_id}.kill"), vec![]);
        self.sessions
            .retain(|session| string_field(session, "id").as_deref() != Some(session_id));
    }

    fn find_session(&self, session_id: &str) -> Option<&Value> {
        self.sessions
            .iter()
            .find(|session| string_field(session, "id").as_deref() == Some(session_id))
    }

    fn map_lookup(&self, entries: &[Value], key: &str) -> Option<String> {
        self.map_lookup_value(entries, key)
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    fn map_lookup_value<'a>(&self, entries: &'a [Value], key: &str) -> Option<&'a Value> {
        entries.iter().find_map(|entry| {
            (entry.get(0).and_then(Value::as_str) == Some(key))
                .then(|| entry.get(1))
                .flatten()
        })
    }

    fn output(&self, error: Value) -> Value {
        json!({
            "error": error,
            "host": {
                "activeIndex": self.active_index,
                "sessions": self.sessions,
                "toolKeys": self.tool_keys,
                "originalArgs": self.original_args,
                "worktreePaths": self.worktree_paths,
                "targets": self.targets,
            },
            "calls": self.calls,
        })
    }

    fn call(&mut self, method: &str, args: Vec<Value>) {
        self.calls.push(json!({ "method": method, "args": args }));
    }
}

struct CreateRelaunch<'a> {
    session_id: &'a str,
    command: &'a str,
    args: Vec<Value>,
    tool_key: &'a str,
    worktree_path: &'a str,
    backend_id: Option<String>,
    extra_preamble: Option<String>,
    detached: bool,
    team: Option<Value>,
    launch_env: Value,
    persist_args: Vec<Value>,
}

fn launch_args(launch: &CreateRelaunch<'_>) -> Vec<Value> {
    let mut args = vec![
        Value::String("-i".into()),
        Value::String("AIMUX_DAEMON_PORT=43190".into()),
        Value::String("AIMUX_ENV=production".into()),
        Value::String("AIMUX_HOME=<REPO>/home".into()),
    ];
    let configured_codex = launch.tool_key == "codex" && launch.command == "codex";
    let configured_claude = launch.tool_key == "claude" && launch.command == "claude";
    args.push(Value::String(if configured_codex {
        "TERM=tmux-256color".into()
    } else {
        "TERM=xterm-256color".into()
    }));
    if !launch.launch_env.is_null()
        && let Some(value) = launch.launch_env.get("CLAUDE_YOLO").and_then(Value::as_str)
    {
        args.push(Value::String(format!("CLAUDE_YOLO={value}")));
    }
    if configured_codex || configured_claude {
        args.push(Value::String(
            "AIMUX_METADATA_ENDPOINT_FILE=<REPO>/home/projects/aimux-session-migrate-switch/metadata-api.txt".into(),
        ));
        args.push(Value::String(format!(
            "AIMUX_SESSION_ID={}",
            launch.session_id
        )));
        if configured_codex {
            args.push(Value::String(format!(
                "AIMUX_PROJECT_ROOT=/private{}",
                launch.worktree_path
            )));
        }
        args.push(Value::String(format!("AIMUX_TOOL={}", launch.tool_key)));
    }
    args.push(Value::String(launch.command.into()));
    if configured_codex {
        args.push(Value::String("-c".into()));
        args.push(Value::String("features.hooks=true".into()));
        args.push(Value::String("--dangerously-bypass-hook-trust".into()));
    }
    if configured_claude {
        args.push(Value::String("--settings".into()));
        args.push(Value::String(
            "<REPO>/home/projects/aimux-session-migrate-switch/claude-settings/<SESSION>.json"
                .into(),
        ));
    }
    args.extend(launch.args.clone());
    args
}

fn build_session_preamble_options(
    session_id: &str,
    command: &str,
    worktree_path: &str,
    extra_preamble: Option<&str>,
    team: Option<&Value>,
) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("sessionId".into(), Value::String(session_id.into()));
    object.insert("command".into(), Value::String(command.into()));
    object.insert("worktreePath".into(), Value::String(worktree_path.into()));
    if let Some(extra_preamble) = extra_preamble
        && !extra_preamble.trim().is_empty()
    {
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

fn build_switch_preamble_options(
    session_id: &str,
    source_tool: &str,
    target_tool: &str,
    snapshot: &Value,
    instruction: Option<&str>,
) -> Value {
    let mut object = serde_json::Map::new();
    object.insert("sessionId".into(), Value::String(session_id.into()));
    object.insert("sourceTool".into(), Value::String(source_tool.into()));
    object.insert("targetTool".into(), Value::String(target_tool.into()));
    object.insert("snapshot".into(), snapshot.clone());
    if let Some(instruction) = instruction {
        object.insert("instruction".into(), Value::String(instruction.into()));
    }
    Value::Object(object)
}

fn resume_args(tool_key: &str, backend_id: &str) -> Vec<Value> {
    match tool_key {
        "claude" => vec![
            Value::String("--resume".into()),
            Value::String(backend_id.into()),
        ],
        _ => vec![
            Value::String("resume".into()),
            Value::String(backend_id.into()),
        ],
    }
}

fn target_tool_command(tool_key: &str) -> String {
    match tool_key {
        "claude" => "claude".into(),
        "codex" => "codex".into(),
        other => other.into(),
    }
}

fn has_preamble_flag(tool_key: &str) -> bool {
    tool_key == "claude"
}

fn normalized_tool(tool_key: &str) -> Value {
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
        "disabled" => json!({ "command": "disabled", "args": [], "enabled": false }),
        _ => json!({
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
        }),
    }
}

fn upsert_pair(entries: &mut Vec<Value>, key: &str, value: Value) {
    if let Some(entry) = entries
        .iter_mut()
        .find(|entry| entry.get(0).and_then(Value::as_str) == Some(key))
    {
        *entry = json!([key, value]);
    } else {
        entries.push(json!([key, value]));
    }
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
        "team": session.get("team").cloned().unwrap_or(Value::Null),
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
