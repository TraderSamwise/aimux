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

fn session_state(project_root: &str, exchange: &Value) -> Value {
    let topology = topology(project_root);
    let state = build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: project_root.into(),
            topology: &topology,
            metadata_sessions: &BTreeMap::new(),
            exchange,
        },
        Some(&support::live_windows("aimux-repo", &["@1"])),
    );
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
