use aimux::tmux::{
    TMUX_RUNTIME_CONTRACT_OPTION, TmuxCommandSpec, TmuxRuntimeConfig, TmuxRuntimeManager,
};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::rc::Rc;

const CONTRACT: &str =
    include_str!("../../../../testdata/contracts/v1/tmux/runtime-session-lifecycle.json");

const PROJECT_ROOT: &str = "/repo/mobile";
const SESSION_NAME: &str = "aimux-mobile-078d0ecd20ec";

#[test]
fn fixture_tmux_runtime_session_lifecycle_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(CONTRACT).expect("valid tmux runtime session lifecycle contract");
    let cases = contract["cases"]
        .as_array()
        .expect("session lifecycle cases");
    assert_eq!(cases.len(), 9, "unexpected session lifecycle case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = with_contract_env(|| run_case(case));
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} tmux-runtime-session-lifecycle parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn with_contract_env(run: impl FnOnce() -> Value) -> Value {
    let previous_home = std::env::var("AIMUX_HOME").ok();
    let previous_port = std::env::var("AIMUX_DAEMON_PORT").ok();
    unsafe {
        std::env::set_var("AIMUX_HOME", "/tmp/aimux-contract-home");
        std::env::set_var("AIMUX_DAEMON_PORT", "54321");
    }
    let output = run();
    unsafe {
        match previous_home {
            Some(value) => std::env::set_var("AIMUX_HOME", value),
            None => std::env::remove_var("AIMUX_HOME"),
        }
        match previous_port {
            Some(value) => std::env::set_var("AIMUX_DAEMON_PORT", value),
            None => std::env::remove_var("AIMUX_DAEMON_PORT"),
        }
    }
    output
}

#[derive(Debug, Default)]
struct LifecycleState {
    session_exists: bool,
    terminal_features: String,
    dropped_contract: bool,
    dropped_configuration: bool,
    legacy_repaired: bool,
}

fn run_case(case: &Value) -> Value {
    let input = &case["input"];
    let calls = Rc::new(RefCell::new(Vec::<Value>::new()));
    let state = Rc::new(RefCell::new(LifecycleState {
        session_exists: input["sessionExists"].as_bool().unwrap_or(false),
        terminal_features: input["terminalFeatures"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        ..LifecycleState::default()
    }));
    let current_contract = input["currentContract"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let legacy_session = input["legacySession"].as_str().map(str::to_owned);
    let session_list = input["sessionList"].as_str().unwrap_or_default().to_owned();
    let drop_during_contract = input["dropDuringContract"].as_bool().unwrap_or(false);
    let drop_during_configuration = input["dropDuringConfiguration"].as_bool().unwrap_or(false);
    let extended_keys_format_error = input["extendedKeysFormatError"].as_str().map(str::to_owned);
    let calls_for_exec = Rc::clone(&calls);
    let state_for_exec = Rc::clone(&state);
    let mut tmux = TmuxRuntimeManager::with_exec(move |args, options| {
        calls_for_exec.borrow_mut().push(call_to_value(
            args,
            options.and_then(|options| options.cwd.as_deref()),
        ));
        let joined = args.join(" ");
        if joined == "-V" {
            return Ok("tmux 3.5a".to_owned());
        }
        if joined == "list-sessions -F #{session_name}" {
            let state = state_for_exec.borrow();
            if let Some(legacy_session) = &legacy_session
                && !state.legacy_repaired
            {
                return Ok(legacy_session.clone());
            }
            return Ok(session_list.clone());
        }
        if joined.starts_with("rename-session -t ") {
            state_for_exec.borrow_mut().legacy_repaired = true;
            return Ok(String::new());
        }
        if joined == format!("has-session -t {SESSION_NAME}") {
            if !state_for_exec.borrow().session_exists {
                return Err("missing".to_owned());
            }
            return Ok(String::new());
        }
        if joined.starts_with("new-session -d -s ") {
            state_for_exec.borrow_mut().session_exists = true;
            return Ok(String::new());
        }
        if joined == format!("show-options -v -t {SESSION_NAME} {TMUX_RUNTIME_CONTRACT_OPTION}") {
            return Ok(current_contract.clone());
        }
        if joined == format!("show-options -v -t {SESSION_NAME} terminal-features") {
            return Ok(state_for_exec.borrow().terminal_features.clone());
        }
        if args.first().map(String::as_str) == Some("set-option")
            && args.get(1).map(String::as_str) == Some("-as")
            && args.get(4).map(String::as_str) == Some("terminal-features")
        {
            let next = args
                .get(5)
                .map(|value| value.trim_start_matches(','))
                .unwrap_or_default();
            let mut state = state_for_exec.borrow_mut();
            state.terminal_features = [state.terminal_features.as_str(), next]
                .into_iter()
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            return Ok(String::new());
        }
        if args.first().map(String::as_str) == Some("set-option")
            && args.get(3).map(String::as_str) == Some(TMUX_RUNTIME_CONTRACT_OPTION)
            && drop_during_contract
            && !state_for_exec.borrow().dropped_contract
        {
            let mut state = state_for_exec.borrow_mut();
            state.dropped_contract = true;
            state.session_exists = false;
            return Err("no such session: aimux-mobile-abc".to_owned());
        }
        if args.first().map(String::as_str) == Some("set-option")
            && args.get(3).map(String::as_str) == Some("@aimux-project-root")
            && drop_during_configuration
            && !state_for_exec.borrow().dropped_configuration
        {
            let mut state = state_for_exec.borrow_mut();
            state.dropped_configuration = true;
            state.session_exists = false;
            return Err("no such session: aimux-mobile-abc".to_owned());
        }
        if args.iter().any(|arg| arg == "extended-keys-format")
            && let Some(error) = &extended_keys_format_error
        {
            return Err(error.clone());
        }
        if joined.starts_with("list-windows -t ") {
            return Ok(String::new());
        }
        Ok(String::new())
    });

    let result = run_named_case(case["name"].as_str().expect("case name"), &mut tmux);
    normalize(json!({
        "thrown": result.as_ref().err().map_or(Value::Null, |error| json!(error)),
        "result": result.ok().unwrap_or(Value::Null),
        "execCalls": calls.borrow().clone(),
        "terminalFeatures": state.borrow().terminal_features,
    }))
}

fn run_named_case(name: &str, tmux: &mut TmuxRuntimeManager) -> Result<Value, String> {
    let config = lifecycle_config();
    let result = match name {
        "uses a custom dashboard command for new host sessions" => tmux.ensure_project_session(
            PROJECT_ROOT,
            Some(&TmuxCommandSpec {
                cwd: "/repo/mobile/app".to_owned(),
                command: "node".to_owned(),
                args: vec!["dist/main.js".to_owned(), "dashboard".to_owned()],
            }),
            Some(config),
        ),
        "creates detached project session with full managed configuration"
        | "does not append duplicate terminal features on reconfigure"
        | "stamps an existing project session missing the runtime contract"
        | "skips final runtime contract stamp when existing session already has one"
        | "retries when tmux drops the project session during contract stamping"
        | "retries when tmux drops the project session during configuration"
        | "continues when an older tmux refuses extended-keys-format"
        | "propagates non-option failures from extended-keys-format" => {
            tmux.ensure_project_session(PROJECT_ROOT, None, Some(config))
        }
        unexpected => panic!("unexpected case {unexpected}"),
    };
    if name == "does not append duplicate terminal features on reconfigure" {
        tmux.ensure_project_session(PROJECT_ROOT, None, Some(lifecycle_config()))?;
    }
    result.map(|session| {
        json!({
            "projectRoot": session.project_root,
            "projectId": session.project_id,
            "sessionName": session.session_name,
        })
    })
}

fn lifecycle_config() -> TmuxRuntimeConfig {
    TmuxRuntimeConfig {
        project_state_dir: "<aimux-home>/projects/mobile-078d0ecd20ec".to_owned(),
        control_script_command: "sh '<repo>/scripts/tmux-control.sh'".to_owned(),
        statusline_command: TmuxCommandSpec {
            cwd: "<repo>".to_owned(),
            command: "sh".to_owned(),
            args: vec!["<repo>/scripts/tmux-statusline.sh".to_owned()],
        },
        runtime_owner_id: r#"{"home":"<aimux-home>","port":"54321"}"#.to_owned(),
    }
}

fn call_to_value(args: &[String], cwd: Option<&str>) -> Value {
    let mut call = serde_json::Map::new();
    call.insert(
        "args".to_owned(),
        Value::Array(args.iter().cloned().map(Value::String).collect()),
    );
    if let Some(cwd) = cwd {
        call.insert("cwd".to_owned(), Value::String(cwd.to_owned()));
    }
    Value::Object(call)
}

fn normalize(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(normalize_text(&text)),
        Value::Array(items) => Value::Array(items.into_iter().map(normalize).collect()),
        Value::Object(entries) => Value::Object(
            entries
                .into_iter()
                .map(|(key, value)| (key, normalize(value)))
                .collect(),
        ),
        other => other,
    }
}

fn normalize_text(text: &str) -> String {
    let mut output = String::new();
    let home_normalized = text.replace("/tmp/aimux-contract-home", "<aimux-home>");
    let mut rest = home_normalized.as_str();
    while let Some(index) = rest.find("/aimux-tmux-") {
        let before = &rest[..index];
        let path_start = before
            .rfind(char::is_whitespace)
            .map_or(0, |value| value + 1);
        output.push_str(&before[..path_start]);
        output.push_str("<mouse-bindings.conf>");
        let after_prefix = &rest[index + "/aimux-tmux-".len()..];
        if let Some(config_index) = after_prefix.find("/mouse-bindings.conf") {
            rest = &after_prefix[config_index + "/mouse-bindings.conf".len()..];
        } else {
            rest = "";
        }
    }
    output.push_str(rest);
    output
}
