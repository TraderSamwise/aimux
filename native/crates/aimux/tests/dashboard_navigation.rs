use aimux::dashboard_model::{DesktopStateGoldenFixture, DesktopStateSnapshot};
use aimux::dashboard_navigation::{
    DashboardEntryRef, DashboardNavigationOutcome, DashboardNavigationState,
};
use aimux::dashboard_renderer::DashboardNavLevel;

const GOLDEN: &str = include_str!("../../../../src/multiplexer/desktop-state-golden.fixture.json");

#[test]
fn starts_at_worktree_level_when_groups_exist() {
    let snapshot = snapshot();
    let state = DashboardNavigationState::new(&snapshot);

    assert_eq!(state.level, DashboardNavLevel::Worktrees);
    assert_eq!(state.worktree_index, 0);
    assert_eq!(state.focused_worktree_path(&snapshot), None);
}

#[test]
fn moves_between_worktrees_and_steps_into_entries() {
    let snapshot = snapshot();
    let mut state = DashboardNavigationState::new(&snapshot);

    state.move_next(&snapshot);
    assert_eq!(state.focused_worktree_path(&snapshot), Some("<WORKTREE>"));

    assert_eq!(state.step_in(&snapshot), DashboardNavigationOutcome::StepIn);
    assert_eq!(state.level, DashboardNavLevel::Sessions);
    assert_eq!(state.item_index, 0);
    assert_eq!(
        state.selected_entry(&snapshot),
        Some(DashboardEntryRef::Session(
            &snapshot.worktree_groups[1].sessions[0]
        ))
    );

    state.move_next(&snapshot);
    assert_eq!(
        state.selected_entry(&snapshot),
        Some(DashboardEntryRef::Session(
            &snapshot.worktree_groups[1].sessions[1]
        ))
    );

    state.move_next(&snapshot);
    assert_eq!(
        state.selected_entry(&snapshot),
        Some(DashboardEntryRef::Service(
            &snapshot.worktree_groups[1].services[0]
        ))
    );

    assert_eq!(state.back(&snapshot), DashboardNavigationOutcome::Back);
    assert_eq!(state.level, DashboardNavLevel::Worktrees);
    assert_eq!(state.focused_worktree_path(&snapshot), Some("<WORKTREE>"));
}

#[test]
fn digit_at_worktree_level_focuses_rendered_worktree_order() {
    let snapshot = snapshot();
    let mut state = DashboardNavigationState::new(&snapshot);

    assert_eq!(
        state.handle_digit(&snapshot, '2'),
        DashboardNavigationOutcome::Changed
    );
    assert_eq!(state.level, DashboardNavLevel::Worktrees);
    assert_eq!(state.focused_worktree_path(&snapshot), Some("<WORKTREE>"));
    assert_eq!(state.quick_jump_digits, "2");
}

#[test]
fn second_quick_jump_digit_selects_session_or_service_inside_worktree() {
    let snapshot = snapshot();
    let mut state = DashboardNavigationState::new(&snapshot);

    state.handle_digit(&snapshot, '2');
    assert_eq!(
        state.handle_digit(&snapshot, '1'),
        DashboardNavigationOutcome::EntrySelected(DashboardEntryRef::Session(
            &snapshot.worktree_groups[1].sessions[0]
        ))
    );
    assert_eq!(state.level, DashboardNavLevel::Sessions);
    assert_eq!(state.item_index, 0);
    assert_eq!(state.quick_jump_digits, "");

    state.back(&snapshot);
    state.handle_digit(&snapshot, '2');
    assert_eq!(
        state.handle_digit(&snapshot, '3'),
        DashboardNavigationOutcome::EntrySelected(DashboardEntryRef::Service(
            &snapshot.worktree_groups[1].services[0]
        ))
    );
    assert_eq!(state.level, DashboardNavLevel::Sessions);
    assert_eq!(state.item_index, 2);
}

#[test]
fn navigation_skips_project_control_sessions_inside_worktree_groups() {
    let mut snapshot = snapshot();
    snapshot.worktree_groups[0].services.clear();
    snapshot.services.clear();

    let mut plain = snapshot.worktree_groups[0].sessions[0].clone();
    plain.id = "claude-plain".into();
    plain.label = Some("Plain Agent".into());
    plain.overseer = None;
    plain.scribe = None;
    plain.project_control = None;
    plain.team = None;

    let mut overseer = plain.clone();
    overseer.id = "claude-overseer".into();
    overseer.label = Some("Project Overseer".into());
    overseer.overseer = Some(true);
    overseer.project_control = Some(true);

    let mut scribe = plain.clone();
    scribe.id = "claude-scribe".into();
    scribe.label = Some("Project Scribe".into());
    scribe.scribe = Some(true);
    scribe.project_control = Some(true);

    snapshot.sessions = vec![overseer.clone(), plain.clone(), scribe.clone()];
    snapshot.worktree_groups[0].sessions = vec![overseer, plain.clone(), scribe];

    let mut state = DashboardNavigationState::new(&snapshot);
    assert_eq!(state.step_in(&snapshot), DashboardNavigationOutcome::StepIn);
    assert_eq!(
        state.selected_entry(&snapshot),
        Some(DashboardEntryRef::Session(&plain))
    );

    state.move_next(&snapshot);
    assert_eq!(
        state.selected_entry(&snapshot),
        Some(DashboardEntryRef::Session(&plain))
    );
}

#[test]
fn stale_quick_jump_can_be_cleared_without_changing_focused_worktree() {
    let snapshot = snapshot();
    let mut state = DashboardNavigationState::new(&snapshot);

    state.handle_digit(&snapshot, '2');
    state.clear_quick_jump();
    assert_eq!(state.quick_jump_digits, "");
    assert_eq!(state.focused_worktree_path(&snapshot), Some("<WORKTREE>"));

    assert_eq!(
        state.handle_digit(&snapshot, '9'),
        DashboardNavigationOutcome::Ignored
    );
    assert_eq!(state.focused_worktree_path(&snapshot), Some("<WORKTREE>"));
}

fn snapshot() -> DesktopStateSnapshot {
    serde_json::from_str::<DesktopStateGoldenFixture>(GOLDEN)
        .expect("valid fixture")
        .runtime_full
}
