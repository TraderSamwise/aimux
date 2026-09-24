use aimux::daemon_state::{MetadataState, save_metadata_state};
use aimux::project_api_contract::routes;
use aimux::project_service::router::route_project_service_request;
use aimux::project_service::runtime_exchange::runtime_exchange_path;
use aimux::project_service::statusline::{
    StatuslineRefreshInput, refresh_project_statusline_with_tmux_refresh,
    refresh_project_statusline_with_tmux_refresh_async, route_statusline_refresh_request_async,
};
use aimux::runtime_topology::{runtime_topology_path, write_runtime_topology};
use serde_json::{Value, json};
use std::fs::{create_dir_all, read_to_string, remove_dir_all, write};
use std::future::pending;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

mod support;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn statusline_refresh_writes_snapshot_and_tmux_artifacts() {
    let project = temp_project("refresh");
    let state_dir = project.join("state");
    create_dir_all(state_dir.join("tmux-statusline")).expect("status dir");
    write(
        state_dir.join("tmux-statusline").join("top-stale.txt"),
        "stale\n",
    )
    .expect("stale");
    write_runtime_topology(
        runtime_topology_path(&state_dir),
        &topology_fixture(&project),
    )
    .expect("topology");
    save_metadata_state(
        &state_dir,
        &MetadataState {
            version: 1,
            sessions: [
                (
                    "codex-1".to_owned(),
                    json!({
                        "status": { "text": "ready" },
                        "statusline": { "bottom": [{ "id": "plugin", "text": "plugin ok", "tone": "success" }] },
                        "context": { "worktreeName": "main", "branch": "master", "pr": { "number": 7 } },
                        "derived": {
                            "activity": "running",
                            "attention": "normal",
                            "unseenCount": 0,
                            "services": [{ "port": 3000, "url": "http://localhost:3000" }]
                        }
                    }),
                ),
                ("dead-only".to_owned(), json!({ "status": { "text": "drop" } })),
            ]
            .into(),
        },
    )
    .expect("metadata");
    let isolation = support::TestIsolation::new("statusline-refresh");
    let context = isolation.project_context(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::STATUSLINE_REFRESH,
        Some(&json!({ "force": true, "sessionId": "client-abc" })),
    );

    assert_eq!(response.status, 200);
    assert_eq!(response.body, json!({ "ok": true }));
    assert!(
        !state_dir
            .join("tmux-statusline")
            .join("top-stale.txt")
            .exists()
    );
    let snapshot = read_json(state_dir.join("statusline.json"));
    assert_eq!(
        snapshot["project"].as_str().unwrap(),
        project.file_name().unwrap().to_string_lossy()
    );
    assert_eq!(
        ids(snapshot["sessions"].as_array().unwrap()),
        vec!["codex-1", "svc-1"]
    );
    assert_eq!(
        ids(snapshot["teammates"].as_array().unwrap()),
        vec!["reviewer-1"]
    );
    assert!(snapshot["metadata"].get("codex-1").is_some());
    assert!(snapshot["metadata"].get("dead-only").is_none());
    let top =
        read_to_string(state_dir.join("tmux-statusline").join("top-dashboard.txt")).expect("top");
    assert!(top.contains("aimux "));
    assert!(top.contains("ctl ok"));
    let agent_top =
        read_to_string(state_dir.join("tmux-statusline").join("top-@1.txt")).expect("agent top");
    assert!(agent_top.contains("  \u{00b7}  "));
    assert!(agent_top.contains("@master"));
    assert!(agent_top.contains("PR #7"));
    assert!(agent_top.contains(":3000"));
    // The per-window bottom line ships as parts, not a finished string: only the
    // client knows how wide it is, so only the client can fit them.
    let bottom =
        read_to_string(state_dir.join("tmux-statusline").join("bottom-@1.json")).expect("bottom");
    let bottom: Value = serde_json::from_str(&bottom).expect("bottom parts json");
    let chips = bottom["chips"]
        .as_array()
        .expect("chips")
        .iter()
        .filter_map(|chip| chip.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(chips.contains("#[fg=black,bg=yellow] codex"));
    assert!(chips.contains("yarn dev"));
    assert_eq!(bottom["activeChip"], 0);
    let detail = bottom["detail"].as_str().expect("detail");
    assert!(detail.contains("team: reviewer idle"));
    assert!(detail.contains("#[fg=green]plugin ok#[default]"));
    let dashboard_bottom = read_to_string(
        state_dir
            .join("tmux-statusline")
            .join("bottom-dashboard.txt"),
    )
    .expect("dashboard bottom");
    assert!(dashboard_bottom.contains("#[fg=yellow,bold]P#[default]roject"));
    assert!(dashboard_bottom.contains("#[fg=black,bg=yellow] Dashboard #[default]"));
    assert!(
        state_dir
            .join("tmux-statusline")
            .join("bottom-dashboard-client-abc.txt")
            .exists()
    );
    cleanup(project);
}

#[test]
fn statusline_refresh_requests_tmux_refresh_after_writing_artifacts() {
    let project = temp_project("refresh-client");
    let state_dir = project.join("state");
    write_runtime_topology(
        runtime_topology_path(&state_dir),
        &topology_fixture(&project),
    )
    .expect("topology");
    let isolation = support::TestIsolation::new("statusline-refresh-client");
    let context = isolation.project_context(&project, &state_dir);
    let mut calls = Vec::new();

    refresh_project_statusline_with_tmux_refresh(
        &context,
        StatuslineRefreshInput {
            session_id: None,
            force: false,
        },
        |argv| {
            assert!(
                state_dir
                    .join("tmux-statusline")
                    .join("top-dashboard.txt")
                    .exists(),
                "tmux refresh must happen after statusline files are written"
            );
            calls.push(argv.to_vec());
        },
    )
    .expect("refresh statusline");

    assert_eq!(calls, vec![vec!["refresh-client", "-S"]]);
    cleanup(project);
}

#[test]
fn statusline_refresh_reports_corrupt_runtime_exchange() {
    let project = temp_project("corrupt-exchange");
    let state_dir = project.join("state");
    create_dir_all(&state_dir).expect("state dir");
    write(runtime_exchange_path(&state_dir), "version: [").expect("corrupt exchange");
    write_runtime_topology(
        runtime_topology_path(&state_dir),
        &topology_fixture(&project),
    )
    .expect("topology");
    let isolation = support::TestIsolation::new("statusline-corrupt-exchange");
    let context = isolation.project_context(&project, &state_dir);

    let response = route_project_service_request(
        &context,
        "POST",
        routes::STATUSLINE_REFRESH,
        Some(&json!({ "force": true })),
    );

    assert_eq!(response.status, 500);
    assert!(
        response.body["error"]
            .as_str()
            .is_some_and(|error| error.contains("failed to parse runtime exchange")),
        "statusline must report unreadable exchange, not publish empty tasks: {}",
        response.body
    );
    cleanup(project);
}

#[test]
fn async_statusline_refresh_reports_tmux_refresh_failure_after_writing_artifacts() {
    let project = temp_project("async-refresh-client");
    let state_dir = project.join("state");
    write_runtime_topology(
        runtime_topology_path(&state_dir),
        &topology_fixture(&project),
    )
    .expect("topology");
    let isolation = support::TestIsolation::new("statusline-async-refresh-client");
    let context = isolation.project_context(&project, &state_dir);

    // aimux-async-seam: test - statusline route test drives async handler
    let response = aimux::async_runtime::block_on_named(
        "test:statusline-refresh-async",
        route_statusline_refresh_request_async(
            &context,
            "POST",
            routes::STATUSLINE_REFRESH,
            Some(&json!({ "force": false })),
        ),
    )
    .expect("statusline async route");

    assert_eq!(response.status, 200);
    assert_eq!(response.body["ok"], true);
    assert!(
        response.body["tmuxRefresh"]["error"]
            .as_str()
            .is_some_and(|error| error.contains("tmux refresh-client")),
        "tmux refresh failure must be reported, not swallowed: {}",
        response.body
    );
    assert!(
        state_dir.join("statusline.json").exists(),
        "statusline artifact writes still succeed when tmux refresh notification fails"
    );
    assert!(
        state_dir
            .join("tmux-statusline")
            .join("top-dashboard.txt")
            .exists(),
        "precomputed tmux files are the hard success condition"
    );
    let refresh_state = read_json(state_dir.join("statusline-refresh.json"));
    assert_eq!(refresh_state["state"], "failed");
    assert!(
        refresh_state["error"]
            .as_str()
            .is_some_and(|error| error.contains("tmux refresh-client")),
        "failed refresh marker must preserve the tmux cause: {refresh_state}"
    );
    cleanup(project);
}

#[test]
fn async_statusline_refresh_cancellation_leaves_refresh_marked_pending() {
    let project = temp_project("async-refresh-cancel");
    let state_dir = project.join("state");
    write_runtime_topology(
        runtime_topology_path(&state_dir),
        &topology_fixture(&project),
    )
    .expect("topology");
    let isolation = support::TestIsolation::new("statusline-async-refresh-cancel");
    let context = isolation
        .project_context(&project, &state_dir)
        .with_desktop_state(desktop_state_fixture());

    // aimux-async-seam: test - statusline cancellation test drives async helper
    let timed_out = aimux::async_runtime::block_on_named("test:statusline-refresh-cancel", async {
        tokio::time::timeout(
            Duration::from_millis(10),
            refresh_project_statusline_with_tmux_refresh_async(
                &context,
                StatuslineRefreshInput {
                    session_id: Some("client-abc".into()),
                    force: false,
                },
                |_argv| pending::<Result<(), String>>(),
            ),
        )
        .await
    });

    assert!(
        timed_out.is_err(),
        "test must cancel while tmux refresh is pending"
    );
    assert!(
        state_dir.join("statusline.json").exists(),
        "statusline artifacts are complete before tmux refresh is awaited"
    );
    let refresh_state = read_json(state_dir.join("statusline-refresh.json"));
    assert_eq!(refresh_state["state"], "pending");
    assert_eq!(refresh_state["sessionId"], "client-abc");
    assert!(
        refresh_state.get("error").is_none(),
        "pending refresh must not look like an applied or failed refresh: {refresh_state}"
    );
    cleanup(project);
}

#[test]
fn async_statusline_refresh_success_marks_refresh_applied() {
    let project = temp_project("async-refresh-applied");
    let state_dir = project.join("state");
    write_runtime_topology(
        runtime_topology_path(&state_dir),
        &topology_fixture(&project),
    )
    .expect("topology");
    let isolation = support::TestIsolation::new("statusline-async-refresh-applied");
    let context = isolation
        .project_context(&project, &state_dir)
        .with_desktop_state(desktop_state_fixture());

    // aimux-async-seam: test - statusline success test drives async helper
    let result = aimux::async_runtime::block_on_named(
        "test:statusline-refresh-applied",
        refresh_project_statusline_with_tmux_refresh_async(
            &context,
            StatuslineRefreshInput {
                session_id: Some("client-abc".into()),
                force: false,
            },
            |_argv| async { Ok(()) },
        ),
    )
    .expect("refresh result");

    assert_eq!(result.tmux_refresh_error, None);
    let refresh_state = read_json(state_dir.join("statusline-refresh.json"));
    assert_eq!(refresh_state["state"], "applied");
    assert_eq!(refresh_state["sessionId"], "client-abc");
    cleanup(project);
}

#[test]
fn statusline_refresh_uses_client_dashboard_screen_for_client_bottom_artifact() {
    let project = temp_project("refresh-client-screen");
    let state_dir = project.join("state");
    write_runtime_topology(
        runtime_topology_path(&state_dir),
        &topology_fixture(&project),
    )
    .expect("topology");
    create_dir_all(&state_dir).expect("state dir");
    write(
        state_dir.join("dashboard-ui-client-aimux-repo-client-abcd1234.json"),
        r#"{"screen":"coordination"}"#,
    )
    .expect("client ui state");
    let isolation = support::TestIsolation::new("statusline-client-screen");
    let context = isolation.project_context(&project, &state_dir);

    refresh_project_statusline_with_tmux_refresh(
        &context,
        StatuslineRefreshInput {
            session_id: Some("aimux-repo-client-abcd1234".into()),
            force: false,
        },
        |_| {},
    )
    .expect("refresh statusline");

    let generic = read_to_string(
        state_dir
            .join("tmux-statusline")
            .join("bottom-dashboard.txt"),
    )
    .expect("generic dashboard bottom");
    let client = read_to_string(
        state_dir
            .join("tmux-statusline")
            .join("bottom-dashboard-aimux-repo-client-abcd1234.txt"),
    )
    .expect("client dashboard bottom");
    assert!(generic.contains("#[fg=black,bg=yellow] Dashboard #[default]"));
    assert!(client.contains("#[fg=black,bg=yellow] Coordination #[default]"));
    cleanup(project);
}

fn topology_fixture(project: &std::path::Path) -> Value {
    let root = project.to_string_lossy();
    json!({
        "version": 1,
        "generatedAt": "2026-01-01T00:00:00.000Z",
        "rigs": [
            { "id": "rig-1", "name": "aimux", "projectRoot": root, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "nodes": [
            { "id": "node-1", "rigId": "rig-1", "logicalId": "codex-1", "toolConfigKey": "codex", "cwd": root, "label": "codex", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-2", "rigId": "rig-1", "logicalId": "reviewer-1", "toolConfigKey": "codex", "cwd": root, "label": "reviewer", "createdAt": "2026-01-01T00:00:00.000Z" },
            { "id": "node-3", "rigId": "rig-1", "logicalId": "svc-1", "toolConfigKey": "shell", "cwd": root, "label": "web", "createdAt": "2026-01-01T00:00:00.000Z" }
        ],
        "edges": [],
        "bindings": [
            { "id": "binding-1", "nodeId": "node-1", "tmuxSession": "aimux", "tmuxWindowId": "@1", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "binding-2", "nodeId": "node-2", "tmuxSession": "aimux", "tmuxWindowId": "@2", "tmuxWindowIndex": 2, "tmuxWindowName": "reviewer", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "binding-3", "nodeId": "node-3", "tmuxSession": "aimux", "tmuxWindowId": "@3", "tmuxWindowIndex": 3, "tmuxWindowName": "web", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "sessions": [
            { "id": "codex-1", "nodeId": "node-1", "status": "running", "toolConfigKey": "codex", "command": "codex", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" },
            { "id": "reviewer-1", "nodeId": "node-2", "status": "idle", "toolConfigKey": "codex", "command": "codex", "team": { "parentSessionId": "codex-1", "role": "reviewer" }, "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "services": [
            { "id": "svc-1", "rigId": "rig-1", "nodeId": "node-3", "status": "running", "command": "yarn", "args": ["dev"], "launchCommandLine": "yarn dev", "createdAt": "2026-01-01T00:00:00.000Z", "updatedAt": "2026-01-01T00:00:00.000Z" }
        ],
        "worktrees": [],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    })
}

fn desktop_state_fixture() -> Value {
    json!({
        "sessions": [
            {
                "id": "codex-1",
                "command": "codex",
                "tmuxWindowId": "@1",
                "windowName": "codex",
                "worktreePath": "/repo"
            }
        ],
        "services": [],
        "teammates": [],
        "tasks": { "pending": 0, "assigned": 0 },
        "controlPlane": { "daemonAlive": true, "projectServiceAlive": true },
        "flash": null
    })
}

fn read_json(path: PathBuf) -> Value {
    serde_json::from_str(&read_to_string(path).expect("json file")).expect("json")
}

fn ids(values: &[Value]) -> Vec<&str> {
    values
        .iter()
        .map(|value| value["id"].as_str().unwrap())
        .collect()
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-statusline-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}

/// The footer chips render the same agents the dashboard numbers [1]..[N], in
/// the same order, and that order is the tmux window order.
///
/// They used to render the snapshot's raw order and then take the first five of
/// it — neither the dashboard's order nor its first five. On Sam's machine the
/// dashboard read 3, 21, 22, 99, needs-input unread while the chips read
/// 22, 99, on-you, 21, 2. Chips carry no ids, so the unread counts are the
/// discriminator here, exactly as they were when he spotted it.
#[test]
fn footer_chips_render_in_tmux_window_order() {
    fn agent(id: &str, created_at: &str, window_index: i64, unread: i64) -> Value {
        json!({
            "id": id,
            "kind": "agent",
            "tool": "claude",
            "toolConfigKey": "claude",
            "status": "running",
            "createdAt": created_at,
            "tmuxWindowId": format!("@{window_index}"),
            "tmuxWindowIndex": window_index,
            "worktreePath": "/repo",
            "semantic": {
                "presentation": { "compactHint": format!("{unread} unread") },
            },
        })
    }

    fn chip_order(snapshot: &Value, expected: &[&str]) {
        let rendered =
            aimux::project_service::statusline::render_tmux_statusline_contract(&json!({
                "data": snapshot,
                "projectRoot": "/repo",
                "line": "bottom",
                "options": { "currentPath": "/repo", "width": 400 },
            }));
        let text = rendered["text"].as_str().expect("statusline text");
        let positions = expected
            .iter()
            .map(|chip| {
                text.find(chip)
                    .unwrap_or_else(|| panic!("chip {chip} is rendered: {text}"))
            })
            .collect::<Vec<_>>();
        assert!(
            positions.windows(2).all(|pair| pair[0] < pair[1]),
            "chips must read in {expected:?} order, got {text}"
        );
    }

    // Supplied in an order that is neither sorted nor reversed, mirroring the
    // raw snapshot order that produced the wrong chips. Window index decides,
    // and it deliberately disagrees with both creation order and the input.
    chip_order(
        &json!({
            "sessions": [
                agent("7owt0o", "2026-09-09T05:28:51.186Z", 3, 22),
                agent("2jdcpa", "2026-09-08T04:08:35.809Z", 5, 99),
                agent("3yfqu7", "2026-09-07T09:51:17.999Z", 1, 4),
                agent("a88iz7", "2026-09-17T04:44:22.673Z", 4, 21),
                agent("6nenaq", "2026-09-21T09:06:27.160Z", 2, 3),
            ],
        }),
        &[
            "4 unread",
            "3 unread",
            "22 unread",
            "21 unread",
            "99 unread",
        ],
    );

    // An agent with no window has no tmux position, so it falls back to
    // creation order — the only other key on an agent that cannot move.
    chip_order(
        &json!({
            "sessions": [
                json!({
                    "id": "late", "kind": "agent", "tool": "claude", "status": "running",
                    "createdAt": "2026-09-21T09:06:27.160Z", "worktreePath": "/repo",
                    "semantic": { "presentation": { "compactHint": "77 unread" } },
                }),
                json!({
                    "id": "early", "kind": "agent", "tool": "claude", "status": "running",
                    "createdAt": "2026-09-07T09:51:17.999Z", "worktreePath": "/repo",
                    "semantic": { "presentation": { "compactHint": "11 unread" } },
                }),
            ],
        }),
        &["11 unread", "77 unread"],
    );
}

/// Every agent reaches the footer. How many are *shown* is the client's
/// decision, made against its own width, and a hidden one is marked.
///
/// The footer capped at five for six months. Sam's sixth agent was simply
/// absent, with nothing saying so, and no test covered it: the cap sat in
/// resolve_scoped_sessions, which every fixture exercised with five agents or
/// fewer.
#[test]
fn footer_chips_are_not_capped_at_five() {
    fn agent(window_index: i64) -> Value {
        json!({
            "id": format!("claude-{window_index}"),
            "kind": "agent",
            "tool": "claude",
            "toolConfigKey": "claude",
            "status": "running",
            "createdAt": format!("2026-09-24T0{window_index}:00:00.000Z"),
            "tmuxWindowId": format!("@{window_index}"),
            "tmuxWindowIndex": window_index,
            "worktreePath": "/repo",
            "semantic": {
                "presentation": { "compactHint": format!("{window_index}00 unread") },
            },
        })
    }

    let snapshot = json!({
        "sessions": (1..=8).map(agent).collect::<Vec<_>>(),
        "teammates": [],
    });

    let wide = aimux::project_service::statusline::render_tmux_statusline_contract(&json!({
        "data": snapshot,
        "projectRoot": "/repo",
        "line": "bottom",
        "options": { "currentPath": "/repo", "currentWindowId": "@6", "width": 400 },
    }));
    let wide = wide["text"].as_str().expect("statusline text");
    for index in 1..=8 {
        assert!(
            wide.contains(&format!("{index}00 unread")),
            "agent {index} is missing from a footer with room for it: {wide}"
        );
    }
    assert!(
        !wide.contains('\u{203a}'),
        "nothing is hidden at this width"
    );

    // Narrow enough that they cannot all fit: the active one is still shown,
    // and the ones that are not say so rather than vanishing.
    let narrow = aimux::project_service::statusline::render_tmux_statusline_contract(&json!({
        "data": snapshot,
        "projectRoot": "/repo",
        "line": "bottom",
        "options": { "currentPath": "/repo", "currentWindowId": "@6", "width": 80 },
    }));
    let narrow = narrow["text"].as_str().expect("statusline text");
    assert!(
        narrow.contains("600 unread"),
        "the window you are in must be visible: {narrow}"
    );
    assert!(
        narrow.contains('\u{2039}') || narrow.contains('\u{203a}'),
        "hidden chips must be marked: {narrow}"
    );
}
