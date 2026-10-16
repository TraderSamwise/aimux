//! One ladder of row chips, two rows.
//!
//! The dashboard row used to build the ladder itself and the app's row had
//! none of it -- not because the app chose differently but because nothing
//! ever handed it the list. So "what is going on with this agent" had two
//! answers depending on where you looked, and only one of them was ever true.
//!
//! The service decides it now. What this pins is that the labels in the
//! rendered dashboard row are the labels in the session the app is handed, in
//! the same order, from one derivation of one set of facts. The app's half --
//! that it renders them verbatim, truncates rather than reorders, and marks
//! the overflow -- is pinned in `app/lib/row-chips.test.ts` and
//! `app/components/WorktreeDashboard.test.tsx`.
//!
//! A test per surface would pass happily while the surfaces disagreed, which
//! is the failure AGENTS.md's "One Answer, Many Surfaces" describes.

use aimux::agent_row_chips::{RowChip, published_row_chips, visible_row_chips};
use aimux::dashboard_model::DesktopStateSnapshot;
use aimux::dashboard_renderer::{DashboardNavLevel, DashboardRenderInput, render_dashboard_frame};
use aimux::dashboard_session_details::render_session_details;
use aimux::project_service::desktop_state::{
    DesktopStateInput, build_desktop_state_with_live_window_ids,
};
use aimux::runtime_topology::coerce_runtime_topology;
use aimux::tui_render::text::strip_ansi;
use serde_json::{Value, json};
use std::collections::BTreeMap;

mod support;

const SESSION: &str = "claude-live";
const PROJECT: &str = "/repo";
/// The dashboard row's own budget. Two, with a mark if there were more.
const ROW_BUDGET: usize = 2;

fn topology(status: &str) -> Value {
    coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-10-16T00:00:00.000Z",
        "rigs": [{ "id": "rig-1", "name": "repo", "projectRoot": PROJECT, "createdAt": "2026-10-16T00:00:00.000Z", "updatedAt": "2026-10-16T00:00:00.000Z" }],
        "nodes": [{ "id": "node-live", "rigId": "rig-1", "logicalId": SESSION, "toolConfigKey": "claude", "cwd": PROJECT, "createdAt": "2026-10-16T00:00:00.000Z" }],
        "edges": [],
        "bindings": [{ "id": "tmux:live", "nodeId": "node-live", "tmuxSession": "aimux-repo", "tmuxWindowId": "@1", "tmuxWindowIndex": 1, "tmuxWindowName": "claude", "updatedAt": "2026-10-16T00:00:00.000Z" }],
        "sessions": [{
            "id": SESSION,
            "nodeId": "node-live",
            "tool": "claude",
            "toolConfigKey": "claude",
            "command": "claude",
            "args": [],
            "status": status,
            "worktreePath": PROJECT,
            "createdAt": "2026-10-16T00:00:00.000Z",
            "updatedAt": "2026-10-16T00:00:00.000Z"
        }],
        "services": [],
        "worktrees": [{ "id": "wt-main", "rigId": "rig-1", "path": PROJECT, "name": "repo", "status": "active", "branch": "master", "createdAt": "2026-10-16T00:00:00.000Z", "updatedAt": "2026-10-16T00:00:00.000Z" }],
        "worktreeGraveyard": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .expect("topology")
}

/// `count` unread messages on threads the agent takes part in, which is a
/// different fact from the unread badge by construction.
fn exchange(unread: usize, pending: usize) -> Value {
    let mut threads = Vec::new();
    let mut messages = Vec::new();
    for index in 0..unread {
        let id = format!("thread-{index}");
        threads.push(json!({
            "id": id,
            "title": "a conversation",
            "kind": "conversation",
            "status": "open",
            "createdAt": "2026-10-16T00:01:00.000Z",
            "updatedAt": "2026-10-16T00:02:00.000Z",
            "participants": ["aimux", SESSION],
            "unreadBy": [SESSION],
            "tags": [],
        }));
    }
    for index in 0..pending {
        let id = format!("pending-thread-{index}");
        threads.push(json!({
            "id": id,
            "title": "an undelivered message",
            "kind": "conversation",
            "status": "open",
            "createdAt": "2026-10-16T00:01:00.000Z",
            "updatedAt": "2026-10-16T00:02:00.000Z",
            "participants": ["aimux", SESSION],
            "unreadBy": [],
            "tags": [],
        }));
        messages.push(json!({
            "id": format!("message-{index}"),
            "threadId": id,
            "from": "aimux",
            "to": [SESSION],
            "body": "take a look",
            "createdAt": "2026-10-16T00:02:00.000Z",
            "delivery": { "state": "pending" },
        }));
    }
    json!({
        "version": 1,
        "generatedAt": "2026-10-16T00:00:00.000Z",
        "threads": threads,
        "messages": messages,
        "tasks": [],
        "reviews": [],
    })
}

fn desktop_state(status: &str, exchange: &Value, metadata: Value) -> Value {
    let topology = topology(status);
    let mut metadata_sessions = BTreeMap::new();
    metadata_sessions.insert(SESSION.to_owned(), metadata);
    build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: PROJECT.into(),
            topology: &topology,
            metadata_sessions: &metadata_sessions,
            exchange,
        },
        Some(&support::live_windows("aimux-repo", &["@1"])),
    )
}

fn session_state(state: &Value) -> Value {
    state["sessions"]
        .as_array()
        .expect("sessions")
        .iter()
        .find(|session| session["id"] == SESSION)
        .cloned()
        .expect("the agent is in the desktop state")
}

/// The chips the app is handed, read the way the app reads them.
fn chips_handed_to_the_app(session: &Value) -> Vec<RowChip> {
    published_row_chips(
        session
            .get("semantic")
            .and_then(|semantic| semantic.get("presentation"))
            .and_then(|presentation| presentation.get("rowChips")),
    )
}

/// The agent's own row in the rendered dashboard frame, ANSI stripped.
fn dashboard_row(state: &Value) -> String {
    let snapshot: DesktopStateSnapshot =
        serde_json::from_value(state.clone()).expect("the snapshot the dashboard renders");
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
    let plain = strip_ansi(&frame.frame);
    let rows = plain
        .split("\r\n")
        .filter(|line| line.contains("[1] claude"))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), 1, "one row for the agent, got {rows:?}");
    rows.into_iter().next().expect("the agent's row")
}

fn working() -> Value {
    json!({
        "derived": {
            "activity": "running",
            "attention": "normal",
            // Agent output nobody has looked at: a third fact, so the fixture
            // has more chips than the row's budget, which is the case the
            // overflow mark exists for.
            "unseenCount": 5,
        }
    })
}

#[test]
fn the_dashboard_row_renders_the_chips_the_app_is_handed() {
    let state = desktop_state("running", &exchange(8, 3), working());
    let session = session_state(&state);
    let chips = chips_handed_to_the_app(&session);
    assert!(
        !chips.is_empty(),
        "positive control: the fixture gives the agent something to say"
    );

    let row = dashboard_row(&state);
    let (visible, more) = visible_row_chips(&chips, ROW_BUDGET);
    for chip in &visible {
        assert!(
            row.contains(&chip.label),
            "the row shows {:?}, got {row:?}",
            chip.label
        );
    }
    // And in the published order, not some order of the row's own.
    let positions = visible
        .iter()
        .map(|chip| row.find(&chip.label).expect("the label is on the row"))
        .collect::<Vec<_>>();
    assert!(
        positions.windows(2).all(|pair| pair[0] < pair[1]),
        "the row keeps the service's order: {positions:?} for {visible:?}"
    );
    assert_eq!(
        more,
        row.contains('\u{203a}'),
        "and the row marks the overflow exactly when there is one"
    );
}

#[test]
fn every_chip_the_row_could_not_fit_is_named_where_the_mark_points() {
    let state = desktop_state("running", &exchange(8, 3), working());
    let session = session_state(&state);
    let chips = chips_handed_to_the_app(&session);
    let (_, more) = visible_row_chips(&chips, ROW_BUDGET);
    assert!(more, "the fixture overflows, which is the case under test");

    // The pane's numbers come from the same derivation the chips were built
    // from, so the pane the mark points at cannot disagree with the row that
    // pointed at it.
    let pane = render_session_details(Some(&session), 120, 40).join(" ");
    let collapsed = pane.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(
        collapsed.contains("8 unread"),
        "the pane names the unread threads the row could not fit: {collapsed}"
    );
    assert!(
        collapsed.contains("3 pending"),
        "and the undelivered ones: {collapsed}"
    );

    // Proved by making the two sources disagree: the flat field goes to zero
    // while the derivation still says eight. The pane reads the derivation,
    // because that is what the chips were built from.
    let mut stale = session.clone();
    stale["threadUnreadCount"] = json!(0);
    let collapsed = render_session_details(Some(&stale), 120, 40)
        .join(" ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        collapsed.contains("8 unread"),
        "the pane reads the same derivation the row's chips came from: {collapsed}"
    );
}

#[test]
fn a_quiet_agent_says_nothing_on_either_row() {
    let quiet = json!({ "derived": { "activity": "running", "attention": "normal" } });
    let state = desktop_state("running", &exchange(0, 0), quiet);
    let session = session_state(&state);
    assert!(
        chips_handed_to_the_app(&session).is_empty(),
        "nothing is published, which is how the app's row renders nothing"
    );
    let row = dashboard_row(&state);
    assert!(!row.contains("unread"), "got {row:?}");
    assert!(!row.contains('\u{203a}'), "and no overflow mark: {row:?}");
}

/// The tone both rows paint, for the agent that broke the first attempt.
///
/// `runtime_lifecycle` answers `error` before `offline`, so an agent that
/// failed and then exited reads `label: "error"` -- and the dashboard's own
/// `is_session_offline` says it is gone. Deciding the tones from the label
/// alone flipped exactly this agent's chips from muted to attention.
#[test]
fn an_agent_that_failed_and_then_exited_reads_as_gone_on_both_rows() {
    // `offline`, not `exited`: only starting/running/idle/offline reach the
    // dashboard at all, and `offline` is the status whose chips the label
    // disagrees about.
    let state = desktop_state(
        "offline",
        &exchange(8, 0),
        json!({ "derived": { "activity": "error", "attention": "error" } }),
    );
    let session = session_state(&state);
    assert_eq!(
        session["semantic"]["user"]["label"], "error",
        "the label is error, which is the whole trap"
    );
    let chips = chips_handed_to_the_app(&session);
    assert!(!chips.is_empty(), "positive control: it still has facts");
    assert!(
        chips
            .iter()
            .all(|chip| chip.tone == aimux::agent_row_chips::RowChipTone::Muted),
        "every chip the app is handed reads muted: {chips:?}"
    );
}
