use aimux::tmux_expose::{
    ExposeConfig, ExposeHttpClient, ExposeHttpRequest, ExposeScope, ExposeScopeView,
    ExposeSortMode, ExposeUiState, FastControlContext, LoadExposeScopeDeps, focus_expose_item_with,
    initial_expose_scope, load_expose_scope_items_with, load_overseer_expose_item_with,
    next_expose_scope, read_expose_ui_state, write_expose_ui_state,
};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};

const TMUX_EXPOSE_MODEL: &str =
    include_str!("../../../../testdata/contracts/v1/tmux/expose-model.json");

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn fixture_tmux_expose_model_matches_typescript_contract() {
    let contract: Value =
        serde_json::from_str(TMUX_EXPOSE_MODEL).expect("valid expose model fixture");
    let cases = contract["cases"].as_array().expect("expose model cases");
    assert_eq!(cases.len(), 7, "unexpected expose model case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = run_case(case);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "api": case["api"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} tmux-expose-model parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(case: &Value) -> Value {
    let input = &case["input"];
    match case["api"].as_str().expect("api") {
        "nextExposeScope" => json!({
            "values": input["scopes"]
                .as_array()
                .expect("scopes")
                .iter()
                .map(|scope| expose_scope_to_value(next_expose_scope(expose_scope(scope))))
                .collect::<Vec<_>>()
        }),
        "initialExposeScope" => json!({
            "values": input["cases"]
                .as_array()
                .expect("initial scope cases")
                .iter()
                .map(|entry| expose_scope_to_value(initial_expose_scope(
                    entry["crossProject"].as_bool().expect("crossProject"),
                    &context_from_value(&entry["context"]),
                    &config_from_value(&entry["config"]),
                )))
                .collect::<Vec<_>>()
        }),
        "loadExposeScopeItems" => with_state_dir(input, |state_dir| {
            let mut fake = FakeHttp::new(input);
            let deps = LoadExposeScopeDeps {
                daemon_endpoint: Some("http://127.0.0.1:43190".to_owned()),
                metadata_endpoint: None,
            };
            let views = [
                load_expose_scope_items_with(
                    ExposeScope::Worktree,
                    &context(),
                    &state_dir,
                    &deps,
                    &mut fake,
                )
                .expect("worktree scope"),
                load_expose_scope_items_with(
                    ExposeScope::Project,
                    &context(),
                    &state_dir,
                    &deps,
                    &mut fake,
                )
                .expect("project scope"),
                load_expose_scope_items_with(
                    ExposeScope::Global,
                    &context(),
                    &state_dir,
                    &deps,
                    &mut fake,
                )
                .expect("global scope"),
            ];
            json!({
                "views": views.iter().map(view_to_value).collect::<Vec<_>>(),
                "requests": fake.requests.borrow().clone(),
            })
        }),
        "loadOverseerExposeItem" => with_state_dir(input, |state_dir| {
            let mut fake = FakeHttp::new(input);
            let deps = LoadExposeScopeDeps {
                daemon_endpoint: None,
                metadata_endpoint: None,
            };
            json!({
                "item": load_overseer_expose_item_with(&context(), &state_dir, &deps, &mut fake)
                    .expect("overseer item"),
                "requests": fake.requests.borrow().clone(),
                "stateFile": state_file(&state_dir),
            })
        }),
        "focusExposeItem" => with_state_dir(input, |state_dir| {
            let mut fake = FakeHttp::new(input);
            let deps = LoadExposeScopeDeps {
                daemon_endpoint: Some("http://127.0.0.1:43190".to_owned()),
                metadata_endpoint: None,
            };
            let results = [
                focus_expose_item_with(
                    &json!({ "id": "local", "target": { "windowId": "@1" } }),
                    &context(),
                    &state_dir,
                    &deps,
                    &mut fake,
                )
                .expect("local focus"),
                focus_expose_item_with(
                    &json!({ "id": "global", "projectRoot": "/other", "target": { "windowId": "@9" } }),
                    &context(),
                    &state_dir,
                    &deps,
                    &mut fake,
                )
                .expect("global focus"),
            ];
            json!({
                "results": results,
                "requests": fake.requests.borrow().clone(),
            })
        }),
        "readExposeUiState" => with_state_dir(input, |state_dir| {
            json!({
                "states": [
                    expose_ui_state_to_value(read_expose_ui_state(state_dir.join("missing"))),
                    expose_ui_state_to_value(read_expose_ui_state(&state_dir)),
                ],
                "stateFile": state_file(&state_dir),
            })
        }),
        "writeExposeUiState" => with_state_dir(input, |state_dir| {
            write_expose_ui_state(
                &state_dir,
                ExposeUiState {
                    sort_mode: ExposeSortMode::RecentOutput,
                },
            )
            .expect("write ui state");
            json!({
                "state": expose_ui_state_to_value(read_expose_ui_state(&state_dir)),
                "stateFile": state_file(&state_dir),
            })
        }),
        unexpected => panic!("unexpected api {unexpected}"),
    }
}

#[derive(Debug)]
struct FakeHttp {
    responses: VecDeque<Value>,
    requests: Rc<RefCell<Vec<Value>>>,
}

impl FakeHttp {
    fn new(input: &Value) -> Self {
        Self {
            responses: input["responses"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into(),
            requests: Rc::new(RefCell::new(Vec::new())),
        }
    }
}

impl ExposeHttpClient for FakeHttp {
    fn request_json(&mut self, url: &str, request: ExposeHttpRequest) -> Result<Value, String> {
        self.requests.borrow_mut().push(json!({
            "url": normalize_url(url),
            "method": request.method.as_str(),
            "body": request.body.unwrap_or(Value::Null),
            "timeoutMs": request.timeout_ms,
        }));
        Ok(self
            .responses
            .pop_front()
            .unwrap_or_else(|| json!({ "ok": true, "items": [] })))
    }
}

fn with_state_dir(input: &Value, run: impl FnOnce(PathBuf) -> Value) -> Value {
    let root = temp_dir("aimux-expose-model-contract");
    let state_dir = root.join("state");
    fs::create_dir_all(&state_dir).expect("state dir");
    fs::write(
        state_dir.join("metadata-api.txt"),
        format!(
            "{}\n",
            input
                .get("metadataEndpointFile")
                .and_then(Value::as_str)
                .unwrap_or("http://127.0.0.1:43191")
        ),
    )
    .expect("metadata endpoint");
    if let Some(state_file) = input.get("stateFile").and_then(Value::as_str) {
        fs::write(state_dir.join("expose-ui-state.json"), state_file).expect("state file");
    }
    let result = run(state_dir);
    fs::remove_dir_all(root).expect("remove temp dir");
    result
}

fn context() -> FastControlContext {
    FastControlContext {
        project_root: "/repo".to_owned(),
        current_path: Some("/repo/worktree".to_owned()),
        current_window: Some("codex".to_owned()),
        current_window_id: Some("@2".to_owned()),
        current_project_control: None,
        current_client_session: Some("aimux-test-client-12345678".to_owned()),
        client_tty: Some("/dev/ttys001".to_owned()),
    }
}

fn context_from_value(value: &Value) -> FastControlContext {
    FastControlContext {
        project_root: value["projectRoot"].as_str().unwrap_or_default().to_owned(),
        current_path: value
            .get("currentPath")
            .and_then(Value::as_str)
            .map(str::to_owned),
        current_window: value
            .get("currentWindow")
            .and_then(Value::as_str)
            .map(str::to_owned),
        current_window_id: value
            .get("currentWindowId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        current_project_control: value.get("currentProjectControl").and_then(Value::as_bool),
        current_client_session: value
            .get("currentClientSession")
            .and_then(Value::as_str)
            .map(str::to_owned),
        client_tty: value
            .get("clientTty")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

fn config_from_value(value: &Value) -> ExposeConfig {
    ExposeConfig {
        initial_scope: value.get("initialScope").map(expose_scope),
    }
}

fn view_to_value(view: &ExposeScopeView) -> Value {
    json!({
        "scope": expose_scope_to_value(view.scope),
        "scopeLabel": view.scope_label,
        "sublabel": expose_sublabel_to_value(view.sublabel),
        "itemIds": view.items.iter().filter_map(|item| item.get("id").and_then(Value::as_str)).collect::<Vec<_>>(),
        "items": view.items,
    })
}

fn expose_ui_state_to_value(state: ExposeUiState) -> Value {
    json!({ "sortMode": expose_sort_mode_to_value(state.sort_mode) })
}

fn state_file(state_dir: &Path) -> Value {
    fs::read_to_string(state_dir.join("expose-ui-state.json"))
        .map(Value::String)
        .unwrap_or(Value::Null)
}

fn normalize_url(url: &str) -> String {
    url.replace(
        &format!("tmux-expose%3A{}", std::process::id()),
        "tmux-expose%3A%3Cpid%3E",
    )
    .replace(
        &format!("tmux-expose:{}", std::process::id()),
        "tmux-expose:<pid>",
    )
}

fn expose_scope(value: &Value) -> ExposeScope {
    match value.as_str().expect("scope") {
        "worktree" => ExposeScope::Worktree,
        "project" => ExposeScope::Project,
        "global" => ExposeScope::Global,
        unexpected => panic!("unexpected scope {unexpected}"),
    }
}

fn expose_scope_to_value(scope: ExposeScope) -> Value {
    Value::String(
        match scope {
            ExposeScope::Worktree => "worktree",
            ExposeScope::Project => "project",
            ExposeScope::Global => "global",
        }
        .to_owned(),
    )
}

fn expose_sublabel_to_value(sublabel: aimux::tmux_expose::ExposeSublabel) -> Value {
    Value::String(
        match sublabel {
            aimux::tmux_expose::ExposeSublabel::None => "none",
            aimux::tmux_expose::ExposeSublabel::Worktree => "worktree",
            aimux::tmux_expose::ExposeSublabel::ProjectWorktree => "project-worktree",
        }
        .to_owned(),
    )
}

fn expose_sort_mode_to_value(mode: ExposeSortMode) -> Value {
    Value::String(
        match mode {
            ExposeSortMode::Default => "default",
            ExposeSortMode::RecentOutput => "recent-output",
        }
        .to_owned(),
    )
}

fn temp_dir(prefix: &str) -> PathBuf {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!("{}-{}-{sequence}", prefix, std::process::id()))
}
