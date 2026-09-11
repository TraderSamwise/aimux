//! Aggregated tmux and tui fixture contracts.
//!
//! These fixture modules used to be one integration-test binary per corpus.
//! Keep them grouped by subsystem so Cargo links aimux once per subsystem
//! while preserving the same contract assertions.

#[path = "fixtures/fixture_tmux_attach_terminal_guard.rs"]
mod fixture_tmux_attach_terminal_guard;
#[path = "fixtures/fixture_tmux_client_dashboard_slot.rs"]
mod fixture_tmux_client_dashboard_slot;
#[path = "fixtures/fixture_tmux_control_script.rs"]
mod fixture_tmux_control_script;
#[path = "fixtures/fixture_tmux_doctor_contract.rs"]
mod fixture_tmux_doctor_contract;
#[path = "fixtures/fixture_tmux_exec_metrics.rs"]
mod fixture_tmux_exec_metrics;
#[path = "fixtures/fixture_tmux_expose_layout.rs"]
mod fixture_tmux_expose_layout;
#[path = "fixtures/fixture_tmux_expose_model.rs"]
mod fixture_tmux_expose_model;
#[path = "fixtures/fixture_tmux_expose_preview_sanitize.rs"]
mod fixture_tmux_expose_preview_sanitize;
#[path = "fixtures/fixture_tmux_expose_render.rs"]
mod fixture_tmux_expose_render;
#[path = "fixtures/fixture_tmux_expose_runner.rs"]
mod fixture_tmux_expose_runner;
#[path = "fixtures/fixture_tmux_interactive_exec.rs"]
mod fixture_tmux_interactive_exec;
#[path = "fixtures/fixture_tmux_managed_window_lifecycle.rs"]
mod fixture_tmux_managed_window_lifecycle;
#[path = "fixtures/fixture_tmux_query_memo.rs"]
mod fixture_tmux_query_memo;
#[path = "fixtures/fixture_tmux_replace_window.rs"]
mod fixture_tmux_replace_window;
#[path = "fixtures/fixture_tmux_runtime_manager_ops.rs"]
mod fixture_tmux_runtime_manager_ops;
#[path = "fixtures/fixture_tmux_runtime_open_target.rs"]
mod fixture_tmux_runtime_open_target;
#[path = "fixtures/fixture_tmux_runtime_session_lifecycle.rs"]
mod fixture_tmux_runtime_session_lifecycle;
#[path = "fixtures/fixture_tmux_runtime_stop.rs"]
mod fixture_tmux_runtime_stop;
#[path = "fixtures/fixture_tmux_startup_interstitials.rs"]
mod fixture_tmux_startup_interstitials;
#[path = "fixtures/fixture_tmux_statusline_render.rs"]
mod fixture_tmux_statusline_render;
#[path = "fixtures/fixture_tmux_statusline_script.rs"]
mod fixture_tmux_statusline_script;
#[path = "fixtures/fixture_tmux_sync_exec_inventory.rs"]
mod fixture_tmux_sync_exec_inventory;
#[path = "fixtures/fixture_tmux_window_open.rs"]
mod fixture_tmux_window_open;
#[path = "fixtures/fixture_tui_render_box.rs"]
mod fixture_tui_render_box;
#[path = "fixtures/fixture_tui_render_text.rs"]
mod fixture_tui_render_text;
#[path = "fixtures/fixture_tui_render_theme.rs"]
mod fixture_tui_render_theme;
#[path = "fixtures/fixture_tui_screen_renderers.rs"]
mod fixture_tui_screen_renderers;
