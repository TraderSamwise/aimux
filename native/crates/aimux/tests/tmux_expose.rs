use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::core_command_transport::DaemonHttpMethod;
use aimux::project_api_contract::routes;
use aimux::tmux_expose::{
    EXPOSE_HTTP_TIMEOUT_MS, ExposeConfig, ExposeHttpClient, ExposeHttpRequest, ExposeScope,
    ExposeSortMode, ExposeSublabel, ExposeUiState, FastControlContext, LoadExposeScopeDeps,
    focus_expose_item_with, initial_expose_scope, load_expose_scope_items_with,
    load_overseer_expose_item_with, next_expose_scope, parse_expose_args, read_expose_ui_state,
    run_tmux_expose_with_client, tmux_expose_options_from_socket_header, write_expose_ui_state,
    write_selected_window,
};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Default)]
struct FakeHttp {
    responses: VecDeque<Value>,
    requests: Vec<(String, ExposeHttpRequest)>,
}

impl FakeHttp {
    fn with_responses(values: impl IntoIterator<Item = Value>) -> Self {
        Self {
            responses: values.into_iter().collect(),
            requests: Vec::new(),
        }
    }
}

impl ExposeHttpClient for FakeHttp {
    fn request_json(&mut self, url: &str, request: ExposeHttpRequest) -> Result<Value, String> {
        self.requests.push((url.to_owned(), request));
        Ok(self
            .responses
            .pop_front()
            .unwrap_or_else(|| json!({ "ok": true, "items": [] })))
    }
}

fn context() -> FastControlContext {
    FastControlContext {
        project_root: "/repo".into(),
        current_path: Some("/repo/worktree".into()),
        current_window: Some("codex".into()),
        current_window_id: Some("@1".into()),
        current_client_session: Some("aimux-test-client-12345678".into()),
        client_tty: Some("/dev/ttys001".into()),
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
    assert_eq!(
        initial_expose_scope(false, &dashboard, &ExposeConfig::default()),
        ExposeScope::Project
    );

    assert_eq!(
        initial_expose_scope(
            false,
            &context(),
            &ExposeConfig {
                initial_scope: Some(ExposeScope::Project)
            }
        ),
        ExposeScope::Project
    );
}

#[test]
fn scope_items_build_local_and_global_requests_with_empty_failure_fallback() {
    let state_dir = temp_dir("scope-items");
    fs::write(
        state_dir.join("metadata-api.txt"),
        "http://127.0.0.1:45000/\n",
    )
    .expect("endpoint");
    let mut fake = FakeHttp::with_responses([
        json!({ "ok": true, "items": [{ "id": "local", "target": { "windowId": "@1" } }] }),
        json!({ "ok": false, "items": [{ "id": "ignored" }] }),
        json!({ "ok": true, "items": [{ "id": "global", "target": { "windowId": "@9" } }] }),
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
    )
    .expect("project scope");
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
    assert!(failed.items.is_empty());
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

    let global_url = &fake.requests[2].0;
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
            "clientTty": "/dev/ttys001",
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
            "clientTty": "/dev/ttys001",
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
    assert_eq!(parsed.current_path.as_deref(), Some("../there"));
    assert_eq!(parsed.pane_id.as_deref(), Some("%7"));
    assert_eq!(parsed.aimux_home.as_deref(), Some("/tmp/home"));

    assert!(parse_expose_args(&["expose", "--project-root", "/repo"]).is_err());
    assert!(parse_expose_args(&["expose", "--project-state-dir", "/state"]).is_err());
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
        "".to_owned(),
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
fn runner_closes_opens_dashboard_and_focuses_numbered_global_tile() {
    let state_dir = temp_dir("runner-global");
    let options = parsed_options(&state_dir);

    let mut close_client = FakeHttp::with_responses([json!({ "ok": true, "items": [] })]);
    let mut close_input: &[u8] = b"q";
    let mut close_output = Vec::new();
    assert_eq!(
        run_tmux_expose_with_client(
            options.clone(),
            &mut close_input,
            &mut close_output,
            &mut close_client
        ),
        0
    );

    let mut dashboard_client = FakeHttp::with_responses([json!({ "ok": true, "items": [] })]);
    let mut dashboard_input: &[u8] = b"\x01d";
    let mut dashboard_output = Vec::new();
    assert_eq!(
        run_tmux_expose_with_client(
            options.clone(),
            &mut dashboard_input,
            &mut dashboard_output,
            &mut dashboard_client
        ),
        76
    );

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
    let mut focus_input: &[u8] = b"1";
    let mut focus_output = Vec::new();
    assert_eq!(
        run_tmux_expose_with_client(
            options.clone(),
            &mut focus_input,
            &mut focus_output,
            &mut focus_client
        ),
        0
    );
    assert_eq!(
        focus_client.requests[1].0,
        format!("http://127.0.0.1:43190{}", CORE_API_ROUTES.expose_focus)
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
    let mut input: &[u8] = b"r1";
    let mut output = Vec::new();

    assert_eq!(
        run_tmux_expose_with_client(options, &mut input, &mut output, &mut client),
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
