//! The CLI half of the cross-surface operation-failure check.
//!
//! AGENTS.md "One Answer, Many Surfaces": a per-surface test passes happily
//! while the surfaces disagree, which is exactly how that class survives. This
//! reads the same fixture as `app/lib/operation-failure.cross-surface.test.ts`,
//! so a surface that changes what it shows alone fails here.
//!
//! Both cards are fed by one ledger now that a refused action is recorded
//! there. What is pinned is which facts each card shows, not the layout: the
//! CLI renders title, target and recency in a card while the app renders a
//! title and a detail line, and those differ on purpose.

use aimux::dashboard_model::{DashboardOperationFailure, DesktopStateGoldenFixture};
use aimux::dashboard_renderer::{DashboardNavLevel, DashboardRenderInput, render_dashboard_frame};
use aimux::tui_render::text::strip_ansi;
use serde_json::Value;

const FIXTURE: &str =
    include_str!("../../../../testdata/contracts/v1/operation-failure-presentation/surfaces.json");
const GOLDEN: &str = include_str!("../../../../src/multiplexer/desktop-state-golden.fixture.json");

#[test]
fn the_cli_card_shows_the_shared_title_and_target() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture parses");
    let cases = fixture["cases"].as_array().expect("cases array");
    assert!(!cases.is_empty(), "the fixture must carry cases");

    let golden: DesktopStateGoldenFixture =
        serde_json::from_str(GOLDEN).expect("valid desktop-state fixture");
    let mut snapshot = golden.runtime_light.clone();
    snapshot.operation_failures = cases
        .iter()
        .map(|case| {
            serde_json::from_value::<DashboardOperationFailure>(case["failure"].clone())
                .expect("failure parses")
        })
        .collect();

    let result = render_dashboard_frame(&DashboardRenderInput {
        snapshot: &snapshot,
        overseer_sessions: &[],
        scribe_sessions: &[],
        cols: 120,
        rows: 60,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: None,
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: Some("tmux"),
        version: Some("local"),
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_message: None,
        footer_alert: None,
        details_sidebar_visible: false,
        preview_source: "output",
        scribe_preview_entries: &[],
    });
    let plain = strip_ansi(&result.frame);

    for case in cases {
        let title = case["title"].as_str().expect("title");
        let target = case["target"].as_str().expect("target");
        let why = case["why"].as_str().unwrap_or_default();
        assert!(plain.contains(title), "missing title for {why}:\n{plain}");
        assert!(plain.contains(target), "missing target for {why}:\n{plain}");
    }
}

/// The fixture has to carry the case that started this, or the pin is about
/// something other than the bug.
#[test]
fn the_fixture_covers_a_refusal_as_well_as_a_breakage() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture parses");
    let operations: Vec<&str> = fixture["cases"]
        .as_array()
        .expect("cases array")
        .iter()
        .filter_map(|case| case["failure"]["operation"].as_str())
        .collect();
    assert!(
        operations.contains(&"graveyard"),
        "a refused graveyard is the case this exists for"
    );
}
