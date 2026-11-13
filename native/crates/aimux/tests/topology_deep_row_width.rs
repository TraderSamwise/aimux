//! A deep row must still fit the terminal it is drawn in.
//!
//! The delegation indent is paid for out of the identity column so it does not
//! push the task column off the right edge, but that only holds while the
//! identity column has columns left to give. This pins the narrow case: an
//! 80-column terminal, a four-deep tree, and labels long enough to want every
//! column they can get.

use aimux::dashboard_controller::DashboardScreen;
use aimux::dashboard_renderer::{DashboardSubscreenRenderInput, render_dashboard_subscreen_frame};
use aimux::tui_render::text::strip_ansi;
use serde_json::{Value, json};

fn deep_topology(depth_limit: usize) -> Value {
    let mut rows = vec![json!({
        "kind": "worktree",
        "label": "a-long-checkout-name-here",
        "health": "active",
        "detail": "feat/a-fairly-long-branch-name",
        "status": "4 agents",
        "depth": 0,
        "worktreePath": "/repo"
    })];
    for depth in 1..=depth_limit {
        rows.push(json!({
            "kind": "agent",
            "label": format!("claude-a-long-agent-label-{depth}"),
            "health": "attention",
            "detail": "overseer",
            "status": "waiting",
            "depth": depth,
            "sessionId": format!("claude-{depth}"),
            "tool": "claude",
            "task": "a task description long enough to want the rest of the line",
            "managerNotShown": depth == 1,
            "worktreePath": "/repo"
        }));
    }
    json!({
        "topology": {
            "projectName": "aimux",
            "health": "attention",
            "counts": { "worktrees": 1, "agents": depth_limit, "services": 0 },
            "rows": rows
        }
    })
}

fn rendered_lines(resource: &Value, cols: usize) -> Vec<String> {
    let frame = render_dashboard_subscreen_frame(&DashboardSubscreenRenderInput {
        screen: DashboardScreen::Topology,
        resource: Some(resource),
        error: None,
        selected_index: 2,
        cols,
        rows: 40,
        scroll_offset: 0,
        footer_progress: None,
        footer_note: None,
        footer_alerts: &[],
        details_sidebar_visible: false,
        runtime_label: Some("tmux"),
        version: Some("test"),
    });
    strip_ansi(&frame.frame)
        .replace('\u{1b}', "")
        .replace("[K", "")
        .lines()
        .map(str::to_owned)
        .collect()
}

#[test]
fn a_deep_row_keeps_its_columns_apart() {
    // The indent is paid for out of the identity column, and `pad_visible`
    // supplies the space that separates the identity from the state only
    // while the text is shorter than the pad. A deep row meets a pad its
    // identity fills exactly, and the two columns ran together: at three deep
    // the line read `claude-a-long-agent…waiting`.
    let resource = deep_topology(4);
    for cols in [80usize, 100, 120] {
        for line in rendered_lines(&resource, cols) {
            if !line.contains("agent") {
                continue;
            }
            assert!(
                !line.contains("…waiting") && !line.contains(")waiting"),
                "the identity and the state ran together at {cols} columns: {line:?}"
            );
        }
    }
}

/// An eighty-column terminal still says what every agent is doing.
///
/// The `manager not shown` note is twenty columns and used to sit before the
/// task, so a flagged agent on a narrow terminal showed no task at all -- and
/// the note itself was clipped mid-word for the privilege.
#[test]
fn a_narrow_terminal_keeps_the_task_and_drops_the_note() {
    let resource = deep_topology(2);
    let lines = rendered_lines(&resource, 80);
    let flagged = lines
        .iter()
        .find(|line| line.contains("(1)") || line.contains("label-1"))
        .unwrap_or_else(|| panic!("the flagged row was not drawn: {lines:?}"));
    assert!(
        flagged.contains("→ a task"),
        "the flagged row lost what its agent is doing: {flagged:?}"
    );
    assert!(
        !flagged.contains("manager not"),
        "and the note is what gives way, not the task: {flagged:?}"
    );
}

/// A deep row keeps the id a person selects by.
///
/// The indent is paid for out of the identity column, and truncating the
/// composed identity took the `(id)` away first -- the one thing telling two
/// agents with the same label apart. The shortfall is spent on the label.
#[test]
fn a_deep_row_keeps_the_session_id() {
    let resource = deep_topology(4);
    let lines = rendered_lines(&resource, 120);
    let deepest = lines
        .iter()
        .filter(|line| line.contains(" agent "))
        .max_by_key(|line| line.len() - line.trim_start_matches([' ', '▸']).len())
        .unwrap_or_else(|| panic!("no agent row was drawn: {lines:?}"));
    assert!(
        deepest.contains("(4)"),
        "the deepest row lost the id it is selected by: {deepest:?}"
    );
}

/// A SHORT label keeps its id too.
///
/// The shortfall used to be subtracted from the 20-column cap rather than from
/// the name's own width, so a label already shorter than the cap narrowed by
/// nothing and the id was clipped anyway -- which is the case this exists to
/// prevent, and the common one: most labels are short.
#[test]
fn a_deep_row_with_a_short_label_keeps_its_session_id() {
    let mut rows = vec![json!({
        "kind": "worktree",
        "label": "main",
        "health": "active",
        "depth": 0,
        "worktreePath": "/repo"
    })];
    for depth in 1..=5usize {
        rows.push(json!({
            "kind": "agent",
            "label": "coder",
            "health": "active",
            "detail": "coder",
            "status": "waiting",
            "depth": depth,
            // Long enough that label + id overflows a deep row's column, with
            // a label well under the cap.
            "sessionId": format!("claude-01HX8ZK3QF{depth}"),
            "tool": "claude",
            "worktreePath": "/repo"
        }));
    }
    let resource = json!({
        "topology": {
            "projectName": "aimux",
            "health": "active",
            "counts": { "worktrees": 1, "agents": 5, "services": 0 },
            "rows": rows
        }
    });

    let lines = rendered_lines(&resource, 120);
    let deepest = lines
        .iter()
        .filter(|line| line.contains(" agent "))
        .max_by_key(|line| line.len() - line.trim_start_matches([' ', '▸']).len())
        .unwrap_or_else(|| panic!("no agent row was drawn: {lines:?}"));
    assert!(
        deepest.contains("01HX8ZK3QF5"),
        "the deepest row lost the id it is selected by: {deepest:?}"
    );
}

#[test]
fn a_deep_row_still_says_what_the_agent_is_doing() {
    // The indent is taken from the identity column precisely so the task
    // survives. If it stops surviving, the deepest rows become
    // indistinguishable from each other.
    let resource = deep_topology(4);
    let lines = rendered_lines(&resource, 120);
    // The deepest row by its indent, because its label is truncated and so
    // cannot be matched whole.
    let deepest = lines
        .iter()
        .filter(|line| line.contains(" agent "))
        .max_by_key(|line| line.len() - line.trim_start_matches([' ', '▸']).len())
        .unwrap_or_else(|| panic!("no agent row was drawn: {lines:?}"));
    assert!(
        deepest.contains("a task description"),
        "the deepest row lost what its agent is doing: {deepest:?}"
    );
}
