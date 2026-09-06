use aimux::core_command_transport::DaemonHttpMethod;
use aimux::tmux_expose::{
    ExposeClientSizeProbe, ExposeHttpClient, ExposeHttpRequest, ExposeInputEvent,
    ExposeInputSource, ExposeTmuxCapture, TmuxExposeOptions, run_tmux_expose_with_drivers,
};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

const TMUX_EXPOSE_RUNNER: &str =
    include_str!("../../../../testdata/contracts/v1/tmux/expose-runner.json");

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn fixture_tmux_expose_runner_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(TMUX_EXPOSE_RUNNER).expect("valid expose runner fixture");
    let cases = contract["cases"].as_array().expect("expose runner cases");
    assert_eq!(cases.len(), 6, "unexpected expose runner case count");

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
        "{} tmux-expose-runner parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    let input = &case["input"];
    let root = temp_dir("aimux-expose-runner-contract");
    let state_dir = root.join("state");
    fs::create_dir_all(&state_dir).expect("state dir");
    fs::write(
        state_dir.join("metadata-api.txt"),
        "http://127.0.0.1:43191\n",
    )
    .expect("metadata endpoint");
    if let Some(ui_state) = input.get("uiState") {
        fs::write(
            state_dir.join("expose-ui-state.json"),
            serde_json::to_string(ui_state).expect("ui state json"),
        )
        .expect("ui state");
    }
    let selection_file = input
        .get("selectionFile")
        .and_then(Value::as_bool)
        .filter(|value| *value)
        .map(|_| root.join("selected-window"));
    let mut options = TmuxExposeOptions {
        project_root: PathBuf::from("/repo"),
        project_state_dir: state_dir.clone(),
        current_client_session: Some("aimux-repo-client-deadbeef".to_owned()),
        client_tty: Some("/dev/ttys001".to_owned()),
        current_window: input
            .get("currentWindow")
            .and_then(Value::as_str)
            .unwrap_or("codex")
            .to_owned()
            .into(),
        current_window_id: input
            .get("currentWindowId")
            .and_then(Value::as_str)
            .unwrap_or("@1")
            .to_owned()
            .into(),
        current_path: Some("/repo".to_owned()),
        daemon_endpoint: Some("http://127.0.0.1:43191".to_owned()),
        metadata_endpoint: Some("http://127.0.0.1:43191".to_owned()),
        selection_file: selection_file.clone(),
        columns: Some(80),
        rows: Some(24),
        ..TmuxExposeOptions::default()
    };
    options.expose_config.initial_scope = input
        .get("initialScope")
        .and_then(Value::as_str)
        .map(expose_scope);
    let mut http = FakeHttp::new(input);
    let mut capture = FakeCapture::new(input);
    let mut size_probe = FakeSizeProbe;
    let mut source = ScriptedInput::new(input);
    let mut output = CountingOutput::default();
    let exit_code = run_tmux_expose_with_drivers(
        options,
        &mut source,
        &mut output,
        &mut http,
        &mut capture,
        &mut size_probe,
    );
    let selected = selection_file
        .as_deref()
        .and_then(read_optional_string)
        .map(Value::String)
        .unwrap_or(Value::Null);
    let ui_state = read_optional_string(&state_dir.join("expose-ui-state.json"))
        .map(Value::String)
        .unwrap_or(Value::Null);
    let result = json!({
        "exitCode": exit_code,
        "requests": http.requests,
        "captureCalls": capture.calls,
        "selected": selected,
        "uiState": ui_state,
        "output": output.summary(),
    });
    fs::remove_dir_all(root).expect("cleanup");
    result
}

#[derive(Default)]
struct CountingOutput {
    chunks: Vec<String>,
}

impl CountingOutput {
    fn summary(&self) -> Value {
        let text = self.chunks.join("");
        json!({
            "hasTitle": text.contains("Exposé"),
            "hasRecentOutput": text.contains("recent output"),
            "hasDashboardExit": text.contains("^A d dashboard"),
        })
    }
}

impl Write for CountingOutput {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.chunks.push(String::from_utf8_lossy(buf).into_owned());
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

struct ScriptedInput {
    chunks: VecDeque<Vec<u8>>,
}

impl ScriptedInput {
    fn new(input: &Value) -> Self {
        Self {
            chunks: input["actions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|action| action.get("data").and_then(Value::as_str))
                .map(|data| data.as_bytes().to_vec())
                .collect(),
        }
    }
}

impl ExposeInputSource for ScriptedInput {
    fn read_timeout(&mut self, buffer: &mut [u8], _timeout: Duration) -> ExposeInputEvent {
        let Some(chunk) = self.chunks.pop_front() else {
            return ExposeInputEvent::End;
        };
        let count = chunk.len().min(buffer.len());
        buffer[..count].copy_from_slice(&chunk[..count]);
        ExposeInputEvent::Data(count)
    }
}

struct FakeHttp {
    responses: VecDeque<Value>,
    requests: Vec<Value>,
}

impl FakeHttp {
    fn new(input: &Value) -> Self {
        Self {
            responses: input["responses"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into(),
            requests: Vec::new(),
        }
    }
}

impl ExposeHttpClient for FakeHttp {
    fn request_json(&mut self, url: &str, request: ExposeHttpRequest) -> Result<Value, String> {
        self.requests.push(json!({
            "method": method_to_value(request.method),
            "url": normalize_url(url),
            "body": request.body.unwrap_or(Value::Null),
        }));
        Ok(self
            .responses
            .pop_front()
            .unwrap_or_else(|| json!({ "ok": true, "items": [] })))
    }
}

struct FakeCapture {
    captures: Value,
    calls: Vec<Value>,
}

impl FakeCapture {
    fn new(input: &Value) -> Self {
        Self {
            captures: input.get("captures").cloned().unwrap_or(Value::Null),
            calls: Vec::new(),
        }
    }
}

impl ExposeTmuxCapture for FakeCapture {
    fn capture_target(&mut self, item: &Value) -> Result<String, String> {
        let window_id = item["target"]["windowId"].as_str().unwrap_or_default();
        self.calls.push(json!({
            "windowId": window_id,
            "options": {
                "startLine": -40,
                "includeEscapes": true,
            },
        }));
        Ok(self
            .captures
            .get(window_id)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("capture {window_id}\n")))
    }
}

#[derive(Default)]
struct FakeSizeProbe;

impl ExposeClientSizeProbe for FakeSizeProbe {
    fn query_client_size(&mut self, _client_tty: Option<&str>) -> String {
        String::new()
    }
}

fn method_to_value(method: DaemonHttpMethod) -> Value {
    Value::String(method.as_str().to_owned())
}

fn normalize_url(url: &str) -> String {
    let path = url
        .strip_prefix("http://127.0.0.1:43191")
        .or_else(|| url.strip_prefix("http://127.0.0.1"))
        .unwrap_or(url);
    path.replace(
        &format!("tmux-expose%3A{}", std::process::id()),
        "tmux-expose%3A%3Cpid%3E",
    )
}

fn expose_scope(value: &str) -> aimux::tmux_expose::ExposeScope {
    match value {
        "worktree" => aimux::tmux_expose::ExposeScope::Worktree,
        "project" => aimux::tmux_expose::ExposeScope::Project,
        "global" => aimux::tmux_expose::ExposeScope::Global,
        unexpected => panic!("unexpected expose scope {unexpected}"),
    }
}

fn read_optional_string(path: &Path) -> Option<String> {
    fs::read_to_string(path).ok()
}

fn temp_dir(prefix: &str) -> PathBuf {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("{}-{}-{sequence}", prefix, std::process::id()))
}
