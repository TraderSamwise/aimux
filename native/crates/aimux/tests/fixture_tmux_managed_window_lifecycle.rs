use aimux::tmux::{
    TmuxCommandSpec, TmuxExecOptions, TmuxManagedWindow, TmuxRuntimeManager, TmuxTarget,
};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::BTreeSet;
use std::rc::Rc;

const CONTRACT: &str =
    include_str!("../../../../testdata/contracts/v1/tmux/managed-window-lifecycle.json");
const HOST: &str = "aimux-mobile-078d0ecd20ec";
const CLIENT: &str = "aimux-mobile-078d0ecd20ec-client-deadbeef";

#[test]
fn fixture_tmux_managed_window_lifecycle_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(CONTRACT).expect("valid tmux managed window lifecycle contract");
    let cases = contract["cases"].as_array().expect("managed window cases");
    assert_eq!(cases.len(), 9, "unexpected managed window case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = run_case(case);
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
        "{} tmux-managed-window-lifecycle parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    let input = &case["input"];
    let calls = Rc::new(RefCell::new(Vec::<Value>::new()));
    let errors = input["errors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<BTreeSet<_>>();
    let error_message = input["errorMessage"]
        .as_str()
        .unwrap_or("tmux failed")
        .to_owned();
    let session_list = input["sessionList"].as_str().unwrap_or_default().to_owned();
    let stored_root_session = input["storedRootSession"]
        .as_str()
        .unwrap_or("aimux-other-session")
        .to_owned();
    let stored_root = input["storedRoot"].as_str().unwrap_or_default().to_owned();
    let host_windows = input["hostWindows"].as_str().unwrap_or_default().to_owned();
    let client_windows = input["clientWindows"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let other_windows = input["otherWindows"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let abc_windows = input["abcWindows"].as_str().unwrap_or_default().to_owned();
    let pane_dead = input["paneDead"].as_str().unwrap_or("0").to_owned();
    let window_active = input["windowActive"].as_str().unwrap_or("1").to_owned();
    let window_metadata = input["windowMetadata"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let new_window_raw = input["newWindowRaw"]
        .as_str()
        .unwrap_or("@3\t3\tcodex")
        .to_owned();
    let calls_for_exec = Rc::clone(&calls);
    let mut tmux = TmuxRuntimeManager::with_exec(move |args, options| {
        calls_for_exec
            .borrow_mut()
            .push(call_to_value(args, options));
        let joined = args.join(" ");
        if joined == "-V" {
            return Ok("tmux 3.5a".to_owned());
        }
        if errors.contains(&joined) {
            return Err(error_message.clone());
        }
        if joined == "list-sessions -F #{session_name}" {
            return Ok(session_list.clone());
        }
        if joined == format!("show-options -v -t {stored_root_session} @aimux-project-root") {
            return Ok(stored_root.clone());
        }
        if joined.starts_with(&format!("list-windows -t {HOST} -F ")) {
            return Ok(host_windows.clone());
        }
        if joined.starts_with(&format!("list-windows -t {CLIENT} -F ")) {
            return Ok(client_windows.clone());
        }
        if joined.starts_with("list-windows -t aimux-other-session -F ") {
            return Ok(other_windows.clone());
        }
        if joined.starts_with("list-windows -t aimux-mobile-abc -F ") {
            return Ok(abc_windows.clone());
        }
        if joined == "display-message -p -t @3 #{pane_dead}" {
            return Ok(pane_dead.clone());
        }
        if joined == "display-message -p -t @3 #{window_active}" {
            return Ok(window_active.clone());
        }
        if joined.starts_with("show-window-options -v -t @3 @aimux-meta") {
            return Ok(window_metadata.clone());
        }
        if joined.starts_with("new-window -P ") {
            return Ok(new_window_raw.clone());
        }
        Ok(String::new())
    });

    let result = run_named_case(case["name"].as_str().expect("case name"), &mut tmux);
    json!({
        "thrown": result.as_ref().err().map_or(Value::Null, |error| json!(error)),
        "result": result.ok().unwrap_or(Value::Null),
        "execCalls": calls.borrow().clone(),
    })
}

fn run_named_case(name: &str, tmux: &mut TmuxRuntimeManager) -> Result<Value, String> {
    match name {
        "lists managed windows across host and client sessions without duplicates"
        | "includes managed sessions whose stored root matches the requested project" => Ok(
            managed_to_value(tmux.list_project_managed_windows("/repo/mobile")?),
        ),
        "finds managed windows by backend session id" => Ok(tmux
            .find_managed_window("aimux-mobile-abc", None, Some("backend-existing"))
            .map(|entry| entry.map(|entry| target_to_value(&entry.target)))?
            .unwrap_or(Value::Null)),
        "creates agent windows" => tmux
            .create_window(
                "aimux-mobile-abc",
                "codex",
                "/repo/mobile",
                "codex",
                &["--full-auto".to_owned()],
                false,
            )
            .map(|target| target_to_value(&target)),
        "reports sanitized create window failures" => tmux
            .create_window(
                "aimux-proj",
                "claude",
                "/repo",
                "env",
                &[
                    "-i".to_owned(),
                    "OPENAI_API_KEY=sk-real".to_owned(),
                    "claude".to_owned(),
                ],
                false,
            )
            .map(|target| target_to_value(&target)),
        "runs basic window lifecycle commands" => {
            let target = target();
            tmux.kill_window(&target)?;
            tmux.unlink_window(&target)?;
            tmux.rename_window(&target.window_id, "renamed")?;
            tmux.respawn_window(
                &target,
                &TmuxCommandSpec {
                    cwd: "/repo/mobile".to_owned(),
                    command: "codex".to_owned(),
                    args: vec!["--resume".to_owned()],
                },
            )?;
            tmux.clear_target_history(&target)?;
            tmux.select_window(&target)?;
            Ok(Value::Null)
        }
        "checks window liveness and activity from tmux display-message" => Ok(json!({
            "alive": tmux.is_window_alive(&target())?,
            "active": tmux.is_window_active(&target()),
        })),
        "reads and writes aimux window metadata" => {
            let metadata = agent_metadata();
            tmux.set_window_metadata(&target().window_id, &metadata)?;
            Ok(tmux
                .get_window_metadata(&target().window_id)
                .unwrap_or(Value::Null))
        }
        "applies managed agent window policy" => {
            tmux.apply_managed_agent_window_policy(&target().window_id, "codex")?;
            Ok(Value::Null)
        }
        unexpected => panic!("unexpected case {unexpected}"),
    }
}

fn target() -> TmuxTarget {
    TmuxTarget {
        session_name: "aimux-mobile-abc".to_owned(),
        window_id: "@3".to_owned(),
        window_index: 3,
        window_name: "codex".to_owned(),
        pane_dead: None,
    }
}

fn agent_metadata() -> Value {
    json!({
        "kind": "agent",
        "sessionId": "codex-abc123",
        "command": "codex",
        "args": ["--full-auto"],
        "toolConfigKey": "codex",
        "worktreePath": "/repo/mobile",
    })
}

fn managed_to_value(entries: Vec<TmuxManagedWindow>) -> Value {
    Value::Array(entries.iter().map(managed_entry_to_value).collect())
}

fn managed_entry_to_value(entry: &TmuxManagedWindow) -> Value {
    json!({
        "target": target_to_value(&entry.target),
        "metadata": entry.metadata,
    })
}

fn target_to_value(target: &TmuxTarget) -> Value {
    let mut value = serde_json::Map::new();
    value.insert(
        "sessionName".to_owned(),
        Value::String(target.session_name.clone()),
    );
    value.insert(
        "windowId".to_owned(),
        Value::String(target.window_id.clone()),
    );
    value.insert("windowIndex".to_owned(), json!(target.window_index));
    value.insert(
        "windowName".to_owned(),
        Value::String(target.window_name.clone()),
    );
    if let Some(pane_dead) = target.pane_dead {
        value.insert("paneDead".to_owned(), Value::Bool(pane_dead));
    }
    Value::Object(value)
}

fn call_to_value(args: &[String], options: Option<&TmuxExecOptions>) -> Value {
    let mut call = serde_json::Map::new();
    call.insert(
        "args".to_owned(),
        Value::Array(args.iter().cloned().map(Value::String).collect()),
    );
    if let Some(cwd) = options.and_then(|options| options.cwd.as_deref()) {
        call.insert("cwd".to_owned(), Value::String(cwd.to_owned()));
    }
    Value::Object(call)
}
