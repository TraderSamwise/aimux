//! One answer about sub-agents, four renderers.
//!
//! The project service decides which sub-agents a session has working and
//! publishes the count, the label and the one-sentence detail. The dashboard
//! row renders the label, the details pane renders the detail, and the app's
//! row and chat header render those same two strings -- the app side is pinned
//! in `app/components/WorktreeDashboard.test.tsx`, which asserts it renders
//! what it is handed rather than composing a count of its own.
//!
//! What this pins is that the strings the two terminal renderers put on screen
//! are the strings the app is handed, from the object the app is handed. A test
//! per surface would pass happily while the surfaces disagreed, which is the
//! failure AGENTS.md's "One Answer, Many Surfaces" describes.

use aimux::dashboard_model::DesktopStateSnapshot;
use aimux::dashboard_renderer::{DashboardNavLevel, DashboardRenderInput, render_dashboard_frame};
use aimux::dashboard_session_details::render_session_details;
use aimux::project_service::desktop_state::{
    DesktopStateInput, build_desktop_state_with_live_window_ids,
};
use aimux::runtime_topology::coerce_runtime_topology;
use aimux::subagent_activity::{subagent_summary, subagent_summary_label};
use aimux::tui_render::text::strip_ansi;
use serde_json::{Value, json};
use std::collections::BTreeMap;

mod support;

const SESSION: &str = "claude-live";
const PROJECT: &str = "/repo";

fn topology() -> Value {
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
            "status": "running",
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

fn empty_exchange() -> Value {
    json!({
        "version": 1,
        "generatedAt": "2026-10-16T00:00:00.000Z",
        "threads": [],
        "messages": [],
        "tasks": [],
        "reviews": [],
    })
}

/// The published summary for `count` working sub-agents, built by the same
/// function the project service publishes with.
fn published_summary(count: usize) -> Value {
    let runs = (0..count)
        .map(|index| aimux::subagent_activity::SubagentRun {
            key: format!("agent-{index}"),
            name: format!("Adversarial review of PR 45{index}"),
            kind: Some("Explore".to_owned()),
            model: Some("opus".to_owned()),
            started_at_ms: Some(1_760_000_000_000 + index as u64),
            updated_at_ms: 1_760_000_100_000,
        })
        .collect::<Vec<_>>();
    subagent_summary(&runs).expect("a summary for a non-zero count")
}

/// The desktop state the app is served, with the summary on session metadata
/// exactly as the periodic task writes it.
fn desktop_state(summary: Option<&Value>) -> Value {
    let topology = topology();
    let mut metadata_sessions = BTreeMap::new();
    let mut record = json!({ "derived": { "activity": "running", "attention": "normal" } });
    if let Some(summary) = summary {
        record["subagents"] = summary.clone();
    }
    metadata_sessions.insert(SESSION.to_owned(), record);
    build_desktop_state_with_live_window_ids(
        DesktopStateInput {
            project_root: PROJECT.into(),
            topology: &topology,
            metadata_sessions: &metadata_sessions,
            exchange: &empty_exchange(),
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

/// The agent's own row in the dashboard frame, ANSI stripped, wide enough
/// that the chip is not what loses the width fight.
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

/// Edits every copy of the agent in the state.
///
/// The desktop state carries the session twice -- once in `sessions` and again
/// inside its worktree group -- and the dashboard renders rows from the group
/// copy whenever the project has worktrees. Patching only the top-level one
/// made a fixture that looked right and rendered the old row.
fn patch_session(state: &mut Value, edit: &dyn Fn(&mut Value)) {
    match state {
        Value::Object(map) => {
            if map.get("id").and_then(Value::as_str) == Some(SESSION) {
                edit(state);
                return;
            }
            for value in map.values_mut() {
                patch_session(value, edit);
            }
        }
        Value::Array(items) => {
            for item in items {
                patch_session(item, edit);
            }
        }
        _ => {}
    }
}

/// Whitespace runs collapsed, so a wrapped line compares as the sentence it
/// is.
fn collapsed(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[test]
fn the_row_the_pane_and_the_app_carry_one_label() {
    for count in [1usize, 2, 7] {
        let summary = published_summary(count);
        let state = desktop_state(Some(&summary));
        let session = session_state(&state);

        let label = subagent_summary_label(count);
        assert_eq!(
            session["subagents"]["label"],
            json!(label),
            "the app's row renders this string verbatim"
        );
        assert_eq!(session["subagents"]["running"].as_u64(), Some(count as u64));

        let row = dashboard_row(&state);
        assert!(
            row.contains(&label),
            "the dashboard row shows {label:?}, got {row:?}"
        );

        let detail = session["subagents"]["detail"]
            .as_str()
            .expect("the published detail")
            .to_owned();
        assert!(
            detail.starts_with(&label),
            "the detail is built from the same label: {detail:?}"
        );
        // Compared with whitespace collapsed: the pane wraps and indents a
        // long sentence, so the bytes differ while the sentence does not.
        let pane = collapsed(&render_session_details(Some(&session), 120, 40).join(" "));
        assert!(
            pane.contains(&collapsed(&detail)),
            "the details pane names them with the published sentence, got:\n{pane}"
        );
        assert!(
            pane.contains("Adversarial review of PR 450"),
            "and that sentence names the sub-agents, got:\n{pane}"
        );
    }
}

#[test]
fn nothing_working_says_nothing_on_any_surface() {
    let state = desktop_state(None);
    let session = session_state(&state);
    assert_eq!(
        session.get("subagents"),
        None,
        "the app is handed no key at all, which is how its row renders nothing"
    );
    let pane = render_session_details(Some(&session), 120, 40).join("\n");
    assert!(!pane.contains("Sub-agents"), "and the pane says nothing");
    assert!(!dashboard_row(&state).contains("sub-agent"));
}

#[test]
fn a_summary_that_says_none_are_working_is_not_rendered_either() {
    // The task removes the key rather than publishing a zero, but a zero can
    // still arrive from an older build's metadata, and "0 sub-agents" on a row
    // is worse than silence.
    let state = desktop_state(Some(&json!({
        "running": 0,
        "label": "0 sub-agents",
        "detail": "0 sub-agents",
        "items": [],
    })));
    let session = session_state(&state);
    assert_eq!(session["subagents"]["running"].as_u64(), Some(0));
    assert!(!dashboard_row(&state).contains("0 sub-agents"));
    let pane = render_session_details(Some(&session), 120, 40).join("\n");
    assert!(!pane.contains("Sub-agents"));
}

/// What a busy row does with a third chip, said out loud.
///
/// `ROW_CHIP_BUDGET` is two, and the sub-agent chip ranks behind the two
/// attention chips -- something waiting on a person outranks the agent's own
/// work. So on a row where both of those fire, the sub-agents are behind the
/// overflow mark rather than on the row, and the details pane is where they
/// are named. That is the existing contract for every chip past the second,
/// and this pins it so the eviction is a decision rather than a surprise.
#[test]
fn a_busy_row_puts_the_subagents_behind_the_overflow_mark() {
    let summary = published_summary(2);
    let mut state = desktop_state(Some(&summary));
    // Both chips read the service's derivation rather than the raw counts: the
    // row asks `semantic.waitingOnMeCount` and the session's own
    // `workflowBlockedCount`.
    patch_session(&mut state, &|session| {
        session["semantic"]["waitingOnMeCount"] = json!(3);
        session["workflowBlockedCount"] = json!(1);
    });

    let row = dashboard_row(&state);
    assert!(row.contains("waiting on you"), "got {row:?}");
    assert!(row.contains("coordination blocked"), "got {row:?}");
    assert!(
        !row.contains("2 sub-agents"),
        "the third chip does not fit, and nothing pretends it does: {row:?}"
    );
    assert!(
        row.contains('\u{203a}'),
        "the row says there is more rather than dropping it in silence: {row:?}"
    );
    let pane = collapsed(&render_session_details(Some(&session_state(&state)), 120, 40).join(" "));
    assert!(
        pane.contains("2 sub-agents: Adversarial review of PR 450 (Explore)"),
        "and the pane is where the mark points, got:\n{pane}"
    );
}

/// The same row with nothing waiting on anyone: the chip is on the row.
#[test]
fn a_quiet_row_shows_the_subagents_on_it() {
    let row = dashboard_row(&desktop_state(Some(&published_summary(2))));
    assert!(row.contains("2 sub-agents"), "got {row:?}");
}
