use aimux::dashboard_model::{DesktopStateGoldenFixture, DesktopStateSnapshot};
use aimux::dashboard_navigation::{
    DashboardEntryRef, DashboardNavigationGroupKind, DashboardNavigationOutcome,
    DashboardNavigationState, dashboard_navigation_groups,
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

/// The pointer follows a worktree that has just been made.
///
/// `w` asks for a name and the route decides the path, so the create response
/// is the only thing that knows where it landed; the dashboard then has to
/// wait for a snapshot that carries it. Returning false rather than guessing is
/// what lets the caller keep waiting instead of moving the pointer somewhere
/// arbitrary in the meantime.
#[test]
fn selecting_a_worktree_by_path_waits_until_it_is_on_screen() {
    let snapshot = snapshot();
    let mut state = DashboardNavigationState::new(&snapshot);
    let path = snapshot
        .worktree_groups
        .iter()
        .find_map(|group| group.path.as_deref())
        .expect("a worktree with a path");

    let before = state.worktree_index;
    assert!(
        !state.select_worktree(&snapshot, "/repo/.aimux/worktrees/not-here"),
        "a path that is not on screen must not move the pointer"
    );
    assert_eq!(
        state.worktree_index, before,
        "the pointer moved for a path that is not there"
    );

    assert!(state.select_worktree(&snapshot, path));
    assert_eq!(state.focused_worktree_path(&snapshot), Some(path));
    assert_ne!(
        state.worktree_index, before,
        "this fixture has to actually move the pointer to be worth running"
    );
}

/// The only place in the whole dashboard that could call a worktree "unknown".
///
/// It fires for a session whose worktree path the service gave no group -- a
/// graveyarded worktree's leftover agents, before that debris was dropped at
/// the source. The name is on the path; nothing here knows the branch.
#[test]
fn an_unrecognised_worktree_path_is_named_by_its_directory_not_called_unknown() {
    let mut snapshot = snapshot();
    snapshot.worktree_groups.truncate(1);
    snapshot.worktree_groups[0].services.clear();
    snapshot.services.clear();

    let mut stray = snapshot.worktree_groups[0].sessions[0].clone();
    stray.id = "codex-stray".into();
    stray.overseer = None;
    stray.scribe = None;
    stray.project_control = None;
    stray.team = None;
    stray.worktree_path = Some("/repo/.aimux/worktrees/perf".into());
    stray.worktree_name = None;
    stray.worktree_branch = None;
    snapshot.sessions = vec![stray];
    snapshot.worktree_groups[0].sessions.clear();

    let groups = dashboard_navigation_groups(&snapshot);
    let stray_group = groups
        .iter()
        .find(|group| group.path == Some("/repo/.aimux/worktrees/perf"))
        .expect("orphan group");
    assert_eq!(stray_group.name, "perf");
    assert_eq!(stray_group.branch, "");
    assert!(
        groups.iter().all(|group| group.name != "unknown"),
        "a worktree was named unknown"
    );
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
fn supervisor_group_does_not_change_resolved_worktree_session_membership() {
    let mut snapshot = snapshot();
    snapshot.worktree_groups[0].services.clear();
    snapshot.services.clear();

    let mut main_agent = snapshot.worktree_groups[0].sessions[0].clone();
    main_agent.id = "main-agent".into();
    main_agent.overseer = None;
    main_agent.scribe = None;
    main_agent.project_control = None;
    main_agent.team = None;

    let mut worker_agent = snapshot.worktree_groups[1].sessions[0].clone();
    worker_agent.id = "worker-agent".into();
    worker_agent.overseer = None;
    worker_agent.scribe = None;
    worker_agent.project_control = None;
    worker_agent.team = None;

    let mut overseer = main_agent.clone();
    overseer.id = "project-overseer".into();
    overseer.overseer = Some(true);
    overseer.project_control = Some(true);

    let mut scribe = main_agent.clone();
    scribe.id = "project-scribe".into();
    scribe.scribe = Some(true);
    scribe.project_control = Some(true);

    snapshot.sessions = vec![
        scribe.clone(),
        main_agent.clone(),
        worker_agent.clone(),
        overseer.clone(),
    ];
    snapshot.worktree_groups[0].sessions = vec![main_agent, overseer];
    snapshot.worktree_groups[1].sessions = vec![worker_agent, scribe];

    let groups = dashboard_navigation_groups(&snapshot);
    assert_eq!(groups[0].kind, DashboardNavigationGroupKind::Supervisor);
    assert_eq!(
        groups[0]
            .sessions
            .iter()
            .map(|session| session.id.as_str())
            .collect::<Vec<_>>(),
        vec!["project-overseer", "project-scribe"]
    );
    assert_eq!(
        groups[1]
            .sessions
            .iter()
            .map(|session| session.id.as_str())
            .collect::<Vec<_>>(),
        vec!["main-agent"]
    );
    assert_eq!(
        groups[2]
            .sessions
            .iter()
            .map(|session| session.id.as_str())
            .collect::<Vec<_>>(),
        vec!["worker-agent"]
    );
}

#[test]
fn step_in_ignores_worktree_with_only_project_control_sessions() {
    let mut snapshot = snapshot();
    snapshot.worktree_groups[0].services.clear();
    snapshot.services.clear();

    let mut overseer = snapshot.worktree_groups[0].sessions[0].clone();
    overseer.id = "claude-overseer".into();
    overseer.label = Some("Project Overseer".into());
    overseer.overseer = Some(true);
    overseer.project_control = Some(true);

    let mut scribe = overseer.clone();
    scribe.id = "claude-scribe".into();
    scribe.label = Some("Project Scribe".into());
    scribe.overseer = None;
    scribe.scribe = Some(true);

    snapshot.sessions = vec![overseer.clone(), scribe.clone()];
    snapshot.worktree_groups[0].sessions = vec![overseer, scribe];

    let mut state = DashboardNavigationState::new(&snapshot);

    assert_eq!(
        state.step_in(&snapshot),
        DashboardNavigationOutcome::Ignored
    );
    assert_eq!(state.level, DashboardNavLevel::Worktrees);
    assert_eq!(state.item_index, 0);
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

/// Returning from an agent points the dashboard at that agent, wherever it
/// sits, so the row you left is the row you come back to.
#[test]
fn selects_an_agent_by_id_from_any_group() {
    let snapshot = snapshot();
    let groups = dashboard_navigation_groups(&snapshot);
    let (expected_group, expected_item, session_id) = groups
        .iter()
        .enumerate()
        .find_map(|(group_index, group)| {
            let item_index = group.sessions.len().checked_sub(1)?;
            let session = group.sessions.get(item_index)?;
            (groups.len() > 1 || item_index > 0)
                .then(|| (group_index, item_index, session.id.clone()))
        })
        .expect("a session to select");

    let mut state = DashboardNavigationState::new(&snapshot);
    assert!(state.select_session(&snapshot, &session_id));
    assert_eq!(state.level, DashboardNavLevel::Sessions);
    assert_eq!(state.worktree_index, expected_group);
    assert_eq!(state.item_index, expected_item);
    match state.selected_entry(&snapshot) {
        Some(DashboardEntryRef::Session(session)) => assert_eq!(session.id, session_id),
        other => panic!("expected the selected session, got {other:?}"),
    }
}

#[test]
fn leaves_the_selection_alone_for_an_agent_that_is_not_on_screen() {
    let snapshot = snapshot();
    let mut state = DashboardNavigationState::new(&snapshot);
    let before = (state.level, state.worktree_index, state.item_index);

    assert!(!state.select_session(&snapshot, "claude-not-here"));
    assert_eq!(
        (state.level, state.worktree_index, state.item_index),
        before
    );
}

/// The gap between `2` and `1` is a real gap -- a tenth of a second, in which
/// an event can arrive and the list can be rebuilt. The second digit has to
/// land in the checkout the first one highlighted, not at the row index that
/// checkout happened to occupy at the time.
///
/// Without this the keystroke enters an agent in a different worktree, which is
/// the worst outcome a navigation shortcut has: it looks like it worked.
#[test]
fn the_second_digit_lands_in_the_group_the_first_one_named() {
    let snapshot = snapshot();
    let mut state = DashboardNavigationState::new(&snapshot);
    state.handle_digit(&snapshot, '2');
    let highlighted = state
        .focused_worktree_path(&snapshot)
        .expect("digit 2 focused a checkout")
        .to_owned();

    // A group appears ahead of it, so every index below shifts by one.
    let mut reordered = snapshot.clone();
    let mut inserted = reordered.worktree_groups[1].clone();
    inserted.name = "inserted-ahead".into();
    inserted.path = Some("<INSERTED>".to_owned());
    inserted.sessions.clear();
    inserted.services.clear();
    reordered.worktree_groups.insert(0, inserted);

    state.handle_digit(&reordered, '1');

    assert_eq!(
        state.focused_worktree_path(&reordered),
        Some(highlighted.as_str()),
        "the jump followed the row index instead of the digit"
    );
    assert_eq!(state.level, DashboardNavLevel::Sessions);
}

/// The same gap, one level down. Rows inside a checkout are sorted by when
/// they were created, so an agent appearing between `2` and `1` pushes every
/// row the user counted down by one.
///
/// Anchoring the checkout alone was not enough: the jump found the right
/// worktree and then entered the wrong agent inside it.
#[test]
fn the_second_digit_lands_on_the_row_the_user_counted() {
    let snapshot = snapshot();
    let mut state = DashboardNavigationState::new(&snapshot);
    state.handle_digit(&snapshot, '2');
    let counted = snapshot.worktree_groups[1].sessions[0].id.clone();

    // A newer agent sorts ahead of it, so what was row 1 is now row 2.
    let mut reordered = snapshot.clone();
    let mut ahead = reordered.worktree_groups[1].sessions[0].clone();
    ahead.id = "arrived-first".into();
    ahead.tmux_window_index = Some(0);
    reordered.worktree_groups[1].sessions.insert(0, ahead);

    let outcome = state.handle_digit(&reordered, '1');

    match outcome {
        DashboardNavigationOutcome::EntrySelected(DashboardEntryRef::Session(session)) => {
            assert_eq!(
                session.id, counted,
                "the jump entered the row that moved into position, not the one counted"
            );
        }
        other => panic!("expected the counted row to be entered, got {other:?}"),
    }
}

/// And when the row is simply gone, nothing is entered on a guess. Resolving
/// against whatever has shifted into that position is how a jump enters an
/// agent the user never saw.
#[test]
fn a_jump_whose_row_has_gone_enters_nothing() {
    let snapshot = snapshot();
    let mut state = DashboardNavigationState::new(&snapshot);
    state.handle_digit(&snapshot, '2');

    let gone = snapshot.worktree_groups[1].sessions[0].id.clone();
    let mut emptied = snapshot.clone();
    emptied.worktree_groups[1]
        .sessions
        .retain(|session| session.id != gone);
    emptied.sessions.retain(|session| session.id != gone);

    assert_eq!(
        state.handle_digit(&emptied, '1'),
        DashboardNavigationOutcome::Changed,
        "a vanished row must not hand the keystroke to its replacement"
    );
    assert_eq!(state.level, DashboardNavLevel::Worktrees);
    assert_eq!(
        state.focused_worktree_path(&emptied),
        snapshot.worktree_groups[1].path.as_deref(),
        "and the highlight must still be on the checkout the jump named"
    );
}

/// The checkout the jump named, even when the row inside it is gone and the
/// list has been rebuilt around it. The next key acts on whatever is
/// highlighted, so leaving it on a stale row index points `x` at a checkout
/// the user never selected.
#[test]
fn a_jump_that_enters_nothing_still_moves_the_highlight() {
    let snapshot = snapshot();
    let mut state = DashboardNavigationState::new(&snapshot);
    state.handle_digit(&snapshot, '2');
    let named = state
        .focused_worktree_path(&snapshot)
        .expect("digit 2 focused a checkout")
        .to_owned();

    // A checkout appears ahead of it and its only row goes, in the same gap.
    let mut shifted = snapshot.clone();
    let mut ahead = shifted.worktree_groups[1].clone();
    ahead.name = "arrived-ahead".into();
    ahead.path = Some("<AHEAD>".to_owned());
    ahead.sessions.clear();
    ahead.services.clear();
    shifted.worktree_groups.insert(0, ahead);
    let gone = snapshot.worktree_groups[1].sessions[0].id.clone();
    shifted.worktree_groups[2]
        .sessions
        .retain(|session| session.id != gone);
    shifted.sessions.retain(|session| session.id != gone);

    state.handle_digit(&shifted, '1');

    assert_eq!(
        state.focused_worktree_path(&shifted),
        Some(named.as_str()),
        "the highlight was left on the row index, not on the checkout"
    );
}

/// A checkout that has gone resolves no row at all. The dangerous shape is a
/// stale index plus an id that exists in whatever slid into that position:
/// sessions are listed by the group that holds them regardless of their own
/// worktree path, so one id really can appear in two groups.
///
/// Resolving the row against that index enters an agent in a checkout the user
/// never named, and it looks like the jump worked.
#[test]
fn a_jump_whose_checkout_has_gone_enters_nothing_anywhere() {
    let snapshot = snapshot();
    let mut state = DashboardNavigationState::new(&snapshot);
    state.handle_digit(&snapshot, '2');
    let counted = snapshot.worktree_groups[1].sessions[0].id.clone();

    // The named checkout goes, and another takes its index while still listing
    // the very row that was counted.
    let mut removed = snapshot.clone();
    let mut successor = snapshot.worktree_groups[1].clone();
    successor.name = "took-its-place".into();
    successor.path = Some("<SUCCESSOR>".to_owned());
    for session in &mut successor.sessions {
        session.worktree_path = Some("<SUCCESSOR>".to_owned());
    }
    for service in &mut successor.services {
        service.worktree_path = Some("<SUCCESSOR>".to_owned());
    }
    removed.worktree_groups[1] = successor;
    for session in &mut removed.sessions {
        if session.worktree_path.as_deref() == Some("<WORKTREE>") {
            session.worktree_path = Some("<SUCCESSOR>".to_owned());
        }
    }
    for service in &mut removed.services {
        if service.worktree_path.as_deref() == Some("<WORKTREE>") {
            service.worktree_path = Some("<SUCCESSOR>".to_owned());
        }
    }

    let outcome = state.handle_digit(&removed, '1');

    assert_eq!(
        outcome,
        DashboardNavigationOutcome::Changed,
        "the jump entered {counted} in a checkout that was never named"
    );
    assert_eq!(state.level, DashboardNavLevel::Worktrees);
}

/// Cancelling a jump with `0` leaves the highlight on the checkout it named,
/// not on the row index that checkout used to occupy. The next key acts on
/// wherever the highlight is, so a stale index points it at a stranger.
#[test]
fn cancelling_a_jump_still_leaves_the_highlight_where_it_was_put() {
    let snapshot = snapshot();
    let mut state = DashboardNavigationState::new(&snapshot);
    state.handle_digit(&snapshot, '2');
    let named = state
        .focused_worktree_path(&snapshot)
        .expect("digit 2 focused a checkout")
        .to_owned();

    let mut shifted = snapshot.clone();
    let mut ahead = shifted.worktree_groups[1].clone();
    ahead.name = "arrived-ahead".into();
    ahead.path = Some("<AHEAD>".to_owned());
    ahead.sessions.clear();
    ahead.services.clear();
    shifted.worktree_groups.insert(0, ahead);

    assert_eq!(
        state.handle_digit(&shifted, '0'),
        DashboardNavigationOutcome::Changed
    );
    assert_eq!(
        state.focused_worktree_path(&shifted),
        Some(named.as_str()),
        "cancelling left the highlight on the row index, not the checkout"
    );
    assert_eq!(state.quick_jump_digits, "");
}
