use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::core_command_transport::DaemonHttpMethod;
use aimux::debug_logging::{
    LogLevel, LoggingRuntimeConfig, configure_logging, reset_logging_for_tests,
};
use aimux::project_api_contract::routes;
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::project_service::switchable_agents::route_switchable_agent_request_async;
use aimux::runtime_topology::runtime_topology_path;
use aimux::tmux_expose::{
    EXPOSE_HTTP_TIMEOUT_MS, ExposeClientSizeProbe, ExposeConfig, ExposeHttpClient,
    ExposeHttpRequest, ExposeInputEvent, ExposeInputSource, ExposeScope, ExposeScopeView,
    ExposeSortMode, ExposeSublabel, ExposeTmuxCapture, ExposeUiState, FastControlContext,
    LoadExposeScopeDeps, RELAUNCH_ON_RESIZE_EXIT, expose_project_control_flag_from_metadata,
    focus_expose_item_with, initial_expose_scope, load_expose_scope_items_with,
    load_overseer_expose_item_with, next_expose_scope, parse_expose_args, read_expose_ui_state,
    run_tmux_expose_with_client_and_capture, run_tmux_expose_with_drivers,
    tmux_expose_options_from_socket_header, write_expose_ui_state, write_selected_window,
};
use aimux::tmux_expose_hot_snapshot::{
    HotExposeScopeKey, read_hot_expose_scope_view, write_hot_expose_scope_view,
};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const EXPOSE_NODE_FRAME: &str =
    include_str!("../../../../testdata/contracts/v1/tmux/expose-node-frame.json");

#[derive(Debug, Default)]
struct FakeHttp {
    responses: VecDeque<Result<Value, String>>,
    requests: Vec<(String, ExposeHttpRequest)>,
}

#[derive(Debug)]
struct FakeCapture {
    responses: VecDeque<Result<String, String>>,
    calls: Vec<String>,
}

#[derive(Debug)]
struct ScriptedInput {
    events: VecDeque<ScriptedInputEvent>,
}

#[derive(Debug, Default)]
struct FakeSizeProbe {
    responses: VecDeque<String>,
    calls: Vec<Option<String>>,
}

#[derive(Debug)]
enum ScriptedInputEvent {
    Bytes(Vec<u8>),
    Timeout,
}

impl Default for FakeCapture {
    fn default() -> Self {
        Self {
            responses: VecDeque::from([Ok("agent output\n".into())]),
            calls: Vec::new(),
        }
    }
}

impl FakeCapture {
    fn with_responses(values: impl IntoIterator<Item = Result<String, String>>) -> Self {
        Self {
            responses: values.into_iter().collect(),
            calls: Vec::new(),
        }
    }
}

impl ScriptedInput {
    fn new(events: impl IntoIterator<Item = ScriptedInputEvent>) -> Self {
        Self {
            events: events.into_iter().collect(),
        }
    }
}

impl FakeSizeProbe {
    fn with_responses(values: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            responses: values.into_iter().map(Into::into).collect(),
            calls: Vec::new(),
        }
    }
}

impl ExposeInputSource for ScriptedInput {
    fn read_timeout(
        &mut self,
        buffer: &mut [u8],
        _timeout: std::time::Duration,
    ) -> ExposeInputEvent {
        match self.events.pop_front() {
            None => ExposeInputEvent::End,
            Some(ScriptedInputEvent::Timeout) => ExposeInputEvent::Timeout,
            Some(ScriptedInputEvent::Bytes(bytes)) => {
                let count = bytes.len().min(buffer.len());
                buffer[..count].copy_from_slice(&bytes[..count]);
                ExposeInputEvent::Data(count)
            }
        }
    }
}

impl ExposeClientSizeProbe for FakeSizeProbe {
    fn query_client_size(&mut self, client_tty: Option<&str>) -> String {
        self.calls.push(client_tty.map(str::to_owned));
        self.responses.pop_front().unwrap_or_default()
    }
}

impl ExposeTmuxCapture for FakeCapture {
    fn capture_target(&mut self, item: &Value) -> Result<String, String> {
        self.calls.push(
            item.get("target")
                .and_then(|target| target.get("windowId"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        );
        self.responses
            .pop_front()
            .unwrap_or_else(|| Ok("agent output\n".into()))
    }
}

impl FakeHttp {
    fn with_responses(values: impl IntoIterator<Item = Value>) -> Self {
        Self {
            responses: values.into_iter().map(Ok).collect(),
            requests: Vec::new(),
        }
    }

    fn with_results(values: impl IntoIterator<Item = Result<Value, String>>) -> Self {
        Self {
            responses: values.into_iter().collect(),
            requests: Vec::new(),
        }
    }
}

fn run_tmux_expose_with_stable_size(
    options: aimux::tmux_expose::TmuxExposeOptions,
    input: &mut impl ExposeInputSource,
    output: &mut impl std::io::Write,
    client: &mut impl ExposeHttpClient,
    capture: &mut impl ExposeTmuxCapture,
) -> i32 {
    let mut size_probe = FakeSizeProbe::default();
    run_tmux_expose_with_drivers(options, input, output, client, capture, &mut size_probe)
}

impl ExposeHttpClient for FakeHttp {
    fn request_json(&mut self, url: &str, request: ExposeHttpRequest) -> Result<Value, String> {
        self.requests.push((url.to_owned(), request));
        self.responses
            .pop_front()
            .unwrap_or_else(|| Ok(json!({ "ok": true, "items": [] })))
    }
}

fn context() -> FastControlContext {
    FastControlContext {
        project_root: "/repo".into(),
        current_path: Some("/repo/worktree".into()),
        current_window: Some("codex".into()),
        current_window_id: Some("@1".into()),
        current_project_control: Some(false),
        current_client_session: Some("aimux-test-client-12345678".into()),
        client_tty: Some("/dev/aimux-test-tty".into()),
    }
}

#[test]
fn initial_scope_matches_launch_context_and_config() {
    assert_eq!(
        initial_expose_scope(true, &context(), &ExposeConfig::default()),
        ExposeScope::Global
    );
    assert_eq!(
        next_expose_scope(next_expose_scope(next_expose_scope(ExposeScope::Worktree))),
        ExposeScope::Global
    );

    let mut missing_window_id = context();
    missing_window_id.current_window_id = None;
    assert_eq!(
        initial_expose_scope(false, &missing_window_id, &ExposeConfig::default()),
        ExposeScope::Project
    );

    let mut dashboard = context();
    dashboard.current_window = Some("meta-dashboard".into());
    dashboard.current_project_control = Some(false);
    assert_eq!(
        initial_expose_scope(false, &dashboard, &ExposeConfig::default()),
        ExposeScope::Project
    );

    let mut project_control = context();
    project_control.current_project_control = Some(true);
    assert_eq!(
        initial_expose_scope(false, &project_control, &ExposeConfig::default()),
        ExposeScope::Project
    );

    let ordinary_agent = context();
    assert_eq!(
        initial_expose_scope(false, &ordinary_agent, &ExposeConfig::default()),
        ExposeScope::Worktree
    );

    assert_eq!(
        initial_expose_scope(
            false,
            &project_control,
            &ExposeConfig {
                initial_scope: Some(ExposeScope::Global)
            }
        ),
        ExposeScope::Global
    );
}

#[test]
fn initial_scope_uses_project_control_identity_from_metadata() {
    let overseer = json!({
        "sessionId": "claude-overseer",
        "projectControl": true,
        "team": { "role": "overseer" }
    });
    let scribe = json!({
        "sessionId": "claude-scribe",
        "scribe": true,
        "team": { "role": "scribe" }
    });
    let ordinary = json!({
        "sessionId": "codex-agent",
        "projectControl": false,
        "team": { "role": "worker" }
    });

    assert!(expose_project_control_flag_from_metadata(&overseer));
    assert!(expose_project_control_flag_from_metadata(&scribe));
    assert!(!expose_project_control_flag_from_metadata(&ordinary));

    for metadata in [overseer, scribe] {
        let mut caller = context();
        caller.current_project_control = Some(expose_project_control_flag_from_metadata(&metadata));
        assert_eq!(
            initial_expose_scope(false, &caller, &ExposeConfig::default()),
            ExposeScope::Project
        );
    }
}

#[test]
fn scope_items_build_local_and_global_requests_without_collapsing_failures_to_empty() {
    let state_dir = temp_dir("scope-items");
    fs::write(
        state_dir.join("metadata-api.txt"),
        "http://127.0.0.1:45000/\n",
    )
    .expect("endpoint");
    let mut fake = FakeHttp::with_results([
        Ok(json!({ "ok": true, "items": [{ "id": "local", "target": { "windowId": "@1" } }] })),
        Err("empty reply from server".into()),
        Ok(json!({ "ok": true, "items": [] })),
        Ok(json!({ "ok": true, "items": [{ "id": "global", "target": { "windowId": "@9" } }] })),
    ]);
    let deps = LoadExposeScopeDeps {
        daemon_endpoint: Some("http://127.0.0.1:43190/".into()),
        metadata_endpoint: None,
    };

    let local = load_expose_scope_items_with(
        ExposeScope::Worktree,
        &context(),
        &state_dir,
        &deps,
        &mut fake,
    )
    .expect("local scope");
    let failed = load_expose_scope_items_with(
        ExposeScope::Project,
        &context(),
        &state_dir,
        &deps,
        &mut fake,
    );
    let empty = load_expose_scope_items_with(
        ExposeScope::Project,
        &context(),
        &state_dir,
        &deps,
        &mut fake,
    )
    .expect("empty project scope");
    let global = load_expose_scope_items_with(
        ExposeScope::Global,
        &context(),
        &state_dir,
        &deps,
        &mut fake,
    )
    .expect("global scope");

    assert_eq!(local.scope_label, "this worktree");
    assert_eq!(local.sublabel, ExposeSublabel::None);
    assert_eq!(local.items[0]["id"], "local");
    assert_eq!(
        failed.expect_err("transient failure"),
        "empty reply from server"
    );
    assert!(empty.items.is_empty());
    assert_eq!(global.scope_label, "all projects");
    assert_eq!(global.sublabel, ExposeSublabel::ProjectWorktree);
    assert_eq!(global.items[0]["id"], "global");

    let local_url = &fake.requests[0].0;
    assert!(local_url.starts_with("http://127.0.0.1:45000/control/switchable-agents?"));
    assert!(local_url.contains("scope=worktree"));
    assert!(local_url.contains("labelFormat=raw"));
    assert!(local_url.contains("includePreview=1"));
    assert!(local_url.contains("clientKind=expose"));
    assert!(local_url.contains("clientTtlMs=10000"));
    assert!(local_url.contains("currentClientSession=aimux-test-client-12345678"));
    assert!(local_url.contains("currentWindowId=%401"));
    assert!(local_url.contains("currentPath=%2Frepo%2Fworktree"));
    assert_eq!(fake.requests[0].1.method, DaemonHttpMethod::Get);
    assert_eq!(fake.requests[0].1.timeout_ms, EXPOSE_HTTP_TIMEOUT_MS);

    let global_url = &fake.requests[3].0;
    assert!(global_url.starts_with("http://127.0.0.1:43190/core/expose/items?"));
    assert!(global_url.contains("includePreview=1"));
    assert!(!global_url.contains("currentWindow"));
    cleanup(state_dir);
}

#[test]
fn overseer_lookup_requests_all_scope_and_returns_first_overseer() {
    let state_dir = temp_dir("overseer");
    let mut fake = FakeHttp::with_responses([json!({
        "ok": true,
        "items": [
            { "id": "normal", "target": { "windowId": "@1" } },
            { "id": "overseer", "overseer": true, "target": { "windowId": "@2" } }
        ]
    })]);
    let deps = LoadExposeScopeDeps {
        daemon_endpoint: None,
        metadata_endpoint: Some("http://127.0.0.1:45000".into()),
    };

    let item =
        load_overseer_expose_item_with(&context(), &state_dir, &deps, &mut fake).expect("lookup");

    assert_eq!(item.expect("overseer")["id"], "overseer");
    assert!(fake.requests[0].0.contains("scope=all"));
    assert!(fake.requests[0].0.contains("includeOverseer=1"));
    cleanup(state_dir);
}

#[test]
fn focus_routes_local_items_to_project_service_and_global_items_to_daemon() {
    let state_dir = temp_dir("focus");
    let deps = LoadExposeScopeDeps {
        daemon_endpoint: Some("http://127.0.0.1:43190".into()),
        metadata_endpoint: Some("http://127.0.0.1:45000".into()),
    };
    let mut fake = FakeHttp::with_responses([json!({ "ok": true }), json!({ "ok": true })]);

    let local = json!({ "id": "local", "target": { "windowId": "@1" } });
    let global = json!({
        "id": "global",
        "projectRoot": "/other-repo",
        "target": { "windowId": "@9" }
    });

    assert!(
        focus_expose_item_with(&local, &context(), &state_dir, &deps, &mut fake).expect("local")
    );
    assert!(
        focus_expose_item_with(&global, &context(), &state_dir, &deps, &mut fake).expect("global")
    );

    assert_eq!(
        fake.requests[0].0,
        format!("http://127.0.0.1:45000{}", routes::controls::FOCUS_WINDOW)
    );
    assert_eq!(
        fake.requests[0].1.body,
        Some(json!({
            "windowId": "@1",
            "currentClientSession": "aimux-test-client-12345678",
            "clientTty": "/dev/aimux-test-tty",
            "focus": true
        }))
    );
    assert_eq!(
        fake.requests[1].0,
        format!("http://127.0.0.1:43190{}", CORE_API_ROUTES.expose_focus)
    );
    assert_eq!(
        fake.requests[1].1.body,
        Some(json!({
            "windowId": "@9",
            "projectRoot": "/other-repo",
            "currentClientSession": "aimux-test-client-12345678",
            "clientTty": "/dev/aimux-test-tty",
            "focus": true
        }))
    );
    cleanup(state_dir);
}

#[test]
fn selection_file_only_short_circuits_same_project_or_local_items() {
    let root = temp_dir("selection");
    let file = root.join("selected");

    assert!(write_selected_window(
        Some(&file),
        &root,
        &json!({ "target": { "windowId": "@1" } }),
    ));
    assert_eq!(fs::read_to_string(&file).expect("selected"), "@1\n");

    assert!(write_selected_window(
        Some(&file),
        &root,
        &json!({ "projectRoot": root, "target": { "windowId": "@2" } }),
    ));
    assert_eq!(fs::read_to_string(&file).expect("selected"), "@2\n");

    assert!(!write_selected_window(
        Some(&file),
        Path::new("/repo"),
        &json!({ "projectRoot": "/other-repo", "target": { "windowId": "@9" } }),
    ));
    assert_eq!(fs::read_to_string(&file).expect("selected"), "@2\n");
    cleanup(root);
}

#[test]
fn ui_state_defaults_invalid_files_and_round_trips_valid_modes() {
    let state_dir = temp_dir("ui-state");
    assert_eq!(
        read_expose_ui_state(&state_dir).sort_mode,
        ExposeSortMode::Default
    );

    fs::write(
        state_dir.join("expose-ui-state.json"),
        r#"{"version":1,"sortMode":"bad"}"#,
    )
    .expect("invalid state");
    assert_eq!(
        read_expose_ui_state(&state_dir).sort_mode,
        ExposeSortMode::Default
    );

    write_expose_ui_state(
        &state_dir,
        ExposeUiState {
            sort_mode: ExposeSortMode::RecentOutput,
        },
    )
    .expect("write state");
    assert_eq!(
        read_expose_ui_state(&state_dir).sort_mode,
        ExposeSortMode::RecentOutput
    );
    cleanup(state_dir);
}

#[test]
fn expose_args_require_paths_and_resolve_them_without_touching_optional_values() {
    let cwd = std::env::current_dir().expect("cwd");
    let parsed = parse_expose_args(&[
        "expose",
        "--project-root",
        "relative-project",
        "--project-state-dir=relative-state",
        "--current-client-session",
        "client-session",
        "--client-tty",
        "/dev/ttys001",
        "--current-window",
        "codex",
        "--current-window-id",
        "@1",
        "--current-project-control",
        "true",
        "--current-path",
        "../there",
        "--pane-id",
        "%7",
        "--aimux-home",
        "/tmp/home",
    ])
    .expect("parse");

    assert_eq!(parsed.project_root, cwd.join("relative-project"));
    assert_eq!(parsed.project_state_dir, cwd.join("relative-state"));
    assert_eq!(
        parsed.current_client_session.as_deref(),
        Some("client-session")
    );
    assert_eq!(parsed.client_tty.as_deref(), Some("/dev/ttys001"));
    assert_eq!(parsed.current_window.as_deref(), Some("codex"));
    assert_eq!(parsed.current_window_id.as_deref(), Some("@1"));
    assert_eq!(parsed.current_project_control, Some(true));
    assert_eq!(parsed.current_path.as_deref(), Some("../there"));
    assert_eq!(parsed.pane_id.as_deref(), Some("%7"));
    assert_eq!(parsed.aimux_home.as_deref(), Some("/tmp/home"));

    assert!(parse_expose_args(&["expose", "--project-root", "/repo"]).is_err());
    assert!(parse_expose_args(&["expose", "--project-state-dir", "/state"]).is_err());
}

#[test]
fn expose_args_load_resolved_initial_scope_from_aimux_config() {
    let root = temp_dir("parse-expose-config");
    let aimux_home = root.join("aimux-home");
    let project = root.join("repo");
    let state = root.join("state");
    fs::create_dir_all(&aimux_home).expect("aimux home");
    fs::create_dir_all(project.join(".aimux")).expect("project config dir");
    fs::create_dir_all(&state).expect("state dir");
    fs::write(
        aimux_home.join("config.json"),
        r#"{"expose":{"initialScope":"project"}}"#,
    )
    .expect("global config");
    fs::write(project.join(".aimux/config.json"), "{}").expect("project config");

    let parsed = parse_expose_args(&[
        "expose",
        "--project-root",
        project.to_str().unwrap(),
        "--project-state-dir",
        state.to_str().unwrap(),
        "--current-window",
        "codex",
        "--current-window-id",
        "@1",
        "--current-project-control",
        "false",
        "--aimux-home",
        aimux_home.to_str().unwrap(),
    ])
    .expect("parse");

    assert_eq!(
        parsed.expose_config.initial_scope,
        Some(ExposeScope::Project),
        "agent-launched Expose must honor resolved config instead of the built-in worktree default"
    );
    cleanup(root);
}

#[test]
fn socket_header_mapping_matches_metadata_server_contract() {
    let header = vec![
        "/project".to_owned(),
        "/state".to_owned(),
        "client-session".to_owned(),
        "/dev/ttys001".to_owned(),
        "codex".to_owned(),
        "@1".to_owned(),
        "/project/wt".to_owned(),
        "%7".to_owned(),
        "/home/.aimux".to_owned(),
        "1".to_owned(),
        "/tmp/status".to_owned(),
        "120cols".to_owned(),
        "30rows".to_owned(),
        "http://127.0.0.1:43190".to_owned(),
        "/tmp/selection".to_owned(),
    ];

    let options = tmux_expose_options_from_socket_header(&header, "/fallback", "/fallback-state");

    assert_eq!(options.project_root, PathBuf::from("/project"));
    assert_eq!(options.project_state_dir, PathBuf::from("/state"));
    assert_eq!(
        options.current_client_session.as_deref(),
        Some("client-session")
    );
    assert_eq!(options.client_tty.as_deref(), Some("/dev/ttys001"));
    assert_eq!(options.current_window.as_deref(), Some("codex"));
    assert_eq!(options.current_window_id.as_deref(), Some("@1"));
    assert_eq!(options.current_project_control, Some(true));
    assert_eq!(options.current_path.as_deref(), Some("/project/wt"));
    assert_eq!(options.pane_id.as_deref(), Some("%7"));
    assert_eq!(options.aimux_home.as_deref(), Some("/home/.aimux"));
    assert_eq!(
        options.daemon_endpoint.as_deref(),
        Some("http://127.0.0.1:43190")
    );
    assert_eq!(
        options.selection_file,
        Some(PathBuf::from("/tmp/selection"))
    );
    assert_eq!(options.columns, Some(120));
    assert_eq!(options.rows, Some(30));
}

#[test]
fn socket_header_mapping_loads_resolved_initial_scope_from_aimux_config() {
    let root = temp_dir("socket-expose-config");
    let aimux_home = root.join("aimux-home");
    let project = root.join("repo");
    let state = root.join("state");
    fs::create_dir_all(&aimux_home).expect("aimux home");
    fs::create_dir_all(project.join(".aimux")).expect("project config dir");
    fs::create_dir_all(&state).expect("state dir");
    fs::write(
        aimux_home.join("config.json"),
        r#"{"expose":{"initialScope":"project"}}"#,
    )
    .expect("global config");
    fs::write(project.join(".aimux/config.json"), "{}").expect("project config");
    let header = vec![
        project.to_string_lossy().into_owned(),
        state.to_string_lossy().into_owned(),
        String::new(),
        String::new(),
        "codex".to_owned(),
        "@1".to_owned(),
        project.to_string_lossy().into_owned(),
        String::new(),
        aimux_home.to_string_lossy().into_owned(),
    ];

    let options = tmux_expose_options_from_socket_header(&header, "/fallback", "/fallback-state");

    assert_eq!(
        options.expose_config.initial_scope,
        Some(ExposeScope::Project)
    );
    cleanup(root);
}

#[test]
fn runner_closes_opens_dashboard_and_focuses_numbered_global_tile() {
    let state_dir = temp_dir("runner-global");
    let mut options = parsed_options(&state_dir);
    options.client_tty = None;

    let mut close_client = FakeHttp::with_responses([json!({ "ok": true, "items": [] })]);
    let mut close_capture = FakeCapture::default();
    let mut close_input: &[u8] = b"q";
    let mut close_output = Vec::new();
    assert_eq!(
        run_tmux_expose_with_client_and_capture(
            options.clone(),
            &mut close_input,
            &mut close_output,
            &mut close_client,
            &mut close_capture,
        ),
        0
    );
    assert_cursor_hidden_then_restored(&close_output);

    let mut dashboard_client = FakeHttp::with_responses([json!({ "ok": true, "items": [] })]);
    let mut dashboard_capture = FakeCapture::default();
    let mut dashboard_input: &[u8] = b"\x01d";
    let mut dashboard_output = Vec::new();
    assert_eq!(
        run_tmux_expose_with_client_and_capture(
            options.clone(),
            &mut dashboard_input,
            &mut dashboard_output,
            &mut dashboard_client,
            &mut dashboard_capture,
        ),
        76
    );
    assert_cursor_hidden_then_restored(&dashboard_output);

    let mut focus_client = FakeHttp::with_responses([
        json!({
            "ok": true,
            "items": [{
                "id": "remote",
                "label": "codex",
                "projectRoot": "/other-repo",
                "projectName": "Other",
                "target": { "windowId": "@9" },
                "metadata": { "recencyAt": "2026-01-02T00:00:00.000Z" },
                "recentRank": 0
            }]
        }),
        json!({ "ok": true }),
    ]);
    let mut focus_capture = FakeCapture::default();
    let mut focus_input = ScriptedInput::new([
        ScriptedInputEvent::Timeout,
        ScriptedInputEvent::Bytes(b"1".to_vec()),
    ]);
    let mut focus_output = Vec::new();
    assert_eq!(
        run_tmux_expose_with_stable_size(
            options.clone(),
            &mut focus_input,
            &mut focus_output,
            &mut focus_client,
            &mut focus_capture,
        ),
        0
    );
    assert_cursor_hidden_then_restored(&focus_output);
    assert_eq!(
        focus_client.requests[1].0,
        format!("http://127.0.0.1:43190{}", CORE_API_ROUTES.expose_focus)
    );
    cleanup(state_dir);
}

#[test]
fn runner_moves_selection_with_n_before_closing() {
    let state_dir = temp_dir("runner-move-n");
    let mut options = parsed_options(&state_dir);
    options.current_window = Some("shell".into());
    options.current_window_id = Some("@1".into());
    options.expose_config.initial_scope = Some(ExposeScope::Worktree);
    let mut client = FakeHttp::with_responses([json!({
        "ok": true,
        "items": [
            hot_item("@1", "first preview\n"),
            hot_item("@2", "second preview\n")
        ]
    })]);
    let mut capture =
        FakeCapture::with_responses([Ok("first live\n".into()), Ok("second live\n".into())]);
    let mut input = ScriptedInput::new([
        ScriptedInputEvent::Timeout,
        ScriptedInputEvent::Bytes(b"nq".to_vec()),
    ]);
    let mut output = Vec::new();

    assert_eq!(
        run_tmux_expose_with_stable_size(
            options,
            &mut input,
            &mut output,
            &mut client,
            &mut capture,
        ),
        0
    );

    let rendered = String::from_utf8(output).expect("utf8 output");
    let last_frame = last_synchronized_frame(&rendered);
    assert!(
        last_frame.contains("▸\u{1b}[0m \u{1b}[1;33m2"),
        "expected n to move selection to tile 2:\n{rendered}"
    );
    cleanup(state_dir);
}

#[test]
fn runner_renders_topology_backed_tiles_when_live_window_projection_erases_expose_items() {
    let state_dir = temp_dir("runner-projection-erased-items");
    fs::write(
        runtime_topology_path(&state_dir),
        serde_yaml::to_string(&expose_projection_topology()).expect("topology yaml"),
    )
    .expect("write topology");
    let request_context =
        ProjectServiceRequestContext::with_project_state_dir(Path::new("/repo"), &state_dir)
            .with_live_window_ids(Vec::<String>::new());
    // aimux-async-seam: test - Expose regression drives the async switchable-agents route
    let route_response = aimux::async_runtime::block_on_named(
        "test:expose-projection-erased-items",
        route_switchable_agent_request_async(
            &request_context,
            "GET",
            "/control/switchable-agents?scope=all&currentPath=/repo/wt&currentWindowId=%401&labelFormat=raw&expose=1",
        ),
    )
    .expect("switchable-agents route");

    assert_eq!(route_response.status, 200);
    assert_eq!(route_response.body["tmuxLiveWindowQuery"]["ok"], false);
    assert_eq!(
        route_response.body["items"]
            .as_array()
            .expect("items")
            .len(),
        2,
        "the route must not collapse topology-backed Expose sessions into an empty list"
    );

    let mut options = parsed_options(&state_dir);
    options.current_window = Some("dashboard".into());
    options.current_window_id = Some("@dashboard".into());
    options.current_path = Some("/repo/wt".into());
    options.columns = Some(120);
    options.rows = Some(30);
    options.expose_config.initial_scope = Some(ExposeScope::Project);
    let mut client = FakeHttp::with_responses([route_response.body]);
    let mut capture =
        FakeCapture::with_responses([Ok("first live\n".into()), Ok("second live\n".into())]);
    let mut input = ScriptedInput::new([
        ScriptedInputEvent::Timeout,
        ScriptedInputEvent::Bytes(b"q".to_vec()),
    ]);
    let mut output = Vec::new();

    assert_eq!(
        run_tmux_expose_with_stable_size(
            options,
            &mut input,
            &mut output,
            &mut client,
            &mut capture,
        ),
        0
    );

    let rendered = String::from_utf8(output).expect("utf8 output");
    let populated_frame = synchronized_frames(&rendered)
        .into_iter()
        .find(|frame| frame.contains("all worktrees (2)"))
        .unwrap_or_else(|| {
            panic!("expected Expose to eventually render two topology-backed tiles:\n{rendered}")
        });
    assert!(
        !populated_frame.contains("all worktrees (0)"),
        "projection-erased sessions must not render as authoritative empty Expose:\n{populated_frame}"
    );
    assert!(
        capture.calls.iter().any(|window_id| window_id == "@1")
            && capture.calls.iter().any(|window_id| window_id == "@2"),
        "expected Expose to capture both rendered tiles, got {:?}",
        capture.calls
    );
    cleanup(state_dir);
}

#[test]
fn runner_reloads_scope_toggles_sort_and_uses_same_project_selection_file() {
    let state_dir = temp_dir("runner-selection");
    let selection_file = state_dir.join("selection");
    let mut options = parsed_options(&state_dir);
    options.current_window = Some("codex".into());
    options.current_window_id = Some("@1".into());
    options.expose_config.initial_scope = Some(ExposeScope::Worktree);
    options.selection_file = Some(selection_file.clone());
    let mut client = FakeHttp::with_responses([json!({
        "ok": true,
        "items": [
            { "id": "old", "label": "old", "target": { "windowId": "@1" }, "metadata": { "recencyAt": "2026-01-01T00:00:00.000Z" }, "recentRank": 1 },
            { "id": "new", "label": "new", "target": { "windowId": "@2" }, "metadata": { "recencyAt": "2026-01-02T00:00:00.000Z" }, "recentRank": 0 }
        ]
    })]);
    let mut capture = FakeCapture::default();
    let mut input = ScriptedInput::new([
        ScriptedInputEvent::Timeout,
        ScriptedInputEvent::Bytes(b"r1".to_vec()),
    ]);
    let mut output = Vec::new();

    assert_eq!(
        run_tmux_expose_with_stable_size(
            options,
            &mut input,
            &mut output,
            &mut client,
            &mut capture
        ),
        0
    );

    assert_eq!(
        fs::read_to_string(selection_file).expect("selection"),
        "@2\n"
    );
    assert_eq!(client.requests.len(), 1);
    assert_eq!(
        read_expose_ui_state(&state_dir).sort_mode,
        ExposeSortMode::RecentOutput
    );
    cleanup(state_dir);
}

#[test]
fn runner_renders_hot_snapshot_without_blocking_on_item_discovery() {
    let state_dir = temp_dir("runner-hot-snapshot");
    write_hot_expose_scope_view(
        &state_dir,
        HotExposeScopeKey {
            project_root: "/repo".into(),
            scope: ExposeScope::Project,
            worktree_key: None,
            launch_window_id: None,
        },
        ExposeScopeView {
            scope: ExposeScope::Project,
            scope_label: "all worktrees".into(),
            sublabel: ExposeSublabel::Worktree,
            items: vec![hot_item("@1", "hot preview line\n")],
        },
        None,
    );
    let mut options = parsed_options(&state_dir);
    options.current_window = Some("codex".into());
    options.expose_config.initial_scope = Some(ExposeScope::Project);
    let mut client = FakeHttp::default();
    let mut capture = FakeCapture::with_responses([Err("tmux unavailable".into())]);
    let mut input = ScriptedInput::new([
        ScriptedInputEvent::Timeout,
        ScriptedInputEvent::Bytes(b"q".to_vec()),
    ]);
    let mut output = Vec::new();

    assert_eq!(
        run_tmux_expose_with_stable_size(
            options,
            &mut input,
            &mut output,
            &mut client,
            &mut capture
        ),
        0
    );

    assert!(client.requests.is_empty());
    assert!(String::from_utf8_lossy(&output).contains("hot preview line"));
    cleanup(state_dir);
}

#[test]
fn runner_renders_loading_frame_before_initial_item_discovery() {
    let state_dir = temp_dir("runner-loading-before-discovery");
    let mut options = parsed_options(&state_dir);
    options.current_window = Some("codex".into());
    options.current_window_id = Some("@1".into());
    options.expose_config.initial_scope = Some(ExposeScope::Project);
    let mut client = FakeHttp::with_responses([json!({
        "ok": true,
        "items": [hot_item("@1", "loaded preview line\n")]
    })]);
    let mut capture = FakeCapture::with_responses([Err("tmux unavailable".into())]);
    let mut input = ScriptedInput::new([
        ScriptedInputEvent::Timeout,
        ScriptedInputEvent::Bytes(b"q".to_vec()),
    ]);
    let mut output = Vec::new();

    assert_eq!(
        run_tmux_expose_with_stable_size(
            options,
            &mut input,
            &mut output,
            &mut client,
            &mut capture,
        ),
        0
    );

    let rendered = String::from_utf8(output).expect("utf8 output");
    let first_frame = first_synchronized_frame(&rendered);
    let last_frame = last_synchronized_frame(&rendered);
    assert!(first_frame.contains("Loading sessions..."));
    assert!(!first_frame.contains("loaded preview line"));
    assert!(last_frame.contains("loaded preview line"));
    assert_eq!(client.requests.len(), 1);
    assert_eq!(capture.calls, vec!["@1"]);
    cleanup(state_dir);
}

#[test]
fn runner_retries_initial_item_discovery_failure_instead_of_rendering_empty() {
    let state_dir = temp_dir("runner-retry-initial-discovery");
    let mut options = parsed_options(&state_dir);
    options.current_window = Some("codex".into());
    options.current_window_id = Some("@1".into());
    options.expose_config.initial_scope = Some(ExposeScope::Project);
    let mut client = FakeHttp::with_results([
        Err("empty reply from server".into()),
        Ok(json!({
            "ok": true,
            "items": [hot_item("@1", "retry loaded preview line\n")]
        })),
    ]);
    let mut capture = FakeCapture::with_responses([Err("tmux unavailable".into())]);
    let mut input = ScriptedInput::new([
        ScriptedInputEvent::Timeout,
        ScriptedInputEvent::Bytes(b"q".to_vec()),
    ]);
    let mut output = Vec::new();

    assert_eq!(
        run_tmux_expose_with_stable_size(
            options,
            &mut input,
            &mut output,
            &mut client,
            &mut capture,
        ),
        0
    );

    let rendered = String::from_utf8(output).expect("utf8 output");
    let first_frame = first_synchronized_frame(&rendered);
    let last_frame = last_synchronized_frame(&rendered);
    assert!(first_frame.contains("Loading sessions..."));
    assert!(!first_frame.contains("No active agents"));
    assert!(last_frame.contains("retry loaded preview line"));
    assert_eq!(client.requests.len(), 2);
    assert_eq!(capture.calls, vec!["@1"]);
    cleanup(state_dir);
}

#[test]
fn runner_captures_missing_previews_before_first_loaded_frame() {
    let state_dir = temp_dir("runner-startup-capture");
    let mut options = parsed_options(&state_dir);
    options.current_window = Some("codex".into());
    options.current_window_id = Some("@1".into());
    options.expose_config.initial_scope = Some(ExposeScope::Project);
    let mut client = FakeHttp::with_responses([json!({
        "ok": true,
        "items": [{
            "id": "one",
            "label": "one",
            "target": { "sessionName": "aimux-repo", "windowId": "@1", "windowIndex": 1, "windowName": "one" },
            "activity": 1,
            "urgency": 0,
            "recentRank": 0,
            "metadata": {
                "sessionId": "one",
                "command": "codex",
                "args": [],
                "toolConfigKey": "codex",
                "worktreePath": "/repo"
            }
        }]
    })]);
    let mut capture = FakeCapture::with_responses([Ok("first live capture line\n".into())]);
    let mut input = ScriptedInput::new([ScriptedInputEvent::Bytes(b"q".to_vec())]);
    let mut output = Vec::new();

    assert_eq!(
        run_tmux_expose_with_stable_size(
            options,
            &mut input,
            &mut output,
            &mut client,
            &mut capture,
        ),
        0
    );

    let rendered = String::from_utf8(output).expect("utf8 output");
    let frames = synchronized_frames(&rendered);
    assert_eq!(capture.calls, vec!["@1"]);
    assert!(
        frames
            .get(1)
            .is_some_and(|frame| frame.contains("first live capture line")),
        "first loaded frame should contain captured output:\n{rendered}"
    );
    cleanup(state_dir);
}

#[test]
fn runner_logs_failed_startup_preview_capture() {
    let state_dir = temp_dir("runner-startup-capture-log");
    let log_path = state_dir.join("debug.jsonl");
    configure_logging(LoggingRuntimeConfig {
        enabled: true,
        level: LogLevel::Debug,
        categories: vec!["expose".to_owned()],
        path: log_path.clone(),
        process_kind: "test".to_owned(),
        project_id: None,
        project_root: None,
        ..LoggingRuntimeConfig::default()
    });
    let mut options = parsed_options(&state_dir);
    options.current_window = Some("codex".into());
    options.current_window_id = Some("@1".into());
    options.expose_config.initial_scope = Some(ExposeScope::Project);
    let mut client = FakeHttp::with_responses([json!({
        "ok": true,
        "items": [{
            "id": "one",
            "label": "one",
            "target": { "sessionName": "aimux-repo", "windowId": "@1", "windowIndex": 1, "windowName": "one" },
            "activity": 1,
            "urgency": 0,
            "recentRank": 0,
            "metadata": { "sessionId": "one", "command": "codex", "worktreePath": "/repo" }
        }]
    })]);
    let mut capture = FakeCapture::with_responses([Err("tmux capture failed".into())]);
    let mut input = ScriptedInput::new([ScriptedInputEvent::Bytes(b"q".to_vec())]);
    let mut output = Vec::new();

    assert_eq!(
        run_tmux_expose_with_stable_size(
            options,
            &mut input,
            &mut output,
            &mut client,
            &mut capture,
        ),
        0
    );
    reset_logging_for_tests();

    let raw = fs::read_to_string(&log_path).expect("debug log written");
    assert!(raw.contains("expose startup preview capture failed"));
    assert!(raw.contains("\"windowId\":\"@1\""));
    assert!(raw.contains("\"sessionId\":\"one\""));
    assert!(raw.contains("\"error\":\"tmux capture failed\""));
    cleanup(state_dir);
}

#[test]
fn runner_applies_pending_navigation_after_initial_item_discovery() {
    let state_dir = temp_dir("runner-pending-navigation");
    let mut options = parsed_options(&state_dir);
    options.current_window = Some("shell".into());
    options.current_window_id = Some("@1".into());
    options.expose_config.initial_scope = Some(ExposeScope::Worktree);
    let mut client = FakeHttp::with_responses([
        json!({
            "ok": true,
            "items": [
                hot_item("@1", "first preview\n"),
                hot_item("@2", "second preview\n")
            ]
        }),
        json!({ "ok": true }),
    ]);
    let mut capture = FakeCapture::with_responses([
        Err("tmux unavailable".into()),
        Err("tmux unavailable".into()),
    ]);
    let mut input = ScriptedInput::new([
        ScriptedInputEvent::Bytes(b"n\r".to_vec()),
        ScriptedInputEvent::Timeout,
    ]);
    let mut output = Vec::new();

    assert_eq!(
        run_tmux_expose_with_stable_size(
            options,
            &mut input,
            &mut output,
            &mut client,
            &mut capture,
        ),
        0
    );

    assert_eq!(client.requests.len(), 2);
    assert_eq!(
        client.requests[1].1.body.as_ref().unwrap()["windowId"],
        "@2"
    );
    cleanup(state_dir);
}

#[test]
fn runner_matches_node_generated_whole_expose_frame() {
    let contract: Value = serde_json::from_str(EXPOSE_NODE_FRAME).expect("node frame fixture");
    let case = &contract["cases"][0];
    let state_dir = temp_dir("runner-node-frame");
    let snapshot = &case["input"]["hotSnapshot"];
    write_hot_expose_scope_view(
        &state_dir,
        HotExposeScopeKey {
            project_root: snapshot["key"]["projectRoot"]
                .as_str()
                .expect("project root")
                .into(),
            scope: expose_scope_value(&snapshot["key"]["scope"]),
            worktree_key: snapshot["key"]
                .get("worktreeKey")
                .and_then(Value::as_str)
                .map(str::to_owned),
            launch_window_id: snapshot["key"]
                .get("launchWindowId")
                .and_then(Value::as_str)
                .map(str::to_owned),
        },
        ExposeScopeView {
            scope: expose_scope_value(&snapshot["view"]["scope"]),
            scope_label: snapshot["view"]["scopeLabel"]
                .as_str()
                .expect("scope label")
                .into(),
            sublabel: expose_sublabel_value(&snapshot["view"]["sublabel"]),
            items: snapshot["view"]["items"]
                .as_array()
                .expect("items")
                .to_vec(),
        },
        None,
    );
    let input_options = &case["input"]["options"];
    let mut options = parsed_options(&state_dir);
    options.project_root =
        PathBuf::from(input_options["projectRoot"].as_str().expect("project root"));
    options.current_window = input_options
        .get("currentWindow")
        .and_then(Value::as_str)
        .map(str::to_owned);
    options.current_window_id = input_options
        .get("currentWindowId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    options.current_path = input_options
        .get("currentPath")
        .and_then(Value::as_str)
        .map(str::to_owned);
    options.current_client_session = input_options
        .get("currentClientSession")
        .and_then(Value::as_str)
        .map(str::to_owned);
    options.daemon_endpoint = input_options
        .get("daemonEndpoint")
        .and_then(Value::as_str)
        .map(str::to_owned);
    options.columns = input_options
        .get("columns")
        .and_then(Value::as_u64)
        .map(|value| value as usize);
    options.rows = input_options
        .get("rows")
        .and_then(Value::as_u64)
        .map(|value| value as usize);
    options.expose_config.initial_scope = input_options
        .get("exposeConfig")
        .and_then(|config| config.get("initialScope"))
        .map(expose_scope_value);
    let mut client = FakeHttp::with_responses([json!({ "ok": true, "items": [] })]);
    let mut capture = FakeCapture::with_responses([Err("tmux unavailable".into())]);
    let mut input = ScriptedInput::new([ScriptedInputEvent::Bytes(
        case["input"]["inputBytes"]
            .as_str()
            .expect("input bytes")
            .as_bytes()
            .to_vec(),
    )]);
    let mut output = Vec::new();

    let exit_code = run_tmux_expose_with_stable_size(
        options,
        &mut input,
        &mut output,
        &mut client,
        &mut capture,
    );

    assert_eq!(
        exit_code,
        case["output"]["exitCode"].as_i64().unwrap() as i32
    );
    assert_eq!(
        first_synchronized_frame(&String::from_utf8(output).expect("utf8 output")),
        case["output"]["frame"].as_str().expect("expected output")
    );
    cleanup(state_dir);
}

#[test]
fn runner_validates_stale_hot_selection_before_writing_selection_file() {
    let state_dir = temp_dir("runner-hot-selection");
    let selection_file = state_dir.join("selected-window.txt");
    write_hot_expose_scope_view(
        &state_dir,
        HotExposeScopeKey {
            project_root: "/repo".into(),
            scope: ExposeScope::Project,
            worktree_key: None,
            launch_window_id: None,
        },
        ExposeScopeView {
            scope: ExposeScope::Project,
            scope_label: "all worktrees".into(),
            sublabel: ExposeSublabel::Worktree,
            items: vec![hot_item("@1", "hot preview line\n")],
        },
        None,
    );
    let mut options = parsed_options(&state_dir);
    options.current_window = Some("codex".into());
    options.expose_config.initial_scope = Some(ExposeScope::Project);
    options.selection_file = Some(selection_file.clone());
    options.client_tty = None;
    let mut client = FakeHttp::with_responses([json!({ "ok": true })]);
    let mut capture = FakeCapture::with_responses([Err("tmux unavailable".into())]);
    let mut input: &[u8] = b"\r";
    let mut output = Vec::new();

    assert_eq!(
        run_tmux_expose_with_client_and_capture(
            options,
            &mut input,
            &mut output,
            &mut client,
            &mut capture
        ),
        0
    );

    assert!(!selection_file.exists());
    assert_eq!(
        client.requests[0].0,
        format!("http://127.0.0.1:45000{}", routes::controls::FOCUS_WINDOW)
    );
    cleanup(state_dir);
}

#[test]
fn runner_replaces_preview_snapshot_with_live_capture_output() {
    let state_dir = temp_dir("runner-live-capture");
    let mut options = parsed_options(&state_dir);
    options.current_window = Some("codex".into());
    options.expose_config.initial_scope = Some(ExposeScope::Project);
    let mut client = FakeHttp::with_responses([json!({
        "ok": true,
        "items": [hot_item("@1", "warm preview line\n")]
    })]);
    let mut capture = FakeCapture::with_responses([Ok("live capture line\n".into())]);
    let mut input = ScriptedInput::new([
        ScriptedInputEvent::Timeout,
        ScriptedInputEvent::Bytes(b"q".to_vec()),
    ]);
    let mut output = Vec::new();

    assert_eq!(
        run_tmux_expose_with_stable_size(
            options,
            &mut input,
            &mut output,
            &mut client,
            &mut capture
        ),
        0
    );

    let rendered = String::from_utf8_lossy(&output);
    assert!(rendered.contains("live capture line"));
    assert_eq!(capture.calls, vec!["@1"]);
    cleanup(state_dir);
}

#[test]
fn runner_writes_loaded_items_to_hot_snapshot_cache() {
    let state_dir = temp_dir("runner-hot-write");
    let mut options = parsed_options(&state_dir);
    options.current_window = Some("meta-dashboard".into());
    options.expose_config.initial_scope = Some(ExposeScope::Global);
    let mut client = FakeHttp::with_responses([json!({
        "ok": true,
        "items": [hot_item("@9", "loaded preview line\n")]
    })]);
    let mut capture = FakeCapture::with_responses([Err("tmux unavailable".into())]);
    let mut input = ScriptedInput::new([
        ScriptedInputEvent::Timeout,
        ScriptedInputEvent::Bytes(b"q".to_vec()),
    ]);
    let mut output = Vec::new();

    assert_eq!(
        run_tmux_expose_with_stable_size(
            options,
            &mut input,
            &mut output,
            &mut client,
            &mut capture
        ),
        0
    );

    let cached = read_hot_expose_scope_view(
        &state_dir,
        &HotExposeScopeKey {
            project_root: "/repo".into(),
            scope: ExposeScope::Global,
            worktree_key: None,
            launch_window_id: None,
        },
    )
    .expect("loaded snapshot");
    assert_eq!(cached.scope, ExposeScope::Global);
    assert_eq!(cached.items.len(), 1);
    assert_eq!(cached.items[0]["target"]["windowId"], "@9");
    assert_eq!(
        cached.items[0]["previewSnapshot"]["output"],
        "loaded preview line\n"
    );
    cleanup(state_dir);
}

#[test]
fn runner_writes_zoomed_project_items_to_hot_snapshot_cache() {
    let state_dir = temp_dir("runner-hot-write-zoom");
    let mut options = parsed_options(&state_dir);
    options.current_window = Some("codex".into());
    options.current_window_id = Some("@1".into());
    options.current_path = Some("/repo/.aimux/worktrees/feature/src".into());
    options.expose_config.initial_scope = Some(ExposeScope::Worktree);
    let mut client = FakeHttp::with_responses([
        json!({
            "ok": true,
            "items": [hot_item("@1", "worktree preview line\n")]
        }),
        json!({
            "ok": true,
            "items": [hot_item("@2", "project preview line\n")]
        }),
    ]);
    let mut capture = FakeCapture::with_responses([
        Err("tmux unavailable".into()),
        Err("tmux unavailable".into()),
    ]);
    let mut input = ScriptedInput::new([
        ScriptedInputEvent::Timeout,
        ScriptedInputEvent::Bytes(b"gq".to_vec()),
    ]);
    let mut output = Vec::new();

    assert_eq!(
        run_tmux_expose_with_stable_size(
            options,
            &mut input,
            &mut output,
            &mut client,
            &mut capture
        ),
        0
    );

    let cached = read_hot_expose_scope_view(
        &state_dir,
        &HotExposeScopeKey {
            project_root: "/repo".into(),
            scope: ExposeScope::Project,
            worktree_key: None,
            launch_window_id: None,
        },
    )
    .expect("project snapshot");
    assert_eq!(cached.scope, ExposeScope::Project);
    assert_eq!(cached.items.len(), 1);
    assert_eq!(cached.items[0]["target"]["windowId"], "@2");
    cleanup(state_dir);
}

#[test]
fn runner_refreshes_live_captures_on_timeout_tick() {
    let state_dir = temp_dir("runner-refresh-capture");
    let mut options = parsed_options(&state_dir);
    options.current_window = Some("codex".into());
    options.expose_config.initial_scope = Some(ExposeScope::Project);
    let mut client = FakeHttp::with_responses([json!({
        "ok": true,
        "items": [hot_item("@1", "warm preview line\n")]
    })]);
    let mut capture = FakeCapture::with_responses([
        Ok("first live line\n".into()),
        Ok("second live line\n".into()),
    ]);
    let mut input = ScriptedInput::new([
        ScriptedInputEvent::Timeout,
        ScriptedInputEvent::Timeout,
        ScriptedInputEvent::Bytes(b"q".to_vec()),
    ]);
    let mut output = Vec::new();

    assert_eq!(
        run_tmux_expose_with_stable_size(
            options,
            &mut input,
            &mut output,
            &mut client,
            &mut capture
        ),
        0
    );

    let rendered = String::from_utf8_lossy(&output);
    assert!(rendered.contains("first live line"));
    assert!(rendered.contains("second live line"));
    assert_eq!(capture.calls, vec!["@1", "@1"]);
    cleanup(state_dir);
}

#[test]
fn runner_reloads_items_every_fifth_timeout_tick() {
    let state_dir = temp_dir("runner-refresh-reload");
    let mut options = parsed_options(&state_dir);
    options.current_window = Some("codex".into());
    options.current_window_id = Some("@1".into());
    options.expose_config.initial_scope = Some(ExposeScope::Project);
    let mut client = FakeHttp::with_responses([
        json!({
            "ok": true,
            "items": [hot_item("@1", "initial preview line\n")]
        }),
        json!({
            "ok": true,
            "items": [hot_item("@2", "reloaded preview line\n")]
        }),
    ]);
    let mut capture = FakeCapture::with_responses([
        Err("tmux unavailable".into()),
        Err("tmux unavailable".into()),
        Err("tmux unavailable".into()),
        Err("tmux unavailable".into()),
        Err("tmux unavailable".into()),
        Err("tmux unavailable".into()),
    ]);
    let mut input = ScriptedInput::new([
        ScriptedInputEvent::Timeout,
        ScriptedInputEvent::Timeout,
        ScriptedInputEvent::Timeout,
        ScriptedInputEvent::Timeout,
        ScriptedInputEvent::Timeout,
        ScriptedInputEvent::Timeout,
        ScriptedInputEvent::Bytes(b"q".to_vec()),
    ]);
    let mut output = Vec::new();

    assert_eq!(
        run_tmux_expose_with_stable_size(
            options,
            &mut input,
            &mut output,
            &mut client,
            &mut capture
        ),
        0
    );

    let rendered = String::from_utf8_lossy(&output);
    assert!(rendered.contains("initial preview line"));
    assert!(rendered.contains("reloaded preview line"));
    assert_eq!(client.requests.len(), 2);
    let cached = read_hot_expose_scope_view(
        &state_dir,
        &HotExposeScopeKey {
            project_root: "/repo".into(),
            scope: ExposeScope::Project,
            worktree_key: None,
            launch_window_id: None,
        },
    )
    .expect("reloaded snapshot");
    assert_eq!(cached.items[0]["target"]["windowId"], "@2");
    cleanup(state_dir);
}

#[test]
fn runner_returns_relaunch_code_when_client_size_changes() {
    let state_dir = temp_dir("runner-resize");
    let mut options = parsed_options(&state_dir);
    options.current_window = Some("codex".into());
    options.current_window_id = Some("@1".into());
    options.client_tty = Some("/dev/ttys001".into());
    options.columns = Some(80);
    options.rows = Some(24);
    options.expose_config.initial_scope = Some(ExposeScope::Project);
    let mut client = FakeHttp::with_responses([json!({
        "ok": true,
        "items": [hot_item("@1", "initial preview line\n")]
    })]);
    let mut capture = FakeCapture::with_responses([Err("tmux unavailable".into())]);
    let mut size_probe = FakeSizeProbe::with_responses(["100x30"]);
    let mut input = ScriptedInput::new([ScriptedInputEvent::Timeout]);
    let mut output = Vec::new();

    assert_eq!(
        run_tmux_expose_with_drivers(
            options,
            &mut input,
            &mut output,
            &mut client,
            &mut capture,
            &mut size_probe
        ),
        RELAUNCH_ON_RESIZE_EXIT
    );
    assert_eq!(size_probe.calls, vec![Some("/dev/ttys001".to_owned())]);
    assert!(client.requests.is_empty());
    assert!(capture.calls.is_empty());
    assert_cursor_hidden_then_restored(&output);
    cleanup(state_dir);
}

fn parsed_options(state_dir: &Path) -> aimux::tmux_expose::TmuxExposeOptions {
    aimux::tmux_expose::TmuxExposeOptions {
        project_root: PathBuf::from("/repo"),
        project_state_dir: state_dir.to_path_buf(),
        current_window: Some("meta-dashboard".into()),
        current_window_id: Some("@1".into()),
        current_client_session: Some("aimux-test-client-12345678".into()),
        client_tty: Some("/dev/ttys001".into()),
        daemon_endpoint: Some("http://127.0.0.1:43190".into()),
        metadata_endpoint: Some("http://127.0.0.1:45000".into()),
        columns: Some(80),
        rows: Some(24),
        ..aimux::tmux_expose::TmuxExposeOptions::default()
    }
}

fn hot_item(window_id: &str, output: &str) -> Value {
    json!({
        "id": format!("session-{window_id}"),
        "label": "codex",
        "urgency": 0,
        "activity": 0,
        "recentRank": 0,
        "previewSnapshot": {
            "output": output,
            "capturedAt": "2026-07-20T13:00:00.000Z",
            "source": "capture",
            "windowId": window_id,
            "startLine": -40,
            "lineCount": 40
        },
        "target": {
            "sessionName": "aimux-test",
            "windowId": window_id,
            "windowIndex": 1,
            "windowName": "codex"
        },
        "metadata": {
            "kind": "agent",
            "sessionId": format!("session-{window_id}"),
            "command": "codex",
            "args": [],
            "toolConfigKey": "codex",
            "worktreePath": "/repo"
        }
    })
}

fn expose_projection_topology() -> Value {
    json!({
        "version": 1,
        "generatedAt": "2026-09-12T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "local", "projectRoot": "/repo", "createdAt": "2026-09-12T00:00:00.000Z", "updatedAt": "2026-09-12T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-one", "rigId": "rig-1", "logicalId": "one", "toolConfigKey": "shell", "cwd": "/repo/wt", "label": "shell-one", "createdAt": "2026-09-12T00:00:00.000Z" },
            { "id": "node-two", "rigId": "rig-1", "logicalId": "two", "toolConfigKey": "shell", "cwd": "/repo/wt", "label": "shell-two", "createdAt": "2026-09-12T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "binding-one", "nodeId": "node-one", "tmuxSession": "aimux-repo", "tmuxWindowId": "@1", "tmuxWindowIndex": 1, "tmuxWindowName": "shell-one", "updatedAt": "2026-09-12T00:00:00.000Z" },
            { "id": "binding-two", "nodeId": "node-two", "tmuxSession": "aimux-repo", "tmuxWindowId": "@2", "tmuxWindowIndex": 2, "tmuxWindowName": "shell-two", "updatedAt": "2026-09-12T00:00:00.000Z" }
        ],
        "sessions": [
            { "id": "session-one", "nodeId": "node-one", "status": "running", "tool": "shell", "command": "shell", "worktreePath": "/repo/wt", "label": "shell-one", "createdAt": "2026-09-12T00:00:00.000Z", "updatedAt": "2026-09-12T00:00:00.000Z" },
            { "id": "session-two", "nodeId": "node-two", "status": "running", "tool": "shell", "command": "shell", "worktreePath": "/repo/wt", "label": "shell-two", "createdAt": "2026-09-12T00:00:00.000Z", "updatedAt": "2026-09-12T00:00:00.000Z" }
        ],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    })
}

fn expose_scope_value(value: &Value) -> ExposeScope {
    match value.as_str().expect("expose scope") {
        "worktree" => ExposeScope::Worktree,
        "project" => ExposeScope::Project,
        "global" => ExposeScope::Global,
        unexpected => panic!("unexpected expose scope {unexpected}"),
    }
}

fn expose_sublabel_value(value: &Value) -> ExposeSublabel {
    match value.as_str().expect("expose sublabel") {
        "none" => ExposeSublabel::None,
        "worktree" => ExposeSublabel::Worktree,
        "project-worktree" => ExposeSublabel::ProjectWorktree,
        unexpected => panic!("unexpected expose sublabel {unexpected}"),
    }
}

fn first_synchronized_frame(output: &str) -> &str {
    synchronized_frames(output)
        .into_iter()
        .next()
        .expect("synchronized frame")
}

fn last_synchronized_frame(output: &str) -> &str {
    synchronized_frames(output)
        .into_iter()
        .last()
        .expect("synchronized frame")
}

fn synchronized_frames(output: &str) -> Vec<&str> {
    let mut frames = Vec::new();
    let mut cursor = 0;
    while let Some(relative_start) = output[cursor..].find("\x1b[?2026h") {
        let start = cursor + relative_start;
        let Some(relative_end) = output[start..].find("\x1b[?2026l") else {
            break;
        };
        let end = start + relative_end + "\x1b[?2026l".len();
        frames.push(&output[start..end]);
        cursor = end;
    }
    frames
}

fn assert_cursor_hidden_then_restored(output: &[u8]) {
    let rendered = String::from_utf8_lossy(output);
    let hide_at = rendered
        .find("\x1b[?25l")
        .unwrap_or_else(|| panic!("expected expose setup to hide cursor:\n{rendered}"));
    let show_at = rendered
        .rfind("\x1b[?25h")
        .unwrap_or_else(|| panic!("expected expose exit to restore cursor:\n{rendered}"));
    assert!(
        hide_at < show_at,
        "expected expose to hide cursor before restoring it:\n{rendered}"
    );
}

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-tmux-expose-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    fs::create_dir_all(&path).expect("create temp dir");
    path
}

fn cleanup(path: PathBuf) {
    let _ = fs::remove_dir_all(path);
}
