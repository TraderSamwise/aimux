//! The service half of the cross-surface delegation-depth check.
//!
//! AGENTS.md "One Answer, Many Surfaces": a per-surface test passes happily
//! while the surfaces disagree. Depth is decided once, in
//! `build_project_topology`, by walking the supervision edge; the TUI indents
//! by it and the Expo app pads by it. Both halves read the same fixture --
//! `app/lib/topology-rows.test.ts` is the other one -- so neither can quietly
//! start drawing a different tree from the same answer.

use aimux::dashboard_controller::{DashboardScreen, DashboardSubscreenAction};
use aimux::dashboard_renderer::{
    DashboardSubscreenRenderInput, render_dashboard_subscreen_frame, topology_indent_columns,
};
use aimux::project_service::topology::build_project_topology;
use aimux::tui_render::text::strip_ansi;
use serde_json::{Value, json};
use std::fs::read_to_string;
use std::path::Path;

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .join("testdata/contracts/v1/topology-depth/surfaces.json");
    serde_json::from_str(&read_to_string(&path).expect("read the shared depth fixture"))
        .expect("parse the shared depth fixture")
}

fn topology_for(case: &Value) -> Value {
    let mut worktree = case["worktree"].clone();
    worktree["sessions"] = case["sessions"].clone();
    worktree["services"] = json!([]);
    let registry = json!({
        "version": 1,
        "sessions": {},
        "watchBindings": case["watchBindings"].clone(),
        "roleSlots": {}
    });
    build_project_topology("aimux", vec![worktree], Some(&registry))
}

#[test]
fn the_service_derives_the_depth_and_the_order_every_surface_draws() {
    let fixture = fixture();
    for case in fixture["cases"].as_array().expect("cases") {
        let why = case["why"].as_str().unwrap_or("");
        let topology = topology_for(case);
        let rows = topology["rows"].as_array().expect("rows").clone();
        let expected = case["rows"].as_array().expect("expected rows");

        assert_eq!(
            rows.len(),
            expected.len(),
            "{why}: row count differs: {rows:?}"
        );
        for (index, (row, want)) in rows.iter().zip(expected).enumerate() {
            assert_eq!(row["kind"], want["kind"], "{why}: row {index} kind");
            assert_eq!(
                row["depth"], want["depth"],
                "{why}: row {index} depth -- a flat answer draws an org as peers: {row:?}"
            );
            if let Some(session_id) = want["sessionId"].as_str() {
                assert_eq!(
                    row["sessionId"], session_id,
                    "{why}: row {index} is the wrong agent, so the order is not the tree's: {row:?}"
                );
            }
            if let Some(overseer) = want["watchedBy"].as_str() {
                assert_eq!(row["watchedBy"], overseer, "{why}: row {index}");
            }
            assert_eq!(
                row.get("managerNotShown").and_then(Value::as_bool),
                want.get("managerNotShown").and_then(Value::as_bool),
                "{why}: row {index} must say whether its manager is among these \
                 rows: {row:?}"
            );
        }
    }
}

#[test]
fn the_tui_indents_every_row_by_the_depth_the_service_gave_it() {
    let fixture = fixture();
    let per_depth = fixture["indent"]["tuiColumnsPerDepth"]
        .as_u64()
        .expect("tuiColumnsPerDepth") as usize;
    let base = fixture["indent"]["tuiBaseColumns"]
        .as_u64()
        .expect("tuiBaseColumns") as usize;
    for depth in 0..5usize {
        assert_eq!(
            topology_indent_columns(depth),
            base + depth * per_depth,
            "the renderer's indent rule left the fixture behind"
        );
    }

    for case in fixture["cases"].as_array().expect("cases") {
        let why = case["why"].as_str().unwrap_or("");
        let topology = topology_for(case);
        let resource = json!({ "topology": topology });
        let frame = render_dashboard_subscreen_frame(&DashboardSubscreenRenderInput {
            screen: DashboardScreen::Topology,
            resource: Some(&resource),
            error: None,
            selected_index: usize::MAX,
            cols: 160,
            rows: 48,
            scroll_offset: 0,
            footer_progress: None,
            footer_note: None,
            footer_alerts: &[],
            details_sidebar_visible: false,
            runtime_label: Some("tmux"),
            version: Some("test"),
        });
        // `strip_ansi` leaves the clear-to-end-of-line control, which would
        // read as a leading character and offset every indent.
        let plain = strip_ansi(&frame.frame)
            .replace('\u{1b}', "")
            .replace("[K", "");

        for want in case["rows"].as_array().expect("expected rows") {
            let label = want["label"]
                .as_str()
                .map(str::to_owned)
                .or_else(|| {
                    let session_id = want["sessionId"].as_str()?;
                    case["sessions"]
                        .as_array()?
                        .iter()
                        .find(|session| session["id"] == session_id)
                        .and_then(|session| session["label"].as_str())
                        .map(str::to_owned)
                })
                .expect("every expected row names something the frame prints");
            let line = plain
                .lines()
                .find(|line| line.contains(&label))
                .unwrap_or_else(|| panic!("{why}: the frame never printed {label}:\n{plain}"));
            // The selection marker and the space after it, then the indent.
            let leading = line.len() - line.trim_start_matches(' ').len();
            let want_indent = want["tuiIndent"].as_u64().expect("tuiIndent") as usize;
            assert_eq!(
                leading,
                want_indent + 2,
                "{why}: {label} is drawn at the wrong depth. line: {line:?}"
            );
        }
    }
}

/// The selection follows the row, not the slot.
///
/// Topology rows are ordered by the delegation tree, so binding a watch
/// reorders them. The subscreen index survives a refresh, so a positional
/// selection silently re-points at a different agent and Enter opens that one.
/// But only when the row is unambiguous.
///
/// A list can carry the same action twice -- two rows about one agent -- and
/// following the first of them would move a selection nobody moved.
#[test]
fn a_duplicated_row_leaves_the_selection_where_it_was() {
    use aimux::dashboard_controller::DashboardController;
    use aimux::dashboard_model::DesktopStateGoldenFixture;

    const GOLDEN: &str =
        include_str!("../../../../src/multiplexer/desktop-state-golden.fixture.json");
    let snapshot = serde_json::from_str::<DesktopStateGoldenFixture>(GOLDEN)
        .expect("the golden desktop-state fixture")
        .runtime_full;
    let mut controller = DashboardController::new(&snapshot);
    controller.set_subscreen_actions(vec![
        DashboardSubscreenAction::Session("one".into()),
        DashboardSubscreenAction::Session("twice".into()),
    ]);
    controller.subscreen_index = 1;

    controller.set_subscreen_actions(vec![
        DashboardSubscreenAction::Session("twice".into()),
        DashboardSubscreenAction::Session("one".into()),
        DashboardSubscreenAction::Session("twice".into()),
    ]);

    assert_eq!(
        controller.subscreen_index, 1,
        "an ambiguous row moved the selection anyway"
    );
}

#[test]
fn a_reordered_list_keeps_the_selection_on_the_agent_it_was_on() {
    use aimux::dashboard_controller::DashboardController;
    use aimux::dashboard_model::DesktopStateGoldenFixture;

    // The real snapshot shape, from the golden fixture the dashboard tests
    // use. Which agents it holds does not matter here: this is about the
    // index surviving a reorder of the subscreen list.
    const GOLDEN: &str =
        include_str!("../../../../src/multiplexer/desktop-state-golden.fixture.json");
    let snapshot = serde_json::from_str::<DesktopStateGoldenFixture>(GOLDEN)
        .expect("the golden desktop-state fixture")
        .runtime_full;
    let mut controller = DashboardController::new(&snapshot);
    controller.set_subscreen_actions(vec![
        DashboardSubscreenAction::Session("lead".into()),
        DashboardSubscreenAction::Session("coder".into()),
        DashboardSubscreenAction::Session("mid".into()),
    ]);
    controller.subscreen_index = 2;

    // `mid` is now watched by `lead`, so it is drawn under it and `coder`
    // moves down.
    controller.set_subscreen_actions(vec![
        DashboardSubscreenAction::Session("lead".into()),
        DashboardSubscreenAction::Session("mid".into()),
        DashboardSubscreenAction::Session("coder".into()),
    ]);

    assert_eq!(
        controller.subscreen_actions.get(controller.subscreen_index),
        Some(&DashboardSubscreenAction::Session("mid".into())),
        "the selection stayed in its old slot and now points at another agent"
    );
}
