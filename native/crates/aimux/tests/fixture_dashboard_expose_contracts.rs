//! Aggregated dashboard and expose fixture contracts.
//!
//! These fixture modules used to be one integration-test binary per corpus.
//! Keep them grouped by subsystem so Cargo links aimux once per subsystem
//! while preserving the same contract assertions.

#[path = "fixtures/fixture_dashboard_command_spec.rs"]
mod fixture_dashboard_command_spec;
#[path = "fixtures/fixture_dashboard_desktop_state_counts.rs"]
mod fixture_dashboard_desktop_state_counts;
#[path = "fixtures/fixture_dashboard_index.rs"]
mod fixture_dashboard_index;
#[path = "fixtures/fixture_dashboard_interaction.rs"]
mod fixture_dashboard_interaction;
#[path = "fixtures/fixture_dashboard_model_apply.rs"]
mod fixture_dashboard_model_apply;
#[path = "fixtures/fixture_dashboard_model_pending_actions.rs"]
mod fixture_dashboard_model_pending_actions;
#[path = "fixtures/fixture_dashboard_model_process_info.rs"]
mod fixture_dashboard_model_process_info;
#[path = "fixtures/fixture_dashboard_model_service.rs"]
mod fixture_dashboard_model_service;
#[path = "fixtures/fixture_dashboard_navigation.rs"]
mod fixture_dashboard_navigation;
#[path = "fixtures/fixture_dashboard_targets.rs"]
mod fixture_dashboard_targets;
#[path = "fixtures/fixture_dashboard_tui_visibility.rs"]
mod fixture_dashboard_tui_visibility;
#[path = "fixtures/fixture_dashboard_ui_state_store.rs"]
mod fixture_dashboard_ui_state_store;
#[path = "fixtures/fixture_dashboard_worktree_groups.rs"]
mod fixture_dashboard_worktree_groups;
#[path = "fixtures/fixture_desktop_state_golden.rs"]
mod fixture_desktop_state_golden;
#[path = "fixtures/fixture_error_display.rs"]
mod fixture_error_display;
#[path = "fixtures/fixture_expose_hot_snapshot.rs"]
mod fixture_expose_hot_snapshot;
#[path = "fixtures/fixture_expose_hot_snapshot_worker.rs"]
mod fixture_expose_hot_snapshot_worker;
#[path = "fixtures/fixture_expose_ordering.rs"]
mod fixture_expose_ordering;
#[path = "fixtures/fixture_expose_pane_output_tap.rs"]
mod fixture_expose_pane_output_tap;
#[path = "fixtures/fixture_graveyard_cleanup.rs"]
mod fixture_graveyard_cleanup;
#[path = "fixtures/fixture_key_parser.rs"]
mod fixture_key_parser;
#[path = "fixtures/fixture_line_editor.rs"]
mod fixture_line_editor;
#[path = "fixtures/fixture_terminal_host.rs"]
mod fixture_terminal_host;
