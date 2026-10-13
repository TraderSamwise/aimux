//! One unread count, two renderers.
//!
//! The footer chip renders "N unread" from `semantic.presentation.compactHint`,
//! which the project service derives from notification-tagged exchange threads
//! still listing the agent in `unreadBy`. The app was handed the same number as
//! `notificationUnreadCount` and rendered nothing, and nothing in the app ever
//! posted `/mark-seen`, so a count the terminal cleared on entry stayed on
//! screen in the GUI forever.
//!
//! This pins the two together: the number the app renders is the number inside
//! the chip's hint, and marking the session viewed empties both.

use aimux::dashboard_model::DesktopStateSnapshot;
use aimux::dashboard_renderer::{DashboardNavLevel, DashboardRenderInput, render_dashboard_frame};
use aimux::dashboard_session_details::render_session_details;
use aimux::project_service::desktop_state::{
    DesktopStateInput, build_desktop_state_with_live_window_ids,
};
use aimux::project_service::runtime_exchange::{
    read_runtime_exchange, runtime_exchange_path, write_runtime_exchange,
};
use aimux::runtime_topology::coerce_runtime_topology;
use aimux::session_viewed::mark_session_viewed;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::{create_dir_all, remove_dir_all};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

mod support;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const SESSION: &str = "codex-live";

fn temp_project(name: &str) -> PathBuf {
    let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "aimux-unread-surfaces-{name}-{}-{sequence}",
        std::process::id()
    ));
    let _ = remove_dir_all(&path);
    create_dir_all(path.join("state")).expect("state dir");
    path
}

fn topology(project_root: &str) -> Value {
    coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-09-05T00:00:00.000Z",
        "rigs": [{ "id": "rig-1", "name": "repo", "projectRoot": project_root, "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }],
        "nodes": [{ "id": "node-live", "rigId": "rig-1", "logicalId": SESSION, "toolConfigKey": "codex", "cwd": project_root, "createdAt": "2026-09-05T00:00:00.000Z" }],
        "edges": [],
        "bindings": [{ "id": "tmux:live", "nodeId": "node-live", "tmuxSession": "aimux-repo", "tmuxWindowId": "@1", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-09-05T00:00:00.000Z" }],
        "sessions": [{
            "id": SESSION,
            "nodeId": "node-live",
            "tool": "codex",
            "toolConfigKey": "codex",
            "command": "codex",
            "args": [],
            "status": "running",
            "worktreePath": project_root,
            "createdAt": "2026-09-05T00:00:00.000Z",
            "updatedAt": "2026-09-05T00:00:00.000Z"
        }],
        "services": [],
        "worktrees": [{ "id": "wt-main", "rigId": "rig-1", "path": project_root, "name": "repo", "status": "active", "branch": "master", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .expect("topology")
}

/// `count` notification-tagged threads the agent has not read.
fn exchange(count: usize) -> Value {
    let threads = (0..count)
        .map(|index| {
            json!({
                "id": format!("thread-notification-{index}"),
                "title": "codex-live needs input",
                "kind": "conversation",
                "status": "open",
                "createdAt": "2026-09-05T00:02:00.000Z",
                "updatedAt": format!("2026-09-05T00:0{}:00.000Z", 4 + index),
                "participants": ["aimux", SESSION],
                "unreadBy": [SESSION],
                "tags": ["notification"],
            })
        })
        .collect::<Vec<_>>();
    json!({
        "version": 1,
        "generatedAt": "2026-09-05T00:00:00.000Z",
        "threads": threads,
        "messages": [],
        "tasks": [],
        "reviews": [],
    })
}

fn desktop_state(project_root: &str, exchange: &Value, attention: Option<&str>) -> Value {
    let topology = topology(project_root);
    let mut metadata_sessions = BTreeMap::new();
    if let Some(attention) = attention {
        metadata_sessions.insert(
            SESSION.to_owned(),
            json!({ "derived": { "attention": attention, "activity": "waiting" } }),
        );
    }
    build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: project_root.into(),
            topology: &topology,
            metadata_sessions: &metadata_sessions,
            exchange,
        },
        Some(&support::live_windows("aimux-repo", &["@1"])),
    )
}

fn session_state(project_root: &str, exchange: &Value) -> Value {
    let state = desktop_state(project_root, exchange, None);
    state["sessions"]
        .as_array()
        .expect("sessions")
        .iter()
        .find(|session| session["id"] == SESSION)
        .cloned()
        .expect("the agent is in the desktop state")
}

/// The chip, rendered from the very object the app is handed, so the two cannot
/// be reading different derivations of the same fact.
fn footer_chip(session: &Value) -> String {
    let mut chip_session = session.clone();
    chip_session["kind"] = json!("agent");
    chip_session["windowName"] = json!("codex");
    let rendered = aimux::project_service::statusline::render_tmux_statusline_contract(&json!({
        "data": { "sessions": [chip_session] },
        "projectRoot": "/repo",
        "line": "bottom",
        "options": { "currentPath": "/repo", "width": 400 },
    }));
    aimux::tui_render::text::strip_ansi(
        rendered["text"]
            .as_str()
            .expect("the bottom line renders text"),
    )
}

#[test]
fn the_app_and_the_chip_show_one_unread_count() {
    for count in [1usize, 3, 7] {
        let session = session_state("/repo", &exchange(count));
        assert_eq!(
            session["notificationUnreadCount"].as_u64(),
            Some(count as u64),
            "the field the app renders carries the count"
        );
        assert_eq!(
            session["semantic"]["presentation"]["compactHint"],
            json!(format!("{count} unread")),
            "and the chip's hint is built from the same derivation"
        );
        let chip = footer_chip(&session);
        assert!(
            chip.contains(&format!("{count} unread")),
            "the rendered chip shows {count} unread, got {chip:?}"
        );
    }
}

#[test]
fn marking_a_session_viewed_empties_the_count_the_app_renders() {
    let project = temp_project("mark-seen");
    let state_dir = project.join("state");
    let project_root = project.to_string_lossy().into_owned();
    write_runtime_exchange(runtime_exchange_path(&state_dir), &exchange(4)).expect("exchange");

    let before = session_state(&project_root, &exchange(4));
    assert_eq!(before["notificationUnreadCount"].as_u64(), Some(4));

    let result = mark_session_viewed(&project, &state_dir, SESSION).expect("mark seen");
    assert_eq!(
        result.notification_threads_read, 4,
        "the unread the chip counts lives in the exchange threads, so that is what has to clear"
    );

    let cleared = read_runtime_exchange(runtime_exchange_path(&state_dir));
    let after = session_state(&project_root, &cleared);
    assert_eq!(
        after["notificationUnreadCount"].as_u64(),
        Some(0),
        "the app renders no badge once the session has been viewed"
    );
    assert_eq!(
        after["semantic"]["presentation"]["compactHint"],
        Value::Null,
        "and the chip carries no unread hint either"
    );
    let _ = remove_dir_all(project);
}

/// `count` unread notification threads whose latest message is a needs-input
/// prompt, which is what makes `notificationNeedsInputUnreadCount` non-zero.
fn needs_input_exchange(count: usize) -> Value {
    let mut exchange = exchange(count);
    let messages = (0..count)
        .map(|index| {
            json!({
                "id": format!("message-{index}"),
                "threadId": format!("thread-notification-{index}"),
                "author": "aimux",
                "body": "codex-live is waiting on you",
                "ts": format!("2026-09-05T00:0{}:30.000Z", 4 + index),
                "metadata": { "kind": "needs_input" },
            })
        })
        .collect::<Vec<_>>();
    exchange["messages"] = Value::Array(messages);
    exchange
}

/// The TUI dashboard row, rendered from the very state the app is handed, so
/// the row and the badge cannot be reading different derivations.
fn dashboard_row(state: &Value) -> String {
    let snapshot: DesktopStateSnapshot =
        serde_json::from_value(state.clone()).expect("the service's own state is a TUI snapshot");
    let frame = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 200,
        rows: 50,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: Some(SESSION),
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: Some("tmux"),
        version: Some("local"),
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = aimux::tui_render::text::strip_ansi(&frame.frame);
    let rows = plain
        .split("\r\n")
        // Anchored on the row's index cell, not the name: the badge drops the
        // parenthetical id to make room, so "(live)" is not always there.
        .filter(|line| line.contains("[1] codex"))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), 1, "one row for the agent, got {rows:?}");
    rows.into_iter().next().expect("the agent's row")
}

/// Every surface that renders the COUNT renders one number.
///
/// The footer chip is deliberately not in this list: `compactHint` is a
/// one-slot phrase with its own priority ladder, so it says "on you" for a
/// needs-input agent rather than a number. The row, the app field and both
/// details renderers all answer with a count, and those are what must agree.
#[test]
fn the_row_the_app_and_the_details_show_one_unread_count() {
    for count in [1usize, 3, 7] {
        let state = desktop_state("/repo", &exchange(count), None);
        let session = &state["sessions"][0];
        assert_eq!(session["id"], json!(SESSION), "the agent is first");
        assert_eq!(
            session["notificationUnreadCount"].as_u64(),
            Some(count as u64),
            "the field the app badge renders"
        );
        let row = dashboard_row(&state);
        assert!(
            row.contains(&format!("(live) {count} ")),
            "the row badges the same number beside the name, got {row:?}"
        );
        let details = render_session_details(Some(session), 60, 40).join("\n");
        assert!(
            details.contains(&format!("Unread: {count}")),
            "and the details pane says the same, got {details:?}"
        );
    }
}

/// The case the row used to get wrong.
///
/// It subtracted the needs-input unreads whenever the pill already announced
/// them, so an agent with one needs-input notification showed `NEEDS INPUT`
/// and NO count, while the app badge beside the same agent showed `1`. Two
/// surfaces, two numbers, and the TUI was the one that disagreed.
#[test]
fn a_needs_input_agent_badges_the_same_count_the_app_does() {
    let state = desktop_state("/repo", &needs_input_exchange(2), Some("needs_input"));
    let session = &state["sessions"][0];
    assert_eq!(
        session["notificationNeedsInputUnreadCount"].as_u64(),
        Some(2),
        "both unreads are needs-input prompts, which is what used to be subtracted"
    );
    assert_eq!(
        session["semantic"]["user"]["label"],
        json!("needs_input"),
        "and the pill announces the state, which is what used to suppress the count"
    );
    assert_eq!(session["notificationUnreadCount"].as_u64(), Some(2));
    let row = dashboard_row(&state);
    assert!(
        row.contains("(live) 2 "),
        "the row badges 2, the number the app badge shows, got {row:?}"
    );
    let details = render_session_details(Some(session), 60, 40).join("\n");
    assert!(
        details.contains("Unread: 2"),
        "the details pane already said 2 while the row said nothing, got {details:?}"
    );
}

/// The badge is the app's, including its cap: past two digits it reads `99+`
/// rather than widening the column and shoving the status cell sideways.
#[test]
fn a_hundred_unread_reads_as_the_apps_cap() {
    let state = desktop_state("/repo", &exchange(100), None);
    let row = dashboard_row(&state);
    assert!(
        row.contains("99+"),
        "the row caps the way the app does, got {row:?}"
    );
}
