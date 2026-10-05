use crate::async_subprocess::AsyncCommand;
use crate::config::load_config_for_project;
use crate::core_command_contract::CORE_COMMAND_NAMES;
use crate::core_command_transport::send_core_command;
use crate::dashboard_action_progress::progress_for_request;
use crate::dashboard_actions::{
    DashboardActionKind, DashboardActionPlan, DashboardActionRequest, plan_dashboard_action,
};
use crate::dashboard_client::{
    ProjectServiceEndpoint, execute_dashboard_action, fetch_dashboard_resource,
    fetch_desktop_state, refresh_dashboard_statusline, resolve_project_service_endpoint,
};
use crate::dashboard_controller::{
    DashboardActionIdentity, DashboardController, DashboardControllerEffect, DashboardFailureAlert,
    DashboardOverseerWatchRequest, DashboardScreen, DashboardSubscreenAction,
    orchestration_targets_from_resource,
};
use crate::dashboard_event_stream::{
    DashboardEventStreamHandle, DashboardEventStreamMessage, spawn_dashboard_project_event_stream,
};
use crate::dashboard_focus::DashboardFocusState;
use crate::dashboard_launch_options::render_launch_options_overlay;
use crate::dashboard_model::{
    DesktopStateGoldenFixture, DesktopStateSnapshot, SessionStatus, filter_dashboard_visible_model,
    is_dashboard_overseer_session, is_dashboard_scribe_session,
};
use crate::dashboard_navigation::{CarriedSelection, DashboardEntryRef};
use crate::dashboard_pending_actions::{
    DashboardPendingActions, PendingTarget, pending_action_for_request,
};
use crate::dashboard_project_events::{
    DashboardProjectEvent, DashboardProjectRefreshState, dashboard_alert_flash_failed,
    dashboard_alert_footer_flash,
};
use crate::dashboard_readiness::mark_native_dashboard_ready;
use crate::dashboard_renderer::{
    DashboardFooterAlert, DashboardRenderInput, DashboardSubscreenRenderInput,
    render_dashboard_frame, render_dashboard_subscreen_frame,
};
use crate::dashboard_service_input::DashboardThreadReplyState;
use crate::dashboard_service_input::{
    render_agent_restore_confirm_overlay, render_label_input_overlay,
    render_migrate_picker_overlay, render_orchestration_input_overlay,
    render_orchestration_route_picker_overlay, render_plane_picker_overlay,
    render_remote_worktree_input_overlay, render_service_input_overlay,
    render_teammate_picker_overlay, render_thread_reply_overlay,
    render_worktree_cache_cleanup_confirm_overlay, render_worktree_input_overlay,
    render_worktree_list_overlay, render_worktree_remove_confirm_overlay,
};
use crate::dashboard_terminal::{
    DashboardTerminalGuard, consume_terminal_resize, ensure_dashboard_stdin_nonblocking,
    read_dashboard_keys, terminal_size, wait_for_dashboard_input,
};
use crate::dashboard_tool_picker::{enabled_dashboard_tools, render_tool_picker_overlay};
use crate::dashboard_tui_visibility::{
    DashboardTuiVisibilityState, consume_dashboard_tui_visibility_wake, mark_dashboard_tui_visible,
    read_dashboard_tui_visibility_for_loop, read_tmux_tui_visibility,
};
use crate::dashboard_ui_state::DashboardUiStatePersistence;
use crate::debug_logging::{LogLevel, log_at};
use crate::paths::PathResolver;
use crate::project_service::work_outline::{
    WorkOutlineEntry, WorkOutlineQuery, list_work_outline_entries,
};
use crate::release_version_contract::read_aimux_runtime_version;
use crate::repair_events::{
    ACTION_DASHBOARD_REFRESH, STATUS_FAILED, STATUS_REPAIRED, record_repair_event_for_project,
};
use crate::runtime_guard::{
    RuntimeGuardState, probe_runtime_guard, runtime_guard_overlay_copy,
    stabilize_runtime_guard_probe,
};
use crate::runtime_guard_repair::{
    RUNTIME_GUARD_REPAIR_FLAP_WINDOW_MS, RUNTIME_GUARD_REPAIR_RETRY_MS, RuntimeGuardRepairDecision,
    RuntimeGuardRepairGate, current_time_ms, runtime_guard_repair_decision,
    runtime_guard_repair_key, start_runtime_guard_repair_daemon_request,
    try_acquire_runtime_guard_repair_lock,
};
use crate::runtime_guard_repair_history::{
    clear_attempts as clear_runtime_guard_repair_attempts,
    load_attempts as load_runtime_guard_repair_attempts,
    record_attempt as record_runtime_guard_repair_attempt,
};
use crate::tmux::{TmuxRuntimeManager, tmux_command_from_env};
use crate::tui_render::theme::{Tone, recede, style};
use crate::tui_render::{OverlayBoxSpec, OverlayVariant, render_overlay_box};
use crate::tui_screen_renderers::{
    render_overseer_overlay_output, render_overseer_watch_instructions_overlay_output,
    render_work_outline_overlay_output,
};
use anyhow::{Context, Result};
use serde_json::{Map, Value, json};
use std::env;
use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::Output;
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

const DASHBOARD_KEY_POLL_INTERVAL: Duration = Duration::from_millis(50);
const DASHBOARD_HIDDEN_POLL_INTERVAL: Duration = Duration::from_millis(250);
const DASHBOARD_STREAM_RETRY_INTERVAL: Duration = Duration::from_secs(2);
const DASHBOARD_FALLBACK_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
const DASHBOARD_TERMINAL_SIZE_RECHECK_INTERVAL: Duration = Duration::from_millis(250);
const DASHBOARD_RUNTIME_GUARD_INTERVAL: Duration = Duration::from_secs(5);
/// The shortest gap between two frames a keypress asked for.
///
/// Master could not paint faster than the sleep it has replaced, so a held key
/// cost one frame per key-poll interval however fast it repeated. A cached
/// frame is cheap but not free -- it can dispatch a request and write the
/// selection -- so it keeps that ceiling. Two digits typed closer together than
/// this arrive in one read and were always one frame.
const DASHBOARD_MIN_INPUT_FRAME_GAP: Duration = DASHBOARD_KEY_POLL_INTERVAL;

/// How long after the last keypress a deferred fetch waits before it is paid.
///
/// A cached frame defers the fetch it skipped rather than cancelling it. Making
/// the very next iteration pay instead would put the cost straight back on the
/// second digit of `2` `1`.
const DASHBOARD_DEFERRED_REFRESH_BUDGET: Duration = Duration::from_millis(150);
/// And the longest it may wait however much more input keeps arriving, so a
/// held key cannot starve the data indefinitely.
const DASHBOARD_DEFERRED_REFRESH_CEILING: Duration = Duration::from_secs(1);

#[derive(Debug, Clone)]
pub struct NativeDashboardOptions {
    pub project_root: PathBuf,
    pub desktop_state_file: Option<PathBuf>,
    pub cols: usize,
    pub rows: usize,
    pub once: bool,
}

#[derive(Debug, Clone)]
pub struct DashboardSnapshotLoad {
    pub snapshot: DesktopStateSnapshot,
    pub endpoint: Option<ProjectServiceEndpoint>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardSnapshotRefreshRepairEvent {
    pub status: &'static str,
    pub error: String,
}

#[derive(Debug, Clone)]
pub enum DashboardSnapshotRefreshOutcome {
    Loaded(DashboardSnapshotLoad),
    Stale {
        snapshot: DesktopStateSnapshot,
        endpoint: Option<ProjectServiceEndpoint>,
        footer_message: String,
    },
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DashboardSnapshotRefreshFailure {
    current_error: Option<String>,
}

#[derive(Debug)]
struct DashboardRuntimeGuardStatus {
    state: RuntimeGuardState,
    disconnected_probe_count: usize,
    entered_at: Option<Instant>,
    probe_receiver: Option<Receiver<RuntimeGuardState>>,
    repair_receiver: Option<Receiver<DashboardRuntimeGuardRepairResult>>,
    repair_key: Option<String>,
    repair_failed_key: Option<String>,
    repair_retry_at_ms: Option<i64>,
    repair_error: Option<String>,
    repair_attempts: Vec<i64>,
}

impl Default for DashboardRuntimeGuardStatus {
    fn default() -> Self {
        Self {
            state: RuntimeGuardState::Ok,
            disconnected_probe_count: 0,
            entered_at: None,
            probe_receiver: None,
            repair_receiver: None,
            repair_key: None,
            repair_failed_key: None,
            repair_retry_at_ms: None,
            repair_error: None,
            repair_attempts: Vec::new(),
        }
    }
}

impl DashboardRuntimeGuardStatus {
    fn set_state(&mut self, state: RuntimeGuardState) -> bool {
        if self.state == state {
            return false;
        }
        self.entered_at = (!state.is_ok()).then(Instant::now);
        self.state = state;
        true
    }

    fn active_ms(&self) -> i64 {
        self.entered_at
            .map(|entered_at| entered_at.elapsed().as_millis().min(i64::MAX as u128) as i64)
            .unwrap_or_default()
    }

    fn repairing(&self) -> bool {
        self.repair_receiver.is_some()
    }

    fn probing(&self) -> bool {
        self.probe_receiver.is_some()
    }

    fn repair_failed_for_current_state(&self) -> bool {
        self.repair_failed_key
            .as_deref()
            .is_some_and(|key| key == runtime_guard_repair_key(&self.state))
    }
}

#[derive(Debug)]
struct DashboardRuntimeGuardRepairResult {
    repair_key: String,
    state: RuntimeGuardState,
    result: Result<Value, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DashboardViewport {
    cols: usize,
    rows: usize,
}

#[derive(Debug, Clone, Copy)]
struct DashboardSnapshotRenderContext<'a> {
    viewport: DashboardViewport,
    endpoint: Option<&'a ProjectServiceEndpoint>,
    hidden_offline_agent_count: usize,
    scroll_offset: usize,
    runtime_guard: Option<&'a DashboardRuntimeGuardStatus>,
    refresh_error: Option<&'a str>,
    /// Why the project event stream is down, while it is.
    stream_error: Option<&'a str>,
    pending_now_ms: i64,
}

impl DashboardViewport {
    fn key(self) -> String {
        format!("{}x{}", self.cols, self.rows)
    }
}

#[derive(Debug, Default)]
struct DashboardViewportState {
    last_size: Option<DashboardViewport>,
    pending_expanded_size: Option<DashboardViewport>,
    pending_expanded_count: usize,
}

impl DashboardViewportState {
    fn get_viewport_size(&mut self, fallback: DashboardViewport) -> DashboardViewport {
        let target = dashboard_tmux_pane_target();
        if let Some(tmux_pane) = target.as_deref()
            && let Some(size) = read_tmux_dashboard_pane_size(tmux_pane)
        {
            if let Some(previous) = self.last_size {
                let expands = size.cols > previous.cols || size.rows > previous.rows;
                if expands {
                    let same_pending = self.pending_expanded_size == Some(size);
                    self.pending_expanded_size = Some(size);
                    self.pending_expanded_count = if same_pending {
                        self.pending_expanded_count + 1
                    } else {
                        1
                    };
                    if self.pending_expanded_count < 2 {
                        return previous;
                    }
                } else {
                    self.pending_expanded_size = None;
                    self.pending_expanded_count = 0;
                }
            }
            self.last_size = Some(size);
            self.pending_expanded_size = None;
            self.pending_expanded_count = 0;
            return size;
        }

        if target.is_some()
            && let Some(size) = self.last_size
        {
            return size;
        }

        let size = terminal_size()
            .map(|(cols, rows)| DashboardViewport { cols, rows })
            .unwrap_or(fallback);
        self.last_size = Some(size);
        size
    }
}

pub fn run_native_dashboard_internal(options: NativeDashboardOptions) -> Result<()> {
    let mut controller: Option<DashboardController> = None;
    let mut focus_state = DashboardFocusState::default();
    let mut ready_marked = false;
    let mut scroll_offset = 0;
    let mut latest_snapshot = None;
    let mut latest_endpoint = None;
    let mut latest_hidden_offline_agent_count = 0;
    let mut refresh_failure = DashboardSnapshotRefreshFailure::default();
    let mut pending_actions = DashboardPendingActions::new();
    let mut deferred_requests: Vec<DeferredDashboardRequest> = Vec::new();
    let (request_outcomes_tx, request_outcomes_rx) = mpsc::channel::<DashboardRequestOutcome>();
    let mut ui_state = if options.once || options.desktop_state_file.is_some() {
        None
    } else {
        DashboardUiStatePersistence::for_project(&options.project_root).ok()
    };
    // The dashboard render loop stays synchronous: it owns the foreground
    // terminal, key polling, and redraw cadence. The project SSE reader is the
    // narrow async seam and feeds this loop through a bounded channel.
    let mut event_stream = None;
    let mut event_stream_retry_at = None;
    // Why the event stream is down, while it is. Derived rather than stored on
    // the controller, so the reconnect that makes it false also removes it.
    let mut event_stream_down: Option<String> = None;
    let mut event_stream_health = DashboardStreamHealth::default();
    let mut refresh_state = DashboardProjectRefreshState::default();
    let mut visibility_state = DashboardTuiVisibilityState {
        started_in_dashboard: !options.once && options.desktop_state_file.is_none(),
        ..DashboardTuiVisibilityState::default()
    };
    let mut runtime_guard = DashboardRuntimeGuardStatus::default();
    let mut last_runtime_guard_probe = Instant::now() - DASHBOARD_RUNTIME_GUARD_INTERVAL;
    let mut render_now = true;
    // When the first cached frame deferred a fetch. Cleared by the refresh that
    // pays it back; while it is set and inside budget, more cached frames may
    // go up, so a run of keypresses is not one blocking fetch per key.
    let mut refresh_deferred_since: Option<Instant> = None;
    // Pushed forward by every cached frame, so a run of keys stays on the fast
    // path and the fetch lands in the gap after it rather than inside it.
    let mut last_cached_frame_at: Option<Instant> = None;

    let mut pending_selection: Option<String> = None;
    let mut rendered_once = false;
    let mut viewport = DashboardViewport {
        cols: options.cols,
        rows: options.rows,
    };
    let live_dashboard = !options.once && options.desktop_state_file.is_none();
    // A live dashboard does not guarantee a terminal: `aimux` with no arguments
    // runs one on whatever stdin it inherited. On a file, /dev/null or a closed
    // pipe `poll` reports readable forever and the read behind it yields
    // nothing, so those keep sleeping.
    let wait_on_stdin = live_dashboard && io::stdin().is_terminal();
    let mut dashboard_ready_since: Option<Instant> = None;
    let mut viewport_state = DashboardViewportState::default();
    if live_dashboard {
        viewport = viewport_state.get_viewport_size(viewport);
    }
    let mut last_viewport_key = viewport.key();
    let mut last_tmux_viewport_check = Instant::now() - DASHBOARD_TERMINAL_SIZE_RECHECK_INTERVAL;
    let mut last_render_viewport_check = Instant::now() - DASHBOARD_KEY_POLL_INTERVAL;
    let mut last_render = Instant::now();
    let clock_start = Instant::now();
    let mut output = dashboard_output(options.once);
    let mut stdin = io::stdin();
    let _terminal = if options.once {
        None
    } else {
        Some(DashboardTerminalGuard::enter(&mut *output).context("enter dashboard terminal")?)
    };

    // A cached frame writes the selection but does not publish it, so the
    // refresh behind it has nothing left to report and would never tell the
    // statusline. The debt is carried rather than lost.
    let mut statusline_dirty = false;
    // Carried across iterations, not reset per pass: a frame a keypress asked
    // for can be held back to keep the frame gap, and when it lands it is still
    // that keypress's frame. Both are cleared by the render that serves them.
    let mut render_requested_by_input = false;
    let mut cacheable_input = true;
    loop {
        // Any reason to repaint that is not a keypress. A cached frame holds
        // none of it, so each one sends this iteration down the refresh path.
        let mut render_requested_by_data = false;
        let now = elapsed_millis(clock_start);
        let first_paint_pending = render_now && !rendered_once;
        let mut dashboard_visible = if first_paint_pending {
            true
        } else if visibility_state.started_in_dashboard {
            read_dashboard_tui_visibility_for_loop(
                &mut visibility_state,
                now,
                read_tmux_tui_visibility,
            )
            .visible
        } else {
            true
        };
        ensure_dashboard_stdin_nonblocking().context("keep dashboard stdin nonblocking")?;
        let keys = read_dashboard_keys(&mut stdin).context("read dashboard key")?;
        if !keys.is_empty() {
            mark_dashboard_tui_visible(&mut visibility_state, now, None);
            dashboard_visible = true;
        }
        let terminal_resized = live_dashboard && consume_terminal_resize();
        if terminal_resized {
            viewport = viewport_state.get_viewport_size(viewport);
            last_viewport_key = viewport.key();
            render_now = true;
            render_requested_by_data = true;
            dashboard_visible = true;
        }
        if live_dashboard {
            let measured_viewport =
                if last_tmux_viewport_check.elapsed() >= DASHBOARD_TERMINAL_SIZE_RECHECK_INTERVAL {
                    last_tmux_viewport_check = Instant::now();
                    Some(viewport_state.get_viewport_size(viewport))
                } else {
                    None
                };
            if let Some(next_viewport) = measured_viewport
                && next_viewport.key() != last_viewport_key
            {
                viewport = next_viewport;
                last_viewport_key = viewport.key();
                render_now = true;
                render_requested_by_data = true;
                dashboard_visible = true;
            }
        }
        if !dashboard_visible {
            suspend_dashboard_event_stream(
                &mut event_stream,
                &mut event_stream_retry_at,
                &mut event_stream_down,
                &mut event_stream_health,
            );
            thread::sleep(DASHBOARD_HIDDEN_POLL_INTERVAL);
            continue;
        }
        if consume_dashboard_tui_visibility_wake(&mut visibility_state) {
            // Coming back from an agent points the selection at that agent, so
            // the row you left is the row you return to.
            pending_selection = previous_window_session_id();
            render_now = true;
            render_requested_by_data = true;
        }
        if drain_dashboard_event_stream(
            &mut event_stream,
            &mut event_stream_retry_at,
            &mut event_stream_down,
            &mut event_stream_health,
            &mut refresh_state,
            controller
                .as_ref()
                .map(|controller| controller.screen.as_str()),
            controller.as_mut(),
        ) {
            render_now = true;
            render_requested_by_data = true;
        }
        // Consumed here, so it must reach `complete_refresh`: the flag latches
        // `refresh_in_flight` and nothing else clears it, which would wedge
        // every later event-driven refresh behind a frame that never refreshed.
        if refresh_state.take_refresh_request() {
            render_now = true;
            render_requested_by_data = true;
        }
        if drain_dashboard_request_outcomes(
            &request_outcomes_rx,
            &mut pending_actions,
            controller.as_mut(),
        ) {
            render_now = true;
            render_requested_by_data = true;
        }
        if pending_action_reconcile_due(&pending_actions, now) {
            render_now = true;
            render_requested_by_data = true;
        }
        reconcile_dashboard_event_stream(
            &mut event_stream,
            &mut event_stream_retry_at,
            &mut event_stream_down,
            &mut event_stream_health,
            latest_endpoint.as_ref(),
            options.once || options.desktop_state_file.is_some(),
        );
        if poll_dashboard_runtime_guard_repair(&mut runtime_guard, &options.project_root) {
            render_now = true;
            render_requested_by_data = true;
        }
        if poll_dashboard_runtime_guard_probe(
            &mut runtime_guard,
            &options.project_root,
            &mut last_runtime_guard_probe,
        ) {
            render_now = true;
            render_requested_by_data = true;
        }
        if should_probe_dashboard_runtime_guard(
            live_dashboard,
            dashboard_ready_since.map(|ready_since| ready_since.elapsed()),
            last_runtime_guard_probe.elapsed(),
            runtime_guard.probing(),
        ) {
            start_dashboard_runtime_guard_probe(&mut runtime_guard, &options.project_root);
        }
        if rendered_once && !keys.is_empty() {
            mark_dashboard_tui_visible(&mut visibility_state, elapsed_millis(clock_start), None);
            let Some(snapshot) = latest_snapshot.as_ref() else {
                render_now = true;
                wait_for_dashboard_keys(wait_on_stdin);
                continue;
            };
            let controller = controller.get_or_insert_with(|| DashboardController::new(snapshot));
            let keys = keys
                .into_iter()
                .filter(|key| !key.is_focus_in())
                .collect::<Vec<_>>();
            let is_coalesced_input = keys.len() > 1;
            for key in keys {
                let before_surface = controller.input_surface();
                let before_hide_offline = controller.hide_offline_agents;
                let effect = controller.handle_key(snapshot, key);
                if controller.hide_offline_agents != before_hide_offline {
                    cacheable_input = false;
                }
                let stop_after_key = is_coalesced_input
                    && controller.should_stop_coalesced_input(before_surface, &effect);
                match effect {
                    DashboardControllerEffect::Quit => return Ok(()),
                    DashboardControllerEffect::Request(request) => {
                        let action = DashboardActionIdentity::of(&request);
                        // Record the overlay now but send the request after the
                        // frame is written: the round trip blocks, and the first
                        // refresh after it already reports the settled state, so
                        // sending first means the overlay never reaches a frame.
                        let pending = pending_action_for_request(request.path, &request.body).map(
                            |(target, id, kind)| {
                                let token = match target {
                                    PendingTarget::Session => pending_actions.set_session_action(
                                        &id,
                                        &kind,
                                        pending_action_now_ms(clock_start),
                                    ),
                                    PendingTarget::Service => pending_actions.set_service_action(
                                        &id,
                                        &kind,
                                        pending_action_now_ms(clock_start),
                                    ),
                                    PendingTarget::Worktree => pending_actions.set_worktree_action(
                                        Some(id.as_str()),
                                        &kind,
                                        pending_action_now_ms(clock_start),
                                    ),
                                };
                                (target, id, token)
                            },
                        );
                        // A route that makes something has no row to paint, so
                        // its only report is the footer. Built from the same
                        // path and body `flush_deferred_dashboard_requests`
                        // identifies the action by, so this note is taken down
                        // by its own outcome and by nobody else's.
                        if let Some(message) = progress_for_request(request.path, &request.body) {
                            controller.set_progress(message, action);
                            // The row this makes does not exist yet, so the
                            // frame that shows it has to be a fresh one: the
                            // server publishes the new row as pending, and the
                            // cached snapshot predates it.
                            cacheable_input = false;
                        }
                        // An overlay has to reach a frame, and only a freshly
                        // loaded snapshot carries one. A request without an
                        // overlay -- attaching to an agent is the common one --
                        // has nothing to show and keeps the fast path.
                        if pending.is_some() {
                            cacheable_input = false;
                        }
                        deferred_requests.push((request, pending));
                        render_now = true;
                        render_requested_by_input = true;
                    }
                    DashboardControllerEffect::MoveSelectedEntry {
                        kind,
                        worktree_path,
                        selected_id,
                        direction,
                        sessions,
                        services,
                        next_item_index,
                    } => {
                        if let Some(ui_state) = ui_state.as_ref() {
                            match ui_state.move_entry_within_worktree(
                                kind.as_str(),
                                worktree_path.as_deref(),
                                &selected_id,
                                direction.as_str(),
                                &sessions,
                                &services,
                            ) {
                                Ok(true) => {
                                    controller.navigation.item_index = next_item_index;
                                    controller.set_note(format!(
                                        "Moved {} {}",
                                        kind.display_label(),
                                        direction.as_str()
                                    ));
                                    if let Some(endpoint) = latest_endpoint.as_ref() {
                                        let _ = refresh_dashboard_statusline(
                                            endpoint,
                                            ui_state.client_session(),
                                        );
                                    }
                                }
                                Ok(false) => {
                                    controller.set_note("Already at edge".into());
                                }
                                Err(error) => {
                                    controller.footer_alert =
                                        Some(DashboardFailureAlert::local(error.to_string()));
                                }
                            }
                        } else {
                            controller.footer_alert = Some(DashboardFailureAlert::local(
                                "Dashboard ordering unavailable",
                            ));
                        }
                        render_now = true;
                        render_requested_by_input = true;
                        cacheable_input = false;
                    }
                    DashboardControllerEffect::WorktreeCacheCleanupPreview(request) => {
                        if let Some(endpoint) = latest_endpoint.as_ref() {
                            match execute_dashboard_controller_action(endpoint, &request)
                                .and_then(cache_cleanup_result_from_response)
                            {
                                Ok(result) => {
                                    controller.worktree_cache_cleanup_confirm = Some(result);
                                }
                                Err(error) => {
                                    controller.footer_alert =
                                        Some(DashboardFailureAlert::local(error.to_string()));
                                }
                            }
                        } else {
                            controller.footer_alert = Some(DashboardFailureAlert::local(
                                "Dashboard action requires a project-service endpoint",
                            ));
                        }
                        render_now = true;
                        render_requested_by_input = true;
                        cacheable_input = false;
                    }
                    DashboardControllerEffect::WorktreeCacheCleanupApply(request) => {
                        if let Some(endpoint) = latest_endpoint.as_ref() {
                            match execute_dashboard_controller_action(endpoint, &request)
                                .and_then(cache_cleanup_result_from_response)
                            {
                                Ok(result) => {
                                    let (message, failed) = worktree_cache_cleanup_summary(&result);
                                    if failed {
                                        controller.footer_alert =
                                            Some(DashboardFailureAlert::local(message));
                                    } else {
                                        controller.set_note(message);
                                    }
                                }
                                Err(error) => {
                                    controller.footer_alert =
                                        Some(DashboardFailureAlert::local(error.to_string()));
                                }
                            }
                        } else {
                            controller.footer_alert = Some(DashboardFailureAlert::local(
                                "Dashboard action requires a project-service endpoint",
                            ));
                        }
                        render_now = true;
                        render_requested_by_input = true;
                        cacheable_input = false;
                    }
                    DashboardControllerEffect::LoadOrchestrationRoutes { mode, path } => {
                        if let Some(endpoint) = latest_endpoint.as_ref() {
                            match fetch_dashboard_resource(endpoint, &path).and_then(|resource| {
                                orchestration_targets_from_resource(&resource)
                                    .map_err(anyhow::Error::msg)
                            }) {
                                Ok(options) => {
                                    controller.set_orchestration_route_options(mode, options);
                                }
                                Err(error) => {
                                    controller.footer_alert = Some(DashboardFailureAlert::local(
                                        format!("Failed to load orchestration targets: {error}"),
                                    ));
                                }
                            }
                        } else {
                            controller.footer_alert = Some(DashboardFailureAlert::local(
                                "Dashboard action requires a project-service endpoint",
                            ));
                        }
                        render_now = true;
                        render_requested_by_input = true;
                        cacheable_input = false;
                    }
                    DashboardControllerEffect::OpenRelevantThread { session_id } => {
                        if let Some(endpoint) = latest_endpoint.as_ref() {
                            if let Err(error) =
                                open_relevant_thread_for_session(endpoint, controller, &session_id)
                            {
                                controller.footer_alert =
                                    Some(DashboardFailureAlert::local(error.to_string()));
                            }
                        } else {
                            controller.footer_alert = Some(DashboardFailureAlert::local(
                                "Dashboard action requires a project-service endpoint",
                            ));
                        }
                        render_now = true;
                        render_requested_by_input = true;
                        cacheable_input = false;
                    }
                    DashboardControllerEffect::LoadWorkOutlineOverlay { session_id, offset } => {
                        let entries =
                            load_work_outline_overlay_entries(&options, session_id.as_deref());
                        controller.set_work_outline_overlay_with_offset(
                            session_id,
                            entries,
                            offset.unwrap_or(0),
                        );
                        render_now = true;
                        render_requested_by_input = true;
                        cacheable_input = false;
                    }
                    DashboardControllerEffect::WatchWithOverseer(request) => {
                        match execute_overseer_watch_command(&options, controller, &request) {
                            Ok(()) => {}
                            Err(error) => {
                                controller.footer_alert = Some(DashboardFailureAlert::local(
                                    format!("Overseer update failed: {error}"),
                                ));
                            }
                        }
                        render_now = true;
                        render_requested_by_input = true;
                        cacheable_input = false;
                    }
                    DashboardControllerEffect::OpenAgentToolPicker(mode) => {
                        let config = load_config_for_project(&options.project_root);
                        controller.open_tool_picker(enabled_dashboard_tools(&config), mode);
                        render_now = true;
                        render_requested_by_input = true;
                        cacheable_input = false;
                    }
                    DashboardControllerEffect::Render => {
                        render_now = true;
                        render_requested_by_input = true;
                    }
                    DashboardControllerEffect::Ignored => {}
                }
                if stop_after_key {
                    break;
                }
            }
        }

        // Read rather than taken: the two `continue` paths above skip rendering
        // entirely, and a deferral a hidden frame consumed would leave the
        // dashboard on cached data until the thirty-second fallback.
        let forced_refresh = dashboard_refresh_deferral_expired(
            refresh_deferred_since.map(|at| at.elapsed()),
            last_cached_frame_at.map(|at| at.elapsed()),
            controller
                .as_ref()
                .is_some_and(|controller| !controller.navigation.quick_jump_digits.is_empty()),
        );
        // Held rather than dropped: `render_now` stays set, so the frame goes
        // up on the next pass. Master could not paint faster than the sleep
        // this replaced, and a frame is not free -- it can dispatch a request
        // and write the selection -- so a held key keeps that ceiling instead
        // of paying it at the autorepeat rate.
        let too_soon_for_another_frame = dashboard_frame_held_back(
            render_now && render_requested_by_input,
            render_requested_by_data || forced_refresh,
            last_render.elapsed(),
        );
        let render_due = !too_soon_for_another_frame
            && (render_now
                || forced_refresh
                || last_render.elapsed() >= DASHBOARD_FALLBACK_REFRESH_INTERVAL);
        if render_due {
            // Its own clock, not the 250ms one above: that one has already run
            // this iteration, so sharing it would silence this measurement
            // entirely rather than pace it -- and a grown pane needs two
            // readings in a row before it is believed. The interval is the old
            // ceiling of one reading per loop iteration, kept now that keys
            // rather than a sleep decide how often the loop comes round.
            if live_dashboard && last_render_viewport_check.elapsed() >= DASHBOARD_KEY_POLL_INTERVAL
            {
                last_render_viewport_check = Instant::now();
                viewport = viewport_state.get_viewport_size(viewport);
            }
            let render_source = dashboard_render_source(DashboardRenderSourceInput {
                has_snapshot: latest_snapshot.is_some(),
                rendered_once,
                render_requested: render_now,
                screen: controller
                    .as_ref()
                    .map(|controller| controller.screen)
                    .unwrap_or(DashboardScreen::Dashboard),
                input_driven: render_now && render_requested_by_input,
                cacheable_input,
                render_from_data: render_requested_by_data,
                selection_move_pending: pending_selection.is_some(),
                forced_refresh,
            });
            let cached_snapshot = latest_snapshot
                .as_ref()
                .filter(|_| render_source == DashboardRenderSource::CachedSnapshot);
            let rendered_from_cached_snapshot = if let (Some(snapshot), Some(controller)) =
                (cached_snapshot, controller.as_mut())
            {
                // The same sentence the refresh path puts up when a load fails,
                // so a cached frame does not quietly drop the staleness banner.
                let cached_refresh_error = refresh_failure
                    .current_error
                    .as_deref()
                    .map(dashboard_snapshot_refresh_footer);
                let frame = render_dashboard_snapshot(
                    &options,
                    controller,
                    snapshot,
                    &mut pending_actions,
                    DashboardSnapshotRenderContext {
                        viewport,
                        endpoint: latest_endpoint.as_ref(),
                        hidden_offline_agent_count: latest_hidden_offline_agent_count,
                        scroll_offset,
                        runtime_guard: Some(&runtime_guard),
                        refresh_error: cached_refresh_error.as_deref(),
                        stream_error: event_stream_down.as_deref(),
                        pending_now_ms: pending_action_now_ms(clock_start),
                    },
                );
                write_dashboard_frame(&mut *output, frame.frame.as_bytes())?;
                rendered_once = true;
                // Written by the frame rather than left to the refresh behind
                // it, because attaching hides this dashboard: the loop then
                // renders nothing at all until the user comes back, and a
                // selection left unwritten is the selection they do not return
                // to. The screen is written here too, and this is the only
                // frame a subscreen gets.
                //
                // The write is four fsyncs, so what keeps a held key from
                // paying them at the autorepeat rate is the frame gap above,
                // which is the ceiling the old sleep gave this loop. Narrowing
                // it to frames that dispatch something was the wrong lever: it
                // silenced every subscreen and every move made while the
                // project service was down.
                if let Some(ui_state) = ui_state.as_mut()
                    && ui_state
                        .persist_controller_state(
                            controller.screen,
                            &controller.preview_source,
                            controller.details_sidebar_visible,
                            snapshot,
                            &controller.navigation,
                        )
                        .unwrap_or(false)
                {
                    statusline_dirty = true;
                }
                // Published from here only when nothing else will. A frame
                // that is dispatching can hide this dashboard before the
                // refresh behind it runs, and a subscreen has no refresh
                // behind it at all, because only the dashboard screen defers
                // one.
                //
                // Every other move waits for that refresh, which is not
                // politeness: `statusline/refresh` invalidates the runtime
                // view, `desktop-state` is in it, and the event comes back to
                // this dashboard as a reason to fetch. Publishing per keypress
                // would hand back, one round trip later, exactly the fetch the
                // frame was cheap for skipping. A subscreen pays nothing for
                // the exception: it writes its screen once on arrival and
                // reports no change after, so scrolling one republishes
                // nothing.
                let nothing_else_will_publish_it = dashboard_frame_must_publish_statusline(
                    !deferred_requests.is_empty(),
                    controller.screen,
                );
                if nothing_else_will_publish_it
                    && statusline_dirty
                    && let (Some(endpoint), Some(ui_state)) =
                        (latest_endpoint.as_ref(), ui_state.as_ref())
                {
                    statusline_dirty = false;
                    // Off-thread: this is a POST, and the point of this frame
                    // is that it did not wait for one.
                    let endpoint = endpoint.clone();
                    let client_session = ui_state.client_session().to_owned();
                    thread::spawn(move || {
                        let _ = refresh_dashboard_statusline(&endpoint, &client_session);
                    });
                }
                scroll_offset = frame.scroll_offset;
                render_now = false;
                render_requested_by_input = false;
                cacheable_input = true;
                // Only the dashboard screen skipped a fetch that would
                // otherwise have happened. A subscreen renders its own
                // resource and never refreshed on input, so it is left alone.
                if controller.screen == DashboardScreen::Dashboard {
                    last_cached_frame_at = Some(Instant::now());
                    refresh_deferred_since.get_or_insert_with(Instant::now);
                }
                last_render = Instant::now();
                true
            } else {
                false
            };
            if rendered_from_cached_snapshot {
                flush_deferred_dashboard_requests(
                    &mut deferred_requests,
                    latest_endpoint.as_ref(),
                    &mut pending_actions,
                    controller.as_mut(),
                    &request_outcomes_tx,
                );
            } else {
                let refresh = resolve_dashboard_snapshot_refresh(
                    latest_snapshot.as_ref(),
                    latest_endpoint.as_ref(),
                    &mut refresh_failure,
                    load_dashboard_snapshot(&options),
                    |event| {
                        record_dashboard_snapshot_refresh_repair_event(
                            &PathResolver::from_env(),
                            &options.project_root,
                            &event,
                        );
                    },
                )?;
                match refresh {
                    DashboardSnapshotRefreshOutcome::Loaded(mut loaded) => {
                        if let Some(ui_state) = ui_state.as_ref() {
                            ui_state.apply_order_to_snapshot(&mut loaded.snapshot);
                        }
                        pending_actions
                            .reconcile(&loaded.snapshot, pending_action_now_ms(clock_start));
                        pending_actions.apply(&mut loaded.snapshot);
                        let hide_offline_agents = controller
                            .as_ref()
                            .map(|controller| controller.hide_offline_agents)
                            .unwrap_or(false);
                        let visible_model =
                            filter_dashboard_visible_model(&loaded.snapshot, hide_offline_agents);
                        // Read off the outgoing snapshot, before anything can
                        // move the indices, so the pointer can be put back on
                        // the same agent once this one is in place.
                        let carried_selection = carried_dashboard_selection(
                            controller.as_ref(),
                            latest_snapshot.as_ref(),
                        );
                        let controller = controller.get_or_insert_with(|| {
                            let mut controller = DashboardController::new(&visible_model.snapshot);
                            if let Some(screen) = ui_state
                                .as_ref()
                                .and_then(DashboardUiStatePersistence::load_screen)
                            {
                                controller.screen = screen;
                            }
                            if let Some(preview_source) = ui_state
                                .as_ref()
                                .and_then(DashboardUiStatePersistence::load_preview_source)
                            {
                                controller.set_preview_source(preview_source);
                            }
                            if let Some(details_visible) = ui_state
                                .as_ref()
                                .and_then(DashboardUiStatePersistence::load_details_sidebar_visible)
                            {
                                controller.details_sidebar_visible = details_visible;
                            }
                            if let Some(ui_state) = ui_state.as_ref() {
                                ui_state.restore_navigation(
                                    &mut controller.navigation,
                                    &visible_model.snapshot,
                                );
                            }
                            controller
                        });
                        restore_dashboard_navigation_for_render(
                            ui_state.as_ref(),
                            controller,
                            &visible_model.snapshot,
                            render_requested_by_input,
                            rendered_once,
                        );
                        if let Some(carried) = carried_selection {
                            controller
                                .navigation
                                .follow_selection(&visible_model.snapshot, &carried);
                        }
                        // After the restore, so returning from an agent wins
                        // over whatever the last persisted selection was.
                        if let Some(session_id) = pending_selection.take() {
                            controller
                                .navigation
                                .select_session(&visible_model.snapshot, &session_id);
                        }
                        let frame = render_dashboard_snapshot(
                            &options,
                            controller,
                            &visible_model.snapshot,
                            &mut pending_actions,
                            DashboardSnapshotRenderContext {
                                viewport,
                                endpoint: loaded.endpoint.as_ref(),
                                hidden_offline_agent_count: visible_model
                                    .hidden_offline_agent_count,
                                scroll_offset,
                                runtime_guard: Some(&runtime_guard),
                                refresh_error: None,
                                stream_error: event_stream_down.as_deref(),
                                pending_now_ms: pending_action_now_ms(clock_start),
                            },
                        );
                        write_dashboard_frame(&mut *output, frame.frame.as_bytes())?;
                        rendered_once = true;
                        flush_deferred_dashboard_requests(
                            &mut deferred_requests,
                            loaded.endpoint.as_ref(),
                            &mut pending_actions,
                            Some(controller),
                            &request_outcomes_tx,
                        );
                        let carried_statusline = std::mem::take(&mut statusline_dirty);
                        let statusline_client_session = ui_state.as_mut().and_then(|ui_state| {
                            dashboard_statusline_due(
                                ui_state
                                    .persist_controller_state(
                                        controller.screen,
                                        &controller.preview_source,
                                        controller.details_sidebar_visible,
                                        &visible_model.snapshot,
                                        &controller.navigation,
                                    )
                                    .unwrap_or(false),
                                carried_statusline,
                            )
                            .then(|| ui_state.client_session().to_owned())
                        });
                        if let (Some(endpoint), Some(client_session)) = (
                            loaded.endpoint.as_ref(),
                            statusline_client_session.as_deref(),
                        ) {
                            let _ = refresh_dashboard_statusline(endpoint, client_session);
                        }
                        scroll_offset = frame.scroll_offset;
                        if !ready_marked {
                            match mark_native_dashboard_ready(&options.project_root) {
                                Ok(true) => {
                                    ready_marked = true;
                                    dashboard_ready_since = Some(Instant::now());
                                }
                                Ok(false) => {}
                                Err(error) => {
                                    eprintln!("dashboard ready marker failed: {error}");
                                }
                            }
                        }
                        latest_hidden_offline_agent_count =
                            visible_model.hidden_offline_agent_count;
                        latest_snapshot = Some(visible_model.snapshot);
                        latest_endpoint = loaded.endpoint;
                        render_requested_by_input = false;
                        cacheable_input = true;
                        refresh_deferred_since = None;
                        last_cached_frame_at = None;
                        refresh_state.complete_refresh();
                        reconcile_dashboard_event_stream(
                            &mut event_stream,
                            &mut event_stream_retry_at,
                            &mut event_stream_down,
                            &mut event_stream_health,
                            latest_endpoint.as_ref(),
                            options.once || options.desktop_state_file.is_some(),
                        );
                        let focus_render = if let (Some(snapshot), Some(endpoint)) =
                            (latest_snapshot.as_ref(), latest_endpoint.as_ref())
                        {
                            sync_dashboard_focus(&mut focus_state, controller, snapshot, endpoint)
                        } else {
                            false
                        };
                        render_now = focus_render;
                        last_render = Instant::now();
                        if options.once {
                            return Ok(());
                        }
                    }
                    DashboardSnapshotRefreshOutcome::Stale {
                        mut snapshot,
                        endpoint,
                        footer_message,
                    } => {
                        pending_actions.apply(&mut snapshot);
                        let controller =
                            controller.get_or_insert_with(|| DashboardController::new(&snapshot));
                        let frame = render_dashboard_snapshot(
                            &options,
                            controller,
                            &snapshot,
                            &mut pending_actions,
                            DashboardSnapshotRenderContext {
                                viewport,
                                endpoint: endpoint.as_ref(),
                                hidden_offline_agent_count: latest_hidden_offline_agent_count,
                                scroll_offset,
                                runtime_guard: Some(&runtime_guard),
                                refresh_error: Some(&footer_message),
                                stream_error: event_stream_down.as_deref(),
                                pending_now_ms: pending_action_now_ms(clock_start),
                            },
                        );
                        write_dashboard_frame(&mut *output, frame.frame.as_bytes())?;
                        rendered_once = true;
                        flush_deferred_dashboard_requests(
                            &mut deferred_requests,
                            endpoint.as_ref(),
                            &mut pending_actions,
                            Some(controller),
                            &request_outcomes_tx,
                        );
                        scroll_offset = frame.scroll_offset;
                        if !ready_marked {
                            match mark_native_dashboard_ready(&options.project_root) {
                                Ok(true) => {
                                    ready_marked = true;
                                    dashboard_ready_since = Some(Instant::now());
                                }
                                Ok(false) => {}
                                Err(error) => {
                                    eprintln!("dashboard ready marker failed: {error}");
                                }
                            }
                        }
                        render_requested_by_input = false;
                        cacheable_input = true;
                        refresh_deferred_since = None;
                        last_cached_frame_at = None;
                        refresh_state.complete_refresh();
                        reconcile_dashboard_event_stream(
                            &mut event_stream,
                            &mut event_stream_retry_at,
                            &mut event_stream_down,
                            &mut event_stream_health,
                            latest_endpoint.as_ref(),
                            options.once || options.desktop_state_file.is_some(),
                        );
                        render_now = false;
                        last_render = Instant::now();
                    }
                }
            }
        }
        wait_for_dashboard_keys(wait_on_stdin);
    }
}

/// Hold the loop for one key-poll interval, waking early if a key arrives.
fn wait_for_dashboard_keys(wait_on_stdin: bool) {
    if wait_on_stdin {
        wait_for_dashboard_input(DASHBOARD_KEY_POLL_INTERVAL);
    } else {
        thread::sleep(DASHBOARD_KEY_POLL_INTERVAL);
    }
}

/// Where this frame's data comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DashboardRenderSource {
    /// The snapshot already in hand. Nothing is fetched, so the frame is on
    /// screen in the time it takes to compose it.
    CachedSnapshot,
    /// Fetch `desktop-state` first. Every frame carrying new data takes this.
    Refresh,
}

/// A keypress that only moves the pointer needs no new data, and making it wait
/// for a round trip is what `2` `1` felt like: two fetches before the agent is
/// attached, one per digit.
///
/// A frame nothing asked for is the fallback tick, which exists precisely to go
/// and look -- so it fetches however long a subscreen has been sitting there.
///
/// Everything else that could make the held snapshot the wrong thing to paint
/// takes `Refresh` too, because a cached frame cannot show what it does not
/// hold:
/// a new optimistic overlay, a reordered row, a changed offline filter, data
/// that has just arrived, or a pointer the loop is about to move itself.
#[derive(Debug, Clone, Copy)]
struct DashboardRenderSourceInput {
    has_snapshot: bool,
    rendered_once: bool,
    render_requested: bool,
    screen: DashboardScreen,
    input_driven: bool,
    cacheable_input: bool,
    render_from_data: bool,
    selection_move_pending: bool,
    forced_refresh: bool,
}

/// Whether this cached frame has to publish the statusline itself, rather than
/// leaving it to the refresh it deferred.
///
/// Leaving it is the default and it is the cheap one, because
/// `statusline/refresh` invalidates the runtime view -- `desktop-state` is in
/// it -- so the POST comes back to this dashboard as a reason to fetch. Doing
/// it per keypress hands back, one round trip later, exactly the fetch the
/// frame was cheap for skipping.
///
/// Two frames have nobody to leave it to. One that is dispatching can hide
/// this dashboard before the refresh behind it runs. And a subscreen has no
/// refresh behind it at all, since only the dashboard screen defers one -- a
/// subscreen that left it would keep the tab bar pointing at Dashboard for as
/// long as the user stayed.
fn dashboard_frame_must_publish_statusline(dispatching: bool, screen: DashboardScreen) -> bool {
    dispatching || screen != DashboardScreen::Dashboard
}

/// Whether the tmux statusline still has to be told about a persisted change.
///
/// Not the persist's own answer alone. A cached frame writes the same state a
/// moment earlier, so by the time the refresh behind it persists there is
/// nothing left to report -- and the move that caused both would never be
/// published.
fn dashboard_statusline_due(persisted_change: bool, carried_from_cached_frame: bool) -> bool {
    persisted_change || carried_from_cached_frame
}

/// Whether a frame a keypress asked for should wait a moment longer.
///
/// Held, never dropped -- the reason it was asked for outlives the pass, so the
/// frame goes up on the next one. Master could not paint faster than the sleep
/// this replaced, and a frame is not free: it can dispatch a request, spawn the
/// thread that sends it, and write the selection to disk. A key repeating sixty
/// times a second would otherwise pay all of that sixty times a second.
///
/// Only an input frame waits. Data arriving and a fetch coming due are not the
/// user's keyboard and are already paced by their own clocks.
fn dashboard_frame_held_back(
    requested_by_input: bool,
    requested_by_anything_else: bool,
    since_last_frame: Duration,
) -> bool {
    requested_by_input
        && !requested_by_anything_else
        && since_last_frame < DASHBOARD_MIN_INPUT_FRAME_GAP
}

/// Whether a deferred fetch has waited long enough that the next frame must
/// pay it.
///
/// A fetch landing in the middle of a quick jump is a repaint the user did not
/// ask for between two keys they meant as one, so it waits for the chord to
/// finish. It is not what keeps the jump correct -- the chord holds the group
/// it was read off and finds it again, so a rebuilt list cannot misdirect it
/// -- and the ceiling still applies, so an abandoned chord cannot freeze the
/// data for good.
fn dashboard_refresh_deferral_expired(
    deferred_for: Option<Duration>,
    idle_for: Option<Duration>,
    quick_jump_pending: bool,
) -> bool {
    let Some(deferred_for) = deferred_for else {
        return false;
    };
    if deferred_for >= DASHBOARD_DEFERRED_REFRESH_CEILING {
        return true;
    }
    if quick_jump_pending {
        return false;
    }
    idle_for.is_some_and(|idle| idle >= DASHBOARD_DEFERRED_REFRESH_BUDGET)
}

fn dashboard_render_source(input: DashboardRenderSourceInput) -> DashboardRenderSource {
    let cacheable = input.has_snapshot
        && input.rendered_once
        && input.render_requested
        && !input.render_from_data
        && !input.selection_move_pending
        && !input.forced_refresh
        && (input.screen != DashboardScreen::Dashboard
            || (input.input_driven && input.cacheable_input));
    if cacheable {
        DashboardRenderSource::CachedSnapshot
    } else {
        DashboardRenderSource::Refresh
    }
}

fn dashboard_output(once: bool) -> Box<dyn Write> {
    if once {
        return Box::new(io::stdout());
    }
    fs::OpenOptions::new()
        .write(true)
        .open("/dev/tty")
        .map(|file| Box::new(file) as Box<dyn Write>)
        .unwrap_or_else(|_| Box::new(io::stdout()))
}

fn write_dashboard_frame(output: &mut dyn Write, bytes: &[u8]) -> io::Result<()> {
    let mut remaining = bytes;
    while !remaining.is_empty() {
        match output.write(remaining) {
            Ok(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "failed to write dashboard frame",
                ));
            }
            Ok(count) => {
                remaining = &remaining[count..];
            }
            Err(error) if is_terminal_output_hangup(&error) => return Ok(()),
            Err(error) if is_nonblocking_terminal_write(&error) => {
                thread::sleep(Duration::from_millis(5));
            }
            Err(error) => return Err(error),
        }
    }
    loop {
        match output.flush() {
            Ok(()) => return Ok(()),
            Err(error) if is_terminal_output_hangup(&error) => return Ok(()),
            Err(error) if is_nonblocking_terminal_write(&error) => {
                thread::sleep(Duration::from_millis(5));
            }
            Err(error) => return Err(error),
        }
    }
}

fn is_nonblocking_terminal_write(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::WouldBlock
        || error.raw_os_error() == Some(libc::EAGAIN)
        || error.raw_os_error() == Some(libc::EWOULDBLOCK)
}

fn is_terminal_output_hangup(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::EIO)
}

fn suspend_dashboard_event_stream(
    event_stream: &mut Option<DashboardEventStreamHandle>,
    retry_at: &mut Option<Instant>,
    down: &mut Option<String>,
    health: &mut DashboardStreamHealth,
) {
    if event_stream.is_some() {
        *event_stream = None;
    }
    *retry_at = None;
    // Suspended on purpose, so "the stream is down" stops being a report about
    // anything. Left standing it would outlive the project it was about, and so
    // would a latch saying the last cycle was empty.
    *down = None;
    *health = DashboardStreamHealth::default();
}

fn drain_dashboard_event_stream(
    event_stream: &mut Option<DashboardEventStreamHandle>,
    retry_at: &mut Option<Instant>,
    down: &mut Option<String>,
    stream_state: &mut DashboardStreamHealth,
    refresh_state: &mut DashboardProjectRefreshState,
    active_screen: Option<&str>,
    mut controller: Option<&mut DashboardController>,
) -> bool {
    let Some(stream) = event_stream.as_ref() else {
        return false;
    };
    let mut stream_closed = false;
    let mut stream_error = None;
    let mut render = false;
    while let Ok(message) = stream.try_recv() {
        match message {
            DashboardEventStreamMessage::Opened => {
                // The subscription was accepted. Not the spawn, which says only
                // that a connection was attempted, and not the first event,
                // which on an idle project never comes.
                //
                // Unless the last stream opened and closed without delivering
                // anything: a service that answers `/events` with a complete
                // body does that every retry, and clearing here would flash the
                // bar off and on every few seconds instead of saying plainly
                // that the stream does not work.
                if stream_state.accept_proves_recovery() && down.take().is_some() {
                    render = true;
                }
                stream_state.delivered = false;
            }
            DashboardEventStreamMessage::Event(event) => {
                // Demonstrably working, whatever happened last time.
                stream_state.observe_delivery();
                if down.take().is_some() {
                    render = true;
                }
                if let DashboardProjectEvent::Alert(payload) = &event
                    && let Some(message) = dashboard_alert_footer_flash("dashboard", payload)
                    && let Some(controller) = controller.as_deref_mut()
                {
                    // `✗ {title}` is a failed task. Flattened into the note
                    // channel it rendered in the same grey as `✓ {title}` and
                    // was gone on the next keypress.
                    if dashboard_alert_flash_failed(payload) {
                        // Never over the top of one: this arrives unprompted
                        // from the project service, and the alert slot holds
                        // the answer to something the user just asked for.
                        if controller.footer_alert.is_none() {
                            controller.footer_alert = Some(DashboardFailureAlert::local(message));
                        } else {
                            controller.set_note(message);
                        }
                    } else {
                        controller.set_note(message);
                    }
                    render = true;
                }
                refresh_state.observe_for_screen(&event, active_screen);
            }
            DashboardEventStreamMessage::Error(error) => {
                stream_closed = true;
                stream_error = Some(error);
                // Same bookkeeping as a clean close: a stream that accepted and
                // then errored without delivering is not one whose next accept
                // proves anything either.
                stream_state.observe_close();
                break;
            }
            DashboardEventStreamMessage::Ended => {
                // A clean close is still no stream. Silent here, the report
                // raised when it died was cleared by the open that preceded it
                // and nothing said it had gone again.
                stream_closed = true;
                render |= raise_stream_down(down, "project event stream ended");
                stream_state.observe_close();
                break;
            }
        }
    }
    if let Some(error) = stream_error {
        render |= raise_stream_down(down, &error);
    }
    if stream_closed {
        *event_stream = None;
        *retry_at = Some(Instant::now() + DASHBOARD_STREAM_RETRY_INTERVAL);
    }
    render
}

/// What the last stream cycle actually did.
///
/// A subscription being accepted is normally proof the stream is back, which is
/// what an idle project needs -- it delivers nothing for minutes. But a service
/// that answers `/events` with a complete body accepts and closes on every
/// retry, and clearing on each accept would flash the report off and on rather
/// than saying plainly that the stream does not work. So an accept clears it
/// only when the last cycle was not one of those, and a delivered event clears
/// it unconditionally.
#[derive(Debug, Default)]
struct DashboardStreamHealth {
    delivered: bool,
    closed_empty: bool,
}

impl DashboardStreamHealth {
    /// Whether a subscription being accepted is proof the stream is back.
    fn accept_proves_recovery(&self) -> bool {
        !self.closed_empty
    }

    fn observe_delivery(&mut self) {
        self.delivered = true;
        self.closed_empty = false;
    }

    fn observe_close(&mut self) {
        self.closed_empty = !self.delivered;
        self.delivered = false;
    }
}

/// Report that the event stream is down, and say whether that is news.
///
/// Derived rather than stored on the controller, and so not dismissible: the
/// stream retries every few seconds, and an alert the user can clear would come
/// straight back, while a stored one would outlive the reconnect that makes it
/// false. `refresh_error` is the same shape for the same reason.
fn raise_stream_down(down: &mut Option<String>, error: &str) -> bool {
    if down.as_deref() == Some(error) {
        return false;
    }
    *down = Some(error.to_owned());
    true
}

fn reconcile_dashboard_event_stream(
    event_stream: &mut Option<DashboardEventStreamHandle>,
    retry_at: &mut Option<Instant>,
    down: &mut Option<String>,
    health: &mut DashboardStreamHealth,
    endpoint: Option<&ProjectServiceEndpoint>,
    disabled: bool,
) {
    if disabled {
        *event_stream = None;
        *retry_at = None;
        // There is no stream to be down, so saying it is down would be a
        // standing untruth on a surface nobody can clear.
        *down = None;
        *health = DashboardStreamHealth::default();
        return;
    }
    let Some(endpoint) = endpoint else {
        // No endpoint is a different state from a stream that died, and the
        // report of the latter would otherwise be permanent and, being derived,
        // not dismissible either.
        *down = None;
        *health = DashboardStreamHealth::default();
        return;
    };
    if event_stream
        .as_ref()
        .is_some_and(|stream| stream.endpoint() == endpoint)
    {
        return;
    }
    // A different project's stream tells us nothing about this one's.
    if event_stream.is_some() {
        *down = None;
        *health = DashboardStreamHealth::default();
    }
    if let Some(retry_at) = retry_at.as_ref()
        && Instant::now() < *retry_at
    {
        return;
    }
    *event_stream = Some(spawn_dashboard_project_event_stream(endpoint.clone()));
    *retry_at = None;
    // The report stays up until the new stream actually delivers something.
    // Clearing it here made the bar blink off at every retry and back on when
    // that retry failed, so a glance during the gap saw a healthy stream.
}

fn elapsed_millis(start: Instant) -> i64 {
    start.elapsed().as_millis().min(i64::MAX as u128) as i64
}

fn pending_action_reconcile_due(pending_actions: &DashboardPendingActions, now_ms: i64) -> bool {
    pending_actions
        .next_reconcile_at_ms(now_ms)
        .is_some_and(|due_at| now_ms >= due_at)
}

fn should_probe_dashboard_runtime_guard(
    live_dashboard: bool,
    ready_age: Option<Duration>,
    elapsed_since_last_probe: Duration,
    probe_in_flight: bool,
) -> bool {
    live_dashboard
        && !probe_in_flight
        && ready_age.is_some_and(|age| age >= DASHBOARD_RUNTIME_GUARD_INTERVAL)
        && elapsed_since_last_probe >= DASHBOARD_RUNTIME_GUARD_INTERVAL
}

fn start_dashboard_runtime_guard_probe(
    runtime_guard: &mut DashboardRuntimeGuardStatus,
    project_root: &Path,
) {
    if runtime_guard.probing() {
        return;
    }
    let project_root = project_root.to_path_buf();
    let (sender, receiver) = mpsc::channel();
    runtime_guard.probe_receiver = Some(receiver);
    thread::spawn(move || {
        let result = probe_runtime_guard(project_root);
        let _ = sender.send(result);
    });
}

fn poll_dashboard_runtime_guard_probe(
    runtime_guard: &mut DashboardRuntimeGuardStatus,
    project_root: &Path,
    last_probe_completed: &mut Instant,
) -> bool {
    let Some(receiver) = runtime_guard.probe_receiver.as_ref() else {
        return false;
    };
    let raw_probe = match receiver.try_recv() {
        Ok(raw_probe) => raw_probe,
        Err(TryRecvError::Empty) => return false,
        Err(TryRecvError::Disconnected) => RuntimeGuardState::Disconnected,
    };
    runtime_guard.probe_receiver = None;
    *last_probe_completed = Instant::now();
    apply_dashboard_runtime_guard_probe_result(runtime_guard, project_root, raw_probe)
}

fn apply_dashboard_runtime_guard_probe_result(
    runtime_guard: &mut DashboardRuntimeGuardStatus,
    project_root: &Path,
    raw_probe: RuntimeGuardState,
) -> bool {
    let (next_state, disconnected_probe_count) = stabilize_runtime_guard_probe(
        &runtime_guard.state,
        raw_probe,
        runtime_guard.disconnected_probe_count,
        2,
    );
    runtime_guard.disconnected_probe_count = disconnected_probe_count;
    let mut render = false;
    if runtime_guard.set_state(next_state) {
        if runtime_guard.state.is_ok() {
            if let Err(error) = clear_runtime_guard_repair_attempts(
                PathResolver::from_env().global_aimux_dir(),
                &project_root.to_string_lossy(),
            ) {
                runtime_guard.repair_error =
                    Some(format!("Aimux repair history clear failed: {error}"));
            } else {
                runtime_guard.repair_attempts.clear();
                runtime_guard.repair_failed_key = None;
                runtime_guard.repair_retry_at_ms = None;
                runtime_guard.repair_error = None;
            }
        }
        render = true;
    }
    if maybe_start_dashboard_runtime_guard_repair(runtime_guard, project_root) {
        render = true;
    }
    render
}

fn maybe_start_dashboard_runtime_guard_repair(
    runtime_guard: &mut DashboardRuntimeGuardStatus,
    project_root: &Path,
) -> bool {
    let project_root_text = project_root.to_string_lossy().into_owned();
    let now_ms = current_time_ms();
    let home = PathResolver::from_env().global_aimux_dir();
    runtime_guard.repair_attempts = match load_runtime_guard_repair_attempts(
        &home,
        &project_root_text,
        RUNTIME_GUARD_REPAIR_FLAP_WINDOW_MS,
        now_ms,
    ) {
        Ok(attempts) => attempts,
        Err(error) => {
            runtime_guard.repair_error = Some(format!("Aimux repair history unavailable: {error}"));
            runtime_guard.repair_failed_key = Some(runtime_guard_repair_key(&runtime_guard.state));
            runtime_guard.repair_retry_at_ms = Some(now_ms + RUNTIME_GUARD_REPAIR_RETRY_MS);
            return true;
        }
    };
    let decision = runtime_guard_repair_decision(&RuntimeGuardRepairGate {
        state: &runtime_guard.state,
        repairing: runtime_guard.repairing(),
        timed_out_pending: false,
        failed_key: runtime_guard.repair_failed_key.as_deref(),
        retry_at_ms: runtime_guard.repair_retry_at_ms,
        attempt_count: runtime_guard.repair_attempts.len(),
        now_ms,
    });
    let RuntimeGuardRepairDecision::Start { repair_key } = decision else {
        if matches!(decision, RuntimeGuardRepairDecision::Flapping) {
            runtime_guard.repair_error = Some(
                "Aimux repair is looping; run `aimux restart` after checking installed versions."
                    .into(),
            );
            runtime_guard.repair_failed_key = Some(runtime_guard_repair_key(&runtime_guard.state));
            runtime_guard.repair_retry_at_ms = None;
            return true;
        }
        return false;
    };

    let lock = match try_acquire_runtime_guard_repair_lock(&home, &project_root_text, now_ms) {
        Ok(Some(lock)) => lock,
        Ok(None) => return false,
        Err(error) => {
            runtime_guard.repair_error = Some(format!("Aimux repair lock failed: {error}"));
            runtime_guard.repair_failed_key = Some(repair_key);
            runtime_guard.repair_retry_at_ms = Some(now_ms + RUNTIME_GUARD_REPAIR_RETRY_MS);
            return true;
        }
    };

    runtime_guard.repair_attempts = match record_runtime_guard_repair_attempt(
        &home,
        &project_root_text,
        RUNTIME_GUARD_REPAIR_FLAP_WINDOW_MS,
        now_ms,
    ) {
        Ok(attempts) => attempts,
        Err(error) => {
            runtime_guard.repair_error =
                Some(format!("Aimux repair history write failed: {error}"));
            runtime_guard.repair_failed_key = Some(repair_key);
            runtime_guard.repair_retry_at_ms = Some(now_ms + RUNTIME_GUARD_REPAIR_RETRY_MS);
            return true;
        }
    };
    let state = runtime_guard.state.clone();
    runtime_guard.repair_key = Some(repair_key.clone());
    runtime_guard.repair_failed_key = None;
    runtime_guard.repair_retry_at_ms = None;
    runtime_guard.repair_error = None;
    let (sender, receiver) = mpsc::channel();
    runtime_guard.repair_receiver = Some(receiver);
    thread::spawn(move || {
        let result = start_runtime_guard_repair_daemon_request(&project_root_text);
        drop(lock);
        let _ = sender.send(DashboardRuntimeGuardRepairResult {
            repair_key,
            state,
            result,
        });
    });
    true
}

fn poll_dashboard_runtime_guard_repair(
    runtime_guard: &mut DashboardRuntimeGuardStatus,
    project_root: &Path,
) -> bool {
    let mut changed = false;
    loop {
        let result = runtime_guard
            .repair_receiver
            .as_ref()
            .and_then(|receiver| receiver.try_recv().ok());
        let Some(result) = result else {
            break;
        };
        runtime_guard.repair_receiver = None;
        runtime_guard.repair_key = None;
        changed = true;
        match result.result {
            Ok(restart) => {
                if runtime_guard_repair_result_error(&restart, &project_root.to_string_lossy())
                    .is_some()
                {
                    let error = runtime_guard_repair_result_error(
                        &restart,
                        &project_root.to_string_lossy(),
                    )
                    .unwrap_or_else(|| "aimux repair failed".into());
                    fail_dashboard_runtime_guard_repair(runtime_guard, result.repair_key, error);
                    continue;
                }
                if result.state == runtime_guard.state {
                    runtime_guard.set_state(RuntimeGuardState::Ok);
                }
                runtime_guard.repair_failed_key = None;
                runtime_guard.repair_retry_at_ms = None;
                runtime_guard.repair_error = None;
                // Do not clear persisted attempts here: a later healthy guard
                // probe is the evidence that the repair actually settled.
            }
            Err(error) => {
                fail_dashboard_runtime_guard_repair(runtime_guard, result.repair_key, error);
            }
        }
    }
    changed
}

fn fail_dashboard_runtime_guard_repair(
    runtime_guard: &mut DashboardRuntimeGuardStatus,
    repair_key: String,
    error: String,
) {
    runtime_guard.repair_failed_key = Some(repair_key);
    runtime_guard.repair_retry_at_ms = Some(current_time_ms() + RUNTIME_GUARD_REPAIR_RETRY_MS);
    runtime_guard.repair_error = Some(error);
}

fn runtime_guard_repair_result_error(restart: &Value, project_root: &str) -> Option<String> {
    let project = restart
        .get("projects")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|project| project.get("projectRoot").and_then(Value::as_str) == Some(project_root));
    let project = project?;
    for field in ["runtime", "service", "dashboard"] {
        let step = project.get(field).unwrap_or(&Value::Null);
        if step.get("status").and_then(Value::as_str) == Some("failed") {
            return Some(
                step.get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("aimux repair failed")
                    .to_owned(),
            );
        }
    }
    restart
        .get("summary")
        .and_then(|summary| summary.get("failures"))
        .and_then(Value::as_i64)
        .filter(|failures| *failures > 0)
        .map(|_| "aimux repair reported failures".to_owned())
}

fn dashboard_tmux_pane_target() -> Option<String> {
    env::var("TMUX_PANE")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .or_else(current_process_tmux_pane_id)
}

fn read_tmux_dashboard_pane_size(tmux_pane: &str) -> Option<DashboardViewport> {
    let mut command = tmux_command_from_env();
    command.args(["display-message", "-p", "-t", tmux_pane]);
    command.arg("#{pane_width}x#{pane_height}");
    let output = command_output_with_timeout(&mut command, Duration::from_millis(500)).ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let (cols, rows) = raw.split_once('x')?;
    let cols = cols.trim().parse::<usize>().ok()?;
    let rows = rows.trim().parse::<usize>().ok()?;
    (cols > 0 && rows > 0).then_some(DashboardViewport { cols, rows })
}

/// The agent whose window we just came back from. tmux keeps the previously
/// active window as the `!` target, so the dashboard can ask at the moment it
/// becomes visible rather than anything having to push the answer to it.
fn previous_window_session_id() -> Option<String> {
    let mut command = tmux_command_from_env();
    command.args(["display-message", "-p", "-t", "!", "#{@aimux-meta}"]);
    let output = command_output_with_timeout(&mut command, Duration::from_millis(500)).ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str::<Value>(raw.trim())
        .ok()?
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|session_id| !session_id.is_empty())
}

fn current_process_tmux_pane_id() -> Option<String> {
    let mut command = tmux_command_from_env();
    command.args([
        "list-panes",
        "-a",
        "-F",
        "#{pane_id}\t#{pane_pid}\t#{session_attached}\t#{window_active}",
    ]);
    let panes_output =
        command_output_with_timeout(&mut command, Duration::from_millis(500)).ok()?;
    if !panes_output.status.success() {
        return None;
    }
    let panes_raw = String::from_utf8_lossy(&panes_output.stdout);
    let panes = crate::dashboard_tui_visibility::parse_tmux_pane_rows(Some(&panes_raw));
    let parents = crate::process_inspector::list_process_parents()
        .into_iter()
        .map(|(pid, ppid)| (i64::from(pid), i64::from(ppid)))
        .collect();
    crate::dashboard_tui_visibility::find_tmux_pane_for_process(
        &panes,
        &parents,
        i64::from(std::process::id()),
    )
    .map(|pane| pane.pane_id)
}

fn command_output_with_timeout(
    command: &mut AsyncCommand,
    timeout: Duration,
) -> io::Result<Output> {
    command
        .output_timeout("dashboard-internal:subprocess tmux", timeout)
        .map_err(|error| io::Error::other(error.to_string()))
}

fn execute_dashboard_controller_action(
    endpoint: &ProjectServiceEndpoint,
    request: &DashboardActionRequest,
) -> Result<Value> {
    let request = attach_dashboard_client_context(request);
    execute_dashboard_action(endpoint, &request)
}

fn attach_dashboard_client_context(request: &DashboardActionRequest) -> DashboardActionRequest {
    if request.path != crate::project_api_contract::routes::controls::FOCUS_WINDOW
        && request.path != crate::project_api_contract::routes::controls::OPEN_NOTIFICATION_TARGET
    {
        return request.clone();
    }
    let Some(context) = dashboard_control_client_context() else {
        return request.clone();
    };
    let Value::Object(mut body) = request.body.clone() else {
        return request.clone();
    };
    insert_context_value(
        &mut body,
        "currentClientSession",
        context.current_client_session,
    );
    insert_context_value(&mut body, "clientTty", context.client_tty);
    insert_context_value(&mut body, "currentWindowId", context.current_window_id);
    DashboardActionRequest {
        method: request.method,
        path: request.path,
        body: Value::Object(body),
    }
}

#[derive(Debug, Clone, Default)]
struct DashboardClientContext {
    current_client_session: Option<String>,
    client_tty: Option<String>,
    current_window_id: Option<String>,
}

fn dashboard_control_client_context() -> Option<DashboardClientContext> {
    let mut tmux = TmuxRuntimeManager::new();
    let dashboard_pane_target = env::var("TMUX_PANE")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let dashboard_window_id = dashboard_pane_target
        .as_deref()
        .and_then(|target| tmux.display_message("#{window_id}", Some(target)))
        .or_else(|| tmux.display_message("#{window_id}", None));
    let ambient_client_tty = tmux.display_message("#{client_tty}", None);
    let ambient_client_session = tmux.current_client_session();
    let clients = tmux.list_clients().unwrap_or_else(|error| {
        log_at(
            LogLevel::Debug,
            "tmux client inventory failed while building dashboard context",
            "dashboard",
            Some(json!({ "error": error })),
        );
        Vec::new()
    });
    let dashboard_client = dashboard_window_id.as_deref().and_then(|window_id| {
        clients
            .iter()
            .filter(|client| client.window_id == window_id)
            .find(|client| {
                ambient_client_tty
                    .as_deref()
                    .is_some_and(|tty| client.tty == tty)
            })
            .or_else(|| clients.iter().find(|client| client.window_id == window_id))
            .cloned()
    });
    let ambient_client = ambient_client_tty
        .as_deref()
        .and_then(|tty| clients.iter().find(|client| client.tty == tty))
        .cloned();
    let visible_client = dashboard_client.or(ambient_client);
    let context = DashboardClientContext {
        current_client_session: visible_client
            .as_ref()
            .map(|client| client.session_name.clone())
            .or(ambient_client_session),
        client_tty: visible_client
            .as_ref()
            .map(|client| client.tty.clone())
            .or(ambient_client_tty),
        current_window_id: dashboard_window_id
            .or_else(|| visible_client.map(|client| client.window_id)),
    };
    (context.current_client_session.is_some()
        || context.client_tty.is_some()
        || context.current_window_id.is_some())
    .then_some(context)
}

fn insert_context_value(body: &mut Map<String, Value>, key: &str, value: Option<String>) {
    if body.contains_key(key) {
        return;
    }
    if let Some(value) = value.filter(|value| !value.trim().is_empty()) {
        body.insert(key.to_owned(), Value::String(value));
    }
}

fn sync_dashboard_focus(
    focus_state: &mut DashboardFocusState,
    controller: &DashboardController,
    snapshot: &DesktopStateSnapshot,
    endpoint: &ProjectServiceEndpoint,
) -> bool {
    let plan = focus_state.plan_sync(controller.screen, snapshot, &controller.navigation);
    let mut synced_seen = false;
    for request in plan.requests {
        if execute_dashboard_controller_action(endpoint, &request).is_ok()
            && request.path == crate::project_api_contract::routes::runtime::MARK_SEEN
        {
            synced_seen = true;
        }
    }
    if synced_seen && let Some(session_id) = plan.seen_session_id {
        focus_state.mark_seen_synced(session_id);
        return true;
    }
    false
}

fn execute_overseer_watch_command(
    options: &NativeDashboardOptions,
    controller: &mut DashboardController,
    request: &DashboardOverseerWatchRequest,
) -> Result<()> {
    let mut payload = serde_json::json!({
        "projectRoot": options.project_root.to_string_lossy(),
        "sessionId": request.session_id,
        "instructions": request.instructions,
    });
    if let Some(goal) = request.goal.as_ref()
        && let Some(object) = payload.as_object_mut()
    {
        object.insert("goal".into(), serde_json::Value::String(goal.clone()));
    }
    let response = send_core_command(
        CORE_COMMAND_NAMES.overseer_watch,
        Some(payload),
        Some(20_000),
    )?;
    let loaded = load_dashboard_snapshot(options)?;
    let visible_model =
        filter_dashboard_visible_model(&loaded.snapshot, controller.hide_offline_agents);
    if let Some(overseer_session_id) = response
        .result
        .get("overseerSessionId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        if let (Some(endpoint), Some(session)) = (
            loaded.endpoint.as_ref(),
            find_dashboard_session(&visible_model.snapshot, overseer_session_id),
        ) {
            controller.focus_session_by_id(&visible_model.snapshot, overseer_session_id);
            if let DashboardActionPlan::Request(focus_request) = plan_dashboard_action(
                Some(DashboardEntryRef::Session(session)),
                DashboardActionKind::Enter,
            ) && execute_dashboard_controller_action(endpoint, &focus_request).is_ok()
            {
                return Ok(());
            }
        }
        controller.footer_alert = Some(DashboardFailureAlert::local(
            "Overseer updated, but could not open overseer",
        ));
        return Ok(());
    }
    controller.set_note(format!("{} added to overseer loop", request.target_label));
    Ok(())
}

fn find_dashboard_session<'a>(
    snapshot: &'a DesktopStateSnapshot,
    session_id: &str,
) -> Option<&'a crate::dashboard_model::DashboardSession> {
    snapshot
        .sessions
        .iter()
        .chain(
            snapshot
                .worktree_groups
                .iter()
                .flat_map(|group| group.sessions.iter()),
        )
        .find(|session| session.id == session_id)
}

fn render_dashboard_snapshot(
    options: &NativeDashboardOptions,
    controller: &mut DashboardController,
    snapshot: &DesktopStateSnapshot,
    pending_actions: &mut DashboardPendingActions,
    context: DashboardSnapshotRenderContext<'_>,
) -> crate::tui_render::screen_frame::ScreenFrameResult {
    let viewport = context.viewport;
    if controller.screen != DashboardScreen::Dashboard {
        return render_dashboard_subscreen_snapshot(
            viewport,
            controller,
            context.endpoint,
            context.scroll_offset,
            pending_actions,
            context.pending_now_ms,
            context.stream_error,
        );
    }
    controller.navigation.clamp(snapshot);
    let (selected_session_id, selected_service_id) =
        match controller.navigation.selected_entry(snapshot) {
            Some(DashboardEntryRef::Session(session)) => (Some(session.id.as_str()), None),
            Some(DashboardEntryRef::Service(service)) => (None, Some(service.id.as_str())),
            None => (None, None),
        };
    let focused_worktree_path = controller.navigation.focused_worktree_path(snapshot);
    let runtime_version = dashboard_runtime_version();
    let scribe_preview_entries =
        scribe_preview_entries_for_render(options, snapshot, selected_session_id, controller);
    let overseer_sessions = snapshot
        .sessions
        .iter()
        .filter(|session| is_dashboard_overseer_session(session))
        .cloned()
        .collect::<Vec<_>>();
    let scribe_sessions = snapshot
        .sessions
        .iter()
        .filter(|session| is_dashboard_scribe_session(session))
        .cloned()
        .collect::<Vec<_>>();
    // Stale data and a refused action are both true at once, so each gets a
    // line. Collapsing them into one slot meant whichever arrived second was
    // never shown, and `X` discarded it unseen.
    let footer_alerts: Vec<DashboardFooterAlert<'_>> = context
        .refresh_error
        .into_iter()
        .chain(context.stream_error)
        .map(|message| DashboardFooterAlert {
            message,
            dismissible: false,
        })
        .chain(
            controller
                .footer_alert
                .as_ref()
                .map(|alert| DashboardFooterAlert {
                    message: alert.message.as_str(),
                    dismissible: true,
                }),
        )
        .collect();
    let frame = render_dashboard_frame(&DashboardRenderInput {
        snapshot,
        overseer_sessions: &overseer_sessions,
        scribe_sessions: &scribe_sessions,
        cols: viewport.cols,
        rows: viewport.rows,
        nav_level: controller.navigation.level,
        selected_session_id,
        selected_service_id,
        focused_worktree_path,
        focused_group_index: Some(controller.navigation.worktree_index),
        runtime_label: Some("tmux"),
        version: Some(&runtime_version),
        hide_offline_agents: controller.hide_offline_agents,
        hidden_offline_agent_count: context.hidden_offline_agent_count,
        scroll_offset: context.scroll_offset,
        footer_progress: controller.footer_progress_view(),
        footer_note: controller.footer_note_view(),
        footer_alerts: &footer_alerts,
        details_sidebar_visible: controller.details_sidebar_visible,
        preview_source: &controller.preview_source,
        scribe_preview_entries: &scribe_preview_entries,
    });
    if controller.overseer_overlay_open {
        let ctx = serde_json::json!({
            "dashboardOverseerSessionsCache": &overseer_sessions,
            "dashboardSessionsCache": &snapshot.sessions,
            "dashboardTeammatesCache": &snapshot.teammates,
            "loopAlertState": snapshot.extra.get("loopAlertState"),
        });
        return dashboard_overlay_frame(
            &frame,
            render_overseer_overlay_output(&ctx, viewport.cols, viewport.rows),
        );
    }
    if let Some(watch) = controller.overseer_watch_instructions.as_ref() {
        let ctx = serde_json::json!({
            "overseerWatchInstructionsTarget": &watch.target,
            "overseerWatchInstructionsBuffer": &watch.buffer,
        });
        if let Some(overlay) =
            render_overseer_watch_instructions_overlay_output(&ctx, viewport.cols, viewport.rows)
        {
            return dashboard_overlay_frame(&frame, overlay);
        }
        return frame;
    }
    if let Some(work_outline_overlay) = controller.work_outline_overlay.as_ref() {
        let mut ctx = serde_json::json!({
            "workOutlineOverlayEntries": &work_outline_overlay.entries,
            "workOutlineOverlayOffset": work_outline_overlay.offset,
            "dashboardScribeSessionsCache": &scribe_sessions,
        });
        if let Some(session_id) = work_outline_overlay.session_id.as_ref()
            && let Some(object) = ctx.as_object_mut()
        {
            object.insert(
                "workOutlineOverlaySessionId".into(),
                serde_json::Value::String(session_id.clone()),
            );
        }
        return dashboard_overlay_frame(
            &frame,
            render_work_outline_overlay_output(&ctx, viewport.cols, viewport.rows),
        );
    }
    if let Some(launch_options) = controller.launch_options.as_ref() {
        let selected_tool = controller
            .tool_picker
            .as_ref()
            .and_then(|picker| picker.selected_tool());
        return dashboard_overlay_frame(
            &frame,
            render_launch_options_overlay(
                launch_options,
                selected_tool,
                viewport.cols,
                viewport.rows,
            ),
        );
    }
    if let Some(tool_picker) = controller.tool_picker.as_ref() {
        return dashboard_overlay_frame(
            &frame,
            render_tool_picker_overlay(tool_picker, viewport.cols, viewport.rows),
        );
    }
    if let Some(service_input) = controller.service_input.as_ref() {
        return dashboard_overlay_frame(
            &frame,
            render_service_input_overlay(service_input, viewport.cols, viewport.rows),
        );
    }
    if let Some(worktree_input) = controller.worktree_input.as_ref() {
        return dashboard_overlay_frame(
            &frame,
            render_worktree_input_overlay(worktree_input, viewport.cols, viewport.rows),
        );
    }
    if let Some(remote_worktree_input) = controller.remote_worktree_input.as_ref() {
        return dashboard_overlay_frame(
            &frame,
            render_remote_worktree_input_overlay(
                remote_worktree_input,
                viewport.cols,
                viewport.rows,
            ),
        );
    }
    if let Some(migrate_picker) = controller.migrate_picker.as_ref() {
        return dashboard_overlay_frame(
            &frame,
            render_migrate_picker_overlay(migrate_picker, viewport.cols, viewport.rows),
        );
    }
    // Mirrors the key-intercept order in dashboard_controller::handle_key: the
    // overlay that eats the keys has to be the overlay on screen.
    if let Some(plane_picker) = controller.plane_picker.as_ref() {
        return dashboard_overlay_frame(
            &frame,
            render_plane_picker_overlay(plane_picker, viewport.cols, viewport.rows),
        );
    }
    if let Some(label_input) = controller.label_input.as_ref() {
        return dashboard_overlay_frame(
            &frame,
            render_label_input_overlay(label_input, viewport.cols, viewport.rows),
        );
    }
    if let Some(confirm) = controller.worktree_remove_confirm.as_ref() {
        return dashboard_overlay_frame(
            &frame,
            render_worktree_remove_confirm_overlay(
                &confirm.name,
                &confirm.path,
                viewport.cols,
                viewport.rows,
            ),
        );
    }
    if controller.worktree_list_open {
        return dashboard_overlay_frame(
            &frame,
            render_worktree_list_overlay(&snapshot.worktree_groups, viewport.cols, viewport.rows),
        );
    }
    if controller.agent_restore_prompt_active(snapshot)
        && let Some(offer) = snapshot.agent_restore_offer.as_ref()
    {
        return dashboard_overlay_frame(
            &frame,
            render_agent_restore_confirm_overlay(offer, viewport.cols, viewport.rows),
        );
    }
    if let Some(preview) = controller.worktree_cache_cleanup_confirm.as_ref() {
        return dashboard_overlay_frame(
            &frame,
            render_worktree_cache_cleanup_confirm_overlay(preview, viewport.cols, viewport.rows),
        );
    }
    if let Some(teammate_picker) = controller.teammate_picker.as_ref() {
        let teammates = crate::dashboard_controller::sorted_teammates_for_parent(
            snapshot,
            &teammate_picker.parent_session_id,
        );
        if let Some(overlay) = render_teammate_picker_overlay(
            &teammates,
            teammate_picker.index,
            viewport.cols,
            viewport.rows,
        ) {
            return dashboard_overlay_frame(&frame, overlay);
        }
    }
    if let Some(route_picker) = controller.orchestration_route_picker.as_ref() {
        return dashboard_overlay_frame(
            &frame,
            render_orchestration_route_picker_overlay(route_picker, viewport.cols, viewport.rows),
        );
    }
    if let Some(input) = controller.orchestration_input.as_ref() {
        return dashboard_overlay_frame(
            &frame,
            render_orchestration_input_overlay(input, viewport.cols, viewport.rows),
        );
    }
    if let Some(reply) = controller.thread_reply.as_ref() {
        return dashboard_overlay_frame(
            &frame,
            render_thread_reply_overlay(reply, viewport.cols, viewport.rows),
        );
    }
    if let Some(overlay) = render_dashboard_runtime_guard_overlay(context.runtime_guard, viewport) {
        return dashboard_overlay_frame(&frame, overlay);
    }
    frame
}

fn dashboard_overlay_frame(
    base: &crate::tui_render::screen_frame::ScreenFrameResult,
    overlay: String,
) -> crate::tui_render::screen_frame::ScreenFrameResult {
    let mut frame = recede(&base.frame);
    frame.push_str(&overlay);
    crate::tui_render::screen_frame::ScreenFrameResult {
        frame,
        scroll_offset: base.scroll_offset,
    }
}

fn render_dashboard_runtime_guard_overlay(
    runtime_guard: Option<&DashboardRuntimeGuardStatus>,
    viewport: DashboardViewport,
) -> Option<String> {
    let runtime_guard = runtime_guard.filter(|runtime_guard| !runtime_guard.state.is_ok())?;
    let copy = runtime_guard_overlay_copy(
        &runtime_guard.state,
        runtime_guard.active_ms(),
        runtime_guard.repair_failed_for_current_state(),
    );
    if copy.title.is_empty() {
        return None;
    }
    let mut body = copy
        .lines
        .iter()
        .map(|line| style(line, Tone::Muted))
        .collect::<Vec<_>>();
    if let Some(error) = runtime_guard.repair_error.as_ref() {
        body.push(style("", Tone::Muted));
        body.push(style(error, Tone::Danger));
    }
    if copy.waiting {
        body.push(style("", Tone::Muted));
        body.push(style("Please wait.", Tone::Muted));
    }
    // "Aimux is updating", "is reconnecting", "is repairing tmux": four of the
    // six states are a wait that ends on its own, and all six wore the red
    // modal with a warning triangle. The escalations flip `waiting` off, so a
    // repair error is the only way a waiting state still needs the user.
    let waiting = copy.waiting && runtime_guard.repair_error.is_none();
    let (variant, icon) = if waiting {
        (OverlayVariant::Progress, None)
    } else {
        (OverlayVariant::Red, Some("!"))
    };
    Some(render_overlay_box(&OverlayBoxSpec {
        title: copy.title,
        body: &body,
        cols: viewport.cols,
        rows: viewport.rows,
        variant,
        icon,
    }))
}

fn dashboard_runtime_version() -> String {
    read_aimux_runtime_version()
}

/// What to render when the refresh failed: the last good data for this screen,
/// said to be stale, or nothing at all when there is no last good data.
fn stale_subscreen_resource(
    controller: &DashboardController,
    error: &str,
) -> (Option<serde_json::Value>, Option<String>) {
    match controller.cached_subscreen_resource() {
        Some(resource) => (
            Some(resource.clone()),
            Some(format!("{error} — showing the last data that loaded")),
        ),
        None => (None, Some(error.to_owned())),
    }
}

fn render_dashboard_subscreen_snapshot(
    viewport: DashboardViewport,
    controller: &mut DashboardController,
    endpoint: Option<&ProjectServiceEndpoint>,
    scroll_offset: usize,
    pending_actions: &mut DashboardPendingActions,
    pending_now_ms: i64,
    stream_error: Option<&str>,
) -> crate::tui_render::screen_frame::ScreenFrameResult {
    // A refresh that fails keeps the screen it already drew. Under load the
    // project service misses the 2s budget routinely, and throwing the rows
    // away turned a slow answer into "Loading topology…" over an empty screen.
    let (mut resource, error) = match dashboard_screen_resource_path(controller.screen) {
        Some(path) => match endpoint {
            Some(endpoint) => match fetch_dashboard_resource(endpoint, path) {
                Ok(resource) => {
                    controller.remember_subscreen_resource(&resource);
                    (Some(resource), None)
                }
                Err(error) => stale_subscreen_resource(controller, &error.to_string()),
            },
            None => stale_subscreen_resource(controller, "Project-service endpoint unavailable"),
        },
        None => (None, None),
    };
    if controller.screen == DashboardScreen::Graveyard
        && let Some(resource) = resource.as_mut()
    {
        pending_actions.reconcile_graveyard_resource(resource, pending_now_ms);
        pending_actions.apply_to_graveyard_resource(resource);
    }
    controller.set_subscreen_actions(dashboard_screen_actions(
        controller.screen,
        resource.as_ref(),
    ));
    // The stream error reaches here too. A subscreen that silently stopped
    // receiving events looked exactly like a subscreen with nothing happening.
    let footer_alerts: Vec<DashboardFooterAlert<'_>> = stream_error
        .map(|message| DashboardFooterAlert {
            message,
            dismissible: false,
        })
        .into_iter()
        .chain(
            controller
                .footer_alert
                .as_ref()
                .map(|alert| DashboardFooterAlert {
                    message: alert.message.as_str(),
                    dismissible: true,
                }),
        )
        .collect();
    let frame = render_dashboard_subscreen_frame(&DashboardSubscreenRenderInput {
        screen: controller.screen,
        resource: resource.as_ref(),
        error: error.as_deref(),
        selected_index: controller.subscreen_index,
        cols: viewport.cols,
        rows: viewport.rows,
        scroll_offset,
        footer_progress: controller.footer_progress_view(),
        footer_note: controller.footer_note_view(),
        footer_alerts: &footer_alerts,
        details_sidebar_visible: controller.details_sidebar_visible,
        runtime_label: Some("tmux"),
        version: Some(&dashboard_runtime_version()),
    });
    if let Some(reply) = controller.thread_reply.as_ref() {
        let mut output = frame.frame;
        output.push_str(&render_thread_reply_overlay(
            reply,
            viewport.cols,
            viewport.rows,
        ));
        return crate::tui_render::screen_frame::ScreenFrameResult {
            frame: output,
            scroll_offset: frame.scroll_offset,
        };
    }
    frame
}

fn dashboard_screen_actions(
    screen: DashboardScreen,
    resource: Option<&serde_json::Value>,
) -> Vec<DashboardSubscreenAction> {
    let Some(resource) = resource else {
        return Vec::new();
    };
    let rows = match screen {
        DashboardScreen::Dashboard | DashboardScreen::Help => return Vec::new(),
        DashboardScreen::Coordination => json_array(resource, &["worklist"]),
        DashboardScreen::Project => json_array(resource, &["project", "story"]),
        DashboardScreen::Library => json_array(resource, &["entries"]),
        DashboardScreen::Topology => json_array(resource, &["topology", "rows"]),
        DashboardScreen::Graveyard => json_array(resource, &["viewModel", "selectableRows"]),
    };
    rows.iter()
        .map(|row| dashboard_screen_action(screen, row))
        .collect()
}

fn dashboard_screen_action(
    screen: DashboardScreen,
    row: &serde_json::Value,
) -> DashboardSubscreenAction {
    match screen {
        DashboardScreen::Coordination => match json_string(row, &["kind"]).as_deref() {
            Some("thread") => json_string(row, &["thread", "thread", "id"])
                .map(|thread_id| DashboardSubscreenAction::Thread {
                    thread_kind: json_string(row, &["thread", "thread", "kind"]),
                    task_id: json_string(row, &["thread", "task", "id"]),
                    target_session_id: json_string(row, &["thread", "thread", "owner"])
                        .or_else(|| first_json_string(row, &["thread", "thread", "waitingOn"]))
                        .or_else(|| first_json_string(row, &["thread", "thread", "participants"])),
                    thread_id,
                })
                .unwrap_or(DashboardSubscreenAction::None),
            Some("notification") => DashboardSubscreenAction::Notification {
                session_id: json_string(row, &["sessionId"]),
                ids: json_array(row, &["notification", "notifications"])
                    .iter()
                    .filter_map(|notification| json_string(notification, &["id"]))
                    .collect(),
            },
            _ => json_string(row, &["sessionId"])
                .map(DashboardSubscreenAction::Session)
                .unwrap_or(DashboardSubscreenAction::None),
        },
        DashboardScreen::Library => json_string(row, &["path"])
            .map(DashboardSubscreenAction::Path)
            .unwrap_or(DashboardSubscreenAction::None),
        DashboardScreen::Topology => json_string(row, &["sessionId"])
            .map(DashboardSubscreenAction::Session)
            .or_else(|| json_string(row, &["serviceId"]).map(DashboardSubscreenAction::Service))
            .unwrap_or(DashboardSubscreenAction::None),
        DashboardScreen::Graveyard => match json_string(row, &["kind"]).as_deref() {
            Some("worktree") => json_string(row, &["entry", "path"])
                .map(DashboardSubscreenAction::GraveyardWorktree)
                .unwrap_or(DashboardSubscreenAction::None),
            Some("standalone-agent") | Some("orphan-agent") => json_string(row, &["entry", "id"])
                .map(DashboardSubscreenAction::GraveyardAgent)
                .unwrap_or(DashboardSubscreenAction::None),
            _ => DashboardSubscreenAction::None,
        },
        DashboardScreen::Project | DashboardScreen::Dashboard | DashboardScreen::Help => {
            DashboardSubscreenAction::None
        }
    }
}

fn json_array<'a>(value: &'a serde_json::Value, path: &[&str]) -> &'a [serde_json::Value] {
    let mut current = value;
    for key in path {
        current = current.get(*key).unwrap_or(&serde_json::Value::Null);
    }
    current.as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn json_string(value: &serde_json::Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current
        .as_str()
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn first_json_string(value: &serde_json::Value, path: &[&str]) -> Option<String> {
    json_array(value, path)
        .iter()
        .find_map(|value| value.as_str().filter(|value| !value.is_empty()))
        .map(str::to_owned)
}

fn dashboard_screen_resource_path(screen: DashboardScreen) -> Option<&'static str> {
    match screen {
        DashboardScreen::Dashboard | DashboardScreen::Help => None,
        DashboardScreen::Coordination => {
            Some(crate::project_api_contract::routes::COORDINATION_WORKLIST)
        }
        DashboardScreen::Project => {
            Some(crate::project_api_contract::routes::PROJECT_OBSERVABILITY)
        }
        DashboardScreen::Library => Some(crate::project_api_contract::routes::LIBRARY),
        DashboardScreen::Topology => Some(crate::project_api_contract::routes::TOPOLOGY),
        DashboardScreen::Graveyard => Some(crate::project_api_contract::routes::GRAVEYARD),
    }
}

fn open_relevant_thread_for_session(
    endpoint: &ProjectServiceEndpoint,
    controller: &mut DashboardController,
    session_id: &str,
) -> Result<()> {
    let resource = fetch_dashboard_resource(
        endpoint,
        crate::project_api_contract::routes::COORDINATION_WORKLIST,
    )?;
    controller.set_subscreen_actions(dashboard_screen_actions(
        DashboardScreen::Coordination,
        Some(&resource),
    ));
    let Some(selection) = preferred_thread_selection(&resource, session_id) else {
        controller.set_note(format!("No thread for {session_id}"));
        return Ok(());
    };
    controller.screen = DashboardScreen::Coordination;
    controller.subscreen_index = selection.worklist_index;
    if selection.waiting_on_session {
        controller.thread_reply = Some(DashboardThreadReplyState {
            thread_id: selection.thread_id,
            title: selection.title,
            targets: selection.targets,
            buffer: String::new(),
        });
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreferredThreadSelection {
    worklist_index: usize,
    thread_id: String,
    title: String,
    targets: Vec<String>,
    waiting_on_session: bool,
}

fn preferred_thread_selection(
    resource: &serde_json::Value,
    session_id: &str,
) -> Option<PreferredThreadSelection> {
    let mut candidates = Vec::new();
    for (index, entry) in json_array(resource, &["threads"]).iter().enumerate() {
        let thread = entry.get("thread").unwrap_or(&serde_json::Value::Null);
        let participants = json_array(thread, &["participants"]);
        if !participants
            .iter()
            .any(|participant| participant.as_str() == Some(session_id))
        {
            continue;
        }
        let waiting_on = json_array(thread, &["waitingOn"]);
        let waiting_on_session = waiting_on
            .iter()
            .any(|participant| participant.as_str() == Some(session_id));
        let unread_by_session = json_array(thread, &["unreadBy"])
            .iter()
            .any(|participant| participant.as_str() == Some(session_id));
        let owns_waiting = json_string(thread, &["owner"]).as_deref() == Some(session_id)
            && !waiting_on.is_empty();
        let score = i64::from(waiting_on_session) * 3
            + i64::from(unread_by_session) * 2
            + i64::from(owns_waiting);
        let thread_id = json_string(thread, &["id"])?;
        let title = json_string(thread, &["displayTitle"])
            .or_else(|| json_string(thread, &["title"]))
            .unwrap_or_else(|| thread_id.clone());
        let targets = if waiting_on.is_empty() {
            participants
                .iter()
                .filter_map(serde_json::Value::as_str)
                .filter(|participant| *participant != "user")
                .map(str::to_owned)
                .collect()
        } else {
            waiting_on
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_owned)
                .collect()
        };
        candidates.push((
            score,
            json_string(thread, &["updatedAt"]).unwrap_or_default(),
            index,
            thread_id,
            title,
            targets,
            waiting_on_session,
        ));
    }
    candidates.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| right.1.cmp(&left.1))
            .then_with(|| left.2.cmp(&right.2))
    });
    let (_, _, _, thread_id, title, targets, waiting_on_session) = candidates.first()?.clone();
    let worklist_index = json_array(resource, &["worklist"]).iter().position(|row| {
        json_string(row, &["kind"]).as_deref() == Some("thread")
            && json_string(row, &["thread", "thread", "id"]).as_deref() == Some(thread_id.as_str())
    })?;
    Some(PreferredThreadSelection {
        worklist_index,
        thread_id,
        title,
        targets,
        waiting_on_session,
    })
}

fn load_dashboard_snapshot(options: &NativeDashboardOptions) -> Result<DashboardSnapshotLoad> {
    if let Some(path) = options.desktop_state_file.as_ref() {
        let contents = fs::read_to_string(path)
            .with_context(|| format!("read desktop-state snapshot {}", path.display()))?;
        return Ok(DashboardSnapshotLoad {
            snapshot: parse_desktop_state_snapshot(&contents)
                .context("parse desktop-state snapshot")?,
            endpoint: None,
        });
    }
    let endpoint = resolve_project_service_endpoint(&options.project_root)?;
    let snapshot = fetch_desktop_state(&endpoint).context("request project desktop-state")?;
    Ok(DashboardSnapshotLoad {
        snapshot,
        endpoint: Some(endpoint),
    })
}

pub fn resolve_dashboard_snapshot_refresh(
    latest_snapshot: Option<&DesktopStateSnapshot>,
    latest_endpoint: Option<&ProjectServiceEndpoint>,
    refresh_failure: &mut DashboardSnapshotRefreshFailure,
    load_result: Result<DashboardSnapshotLoad>,
    mut record_event: impl FnMut(DashboardSnapshotRefreshRepairEvent),
) -> Result<DashboardSnapshotRefreshOutcome> {
    match load_result {
        Ok(loaded) => {
            if let Some(error) = refresh_failure.current_error.take() {
                record_event(DashboardSnapshotRefreshRepairEvent {
                    status: STATUS_REPAIRED,
                    error,
                });
            }
            Ok(DashboardSnapshotRefreshOutcome::Loaded(loaded))
        }
        Err(error) => {
            let message = dashboard_snapshot_refresh_error_message(&error);
            let Some(snapshot) = latest_snapshot else {
                return Err(error.context("load initial dashboard snapshot"));
            };
            if refresh_failure.current_error.as_deref() != Some(message.as_str()) {
                record_event(DashboardSnapshotRefreshRepairEvent {
                    status: STATUS_FAILED,
                    error: message.clone(),
                });
            }
            refresh_failure.current_error = Some(message.clone());
            Ok(DashboardSnapshotRefreshOutcome::Stale {
                snapshot: snapshot.clone(),
                endpoint: latest_endpoint.cloned(),
                footer_message: dashboard_snapshot_refresh_footer(&message),
            })
        }
    }
}

pub fn record_dashboard_snapshot_refresh_repair_event(
    resolver: &PathResolver,
    project_root: &Path,
    event: &DashboardSnapshotRefreshRepairEvent,
) {
    record_repair_event_for_project(
        resolver,
        &project_root.to_string_lossy(),
        ACTION_DASHBOARD_REFRESH,
        "dashboard-refresh",
        event.status,
        Some(json!({ "error": event.error })),
    );
}

fn dashboard_snapshot_refresh_error_message(error: &anyhow::Error) -> String {
    format!("{error:#}")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(": ")
}

fn dashboard_snapshot_refresh_footer(error: &str) -> String {
    format!("Dashboard data stale: {error}; retrying")
}

fn scribe_preview_entries_for_render(
    options: &NativeDashboardOptions,
    snapshot: &DesktopStateSnapshot,
    selected_session_id: Option<&str>,
    controller: &DashboardController,
) -> Vec<WorkOutlineEntry> {
    if controller.preview_source != "scribe" || !dashboard_has_live_scribe(snapshot) {
        return Vec::new();
    }
    let Some(selected) = selected_session_id.and_then(|session_id| {
        snapshot
            .sessions
            .iter()
            .find(|session| session.id == session_id)
    }) else {
        return Vec::new();
    };
    let mut resolver = PathResolver::from_env();
    let project_state_dir = resolver.project_state_dir_for(&options.project_root);
    let direct = list_work_outline_entries(
        &project_state_dir,
        WorkOutlineQuery {
            session_id: Some(selected.id.clone()),
            limit: Some(6),
            ..WorkOutlineQuery::default()
        },
    );
    if !direct.is_empty() || selected.worktree_path.is_none() {
        return direct;
    }
    list_work_outline_entries(
        project_state_dir,
        WorkOutlineQuery {
            worktree_path: selected.worktree_path.clone(),
            limit: Some(6),
            ..WorkOutlineQuery::default()
        },
    )
}

fn load_work_outline_overlay_entries(
    options: &NativeDashboardOptions,
    session_id: Option<&str>,
) -> Vec<WorkOutlineEntry> {
    let mut resolver = PathResolver::from_env();
    let project_state_dir = resolver.project_state_dir_for(&options.project_root);
    list_work_outline_entries(
        project_state_dir,
        WorkOutlineQuery {
            session_id: session_id.map(str::to_owned),
            ..WorkOutlineQuery::default()
        },
    )
}

fn dashboard_has_live_scribe(snapshot: &DesktopStateSnapshot) -> bool {
    snapshot.sessions.iter().any(|session| {
        !matches!(
            session.status,
            SessionStatus::Offline | SessionStatus::Exited
        ) && dashboard_is_scribe_session(session)
    })
}

fn dashboard_is_scribe_session(session: &crate::dashboard_model::DashboardSession) -> bool {
    is_dashboard_scribe_session(session)
}

fn cache_cleanup_result_from_response(response: serde_json::Value) -> Result<serde_json::Value> {
    if let Some(result) = response.get("result").filter(|value| value.is_object()) {
        return Ok(result.clone());
    }
    if response.is_object() {
        return Ok(response);
    }
    Err(anyhow::anyhow!(
        "project service returned invalid worktree cache cleanup response"
    ))
}

/// The summary, and whether any of the deletions failed. A cleanup that could
/// not remove three of four items is reporting three failures, and the note
/// channel erases it on the next keypress.
fn worktree_cache_cleanup_summary(result: &serde_json::Value) -> (String, bool) {
    let target_count = result
        .get("plan")
        .and_then(|plan| plan.get("targets"))
        .and_then(serde_json::Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    let reclaimed_bytes = result
        .get("reclaimedBytes")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0);
    let failed = result
        .get("results")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|entry| entry.get("status").and_then(serde_json::Value::as_str) == Some("failed"))
        .count();
    let message = format!(
        "Removed {} from {target_count} cache item(s); {failed} failed.",
        crate::dashboard_service_input::format_worktree_cache_bytes(reclaimed_bytes)
    );
    (message, failed > 0)
}

fn parse_desktop_state_snapshot(contents: &str) -> Result<DesktopStateSnapshot> {
    serde_json::from_str::<DesktopStateSnapshot>(contents).or_else(|_| {
        serde_json::from_str::<DesktopStateGoldenFixture>(contents)
            .map(|fixture| fixture.runtime_full)
            .map_err(anyhow::Error::from)
    })
}

/// Seed navigation from persisted client state on the first paint only.
///
/// Persisted state is a resume hint, not an authority. Restoring it on every
/// refresh-driven render overwrote the live controller, so releasing a held
/// arrow key made the selection walk back up the list one refresh at a time:
/// keypress renders skip the restore, refresh renders undid them.
/// What the pointer is on, taken from the snapshot that is being replaced.
/// `None` on the first frame, when a worktree row rather than an agent is
/// selected, or when the selection no longer resolves — all cases where there
/// is nothing to carry.
fn carried_dashboard_selection(
    controller: Option<&DashboardController>,
    previous: Option<&DesktopStateSnapshot>,
) -> Option<CarriedSelection> {
    let (controller, previous) = controller.zip(previous)?;
    controller
        .navigation
        .selected_entry(previous)
        .as_ref()
        .map(CarriedSelection::from_entry)
}

fn restore_dashboard_navigation_for_render(
    ui_state: Option<&DashboardUiStatePersistence>,
    controller: &mut DashboardController,
    snapshot: &DesktopStateSnapshot,
    render_requested_by_input: bool,
    rendered_once: bool,
) {
    if render_requested_by_input || rendered_once {
        return;
    }
    let Some(ui_state) = ui_state else {
        return;
    };
    ui_state.restore_navigation(&mut controller.navigation, snapshot);
}

/// Dashboard-loop elapsed milliseconds, used only to age pending-action overlays.
fn pending_action_now_ms(clock_start: Instant) -> i64 {
    elapsed_millis(clock_start)
}

/// A mutation held back until its optimistic frame has been written, paired with
/// the overlay to drop if the request never leaves.
type DeferredDashboardRequest = (DashboardActionRequest, Option<(PendingTarget, String, u64)>);

/// Send the mutations queued during key handling, now that the optimistic frame
/// has been written. Clears the overlay for any request that never left.
/// The outcome of a mutation that ran off the render thread.
struct DashboardRequestOutcome {
    pending: Option<(PendingTarget, String, u64)>,
    /// Which action settled, so a failure can be tagged with it and a later
    /// success can answer that same one and nobody else's.
    action: Option<DashboardActionIdentity>,
    failure: Option<String>,
    /// What a successful mutation did, for the routes where succeeding quietly
    /// is indistinguishable from doing nothing.
    notice: Option<DashboardActionNotice>,
}

/// Send the mutations queued during key handling, now that the optimistic frame
/// has been written.
///
/// Each one runs on its own thread. A worktree graveyard is allowed 180s, and
/// running that inline froze the whole dashboard for its duration — no repaint,
/// no keys — which is what a slow graveyard looked like from the outside.
fn flush_deferred_dashboard_requests(
    deferred: &mut Vec<DeferredDashboardRequest>,
    endpoint: Option<&ProjectServiceEndpoint>,
    pending_actions: &mut DashboardPendingActions,
    mut controller: Option<&mut DashboardController>,
    outcomes: &mpsc::Sender<DashboardRequestOutcome>,
) {
    if deferred.is_empty() {
        return;
    }
    for (request, pending) in deferred.drain(..) {
        let Some(endpoint) = endpoint.cloned() else {
            if let Some(controller) = controller.as_deref_mut() {
                // A failure, so the channel that survives a keypress. No
                // request was sent, so nothing settling can answer it: it goes
                // when the user dismisses it.
                controller.footer_alert = Some(DashboardFailureAlert::local(
                    "Dashboard action requires a project-service endpoint",
                ));
                // The request never left, so no outcome will ever arrive to
                // take down a progress note -- and a progress note outlives
                // keypresses, so it would sit there claiming work that is not
                // happening. Only this request's note: an unrelated action
                // failing to send is not news about a worktree create that is
                // still running.
                controller.clear_progress_for(Some(&DashboardActionIdentity::of(&request)));
            }
            if let Some((target, id, token)) = pending.as_ref() {
                pending_actions.clear_if_token(*target, id, *token);
            }
            continue;
        };
        let outcomes = outcomes.clone();
        // Captured here, before the request is handed to the thread that sends
        // it. `execute_dashboard_controller_action` injects the caller's tmux
        // pane into the body on its way out, so an identity taken in there
        // would carry whichever pane happened to dispatch it -- and a focus
        // retried from a different pane would never answer its own failure.
        let action = Some(DashboardActionIdentity::of(&request));
        thread::spawn(move || {
            let (failure, notice) = match execute_dashboard_controller_action(&endpoint, &request) {
                Ok(body) => (None, dashboard_action_notice(request.path, &body)),
                Err(error) => (Some(error.to_string()), None),
            };
            let _ = outcomes.send(DashboardRequestOutcome {
                pending,
                action,
                failure,
                notice,
            });
        });
    }
}

/// The sentence a finished mutation leaves in the footer, and whether it is
/// reporting something that went wrong.
///
/// A 200 is not the same as a success: a restore that brought back 2 of 36
/// answers OK and then names the 34 that did not come back, and that sentence
/// is the only report of them there is.
#[derive(Debug, Clone)]
struct DashboardActionNotice {
    message: String,
    failed: bool,
}

/// The sentence a finished mutation leaves in the footer. Only routes whose
/// success is otherwise invisible have one.
fn dashboard_action_notice(path: &str, body: &Value) -> Option<DashboardActionNotice> {
    if path == crate::project_api_contract::routes::agents::RESTORE_PREVIOUS {
        return crate::agent_restore_outcome::restore_outcome_message(body).map(|message| {
            DashboardActionNotice {
                message,
                failed: crate::agent_restore_outcome::restore_outcome_failed(body),
            }
        });
    }
    None
}

/// Apply whatever off-thread mutations have finished. Returns true if the frame
/// needs repainting.
fn drain_dashboard_request_outcomes(
    outcomes: &Receiver<DashboardRequestOutcome>,
    pending_actions: &mut DashboardPendingActions,
    mut controller: Option<&mut DashboardController>,
) -> bool {
    let mut changed = false;
    while let Ok(outcome) = outcomes.try_recv() {
        changed = true;
        if let Some(message) = outcome.failure {
            if let Some(controller) = controller.as_deref_mut() {
                controller.clear_progress_for(outcome.action.as_ref());
                // A failed action is an alert, not a note: it outlives the next
                // keypress and is dismissed deliberately. Tagged with the action
                // it was about, so a later success for that same thing can take
                // it down and a success for anything else cannot.
                controller.footer_alert = Some(match outcome.action.clone() {
                    Some(action) => DashboardFailureAlert::for_action(message, action),
                    None => DashboardFailureAlert::local(message),
                });
            }
            if let Some((target, id, token)) = outcome.pending.as_ref() {
                pending_actions.clear_if_token(*target, id, *token);
            }
        } else {
            if let Some(controller) = controller.as_deref_mut()
                && let Some(action) = outcome.action.as_ref()
                && controller
                    .footer_alert
                    .as_ref()
                    .is_some_and(|alert| alert.answered_by(action))
            {
                // The action the failure was about has now succeeded. Leaving
                // the refusal up after the user fixed it and retried is its own
                // small lie -- and the alert outlives keypresses, so nothing
                // else would take it down.
                controller.footer_alert = None;
            }
            if let Some(controller) = controller.as_deref_mut() {
                // Whether or not there is a notice to replace it with: a 200
                // whose body is not an outcome leaves `notice` empty, and the
                // progress note would outlive the work. Keyed on the action, so
                // an unrelated faster request cannot end this one's report.
                controller.clear_progress_for(outcome.action.as_ref());
                if let Some(notice) = outcome.notice {
                    if notice.failed {
                        // A 200 that names what did not work is a failure
                        // report, and the note channel erases it on the next
                        // key -- which for a 36-agent restore is immediately.
                        // Tagged with the action, so a retry where everything
                        // comes back answers it instead of stacking under it.
                        controller.footer_alert = Some(match outcome.action.clone() {
                            Some(action) => {
                                DashboardFailureAlert::for_action(notice.message, action)
                            }
                            None => DashboardFailureAlert::local(notice.message),
                        });
                    } else {
                        controller.set_note(notice.message);
                    }
                }
            }
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOLDEN_SNAPSHOT: &str =
        include_str!("../../../../src/multiplexer/desktop-state-golden.fixture.json");

    fn test_snapshot() -> DesktopStateSnapshot {
        parse_desktop_state_snapshot(GOLDEN_SNAPSHOT).expect("golden snapshot")
    }

    fn stop_agent(session_id: &str) -> DashboardActionIdentity {
        DashboardActionIdentity {
            path: crate::project_api_contract::routes::agents::STOP,
            body: serde_json::json!({ "sessionId": session_id }),
        }
    }

    fn restore_previous() -> DashboardActionIdentity {
        DashboardActionIdentity {
            path: crate::project_api_contract::routes::agents::RESTORE_PREVIOUS,
            body: serde_json::json!({}),
        }
    }

    /// A success that lands late must not take down a failure it did not answer.
    ///
    /// Requests run on detached threads and a graveyard is allowed 180s, so an
    /// outcome routinely arrives after the user has done something else.
    /// Clearing on any successful outcome made a slow success silently erase a
    /// refusal raised minutes later; clearing on any dispatched request erased
    /// it a step earlier. Neither asked whether the two were about the same
    /// thing, so the alert carries which action it was.
    #[test]
    fn a_late_success_does_not_erase_a_failure_it_did_not_answer() {
        let snapshot = test_snapshot();
        let mut controller = DashboardController::new(&snapshot);
        controller.footer_alert = Some(DashboardFailureAlert::for_action(
            "Could not stop agent claude-a",
            stop_agent("claude-a"),
        ));

        let (tx, rx) = mpsc::channel::<DashboardRequestOutcome>();
        tx.send(DashboardRequestOutcome {
            pending: None,
            action: Some(DashboardActionIdentity {
                path: crate::project_api_contract::routes::worktree_actions::GRAVEYARD,
                body: serde_json::json!({ "path": "/repo/.aimux/worktrees/other-tree" }),
            }),
            failure: None,
            notice: Some(DashboardActionNotice {
                message: "Worktree other-tree moved to the graveyard".into(),
                failed: false,
            }),
        })
        .expect("queue outcome");
        drop(tx);

        let mut pending_actions = DashboardPendingActions::default();
        drain_dashboard_request_outcomes(&rx, &mut pending_actions, Some(&mut controller));

        assert_eq!(
            controller.footer_alert_message(),
            Some("Could not stop agent claude-a"),
            "a different action's success is not an answer to this failure"
        );
        assert_eq!(
            controller.footer_note_message(),
            Some("Worktree other-tree moved to the graveyard"),
            "and the success still reports itself"
        );
    }

    /// The one path that sets a progress note and then never sends the request
    /// it was reporting. No outcome ever arrives, and a progress note outlives
    /// keypresses, so without this it claims work that is not happening for as
    /// long as the dashboard stays open.
    #[test]
    fn a_request_that_never_left_does_not_leave_its_progress_note_behind() {
        let snapshot = test_snapshot();
        let mut controller = DashboardController::new(&snapshot);
        controller.set_progress("Restoring 36 agents".into(), restore_previous());

        let (tx, _rx) = mpsc::channel::<DashboardRequestOutcome>();
        let mut deferred: Vec<DeferredDashboardRequest> = vec![(
            DashboardActionRequest {
                method: "POST",
                path: crate::project_api_contract::routes::agents::RESTORE_PREVIOUS,
                body: serde_json::json!({}),
            },
            None,
        )];
        let mut pending_actions = DashboardPendingActions::default();

        flush_deferred_dashboard_requests(
            &mut deferred,
            None,
            &mut pending_actions,
            Some(&mut controller),
            &tx,
        );

        assert_eq!(controller.footer_progress_message(), None);
        assert_eq!(
            controller.footer_alert_message(),
            Some("Dashboard action requires a project-service endpoint")
        );
    }

    /// A create reports itself in the footer and is taken down by its own
    /// outcome — the two halves built from the same request, by one constructor.
    ///
    /// A worktree create is allowed 180s. It paints no row, because the row it
    /// makes does not exist yet, so this note is the only thing on screen
    /// saying the key did anything.
    #[test]
    fn a_create_reports_itself_in_the_footer_until_its_own_outcome_returns() {
        let snapshot = test_snapshot();
        let mut controller = DashboardController::new(&snapshot);
        let request = DashboardActionRequest {
            method: "POST",
            path: crate::project_api_contract::routes::worktree_actions::CREATE,
            body: serde_json::json!({ "name": "feature-a" }),
        };
        let message = progress_for_request(request.path, &request.body).expect("a sentence");
        controller.set_progress(message, DashboardActionIdentity::of(&request));
        assert_eq!(
            controller.footer_progress_message(),
            Some("Creating worktree feature-a")
        );

        // A key in the meantime is the whole reason this is not a note.
        controller.handle_key(
            &snapshot,
            crate::dashboard_controller::DashboardKey::Printable('j'),
        );
        assert_eq!(
            controller.footer_progress_message(),
            Some("Creating worktree feature-a"),
            "a progress note outlives the keys pressed while it runs"
        );

        // Somebody else's outcome is not an answer to this one.
        let (tx, rx) = mpsc::channel::<DashboardRequestOutcome>();
        tx.send(DashboardRequestOutcome {
            pending: None,
            action: Some(stop_agent("claude-a")),
            failure: None,
            notice: None,
        })
        .expect("send");
        let mut pending_actions = DashboardPendingActions::default();
        drain_dashboard_request_outcomes(&rx, &mut pending_actions, Some(&mut controller));
        assert_eq!(
            controller.footer_progress_message(),
            Some("Creating worktree feature-a")
        );

        // Its own, built the way `flush_deferred_dashboard_requests` builds it.
        tx.send(DashboardRequestOutcome {
            pending: None,
            action: Some(DashboardActionIdentity::of(&request)),
            failure: None,
            notice: None,
        })
        .expect("send");
        drain_dashboard_request_outcomes(&rx, &mut pending_actions, Some(&mut controller));
        assert_eq!(controller.footer_progress_message(), None);
    }

    /// A different action failing to send does not take down this one's note.
    ///
    /// The no-endpoint path used to clear whatever note was live. Press `n`,
    /// name a worktree, and while its 180s of git work runs press `s` on an
    /// agent: that second request takes the no-endpoint arm and erased the
    /// create's report, leaving an alert about something else entirely.
    #[test]
    fn a_different_action_that_never_left_keeps_this_one_s_report() {
        let snapshot = test_snapshot();
        let mut controller = DashboardController::new(&snapshot);
        let create = DashboardActionRequest {
            method: "POST",
            path: crate::project_api_contract::routes::worktree_actions::CREATE,
            body: serde_json::json!({ "name": "feature-a" }),
        };
        controller.set_progress(
            progress_for_request(create.path, &create.body).expect("a sentence"),
            DashboardActionIdentity::of(&create),
        );

        let (tx, _rx) = mpsc::channel::<DashboardRequestOutcome>();
        let mut deferred: Vec<DeferredDashboardRequest> = vec![(
            DashboardActionRequest {
                method: "POST",
                path: crate::project_api_contract::routes::agents::STOP,
                body: serde_json::json!({ "sessionId": "claude-a" }),
            },
            None,
        )];
        let mut pending_actions = DashboardPendingActions::default();

        flush_deferred_dashboard_requests(
            &mut deferred,
            None,
            &mut pending_actions,
            Some(&mut controller),
            &tx,
        );

        assert_eq!(
            controller.footer_progress_message(),
            Some("Creating worktree feature-a"),
            "the create is still running; the stop is what could not be sent"
        );
        assert_eq!(
            controller.footer_alert_message(),
            Some("Dashboard action requires a project-service endpoint")
        );
    }

    /// Two presses are two requests, and the note stands until both are back.
    ///
    /// Two unnamed spawns of one tool build byte-identical bodies, so they are
    /// one identity and two requests. Clearing on the first outcome ended the
    /// note while the second was still running -- and the first outcome is
    /// usually the lifecycle queue's 409 for the duplicate, so the report that
    /// replaced it was a failure for work that was going fine.
    ///
    /// Suppressing the second press instead was worse: `c`, claude, `c`, claude
    /// is two different agents, and the second produced no request, no note and
    /// no refusal.
    #[test]
    fn a_second_press_keeps_the_note_until_both_requests_are_back() {
        let snapshot = test_snapshot();
        let mut controller = DashboardController::new(&snapshot);
        let spawn = DashboardActionRequest {
            method: "POST",
            path: crate::project_api_contract::routes::agents::SPAWN,
            body: serde_json::json!({ "tool": "claude", "open": false }),
        };
        let message = progress_for_request(spawn.path, &spawn.body).expect("a sentence");
        controller.set_progress(message.clone(), DashboardActionIdentity::of(&spawn));
        controller.set_progress(message, DashboardActionIdentity::of(&spawn));

        let (tx, rx) = mpsc::channel::<DashboardRequestOutcome>();
        let mut pending_actions = DashboardPendingActions::default();
        tx.send(DashboardRequestOutcome {
            pending: None,
            action: Some(DashboardActionIdentity::of(&spawn)),
            failure: Some("dashboard action failed: lifecycle mutation already in progress".into()),
            notice: None,
        })
        .expect("send");
        drain_dashboard_request_outcomes(&rx, &mut pending_actions, Some(&mut controller));
        assert_eq!(
            controller.footer_progress_message(),
            Some("Creating claude agent"),
            "the other one is still running"
        );
        assert!(
            controller.footer_alert_message().is_some(),
            "and the refusal is still reported rather than swallowed"
        );

        tx.send(DashboardRequestOutcome {
            pending: None,
            action: Some(DashboardActionIdentity::of(&spawn)),
            failure: None,
            notice: None,
        })
        .expect("send");
        drain_dashboard_request_outcomes(&rx, &mut pending_actions, Some(&mut controller));
        assert_eq!(controller.footer_progress_message(), None);
    }

    /// The restore prompt raises its own progress note and then returns the
    /// request, so a guard that refused to send what the footer already
    /// reported would never send it at all.
    #[test]
    fn the_restore_prompt_still_dispatches_the_request_it_reports() {
        let mut snapshot = test_snapshot();
        snapshot.agent_restore_offer = Some(
            serde_json::from_value(serde_json::json!({
                "id": "offer-1",
                "updatedAt": "2026-01-01T00:00:00.000Z",
                "sessionIds": ["claude-a", "claude-b"],
                "sessions": [],
            }))
            .expect("offer"),
        );
        let mut controller = DashboardController::new(&snapshot);

        let effect = controller.handle_key(
            &snapshot,
            crate::dashboard_controller::DashboardKey::Printable('y'),
        );
        let DashboardControllerEffect::Request(request) = effect else {
            panic!("expected the restore request");
        };
        assert_eq!(
            request.path,
            crate::project_api_contract::routes::agents::RESTORE_PREVIOUS
        );
        assert_eq!(
            controller.footer_progress_message(),
            Some("Restoring 2 agents…")
        );
    }

    /// "Aimux is updating", "is reconnecting", "is repairing tmux": four of the
    /// six guard states are a wait that ends on its own, and all six wore the
    /// red modal with a warning triangle.
    #[test]
    fn a_wait_that_ends_on_its_own_is_not_drawn_as_an_emergency() {
        let viewport = DashboardViewport {
            cols: 100,
            rows: 30,
        };
        let waiting = DashboardRuntimeGuardStatus {
            state: RuntimeGuardState::Disconnected,
            entered_at: Some(Instant::now()),
            ..DashboardRuntimeGuardStatus::default()
        };
        let overlay = render_dashboard_runtime_guard_overlay(Some(&waiting), viewport)
            .expect("a waiting overlay");
        assert!(overlay.contains("RECONNECTING"), "{overlay:?}");
        assert!(
            !overlay.contains('⚠'),
            "a self-healing wait is not a warning"
        );
        assert!(
            !overlay.contains("\u{1b}[31m"),
            "nor is it painted in the failure tone"
        );

        let failing = DashboardRuntimeGuardStatus {
            state: RuntimeGuardState::Disconnected,
            entered_at: Some(Instant::now()),
            repair_error: Some("tmux refused".into()),
            ..DashboardRuntimeGuardStatus::default()
        };
        let overlay =
            render_dashboard_runtime_guard_overlay(Some(&failing), viewport).expect("an overlay");
        assert!(
            overlay.contains("\u{1b}[31m"),
            "a repair that failed is still a failure: {overlay:?}"
        );
    }

    /// A 200 is not the same as a success. The restore route answers OK and
    /// then names the agents that did not come back, and that sentence is the
    /// only report of them there is -- so it cannot go in the channel the next
    /// keypress clears.
    #[test]
    fn an_outcome_that_names_failures_outlives_the_next_keypress() {
        let snapshot = test_snapshot();
        let mut controller = DashboardController::new(&snapshot);
        controller.set_progress("Restoring 36 agents".into(), restore_previous());

        let (tx, rx) = mpsc::channel::<DashboardRequestOutcome>();
        tx.send(DashboardRequestOutcome {
            pending: None,
            action: Some(restore_previous()),
            failure: None,
            notice: Some(DashboardActionNotice {
                message: "Restored 2 of 36; 34 could not be restored: claude-7".into(),
                failed: true,
            }),
        })
        .expect("queue outcome");
        drop(tx);

        let mut pending_actions = DashboardPendingActions::default();
        drain_dashboard_request_outcomes(&rx, &mut pending_actions, Some(&mut controller));
        controller.handle_key(&snapshot, crate::dashboard_controller::DashboardKey::Down);

        assert_eq!(
            controller.footer_alert_message(),
            Some("Restored 2 of 36; 34 could not be restored: claude-7")
        );
    }

    /// And a clean one stays a note, so a restore that worked is not an alert
    /// the user has to dismiss.
    #[test]
    fn an_outcome_with_nothing_wrong_stays_a_note() {
        let snapshot = test_snapshot();
        let mut controller = DashboardController::new(&snapshot);

        let (tx, rx) = mpsc::channel::<DashboardRequestOutcome>();
        tx.send(DashboardRequestOutcome {
            pending: None,
            action: Some(restore_previous()),
            failure: None,
            notice: Some(DashboardActionNotice {
                message: "Restored 36 agents".into(),
                failed: false,
            }),
        })
        .expect("queue outcome");
        drop(tx);

        let mut pending_actions = DashboardPendingActions::default();
        drain_dashboard_request_outcomes(&rx, &mut pending_actions, Some(&mut controller));

        assert_eq!(controller.footer_note_message(), Some("Restored 36 agents"));
        assert_eq!(controller.footer_alert_message(), None);
    }

    /// The same shape in the other producer: a cleanup that could not remove
    /// three of four items is reporting three failures.
    #[test]
    fn a_cleanup_that_failed_some_deletions_says_so_durably() {
        let clean = serde_json::json!({
            "plan": { "targets": [{}, {}] },
            "reclaimedBytes": 1024.0,
            "results": [{ "status": "removed" }, { "status": "removed" }],
        });
        let (_, failed) = worktree_cache_cleanup_summary(&clean);
        assert!(!failed);

        let partial = serde_json::json!({
            "plan": { "targets": [{}, {}] },
            "reclaimedBytes": 1024.0,
            "results": [{ "status": "removed" }, { "status": "failed" }],
        });
        let (message, failed) = worktree_cache_cleanup_summary(&partial);
        assert!(failed, "{message}");
        assert!(message.contains("1 failed"), "{message}");
    }

    /// The report has to clear on the subscription being accepted, not on the
    /// first event: a healthy stream on a quiet project delivers nothing for
    /// minutes, and the bar would stand there saying it was down. Clearing on
    /// the spawn instead made it blink off at every failed retry.
    #[test]
    fn an_accepted_subscription_is_what_takes_the_report_down() {
        let mut down = Some("project service closed the stream".to_owned());
        let mut event_stream = None;
        let mut retry_at = None;
        let endpoint = ProjectServiceEndpoint {
            host: "127.0.0.1".to_owned(),
            port: 1,
        };

        reconcile_dashboard_event_stream(
            &mut event_stream,
            &mut retry_at,
            &mut down,
            &mut DashboardStreamHealth::default(),
            Some(&endpoint),
            false,
        );
        assert_eq!(
            down.as_deref(),
            Some("project service closed the stream"),
            "a connection attempt is not a reconnect"
        );

        // What `drain_dashboard_event_stream` does on `Opened`.
        assert!(down.take().is_some());
        assert_eq!(down, None);
    }

    /// A service that answers `/events` with a complete body accepts and closes
    /// on every retry. Clearing on each accept flashed the report off and on
    /// every couple of seconds; never clearing on an accept left a healthy but
    /// idle project saying its stream was down, because it delivers nothing for
    /// minutes.
    #[test]
    fn a_stream_that_opens_and_closes_without_delivering_keeps_saying_so() {
        let mut health = DashboardStreamHealth::default();

        // A healthy reconnect on an idle project: the accept is the proof,
        // because the project delivers nothing for minutes.
        assert!(health.accept_proves_recovery());

        // The broken service: accepted, closed, nothing delivered.
        health.observe_close();
        assert!(
            !health.accept_proves_recovery(),
            "an accept from a stream that closed empty is not proof of anything"
        );

        // Still not, however many times it does the same thing.
        health.observe_close();
        assert!(!health.accept_proves_recovery());

        // A delivered event is proof, and it is proof again afterwards.
        health.observe_delivery();
        assert!(health.accept_proves_recovery());
        health.observe_close();
        assert!(
            health.accept_proves_recovery(),
            "a stream that worked and then closed is a reconnect, not a broken endpoint"
        );

        // And the latch does not survive leaving: it is about one stream on one
        // project, and carrying it to the next one makes it a claim about
        // something it never saw.
        health.observe_close();
        assert!(!health.accept_proves_recovery());
        let fresh = DashboardStreamHealth::default();
        assert!(fresh.accept_proves_recovery());
    }

    /// A subscreen that silently stopped receiving events looked exactly like a
    /// subscreen with nothing happening, because the stream error reached only
    /// the dashboard's footer.
    #[test]
    fn a_dead_stream_is_said_on_a_subscreen_too() {
        let snapshot = test_snapshot();
        let mut controller = DashboardController::new(&snapshot);
        controller.screen = DashboardScreen::Coordination;
        let mut pending_actions = DashboardPendingActions::default();

        let frame = render_dashboard_subscreen_snapshot(
            DashboardViewport {
                cols: 140,
                rows: 36,
            },
            &mut controller,
            None,
            0,
            &mut pending_actions,
            0,
            Some("project service closed the stream"),
        );

        assert!(
            crate::tui_render::text::strip_ansi(&frame.frame)
                .contains("project service closed the stream"),
            "{}",
            crate::tui_render::text::strip_ansi(&frame.frame)
        );
    }

    /// A dead event stream retries every few seconds. Stored as a dismissible
    /// alert it came straight back faster than the user could clear it, and it
    /// outlived the reconnect that made it false -- so it is derived, and the
    /// reconnect removes it.
    #[test]
    fn the_stream_being_down_is_said_once_and_unsaid_by_the_reconnect() {
        let mut down: Option<String> = None;
        let mut event_stream = None;
        let mut retry_at = None;

        assert!(
            raise_stream_down(&mut down, "project service closed the stream"),
            "the first report is news"
        );
        for _ in 0..3 {
            assert!(
                !raise_stream_down(&mut down, "project service closed the stream"),
                "a retry that fails the same way is not news again"
            );
        }
        assert!(
            raise_stream_down(&mut down, "connection refused"),
            "failing a different way is news"
        );
        down = Some("project service closed the stream".to_owned());
        assert_eq!(down.as_deref(), Some("project service closed the stream"));

        let endpoint = ProjectServiceEndpoint {
            host: "127.0.0.1".to_owned(),
            port: 1,
        };
        reconcile_dashboard_event_stream(
            &mut event_stream,
            &mut retry_at,
            &mut down,
            &mut DashboardStreamHealth::default(),
            Some(&endpoint),
            false,
        );
        assert_eq!(
            down.as_deref(),
            Some("project service closed the stream"),
            "a retry that has not delivered anything is not a reconnect"
        );

        reconcile_dashboard_event_stream(
            &mut event_stream,
            &mut retry_at,
            &mut down,
            &mut DashboardStreamHealth::default(),
            None,
            true,
        );
        assert_eq!(down, None, "there is no stream to be down");
    }

    /// A progress note outlives keypresses, so the settling outcome is the only
    /// thing that can take it down. A 200 whose body is not a restore outcome
    /// produces no notice, and clearing only when there was one left the
    /// footer claiming work that had finished.
    #[test]
    fn a_settled_request_takes_its_progress_note_down_even_with_nothing_to_say() {
        let snapshot = test_snapshot();
        let mut controller = DashboardController::new(&snapshot);
        controller.set_progress("Restoring 36 agents".into(), restore_previous());

        let (tx, rx) = mpsc::channel::<DashboardRequestOutcome>();
        tx.send(DashboardRequestOutcome {
            pending: None,
            action: Some(restore_previous()),
            failure: None,
            notice: None,
        })
        .expect("queue outcome");
        drop(tx);

        let mut pending_actions = DashboardPendingActions::default();
        drain_dashboard_request_outcomes(&rx, &mut pending_actions, Some(&mut controller));

        assert_eq!(controller.footer_progress_message(), None);
    }

    /// And the other direction, which is the whole reason the note carries the
    /// action: a faster unrelated request settling first used to end the
    /// restore's report while the restore was still running.
    #[test]
    fn another_action_settling_first_does_not_end_this_one_s_report() {
        let snapshot = test_snapshot();
        let mut controller = DashboardController::new(&snapshot);
        controller.set_progress("Restoring 36 agents".into(), restore_previous());

        let (tx, rx) = mpsc::channel::<DashboardRequestOutcome>();
        tx.send(DashboardRequestOutcome {
            pending: None,
            action: Some(stop_agent("claude-a")),
            failure: None,
            notice: None,
        })
        .expect("queue outcome");
        drop(tx);

        let mut pending_actions = DashboardPendingActions::default();
        drain_dashboard_request_outcomes(&rx, &mut pending_actions, Some(&mut controller));

        assert_eq!(
            controller.footer_progress_message(),
            Some("Restoring 36 agents")
        );
    }

    /// And a failed one, where the alert is what the user should be reading.
    #[test]
    fn a_failed_request_takes_its_progress_note_down_too() {
        let snapshot = test_snapshot();
        let mut controller = DashboardController::new(&snapshot);
        controller.set_progress("Restoring 36 agents".into(), restore_previous());

        let (tx, rx) = mpsc::channel::<DashboardRequestOutcome>();
        tx.send(DashboardRequestOutcome {
            pending: None,
            action: Some(restore_previous()),
            failure: Some("project service refused".into()),
            notice: None,
        })
        .expect("queue outcome");
        drop(tx);

        let mut pending_actions = DashboardPendingActions::default();
        drain_dashboard_request_outcomes(&rx, &mut pending_actions, Some(&mut controller));

        assert_eq!(controller.footer_progress_message(), None);
        assert_eq!(
            controller.footer_alert_message(),
            Some("project service refused")
        );
    }

    /// Nor may the same route against a different target answer it.
    ///
    /// The negative cases all used to differ in BOTH the route and the target,
    /// so comparing only one of the two passed every test -- and comparing only
    /// the route is exactly the mistake that erases one agent's failure when
    /// another agent is stopped.
    #[test]
    fn the_same_route_against_another_target_does_not_answer_it() {
        let snapshot = test_snapshot();
        let mut controller = DashboardController::new(&snapshot);
        controller.footer_alert = Some(DashboardFailureAlert::for_action(
            "Could not stop agent claude-a",
            stop_agent("claude-a"),
        ));

        let (tx, rx) = mpsc::channel::<DashboardRequestOutcome>();
        tx.send(DashboardRequestOutcome {
            pending: None,
            action: Some(stop_agent("claude-b")),
            failure: None,
            notice: None,
        })
        .expect("queue outcome");
        drop(tx);

        let mut pending_actions = DashboardPendingActions::default();
        drain_dashboard_request_outcomes(&rx, &mut pending_actions, Some(&mut controller));

        assert_eq!(
            controller.footer_alert_message(),
            Some("Could not stop agent claude-a"),
            "stopping a different agent says nothing about this one"
        );
    }

    /// And the same target on a different route does not answer it either.
    #[test]
    fn another_route_against_the_same_target_does_not_answer_it() {
        let snapshot = test_snapshot();
        let mut controller = DashboardController::new(&snapshot);
        controller.footer_alert = Some(DashboardFailureAlert::for_action(
            "Could not stop agent claude-a",
            stop_agent("claude-a"),
        ));

        let (tx, rx) = mpsc::channel::<DashboardRequestOutcome>();
        tx.send(DashboardRequestOutcome {
            pending: None,
            action: Some(DashboardActionIdentity {
                path: crate::project_api_contract::routes::agents::RESUME,
                body: serde_json::json!({ "sessionId": "claude-a" }),
            }),
            failure: None,
            notice: None,
        })
        .expect("queue outcome");
        drop(tx);

        let mut pending_actions = DashboardPendingActions::default();
        drain_dashboard_request_outcomes(&rx, &mut pending_actions, Some(&mut controller));

        assert_eq!(
            controller.footer_alert_message(),
            Some("Could not stop agent claude-a"),
            "resuming it is not the same answer as stopping it"
        );
    }

    /// But the success for the very thing that failed does take it down.
    ///
    /// The user stops the agent, it fails, they fix it and stop it again: the
    /// red bar still saying it could not be stopped is its own small lie, and
    /// the alert outlives keypresses now, so nothing else would clear it.
    #[test]
    fn a_success_takes_down_the_failure_it_answers() {
        let snapshot = test_snapshot();
        let mut controller = DashboardController::new(&snapshot);
        controller.footer_alert = Some(DashboardFailureAlert::for_action(
            "Could not stop agent claude-a",
            stop_agent("claude-a"),
        ));

        let (tx, rx) = mpsc::channel::<DashboardRequestOutcome>();
        tx.send(DashboardRequestOutcome {
            pending: None,
            action: Some(stop_agent("claude-a")),
            failure: None,
            notice: None,
        })
        .expect("queue outcome");
        drop(tx);

        let mut pending_actions = DashboardPendingActions::default();
        drain_dashboard_request_outcomes(&rx, &mut pending_actions, Some(&mut controller));

        assert_eq!(controller.footer_alert, None);
    }

    /// A refusal the client raised itself has no action behind it, so no
    /// settling outcome can answer it -- only `X` or a fresh attempt.
    #[test]
    fn a_local_refusal_is_not_answered_by_any_outcome() {
        let snapshot = test_snapshot();
        let mut controller = DashboardController::new(&snapshot);
        controller.footer_alert = Some(DashboardFailureAlert::local(
            "Cannot graveyard fix-chat: agent \"claude\" is attached. Stop it first.",
        ));

        let (tx, rx) = mpsc::channel::<DashboardRequestOutcome>();
        tx.send(DashboardRequestOutcome {
            pending: None,
            action: Some(DashboardActionIdentity {
                path: crate::project_api_contract::routes::worktree_actions::GRAVEYARD,
                body: serde_json::json!({ "path": "/repo/.aimux/worktrees/fix-chat" }),
            }),
            failure: None,
            notice: None,
        })
        .expect("queue outcome");
        drop(tx);

        let mut pending_actions = DashboardPendingActions::default();
        drain_dashboard_request_outcomes(&rx, &mut pending_actions, Some(&mut controller));

        assert!(
            controller.footer_alert.is_some(),
            "nothing was dispatched for this refusal, so nothing settles it"
        );
    }

    /// And a failure still arrives on the channel that survives a keypress,
    /// tagged with the action it was about.
    #[test]
    fn a_failed_outcome_lands_on_the_alert_channel() {
        let snapshot = test_snapshot();
        let mut controller = DashboardController::new(&snapshot);

        let (tx, rx) = mpsc::channel::<DashboardRequestOutcome>();
        tx.send(DashboardRequestOutcome {
            pending: None,
            action: Some(stop_agent("claude-a")),
            failure: Some("Could not stop agent claude-a".into()),
            notice: None,
        })
        .expect("queue outcome");
        drop(tx);

        let mut pending_actions = DashboardPendingActions::default();
        drain_dashboard_request_outcomes(&rx, &mut pending_actions, Some(&mut controller));

        let alert = controller.footer_alert.expect("a failure");
        assert_eq!(alert.message, "Could not stop agent claude-a");
        assert!(
            alert.answered_by(&stop_agent("claude-a")),
            "a retry of this very action is what answers it"
        );
    }

    /// The real shape: a settled action carries both an overlay token and an
    /// identity, and the drain has to honour both.
    ///
    /// Every other test in this module sends `pending: None`, so the optimistic
    /// overlay's token path through here was never exercised alongside the
    /// alert's -- and the two live one line apart.
    #[test]
    fn a_settled_action_clears_its_overlay_and_tags_its_failure() {
        let snapshot = test_snapshot();
        let mut controller = DashboardController::new(&snapshot);
        let mut pending_actions = DashboardPendingActions::default();
        let token = pending_actions.set_session_action(
            "claude-a",
            "stopping",
            pending_action_now_ms(std::time::Instant::now()),
        );
        assert!(
            !pending_actions.is_empty(),
            "precondition: the overlay is showing"
        );

        let (tx, rx) = mpsc::channel::<DashboardRequestOutcome>();
        tx.send(DashboardRequestOutcome {
            pending: Some((PendingTarget::Session, "claude-a".into(), token)),
            action: Some(stop_agent("claude-a")),
            failure: Some("Could not stop agent claude-a".into()),
            notice: None,
        })
        .expect("queue outcome");
        drop(tx);

        drain_dashboard_request_outcomes(&rx, &mut pending_actions, Some(&mut controller));

        assert!(
            pending_actions.is_empty(),
            "a failed action must stop pretending it is still underway"
        );
        let alert = controller.footer_alert.as_ref().expect("a failure");
        assert!(
            alert.answered_by(&stop_agent("claude-a")),
            "and it must be answerable by its own retry"
        );
    }

    /// The case this exists for: `2` then `1` on the dashboard. Each digit is a
    /// pointer move, and a pointer move needs no new data -- so neither digit
    /// pays for a `desktop-state` round trip before its frame is on screen.
    #[test]
    fn a_pointer_move_paints_from_the_snapshot_already_in_hand() {
        assert_eq!(
            dashboard_render_source(DashboardRenderSourceInput {
                has_snapshot: true,
                rendered_once: true,
                render_requested: true,
                screen: DashboardScreen::Dashboard,
                input_driven: true,
                cacheable_input: true,
                render_from_data: false,
                selection_move_pending: false,
                forced_refresh: false,
            }),
            DashboardRenderSource::CachedSnapshot,
        );
    }

    /// The second digit lands a beat after the first, and the deferred fetch
    /// waits for it rather than repainting between two keys the user meant as
    /// one. This is the timer only -- what keeps the jump itself correct when
    /// something else does refresh is the anchor, in `dashboard_navigation`.
    #[test]
    fn a_deferred_fetch_waits_for_the_jump_to_finish() {
        for gap in [10, 100, 400, 900] {
            assert!(
                !dashboard_refresh_deferral_expired(
                    Some(Duration::from_millis(gap)),
                    Some(Duration::from_millis(gap)),
                    true,
                ),
                "a jump {gap}ms in still owns the list it started against"
            );
        }
    }

    /// An abandoned chord is still bounded: the ceiling pays the fetch even
    /// though the digit is still pending, so walking away mid-jump cannot
    /// freeze the dashboard on stale data.
    #[test]
    fn an_abandoned_jump_still_lets_the_data_catch_up() {
        assert!(dashboard_refresh_deferral_expired(
            Some(DASHBOARD_DEFERRED_REFRESH_CEILING),
            Some(DASHBOARD_DEFERRED_REFRESH_CEILING),
            true,
        ));
    }

    /// Between keypresses the clock is idle time, not time since the first
    /// deferral -- otherwise a run of keys pays a fetch partway through it.
    #[test]
    fn a_run_of_keys_stays_on_the_fast_path_and_settles_after_it() {
        assert!(
            !dashboard_refresh_deferral_expired(
                Some(Duration::from_millis(800)),
                Some(Duration::from_millis(20)),
                false,
            ),
            "still typing"
        );
        assert!(
            dashboard_refresh_deferral_expired(
                Some(Duration::from_millis(800)),
                Some(DASHBOARD_DEFERRED_REFRESH_BUDGET),
                false,
            ),
            "stopped typing"
        );
        assert!(
            dashboard_refresh_deferral_expired(
                Some(DASHBOARD_DEFERRED_REFRESH_CEILING),
                Some(Duration::from_millis(0)),
                false,
            ),
            "never stops typing"
        );
    }

    /// Nothing deferred, nothing owed -- however long ago the last frame was.
    #[test]
    fn no_deferral_asks_for_nothing() {
        for idle in [None, Some(Duration::from_secs(60))] {
            assert!(
                !dashboard_refresh_deferral_expired(None, idle, false),
                "nothing was deferred, so nothing is due: idle={idle:?}"
            );
        }
    }

    /// Each of these makes the held snapshot the wrong thing to paint, so each
    /// one has to give up the fast path. Spelled out one by one because the
    /// cost of getting any single one wrong is a frame that lies.
    #[test]
    fn everything_the_held_snapshot_cannot_show_refreshes_instead() {
        let cacheable = |input_driven, cacheable_input, render_from_data, sel, forced| {
            dashboard_render_source(DashboardRenderSourceInput {
                has_snapshot: true,
                rendered_once: true,
                render_requested: true,
                screen: DashboardScreen::Dashboard,
                input_driven,
                cacheable_input,
                render_from_data,
                selection_move_pending: sel,
                forced_refresh: forced,
            })
        };
        for (what, source) in [
            (
                "a key whose result is not in this snapshot",
                cacheable(true, false, false, false, false),
            ),
            (
                "data arriving rather than a keypress",
                cacheable(false, true, true, false, false),
            ),
            (
                "the loop about to move the pointer itself",
                cacheable(true, true, false, true, false),
            ),
            (
                "a refresh already forced",
                cacheable(true, true, false, false, true),
            ),
            (
                "a repaint nothing asked for",
                cacheable(false, true, false, false, false),
            ),
        ] {
            assert_eq!(source, DashboardRenderSource::Refresh, "{what}");
        }
    }

    /// The fallback tick exists to go and look, so it always does -- including
    /// on a subscreen, which arms no deferral of its own. Serving it from the
    /// held snapshot leaves someone sitting on Coordination reading rows from
    /// minutes ago with nothing ever going back for more.
    #[test]
    fn the_tick_nobody_asked_for_always_goes_and_looks() {
        for screen in [DashboardScreen::Dashboard, DashboardScreen::Coordination] {
            assert_eq!(
                dashboard_render_source(DashboardRenderSourceInput {
                    has_snapshot: true,
                    rendered_once: true,
                    render_requested: false,
                    screen,
                    input_driven: false,
                    cacheable_input: true,
                    render_from_data: false,
                    selection_move_pending: false,
                    forced_refresh: false,
                }),
                DashboardRenderSource::Refresh,
                "{screen:?}"
            );
        }
    }

    /// Nothing is cached before there is something to cache.
    #[test]
    fn the_first_frame_always_loads() {
        for (has_snapshot, rendered_once) in [(false, true), (true, false), (false, false)] {
            assert_eq!(
                dashboard_render_source(DashboardRenderSourceInput {
                    has_snapshot,
                    rendered_once,
                    render_requested: true,
                    screen: DashboardScreen::Dashboard,
                    input_driven: true,
                    cacheable_input: true,
                    render_from_data: false,
                    selection_move_pending: false,
                    forced_refresh: false,
                }),
                DashboardRenderSource::Refresh,
                "has_snapshot={has_snapshot} rendered_once={rendered_once}",
            );
        }
    }

    /// A subscreen renders its own resource, so a repaint it asked for paints
    /// from the held snapshot -- but not while a refresh request is in flight,
    /// which is the latch that would wedge every later event-driven refresh
    /// behind a frame that never refreshed.
    #[test]
    fn a_subscreen_keeps_its_cached_frame_but_not_over_a_consumed_refresh() {
        assert_eq!(
            dashboard_render_source(DashboardRenderSourceInput {
                has_snapshot: true,
                rendered_once: true,
                render_requested: true,
                screen: DashboardScreen::Coordination,
                input_driven: false,
                cacheable_input: true,
                render_from_data: false,
                selection_move_pending: false,
                forced_refresh: false,
            }),
            DashboardRenderSource::CachedSnapshot,
        );
        assert_eq!(
            dashboard_render_source(DashboardRenderSourceInput {
                has_snapshot: true,
                rendered_once: true,
                render_requested: true,
                screen: DashboardScreen::Coordination,
                input_driven: false,
                cacheable_input: true,
                render_from_data: true,
                selection_move_pending: false,
                forced_refresh: false,
            }),
            DashboardRenderSource::Refresh,
        );
    }

    /// A held key repeats far faster than the loop used to be able to paint,
    /// and a frame is not free: it can dispatch a request, spawn the thread
    /// that sends it, and fsync the selection. So an input frame keeps the
    /// ceiling the old sleep gave it.
    #[test]
    fn a_repeating_key_does_not_get_a_frame_each_time() {
        assert!(dashboard_frame_held_back(
            true,
            false,
            Duration::from_millis(15)
        ));
        assert!(!dashboard_frame_held_back(
            true,
            false,
            DASHBOARD_MIN_INPUT_FRAME_GAP
        ));
    }

    /// But only the keyboard waits. Data arriving and a fetch coming due have
    /// their own clocks, and holding them would stall the dashboard behind a
    /// key the user is merely leaning on.
    #[test]
    fn nothing_but_a_keypress_is_ever_held_back() {
        assert!(!dashboard_frame_held_back(
            true,
            true,
            Duration::from_millis(0)
        ));
        assert!(!dashboard_frame_held_back(
            false,
            false,
            Duration::from_millis(0)
        ));
    }

    /// The carry is load-bearing because `persist_controller_state` reports a
    /// diff against what is already on disk. The cached frame writes the
    /// selection so attaching cannot lose it -- which means the refresh behind
    /// it finds nothing changed. Read that second answer alone and the move is
    /// never published to the statusline at all.
    #[test]
    fn a_cached_frames_persist_does_not_cost_the_statusline_its_refresh() {
        let root = temp_dir("dashboard-internal-statusline-carry");
        fs::create_dir_all(&root).expect("create temp dir");
        let snapshot = fixture_snapshot();
        let mut controller = DashboardController::new(&snapshot);
        controller.navigation.level = DashboardNavLevel::Sessions;
        controller.navigation.worktree_index = 0;
        controller.navigation.item_index = 1;
        let mut ui_state =
            DashboardUiStatePersistence::new(&root, "client").expect("create ui state");
        let persist = |ui_state: &mut DashboardUiStatePersistence| {
            ui_state
                .persist_controller_state(
                    DashboardScreen::Dashboard,
                    "output",
                    true,
                    &snapshot,
                    &controller.navigation,
                )
                .expect("persist navigation")
        };

        let from_cached_frame = persist(&mut ui_state);
        let from_deferred_refresh = persist(&mut ui_state);

        assert!(from_cached_frame, "the cached frame wrote the selection");
        assert!(
            !from_deferred_refresh,
            "so the refresh behind it has nothing left to report"
        );
        assert!(
            dashboard_statusline_due(from_deferred_refresh, from_cached_frame),
            "and the carry is the only thing that still refreshes the statusline"
        );
        assert!(
            !dashboard_statusline_due(from_deferred_refresh, false),
            "without the carry the move is never published"
        );
    }

    /// A cached frame leaves the statusline to the refresh it deferred, because
    /// publishing invalidates the runtime view and the event comes straight
    /// back as the fetch the frame just skipped.
    ///
    /// Two frames have nothing to leave it to, and both have been a bug: the
    /// dispatching frame, which can hide this dashboard before that refresh
    /// runs, and any subscreen, which defers no refresh at all and would sit
    /// there with the tab bar still reading Dashboard.
    #[test]
    fn a_frame_with_nobody_behind_it_publishes_the_statusline_itself() {
        assert!(dashboard_frame_must_publish_statusline(
            true,
            DashboardScreen::Dashboard
        ));
        for screen in [
            DashboardScreen::Topology,
            DashboardScreen::Graveyard,
            DashboardScreen::Coordination,
            DashboardScreen::Project,
            DashboardScreen::Library,
            DashboardScreen::Help,
        ] {
            assert!(
                dashboard_frame_must_publish_statusline(false, screen),
                "{screen:?} defers no refresh, so nothing else would ever say it is showing"
            );
        }
    }

    /// And an ordinary pointer move does leave it, which is the whole point.
    #[test]
    fn an_ordinary_move_leaves_the_statusline_to_the_deferred_refresh() {
        assert!(!dashboard_frame_must_publish_statusline(
            false,
            DashboardScreen::Dashboard
        ));
    }

    /// The subscreen frame is actually given the alert, not merely able to
    /// render one.
    ///
    /// The renderer's own test hands it a `footer_alerts` list, which proves the
    /// renderer. The wiring is a separate claim, and replacing it with an empty
    /// list passed every test in the repository -- so a refusal raised on the
    /// graveyard screen, which is where resurrect and delete both fail, would
    /// have rendered nowhere while `X` dismissed something never seen.
    #[test]
    fn a_subscreen_frame_is_given_the_controller_alert() {
        let snapshot = test_snapshot();
        let mut controller = DashboardController::new(&snapshot);
        controller.screen = DashboardScreen::Graveyard;
        controller.footer_alert = Some(DashboardFailureAlert::local(
            "Could not resurrect fix-chat: the checkout is missing",
        ));
        let mut pending_actions = DashboardPendingActions::default();

        let frame = render_dashboard_subscreen_snapshot(
            DashboardViewport {
                cols: 140,
                rows: 36,
            },
            &mut controller,
            None,
            0,
            &mut pending_actions,
            0,
            None,
        );

        let plain = crate::tui_render::text::strip_ansi(&frame.frame);
        assert!(
            plain.contains("Could not resurrect fix-chat: the checkout is missing"),
            "{plain}"
        );
        assert!(
            plain.contains("[X] dismiss"),
            "the subscreen footer has no hint row, so the bar has to carry it: {plain}"
        );
    }

    #[test]
    fn a_finished_restore_says_what_it_did_rather_than_nothing() {
        let body = serde_json::json!({
            "accepted": true,
            "restored": [{ "sessionId": "codex-a" }],
            "failed": [{ "sessionId": "claude-b", "error": "no backend session id" }],
        });
        let notice = dashboard_action_notice(
            crate::project_api_contract::routes::agents::RESTORE_PREVIOUS,
            &body,
        )
        .expect("a restore reports its outcome");
        assert!(notice.message.contains("claude-b"), "{}", notice.message);
        assert!(
            notice.failed,
            "a 200 that names what did not come back is a failure report"
        );
        assert!(
            dashboard_action_notice(crate::project_api_contract::routes::agents::KILL, &body)
                .is_none(),
            "only routes whose success is otherwise invisible speak up"
        );
    }

    #[test]
    fn a_slow_mutation_does_not_block_the_render_loop() {
        // A worktree graveyard is allowed 180s. Running it inline froze the
        // dashboard for its duration, which is what a slow graveyard looked
        // like from the outside.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("listener");
        let endpoint = ProjectServiceEndpoint {
            host: "127.0.0.1".to_owned(),
            port: listener.local_addr().expect("addr").port(),
        };
        let accepted = thread::spawn(move || {
            let _held = listener.accept();
            thread::sleep(Duration::from_secs(3));
        });
        let mut pending_actions = DashboardPendingActions::new();
        let token = pending_actions.set_session_action("claude-a1", "graveyarding", 0);
        let mut deferred: Vec<DeferredDashboardRequest> = vec![(
            DashboardActionRequest {
                method: "POST",
                path: crate::project_api_contract::routes::worktree_actions::GRAVEYARD,
                body: serde_json::json!({ "path": "/repo/wt" }),
            },
            Some((PendingTarget::Session, "claude-a1".to_owned(), token)),
        )];
        let (tx, _rx) = mpsc::channel::<DashboardRequestOutcome>();

        let started = Instant::now();
        flush_deferred_dashboard_requests(
            &mut deferred,
            Some(&endpoint),
            &mut pending_actions,
            None,
            &tx,
        );
        let elapsed = started.elapsed();

        assert!(
            elapsed < Duration::from_millis(500),
            "flush blocked the render loop for {elapsed:?}"
        );
        assert!(deferred.is_empty());
        drop(accepted);
    }

    #[test]
    fn pending_action_deadline_requests_a_render_without_input() {
        let mut pending_actions = DashboardPendingActions::new();
        pending_actions.set_session_action("claude-a1", "stopping", 0);

        assert!(!pending_action_reconcile_due(&pending_actions, 399));
        assert!(pending_action_reconcile_due(&pending_actions, 400));
    }

    #[test]
    fn pending_action_clock_matches_dashboard_loop_elapsed_time() {
        let clock_start = Instant::now() - Duration::from_millis(450);
        let pending_now = pending_action_now_ms(clock_start);

        assert!(
            (400..10_000).contains(&pending_now),
            "pending action clock must stay on the dashboard loop elapsed scale, got {pending_now}"
        );
    }

    #[test]
    fn live_dashboard_waits_until_ready_before_runtime_guard_probe() {
        assert!(!should_probe_dashboard_runtime_guard(
            true,
            None,
            DASHBOARD_RUNTIME_GUARD_INTERVAL,
            false
        ));
        assert!(!should_probe_dashboard_runtime_guard(
            true,
            Some(DASHBOARD_RUNTIME_GUARD_INTERVAL - Duration::from_millis(1)),
            DASHBOARD_RUNTIME_GUARD_INTERVAL,
            false
        ));
        assert!(should_probe_dashboard_runtime_guard(
            true,
            Some(DASHBOARD_RUNTIME_GUARD_INTERVAL),
            DASHBOARD_RUNTIME_GUARD_INTERVAL,
            false
        ));
        assert!(!should_probe_dashboard_runtime_guard(
            false,
            Some(DASHBOARD_RUNTIME_GUARD_INTERVAL),
            DASHBOARD_RUNTIME_GUARD_INTERVAL,
            false
        ));
        assert!(!should_probe_dashboard_runtime_guard(
            true,
            Some(DASHBOARD_RUNTIME_GUARD_INTERVAL),
            DASHBOARD_RUNTIME_GUARD_INTERVAL - Duration::from_millis(1),
            false
        ));
        assert!(!should_probe_dashboard_runtime_guard(
            true,
            Some(DASHBOARD_RUNTIME_GUARD_INTERVAL),
            DASHBOARD_RUNTIME_GUARD_INTERVAL,
            true
        ));
    }

    #[test]
    fn dashboard_runtime_guard_probe_poll_does_not_block_render_loop() {
        let mut runtime_guard = DashboardRuntimeGuardStatus::default();
        let (_sender, receiver) = mpsc::channel::<RuntimeGuardState>();
        runtime_guard.probe_receiver = Some(receiver);
        let mut last_probe_completed = Instant::now() - DASHBOARD_RUNTIME_GUARD_INTERVAL;

        let started = Instant::now();
        let changed = poll_dashboard_runtime_guard_probe(
            &mut runtime_guard,
            Path::new("/tmp/aimux-dashboard-runtime-guard-test"),
            &mut last_probe_completed,
        );

        assert!(!changed);
        assert!(runtime_guard.probing());
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "unfinished probe polling blocked render loop for {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn dashboard_runtime_guard_probe_cadence_resets_on_completion() {
        let mut runtime_guard = DashboardRuntimeGuardStatus::default();
        let (sender, receiver) = mpsc::channel();
        runtime_guard.probe_receiver = Some(receiver);
        sender
            .send(RuntimeGuardState::Ok)
            .expect("send probe result");
        let mut last_probe_completed = Instant::now() - DASHBOARD_RUNTIME_GUARD_INTERVAL;
        let before_poll = Instant::now();

        let changed = poll_dashboard_runtime_guard_probe(
            &mut runtime_guard,
            Path::new("/tmp/aimux-dashboard-runtime-guard-test"),
            &mut last_probe_completed,
        );

        assert!(!changed);
        assert!(!runtime_guard.probing());
        assert!(last_probe_completed >= before_poll);
        assert!(!should_probe_dashboard_runtime_guard(
            true,
            Some(DASHBOARD_RUNTIME_GUARD_INTERVAL),
            last_probe_completed.elapsed(),
            runtime_guard.probing()
        ));
    }

    use crate::dashboard_renderer::DashboardNavLevel;
    use serde_json::json;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_snapshot() -> DesktopStateSnapshot {
        serde_json::from_str::<DesktopStateGoldenFixture>(include_str!(
            "../../../../src/multiplexer/desktop-state-golden.fixture.json"
        ))
        .expect("valid desktop-state fixture")
        .runtime_full
    }

    fn temp_dir(prefix: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()))
    }

    #[test]
    fn preferred_thread_worklist_index_uses_typescript_scoring() {
        let resource = json!({
            "threads": [
                {
                    "thread": {
                        "id": "older-unread",
                        "participants": ["codex-1", "user"],
                        "unreadBy": ["codex-1"],
                        "waitingOn": [],
                        "updatedAt": "2026-01-01T00:00:00.000Z"
                    }
                },
                {
                    "thread": {
                        "id": "waiting",
                        "displayTitle": "Blocked deploy thread",
                        "participants": ["codex-1", "user"],
                        "unreadBy": [],
                        "waitingOn": ["codex-1"],
                        "updatedAt": "2026-01-01T00:01:00.000Z"
                    }
                },
                {
                    "thread": {
                        "id": "other",
                        "participants": ["claude-1", "user"],
                        "unreadBy": ["claude-1"],
                        "waitingOn": ["claude-1"],
                        "updatedAt": "2026-01-01T00:02:00.000Z"
                    }
                }
            ],
            "worklist": [
                { "kind": "thread", "thread": { "thread": { "id": "older-unread" } } },
                { "kind": "thread", "thread": { "thread": { "id": "waiting" } } },
                { "kind": "thread", "thread": { "thread": { "id": "other" } } }
            ]
        });

        assert_eq!(
            preferred_thread_selection(&resource, "codex-1"),
            Some(PreferredThreadSelection {
                worklist_index: 1,
                thread_id: "waiting".into(),
                title: "Blocked deploy thread".into(),
                targets: vec!["codex-1".into()],
                waiting_on_session: true,
            })
        );
        assert_eq!(preferred_thread_selection(&resource, "missing"), None);
    }

    #[test]
    fn background_refresh_restores_dashboard_selection_by_id() {
        let root = temp_dir("dashboard-internal-selection-refresh");
        fs::create_dir_all(&root).expect("create temp dir");
        let snapshot = fixture_snapshot();
        let selected_id = snapshot.worktree_groups[0].sessions[1].id.clone();
        let mut controller = DashboardController::new(&snapshot);
        controller.navigation.level = DashboardNavLevel::Sessions;
        controller.navigation.worktree_index = 0;
        controller.navigation.item_index = 1;
        let mut ui_state =
            DashboardUiStatePersistence::new(&root, "client").expect("create ui state");
        ui_state
            .persist_controller_state(
                DashboardScreen::Dashboard,
                "output",
                true,
                &snapshot,
                &controller.navigation,
            )
            .expect("persist navigation");

        let mut reordered = snapshot.clone();
        reordered.worktree_groups[0].sessions.swap(0, 1);
        restore_dashboard_navigation_for_render(
            Some(&ui_state),
            &mut controller,
            &reordered,
            false,
            false,
        );

        assert_eq!(controller.navigation.item_index, 0);
        let Some(DashboardEntryRef::Session(selected)) =
            controller.navigation.selected_entry(&reordered)
        else {
            panic!("expected selected session");
        };
        assert_eq!(selected.id, selected_id);
        fs::remove_dir_all(root).ok();
    }

    // Offlining or onlining an agent moves its row. The pointer is held as an
    // index, so without carrying the identity across it quietly ends up on the
    // neighbour that took the row.
    #[test]
    fn dashboard_pointer_follows_its_agent_across_a_reorder() {
        let snapshot = fixture_snapshot();
        let mut controller = DashboardController::new(&snapshot);
        controller.navigation.level = DashboardNavLevel::Sessions;
        controller.navigation.worktree_index = 0;
        controller.navigation.item_index = 1;
        let Some(DashboardEntryRef::Session(selected)) =
            controller.navigation.selected_entry(&snapshot)
        else {
            panic!("expected selected session");
        };
        let selected_id = selected.id.clone();

        let carried = carried_dashboard_selection(Some(&controller), Some(&snapshot))
            .expect("selection to carry");
        let mut reordered = snapshot.clone();
        reordered.worktree_groups[0].sessions.swap(0, 1);
        assert!(controller.navigation.follow_selection(&reordered, &carried));

        assert_eq!(controller.navigation.item_index, 0);
        let Some(DashboardEntryRef::Session(followed)) =
            controller.navigation.selected_entry(&reordered)
        else {
            panic!("expected selected session");
        };
        assert_eq!(followed.id, selected_id);
    }

    #[test]
    fn dashboard_pointer_stays_put_when_its_agent_is_gone() {
        let snapshot = fixture_snapshot();
        let mut controller = DashboardController::new(&snapshot);
        controller.navigation.level = DashboardNavLevel::Sessions;
        controller.navigation.worktree_index = 0;
        controller.navigation.item_index = 1;
        let carried = carried_dashboard_selection(Some(&controller), Some(&snapshot))
            .expect("selection to carry");

        let mut without = snapshot.clone();
        let CarriedSelection::Session(gone) = &carried else {
            panic!("expected a session selection");
        };
        for group in &mut without.worktree_groups {
            group.sessions.retain(|session| &session.id != gone);
        }

        assert!(
            !controller.navigation.follow_selection(&without, &carried),
            "a missing agent must not drag the pointer somewhere arbitrary"
        );
        assert_eq!(controller.navigation.item_index, 1);
    }

    #[test]
    fn dashboard_selection_carries_nothing_on_the_first_frame() {
        let snapshot = fixture_snapshot();
        let controller = DashboardController::new(&snapshot);
        assert_eq!(carried_dashboard_selection(Some(&controller), None), None);
        assert_eq!(carried_dashboard_selection(None, Some(&snapshot)), None);
    }

    #[test]
    fn input_render_does_not_restore_stale_dashboard_selection() {
        let root = temp_dir("dashboard-internal-input-render-selection");
        fs::create_dir_all(&root).expect("create temp dir");
        let snapshot = fixture_snapshot();
        let mut controller = DashboardController::new(&snapshot);
        controller.navigation.level = DashboardNavLevel::Sessions;
        controller.navigation.worktree_index = 0;
        controller.navigation.item_index = 1;
        let mut ui_state =
            DashboardUiStatePersistence::new(&root, "client").expect("create ui state");
        ui_state
            .persist_controller_state(
                DashboardScreen::Dashboard,
                "output",
                true,
                &snapshot,
                &controller.navigation,
            )
            .expect("persist navigation");

        let mut reordered = snapshot.clone();
        reordered.worktree_groups[0].sessions.swap(0, 1);
        controller.navigation.item_index = 1;
        let expected_id = reordered.worktree_groups[0].sessions[1].id.clone();
        restore_dashboard_navigation_for_render(
            Some(&ui_state),
            &mut controller,
            &reordered,
            true,
            false,
        );

        assert_eq!(controller.navigation.item_index, 1);
        let Some(DashboardEntryRef::Session(selected)) =
            controller.navigation.selected_entry(&reordered)
        else {
            panic!("expected selected session");
        };
        assert_eq!(selected.id, expected_id);
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn dashboard_overlay_recedes_base_frame_like_node_write_frame() {
        let snapshot = fixture_snapshot();
        let options = NativeDashboardOptions {
            project_root: PathBuf::from("/repo"),
            desktop_state_file: None,
            cols: 120,
            rows: 30,
            once: true,
        };
        let context = DashboardSnapshotRenderContext {
            viewport: DashboardViewport {
                cols: 120,
                rows: 30,
            },
            endpoint: None,
            hidden_offline_agent_count: 0,
            scroll_offset: 0,
            runtime_guard: None,
            refresh_error: None,
            stream_error: None,
            pending_now_ms: 0,
        };
        let mut pending_actions = DashboardPendingActions::new();

        let mut plain_controller = DashboardController::new(&snapshot);
        let plain = render_dashboard_snapshot(
            &options,
            &mut plain_controller,
            &snapshot,
            &mut pending_actions,
            context,
        )
        .frame;
        assert!(!plain.starts_with("\x1b[2;38;5;240m"));

        let mut overlay_controller = DashboardController::new(&snapshot);
        overlay_controller.overseer_overlay_open = true;
        let overlay = render_dashboard_snapshot(
            &options,
            &mut overlay_controller,
            &snapshot,
            &mut pending_actions,
            context,
        )
        .frame;
        assert!(overlay.starts_with("\x1b[2;38;5;240m"));
        assert!(overlay.contains("OVERSEER"));
    }
}
