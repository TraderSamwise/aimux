use aimux::tmux::{OpenTargetOptions, TmuxTarget};
use aimux::tmux_session_transport::{
    TmuxSessionStatus, TmuxSessionTransport, TmuxSessionTransportRuntime,
};
use serde_json::{Map, Value, json};
use std::cell::RefCell;
use std::rc::Rc;

const TMUX_SESSION_TRANSPORT: &str =
    include_str!("../../../../testdata/contracts/v1/tmux/session-transport.json");

#[test]
fn fixture_tmux_session_transport_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(TMUX_SESSION_TRANSPORT).expect("valid session transport fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("session transport cases");
    assert_eq!(cases.len(), 8, "unexpected session transport case count");

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
        "{} tmux-session-transport parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    let input = &case["input"];
    let manager = MockTransportRuntime::new(input.get("manager").unwrap_or(&Value::Null));
    let exit_calls = Rc::new(RefCell::new(Vec::<i32>::new()));
    let exit_calls_for_listener = Rc::clone(&exit_calls);
    let mut transport = TmuxSessionTransport::new(
        "codex-1",
        "codex",
        parse_target(input.get("target").unwrap_or(&Value::Null)),
        manager,
        80,
        24,
    );
    transport.on_exit(move |code| exit_calls_for_listener.borrow_mut().push(code));
    let thrown = match case["name"].as_str().expect("case name") {
        "sends text and enter keys through tmux" => {
            transport.write("hello\r").err();
            transport.write("one\ntwo").err()
        }
        "resizes the backing tmux window" => transport.resize(100, 32).err(),
        "keeps dimensions unchanged when tmux resize fails" => transport.resize(100, 32).err(),
        "settles kill when the tmux window is already gone" => {
            transport.kill();
            None
        }
        "settles async kill when the tmux window is already gone" => {
            transport.kill_async();
            None
        }
        "renames and opens the tmux target" => transport
            .rename_window("renamed")
            .err()
            .or_else(|| transport.open().err()),
        "marks exit when the tmux window disappears" => {
            transport.poll_liveness();
            transport.poll_liveness();
            None
        }
        "marks exit when the tmux pane is dead but the window still exists" => {
            transport.poll_liveness();
            transport.poll_liveness();
            None
        }
        unexpected => panic!("unexpected case {unexpected}"),
    };
    let manager_calls = transport.manager().calls.clone();
    let mut snapshot = Map::new();
    snapshot.insert("exited".into(), Value::Bool(transport.exited()));
    if let Some(exit_code) = transport.exit_code() {
        snapshot.insert("exitCode".into(), Value::from(exit_code));
    }
    snapshot.insert(
        "status".into(),
        Value::String(status_string(transport.status()).into()),
    );
    snapshot.insert("target".into(), target_to_value(transport.tmux_target()));
    snapshot.insert("cols".into(), Value::from(transport.dimensions().0));
    snapshot.insert("rows".into(), Value::from(transport.dimensions().1));
    snapshot.insert("calls".into(), Value::Array(manager_calls));
    snapshot.insert(
        "exitCalls".into(),
        Value::Array(
            exit_calls
                .borrow()
                .iter()
                .copied()
                .map(Value::from)
                .collect(),
        ),
    );
    json!({
        "thrown": thrown,
        "snapshot": Value::Object(snapshot)
    })
}

#[derive(Debug, Clone)]
struct MockTransportRuntime {
    calls: Vec<Value>,
    resize_error: Option<String>,
    kill_error: Option<String>,
    inside_tmux: bool,
    get_target_responses: Vec<Option<TmuxTarget>>,
    get_target_index: usize,
}

impl MockTransportRuntime {
    fn new(input: &Value) -> Self {
        Self {
            calls: Vec::new(),
            resize_error: input
                .get("resizeError")
                .and_then(Value::as_str)
                .map(str::to_owned),
            kill_error: input
                .get("killError")
                .and_then(Value::as_str)
                .map(str::to_owned),
            inside_tmux: input.get("insideTmux").and_then(Value::as_bool) == Some(true),
            get_target_responses: input
                .get("getTargetResponses")
                .and_then(Value::as_array)
                .map(|responses| {
                    responses
                        .iter()
                        .map(|value| (!value.is_null()).then(|| parse_target(value)))
                        .collect()
                })
                .unwrap_or_else(|| vec![Some(default_target())]),
            get_target_index: 0,
        }
    }
}

impl TmuxSessionTransportRuntime for MockTransportRuntime {
    fn send_text(&mut self, target: &TmuxTarget, text: &str) -> Result<(), String> {
        self.calls
            .push(json!(["sendText", target_to_value(target), text]));
        Ok(())
    }

    fn send_enter(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.calls
            .push(json!(["sendEnter", target_to_value(target)]));
        Ok(())
    }

    fn send_key(&mut self, target: &TmuxTarget, key: &str) -> Result<(), String> {
        self.calls
            .push(json!(["sendKey", target_to_value(target), key]));
        Ok(())
    }

    fn resize_target(&mut self, target: &TmuxTarget, cols: i64, rows: i64) -> Result<(), String> {
        self.calls
            .push(json!(["resizeTarget", target_to_value(target), cols, rows]));
        if let Some(error) = self.resize_error.as_ref() {
            return Err(error.clone());
        }
        Ok(())
    }

    fn kill_window(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.calls
            .push(json!(["killWindow", target_to_value(target)]));
        if let Some(error) = self.kill_error.as_ref() {
            return Err(error.clone());
        }
        Ok(())
    }

    fn kill_window_async(&mut self, target: &TmuxTarget) -> Result<(), String> {
        self.calls
            .push(json!(["killWindowAsync", target_to_value(target)]));
        if let Some(error) = self.kill_error.as_ref() {
            return Err(error.clone());
        }
        Ok(())
    }

    fn rename_window(&mut self, window_id: &str, name: &str) -> Result<(), String> {
        self.calls.push(json!(["renameWindow", window_id, name]));
        Ok(())
    }

    fn open_target(
        &mut self,
        target: &TmuxTarget,
        options: OpenTargetOptions,
    ) -> Result<(), String> {
        self.calls.push(json!([
            "openTarget",
            target_to_value(target),
            { "insideTmux": options.inside_tmux }
        ]));
        Ok(())
    }

    fn is_inside_tmux(&self) -> bool {
        self.inside_tmux
    }

    fn get_target_by_window_id(
        &mut self,
        session_name: &str,
        window_id: &str,
    ) -> Option<TmuxTarget> {
        self.calls
            .push(json!(["getTargetByWindowId", session_name, window_id]));
        let index = self
            .get_target_index
            .min(self.get_target_responses.len().saturating_sub(1));
        self.get_target_index += 1;
        self.get_target_responses.get(index).cloned().flatten()
    }
}

fn parse_target(value: &Value) -> TmuxTarget {
    let base = default_target();
    if !value.is_object() {
        return base;
    }
    TmuxTarget {
        session_name: value
            .get("sessionName")
            .and_then(Value::as_str)
            .unwrap_or(&base.session_name)
            .to_owned(),
        window_id: value
            .get("windowId")
            .and_then(Value::as_str)
            .unwrap_or(&base.window_id)
            .to_owned(),
        window_index: value
            .get("windowIndex")
            .and_then(Value::as_i64)
            .unwrap_or(base.window_index),
        window_name: value
            .get("windowName")
            .and_then(Value::as_str)
            .unwrap_or(&base.window_name)
            .to_owned(),
        pane_dead: value.get("paneDead").and_then(Value::as_bool),
    }
}

fn default_target() -> TmuxTarget {
    TmuxTarget {
        session_name: "aimux-mobile-abc".into(),
        window_id: "@3".into(),
        window_index: 3,
        window_name: "codex".into(),
        pane_dead: None,
    }
}

fn target_to_value(target: &TmuxTarget) -> Value {
    let mut value = json!({
        "sessionName": target.session_name,
        "windowId": target.window_id,
        "windowIndex": target.window_index,
        "windowName": target.window_name,
    });
    if let Some(pane_dead) = target.pane_dead
        && let Some(object) = value.as_object_mut()
    {
        object.insert("paneDead".into(), Value::Bool(pane_dead));
    }
    value
}

fn status_string(status: TmuxSessionStatus) -> &'static str {
    match status {
        TmuxSessionStatus::Running => "running",
        TmuxSessionStatus::Exited => "exited",
    }
}
