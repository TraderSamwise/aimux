use aimux::tmux_runtime_stop::{
    TmuxRuntimeStopManager, list_managed_project_session_names, stop_project_tmux_runtime,
};
use serde_json::{Value, json};

const TMUX_RUNTIME_STOP: &str =
    include_str!("../../../../../testdata/contracts/v1/tmux/runtime-stop.json");

#[test]
fn fixture_tmux_runtime_stop_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(TMUX_RUNTIME_STOP).expect("valid runtime stop fixture");
    let cases = contract["cases"].as_array().expect("runtime stop cases");
    assert_eq!(cases.len(), 4, "unexpected runtime stop case count");

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
        "{} tmux-runtime-stop parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    let input = &case["input"];
    let mut tmux = FakeTmux::new(input);
    let repo_root = "<repo>";
    match case["name"].as_str().expect("case name") {
        "lists only host and client sessions with clients before host" => ok(json!({
            "sessions": list_managed_project_session_names(&mut tmux, repo_root)
                .expect("list sessions"),
            "calls": tmux.calls,
        })),
        "stop returns empty when tmux is unavailable" => stop_case(&mut tmux, repo_root),
        "persists snapshots before killing clients and host" => stop_case(&mut tmux, repo_root),
        "skips missing sessions then throws on failed kill" => stop_case(&mut tmux, repo_root),
        unexpected => panic!("unexpected case {unexpected}"),
    }
}

fn stop_case(tmux: &mut FakeTmux, repo_root: &str) -> Value {
    match stop_project_tmux_runtime(tmux, repo_root, |tmux, project_root| {
        tmux.calls
            .push(json!(["listProjectManagedWindows", project_root]));
        Ok(())
    }) {
        Ok(killed) => ok(json!({ "killed": killed, "calls": tmux.calls })),
        Err(error) => json!({ "thrown": error, "snapshot": Value::Null }),
    }
}

fn ok(snapshot: Value) -> Value {
    json!({ "thrown": Value::Null, "snapshot": snapshot })
}

#[derive(Debug, Clone)]
struct FakeTmux {
    calls: Vec<Value>,
    available: bool,
    host_session: String,
    sessions: Vec<String>,
    missing: Vec<String>,
    kill_errors: Vec<String>,
}

impl FakeTmux {
    fn new(input: &Value) -> Self {
        Self {
            calls: Vec::new(),
            available: input.get("available").and_then(Value::as_bool) != Some(false),
            host_session: input["hostSession"].as_str().unwrap_or_default().to_owned(),
            sessions: string_array(&input["sessions"]),
            missing: string_array(input.get("missing").unwrap_or(&Value::Null)),
            kill_errors: string_array(input.get("killErrors").unwrap_or(&Value::Null)),
        }
    }
}

impl TmuxRuntimeStopManager for FakeTmux {
    fn is_available(&mut self) -> bool {
        self.calls.push(json!(["isAvailable"]));
        self.available
    }

    fn project_session_name(&mut self, project_root: &str) -> String {
        self.calls.push(json!(["getProjectSession", project_root]));
        self.host_session.clone()
    }

    fn list_session_names(&mut self) -> Result<Vec<String>, String> {
        self.calls.push(json!(["listSessionNames"]));
        Ok(self.sessions.clone())
    }

    fn has_session(&mut self, session_name: &str) -> bool {
        self.calls.push(json!(["hasSession", session_name]));
        !self.missing.iter().any(|name| name == session_name)
    }

    fn kill_session(&mut self, session_name: &str) -> Result<(), String> {
        self.calls.push(json!(["killSession", session_name]));
        if self.kill_errors.iter().any(|name| name == session_name) {
            return Err(format!("kill failed: {session_name}"));
        }
        Ok(())
    }
}

fn string_array(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}
