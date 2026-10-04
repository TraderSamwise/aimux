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
use aimux::project_service::operation_failures::{
    operation_failure_target, with_derived_operation_failure_target,
};
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

    // One row per frame. The card lists at most three and then counts the rest,
    // so rendering the whole fixture at once would turn a missing row into a
    // "2 more failures" line and pass.
    for case in cases {
        let why = case["why"].as_str().unwrap_or_default();
        let mut snapshot = golden.runtime_light.clone();
        // Published exactly as the project service publishes it, so the card is
        // pinned against the row a client actually receives rather than against
        // a hand-assembled one.
        snapshot.operation_failures = vec![
            serde_json::from_value::<DashboardOperationFailure>(
                with_derived_operation_failure_target(case["failure"].clone()),
            )
            .expect("failure parses"),
        ];

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
            footer_alerts: &[],
            details_sidebar_visible: false,
            preview_source: "output",
            scribe_preview_entries: &[],
        });
        let plain = strip_ansi(&result.frame);

        let title = case["title"].as_str().expect("title");
        assert!(plain.contains(title), "missing title for {why}:\n{plain}");
        if let Some(target) = case["target"].as_str() {
            assert!(plain.contains(target), "missing target for {why}:\n{plain}");
        }
    }
}

/// The derivation itself, against the same expectations both cards render.
///
/// Without this the pair was close to a tautology: in the shapes that actually
/// occur most, the target is a literal substring of the title, so asserting the
/// rendered frame contains both says nothing the title assertion did not. This
/// pins the one place the answer is computed.
#[test]
fn the_service_derives_the_target_both_cards_are_given() {
    let fixture: Value = serde_json::from_str(FIXTURE).expect("fixture parses");
    let cases = fixture["cases"].as_array().expect("cases array");

    for case in cases {
        let why = case["why"].as_str().unwrap_or_default();
        let expected = case["target"].as_str();
        assert_eq!(
            operation_failure_target(&case["failure"]).as_deref(),
            expected,
            "derived target disagrees with the shared expectation for {why}"
        );
        let published = with_derived_operation_failure_target(case["failure"].clone());
        assert_eq!(
            published.get("target").and_then(Value::as_str),
            expected,
            "a row with nothing to name must omit the field, not carry an empty one, for {why}"
        );
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

    let cases = fixture["cases"].as_array().expect("cases array");
    assert!(
        cases.iter().any(|case| case["target"].is_null()),
        "a row with nothing to name is a real shape -- the store-unavailable record"
    );
    assert!(
        cases.iter().any(|case| {
            match (case["title"].as_str(), case["target"].as_str()) {
                (Some(title), Some(target)) => !title.contains(target),
                _ => false,
            }
        }),
        "at least one case must have a target the title does not spell, or the target \
         assertion is implied by the title assertion"
    );
}
