use crate::config::load_config_for_project;
use crate::core_command_contract::CORE_COMMAND_NAMES;
use crate::core_command_transport::send_core_command;
use crate::dashboard_actions::{
    DashboardActionKind, DashboardActionPlan, DashboardActionRequest, plan_dashboard_action,
};
use crate::dashboard_client::{
    ProjectServiceEndpoint, execute_dashboard_action, fetch_dashboard_resource,
    fetch_desktop_state, refresh_dashboard_statusline, resolve_project_service_endpoint,
};
use crate::dashboard_controller::{
    DashboardController, DashboardControllerEffect, DashboardOverseerWatchRequest, DashboardScreen,
    DashboardSubscreenAction, orchestration_targets_from_resource,
};
use crate::dashboard_event_stream::{
    DashboardEventStreamHandle, DashboardEventStreamMessage, spawn_dashboard_project_event_stream,
};
use crate::dashboard_focus::DashboardFocusState;
use crate::dashboard_launch_options::render_launch_options_overlay;
use crate::dashboard_model::{
    DesktopStateGoldenFixture, DesktopStateSnapshot, SessionStatus, filter_dashboard_visible_model,
};
use crate::dashboard_navigation::DashboardEntryRef;
use crate::dashboard_project_events::{
    DashboardProjectEvent, DashboardProjectRefreshState, dashboard_alert_footer_flash,
};
use crate::dashboard_readiness::mark_native_dashboard_ready;
use crate::dashboard_renderer::{
    DashboardRenderInput, DashboardSubscreenRenderInput, render_dashboard_frame,
    render_dashboard_subscreen_frame,
};
use crate::dashboard_service_input::DashboardThreadReplyState;
use crate::dashboard_service_input::{
    render_label_input_overlay, render_migrate_picker_overlay, render_orchestration_input_overlay,
    render_orchestration_route_picker_overlay, render_service_input_overlay,
    render_teammate_picker_overlay, render_thread_reply_overlay,
    render_worktree_cache_cleanup_confirm_overlay, render_worktree_input_overlay,
    render_worktree_list_overlay, render_worktree_remove_confirm_overlay,
};
use crate::dashboard_terminal::{
    DashboardTerminalGuard, consume_terminal_resize, read_dashboard_keys, terminal_size,
};
use crate::dashboard_tool_picker::{enabled_dashboard_tools, render_tool_picker_overlay};
use crate::dashboard_tui_visibility::{
    DashboardTuiVisibilityState, consume_dashboard_tui_visibility_wake, mark_dashboard_tui_visible,
    read_dashboard_tui_visibility_for_loop, read_tmux_tui_visibility,
};
use crate::dashboard_ui_state::DashboardUiStatePersistence;
use crate::paths::PathResolver;
use crate::project_service::work_outline::{
    WorkOutlineEntry, WorkOutlineQuery, list_work_outline_entries,
};
use crate::release_version_contract::read_aimux_runtime_version;
use crate::tmux::TmuxRuntimeManager;
use crate::tui_screen_renderers::{
    render_overseer_overlay_output, render_overseer_watch_instructions_overlay_output,
    render_work_outline_overlay_output,
};
use anyhow::{Context, Result};
use serde_json::{Map, Value};
use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

const DASHBOARD_KEY_POLL_INTERVAL: Duration = Duration::from_millis(50);
const DASHBOARD_HIDDEN_POLL_INTERVAL: Duration = Duration::from_millis(250);
const DASHBOARD_STREAM_RETRY_INTERVAL: Duration = Duration::from_secs(2);
const DASHBOARD_FALLBACK_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
const DASHBOARD_TERMINAL_SIZE_RECHECK_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone)]
pub struct NativeDashboardOptions {
    pub project_root: PathBuf,
    pub desktop_state_file: Option<PathBuf>,
    pub cols: usize,
    pub rows: usize,
    pub once: bool,
}

struct DashboardSnapshotLoad {
    snapshot: DesktopStateSnapshot,
    endpoint: Option<ProjectServiceEndpoint>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DashboardViewport {
    cols: usize,
    rows: usize,
}

pub fn run_native_dashboard_internal(options: NativeDashboardOptions) -> Result<()> {
    let mut controller: Option<DashboardController> = None;
    let mut focus_state = DashboardFocusState::default();
    let mut ready_marked = false;
    let mut scroll_offset = 0;
    let mut latest_snapshot = None;
    let mut latest_endpoint = None;
    let mut ui_state = if options.once || options.desktop_state_file.is_some() {
        None
    } else {
        DashboardUiStatePersistence::for_project(&options.project_root).ok()
    };
    let mut event_stream = None;
    let mut event_stream_retry_at = None;
    let mut refresh_state = DashboardProjectRefreshState::default();
    let mut visibility_state = DashboardTuiVisibilityState {
        started_in_dashboard: !options.once && options.desktop_state_file.is_none(),
        ..DashboardTuiVisibilityState::default()
    };
    let mut render_now = true;
    let mut rendered_once = false;
    let mut viewport = DashboardViewport {
        cols: options.cols,
        rows: options.rows,
    };
    let mut last_tmux_viewport_check = Instant::now() - DASHBOARD_TERMINAL_SIZE_RECHECK_INTERVAL;
    let mut last_render = Instant::now();
    let clock_start = Instant::now();
    let mut output = dashboard_output(options.once);
    let mut stdin = io::stdin();
    let _terminal = if options.once {
        None
    } else {
        Some(DashboardTerminalGuard::enter(&mut *output).context("enter dashboard terminal")?)
    };

    loop {
        let mut render_requested_by_input = false;
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
        let keys = read_dashboard_keys(&mut stdin).context("read dashboard key")?;
        if !keys.is_empty() {
            mark_dashboard_tui_visible(&mut visibility_state, now, None);
            dashboard_visible = true;
        }
        let terminal_resized =
            !options.once && options.desktop_state_file.is_none() && consume_terminal_resize();
        if terminal_resized {
            render_now = true;
            dashboard_visible = true;
        }
        if !options.once && options.desktop_state_file.is_none() {
            let tmux_viewport =
                if last_tmux_viewport_check.elapsed() >= DASHBOARD_TERMINAL_SIZE_RECHECK_INTERVAL {
                    last_tmux_viewport_check = Instant::now();
                    read_tmux_terminal_size()
                } else {
                    None
                };
            let measured_viewport = tmux_viewport
                .or_else(|| terminal_size().map(|(cols, rows)| DashboardViewport { cols, rows }));
            if let Some(next_viewport) = measured_viewport
                && next_viewport != viewport
            {
                viewport = next_viewport;
                render_now = true;
                dashboard_visible = true;
            }
        }
        if !dashboard_visible {
            suspend_dashboard_event_stream(&mut event_stream, &mut event_stream_retry_at);
            thread::sleep(DASHBOARD_HIDDEN_POLL_INTERVAL);
            continue;
        }
        if consume_dashboard_tui_visibility_wake(&mut visibility_state) {
            render_now = true;
        }
        if drain_dashboard_event_stream(
            &mut event_stream,
            &mut event_stream_retry_at,
            &mut refresh_state,
            controller
                .as_ref()
                .map(|controller| controller.screen.as_str()),
            controller.as_mut(),
        ) {
            render_now = true;
        }
        if refresh_state.take_refresh_request() {
            render_now = true;
        }
        reconcile_dashboard_event_stream(
            &mut event_stream,
            &mut event_stream_retry_at,
            latest_endpoint.as_ref(),
            options.once || options.desktop_state_file.is_some(),
        );
        if rendered_once && !keys.is_empty() {
            mark_dashboard_tui_visible(&mut visibility_state, elapsed_millis(clock_start), None);
            let Some(snapshot) = latest_snapshot.as_ref() else {
                render_now = true;
                thread::sleep(DASHBOARD_KEY_POLL_INTERVAL);
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
                let effect = controller.handle_key(snapshot, key);
                let stop_after_key = is_coalesced_input
                    && controller.should_stop_coalesced_input(before_surface, &effect);
                match effect {
                    DashboardControllerEffect::Quit => return Ok(()),
                    DashboardControllerEffect::Request(request) => {
                        if let Some(endpoint) = latest_endpoint.as_ref() {
                            if let Err(error) =
                                execute_dashboard_controller_action(endpoint, &request)
                            {
                                controller.footer_message = Some(error.to_string());
                            }
                        } else {
                            controller.footer_message =
                                Some("Dashboard action requires a project-service endpoint".into());
                        }
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
                                    controller.footer_message = Some(format!(
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
                                    controller.footer_message = Some("Already at edge".into());
                                }
                                Err(error) => {
                                    controller.footer_message = Some(error.to_string());
                                }
                            }
                        } else {
                            controller.footer_message =
                                Some("Dashboard ordering unavailable".into());
                        }
                        render_now = true;
                        render_requested_by_input = true;
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
                                    controller.footer_message = Some(error.to_string());
                                }
                            }
                        } else {
                            controller.footer_message =
                                Some("Dashboard action requires a project-service endpoint".into());
                        }
                        render_now = true;
                        render_requested_by_input = true;
                    }
                    DashboardControllerEffect::WorktreeCacheCleanupApply(request) => {
                        if let Some(endpoint) = latest_endpoint.as_ref() {
                            match execute_dashboard_controller_action(endpoint, &request)
                                .and_then(cache_cleanup_result_from_response)
                            {
                                Ok(result) => {
                                    controller.footer_message =
                                        Some(worktree_cache_cleanup_summary(&result));
                                }
                                Err(error) => {
                                    controller.footer_message = Some(error.to_string());
                                }
                            }
                        } else {
                            controller.footer_message =
                                Some("Dashboard action requires a project-service endpoint".into());
                        }
                        render_now = true;
                        render_requested_by_input = true;
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
                                    controller.footer_message = Some(format!(
                                        "Failed to load orchestration targets: {error}"
                                    ));
                                }
                            }
                        } else {
                            controller.footer_message =
                                Some("Dashboard action requires a project-service endpoint".into());
                        }
                        render_now = true;
                        render_requested_by_input = true;
                    }
                    DashboardControllerEffect::OpenRelevantThread { session_id } => {
                        if let Some(endpoint) = latest_endpoint.as_ref() {
                            if let Err(error) =
                                open_relevant_thread_for_session(endpoint, controller, &session_id)
                            {
                                controller.footer_message = Some(error.to_string());
                            }
                        } else {
                            controller.footer_message =
                                Some("Dashboard action requires a project-service endpoint".into());
                        }
                        render_now = true;
                        render_requested_by_input = true;
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
                    }
                    DashboardControllerEffect::WatchWithOverseer(request) => {
                        match execute_overseer_watch_command(&options, controller, &request) {
                            Ok(()) => {}
                            Err(error) => {
                                controller.footer_message =
                                    Some(format!("Overseer update failed: {error}"));
                            }
                        }
                        render_now = true;
                        render_requested_by_input = true;
                    }
                    DashboardControllerEffect::OpenAgentToolPicker(mode) => {
                        let config = load_config_for_project(&options.project_root);
                        controller.open_tool_picker(enabled_dashboard_tools(&config), mode);
                        render_now = true;
                        render_requested_by_input = true;
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

        let render_due = render_now || last_render.elapsed() >= DASHBOARD_FALLBACK_REFRESH_INTERVAL;
        if render_due {
            let cached_subscreen_snapshot = latest_snapshot.as_ref().filter(|_| {
                render_now
                    && controller
                        .as_ref()
                        .is_some_and(|controller| controller.screen != DashboardScreen::Dashboard)
            });
            let rendered_from_cached_snapshot = if let (Some(snapshot), Some(controller)) =
                (cached_subscreen_snapshot, controller.as_mut())
            {
                let frame = render_dashboard_snapshot(
                    &options,
                    viewport,
                    controller,
                    snapshot,
                    latest_endpoint.as_ref(),
                    0,
                    scroll_offset,
                );
                write_dashboard_frame(&mut *output, frame.frame.as_bytes())?;
                rendered_once = true;
                let statusline_client_session = ui_state.as_mut().and_then(|ui_state| {
                    ui_state
                        .persist_screen(controller.screen)
                        .unwrap_or(false)
                        .then(|| ui_state.client_session().to_owned())
                });
                if let (Some(endpoint), Some(client_session)) = (
                    latest_endpoint.as_ref(),
                    statusline_client_session.as_deref(),
                ) {
                    let _ = refresh_dashboard_statusline(endpoint, client_session);
                }
                scroll_offset = frame.scroll_offset;
                render_now = false;
                last_render = Instant::now();
                true
            } else {
                false
            };
            if rendered_from_cached_snapshot {
                if options.once {
                    return Ok(());
                }
            } else {
                let mut loaded = load_dashboard_snapshot(&options)?;
                if let Some(ui_state) = ui_state.as_ref() {
                    ui_state.apply_order_to_snapshot(&mut loaded.snapshot);
                }
                let hide_offline_agents = controller
                    .as_ref()
                    .map(|controller| controller.hide_offline_agents)
                    .unwrap_or(false);
                let visible_model =
                    filter_dashboard_visible_model(&loaded.snapshot, hide_offline_agents);
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
                );
                let frame = render_dashboard_snapshot(
                    &options,
                    viewport,
                    controller,
                    &visible_model.snapshot,
                    loaded.endpoint.as_ref(),
                    visible_model.hidden_offline_agent_count,
                    scroll_offset,
                );
                write_dashboard_frame(&mut *output, frame.frame.as_bytes())?;
                rendered_once = true;
                let statusline_client_session = ui_state.as_mut().and_then(|ui_state| {
                    ui_state
                        .persist_controller_state(
                            controller.screen,
                            &controller.preview_source,
                            controller.details_sidebar_visible,
                            &visible_model.snapshot,
                            &controller.navigation,
                        )
                        .unwrap_or(false)
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
                    let _ = mark_native_dashboard_ready(&options.project_root);
                    ready_marked = true;
                }
                latest_snapshot = Some(visible_model.snapshot);
                latest_endpoint = loaded.endpoint;
                refresh_state.complete_refresh();
                reconcile_dashboard_event_stream(
                    &mut event_stream,
                    &mut event_stream_retry_at,
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
        }
        thread::sleep(DASHBOARD_KEY_POLL_INTERVAL);
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
) {
    if event_stream.is_some() {
        *event_stream = None;
    }
    *retry_at = None;
}

fn drain_dashboard_event_stream(
    event_stream: &mut Option<DashboardEventStreamHandle>,
    retry_at: &mut Option<Instant>,
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
            DashboardEventStreamMessage::Event(event) => {
                if let DashboardProjectEvent::Alert(payload) = &event
                    && let Some(message) = dashboard_alert_footer_flash("dashboard", payload)
                    && let Some(controller) = controller.as_deref_mut()
                {
                    controller.footer_message = Some(message);
                    render = true;
                }
                refresh_state.observe_for_screen(&event, active_screen);
            }
            DashboardEventStreamMessage::Error(error) => {
                stream_closed = true;
                stream_error = Some(error);
                break;
            }
            DashboardEventStreamMessage::Ended => {
                stream_closed = true;
                break;
            }
        }
    }
    if let Some(error) = stream_error
        && let Some(controller) = controller
    {
        controller.footer_message = Some(error);
        render = true;
    }
    if stream_closed {
        *event_stream = None;
        *retry_at = Some(Instant::now() + DASHBOARD_STREAM_RETRY_INTERVAL);
    }
    render
}

fn reconcile_dashboard_event_stream(
    event_stream: &mut Option<DashboardEventStreamHandle>,
    retry_at: &mut Option<Instant>,
    endpoint: Option<&ProjectServiceEndpoint>,
    disabled: bool,
) {
    if disabled {
        *event_stream = None;
        *retry_at = None;
        return;
    }
    let Some(endpoint) = endpoint else {
        return;
    };
    if event_stream
        .as_ref()
        .is_some_and(|stream| stream.endpoint() == endpoint)
    {
        return;
    }
    if let Some(retry_at) = retry_at.as_ref()
        && Instant::now() < *retry_at
    {
        return;
    }
    *event_stream = Some(spawn_dashboard_project_event_stream(endpoint.clone()));
    *retry_at = None;
}

fn elapsed_millis(start: Instant) -> i64 {
    start.elapsed().as_millis().min(i64::MAX as u128) as i64
}

fn read_tmux_terminal_size() -> Option<DashboardViewport> {
    let tmux_pane = env::var("TMUX_PANE")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let mut command = Command::new("tmux");
    command.args(["display-message", "-p"]);
    if let Some(tmux_pane) = tmux_pane.as_deref() {
        command.args(["-t", tmux_pane]);
    }
    command.arg("#{window_width}x#{window_height}");
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let (cols, rows) = raw.split_once('x')?;
    let cols = cols.trim().parse::<usize>().ok()?;
    let rows = rows.trim().parse::<usize>().ok()?;
    (cols > 0 && rows > 0).then_some(DashboardViewport { cols, rows })
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
    let clients = tmux.list_clients();
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
        controller.footer_message = Some("Overseer updated, but could not open overseer".into());
        return Ok(());
    }
    controller.footer_message = Some(format!("{} added to overseer loop", request.target_label));
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
    viewport: DashboardViewport,
    controller: &mut DashboardController,
    snapshot: &DesktopStateSnapshot,
    endpoint: Option<&ProjectServiceEndpoint>,
    hidden_offline_agent_count: usize,
    scroll_offset: usize,
) -> crate::tui_render::screen_frame::ScreenFrameResult {
    if controller.screen != DashboardScreen::Dashboard {
        return render_dashboard_subscreen_snapshot(viewport, controller, endpoint, scroll_offset);
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
        .filter(|session| {
            session.overseer == Some(true)
                || session.team.as_ref().and_then(|team| team.role.as_deref()) == Some("overseer")
        })
        .cloned()
        .collect::<Vec<_>>();
    let scribe_sessions = snapshot
        .sessions
        .iter()
        .filter(|session| {
            if session.scribe == Some(false) {
                return false;
            }
            session.scribe == Some(true)
                || session.team.as_ref().and_then(|team| team.role.as_deref()) == Some("scribe")
        })
        .cloned()
        .collect::<Vec<_>>();
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
        runtime_label: Some("tmux"),
        version: Some(&runtime_version),
        is_dev_runtime: cfg!(debug_assertions),
        hide_offline_agents: controller.hide_offline_agents,
        hidden_offline_agent_count,
        scroll_offset,
        footer_message: controller.footer_message.as_deref(),
        details_sidebar_visible: controller.details_sidebar_visible,
        preview_source: &controller.preview_source,
        scribe_preview_entries: &scribe_preview_entries,
    });
    if controller.overseer_overlay_open {
        let mut output = frame.frame;
        let ctx = serde_json::json!({
            "dashboardOverseerSessionsCache": &overseer_sessions,
            "dashboardSessionsCache": &snapshot.sessions,
            "dashboardTeammatesCache": &snapshot.teammates,
        });
        output.push_str(&render_overseer_overlay_output(
            &ctx,
            viewport.cols,
            viewport.rows,
        ));
        return crate::tui_render::screen_frame::ScreenFrameResult {
            frame: output,
            scroll_offset: frame.scroll_offset,
        };
    }
    if let Some(watch) = controller.overseer_watch_instructions.as_ref() {
        let mut output = frame.frame;
        let ctx = serde_json::json!({
            "overseerWatchInstructionsTarget": &watch.target,
            "overseerWatchInstructionsBuffer": &watch.buffer,
        });
        if let Some(overlay) =
            render_overseer_watch_instructions_overlay_output(&ctx, viewport.cols, viewport.rows)
        {
            output.push_str(&overlay);
        }
        return crate::tui_render::screen_frame::ScreenFrameResult {
            frame: output,
            scroll_offset: frame.scroll_offset,
        };
    }
    if let Some(work_outline_overlay) = controller.work_outline_overlay.as_ref() {
        let mut output = frame.frame;
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
        output.push_str(&render_work_outline_overlay_output(
            &ctx,
            viewport.cols,
            viewport.rows,
        ));
        return crate::tui_render::screen_frame::ScreenFrameResult {
            frame: output,
            scroll_offset: frame.scroll_offset,
        };
    }
    if let Some(launch_options) = controller.launch_options.as_ref() {
        let mut output = frame.frame;
        let selected_tool = controller
            .tool_picker
            .as_ref()
            .and_then(|picker| picker.selected_tool());
        output.push_str(&render_launch_options_overlay(
            launch_options,
            selected_tool,
            viewport.cols,
            viewport.rows,
        ));
        return crate::tui_render::screen_frame::ScreenFrameResult {
            frame: output,
            scroll_offset: frame.scroll_offset,
        };
    }
    if let Some(tool_picker) = controller.tool_picker.as_ref() {
        let mut output = frame.frame;
        output.push_str(&render_tool_picker_overlay(
            tool_picker,
            viewport.cols,
            viewport.rows,
        ));
        return crate::tui_render::screen_frame::ScreenFrameResult {
            frame: output,
            scroll_offset: frame.scroll_offset,
        };
    }
    if let Some(service_input) = controller.service_input.as_ref() {
        let mut output = frame.frame;
        output.push_str(&render_service_input_overlay(
            service_input,
            viewport.cols,
            viewport.rows,
        ));
        return crate::tui_render::screen_frame::ScreenFrameResult {
            frame: output,
            scroll_offset: frame.scroll_offset,
        };
    }
    if let Some(worktree_input) = controller.worktree_input.as_ref() {
        let mut output = frame.frame;
        output.push_str(&render_worktree_input_overlay(
            worktree_input,
            viewport.cols,
            viewport.rows,
        ));
        return crate::tui_render::screen_frame::ScreenFrameResult {
            frame: output,
            scroll_offset: frame.scroll_offset,
        };
    }
    if let Some(migrate_picker) = controller.migrate_picker.as_ref() {
        let mut output = frame.frame;
        output.push_str(&render_migrate_picker_overlay(
            migrate_picker,
            viewport.cols,
            viewport.rows,
        ));
        return crate::tui_render::screen_frame::ScreenFrameResult {
            frame: output,
            scroll_offset: frame.scroll_offset,
        };
    }
    if let Some(label_input) = controller.label_input.as_ref() {
        let mut output = frame.frame;
        output.push_str(&render_label_input_overlay(
            label_input,
            viewport.cols,
            viewport.rows,
        ));
        return crate::tui_render::screen_frame::ScreenFrameResult {
            frame: output,
            scroll_offset: frame.scroll_offset,
        };
    }
    if let Some(confirm) = controller.worktree_remove_confirm.as_ref() {
        let mut output = frame.frame;
        output.push_str(&render_worktree_remove_confirm_overlay(
            &confirm.name,
            &confirm.path,
            viewport.cols,
            viewport.rows,
        ));
        return crate::tui_render::screen_frame::ScreenFrameResult {
            frame: output,
            scroll_offset: frame.scroll_offset,
        };
    }
    if controller.worktree_list_open {
        let mut output = frame.frame;
        output.push_str(&render_worktree_list_overlay(
            &snapshot.worktree_groups,
            viewport.cols,
            viewport.rows,
        ));
        return crate::tui_render::screen_frame::ScreenFrameResult {
            frame: output,
            scroll_offset: frame.scroll_offset,
        };
    }
    if let Some(preview) = controller.worktree_cache_cleanup_confirm.as_ref() {
        let mut output = frame.frame;
        output.push_str(&render_worktree_cache_cleanup_confirm_overlay(
            preview,
            viewport.cols,
            viewport.rows,
        ));
        return crate::tui_render::screen_frame::ScreenFrameResult {
            frame: output,
            scroll_offset: frame.scroll_offset,
        };
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
            let mut output = frame.frame;
            output.push_str(&overlay);
            return crate::tui_render::screen_frame::ScreenFrameResult {
                frame: output,
                scroll_offset: frame.scroll_offset,
            };
        }
    }
    if let Some(route_picker) = controller.orchestration_route_picker.as_ref() {
        let mut output = frame.frame;
        output.push_str(&render_orchestration_route_picker_overlay(
            route_picker,
            viewport.cols,
            viewport.rows,
        ));
        return crate::tui_render::screen_frame::ScreenFrameResult {
            frame: output,
            scroll_offset: frame.scroll_offset,
        };
    }
    if let Some(input) = controller.orchestration_input.as_ref() {
        let mut output = frame.frame;
        output.push_str(&render_orchestration_input_overlay(
            input,
            viewport.cols,
            viewport.rows,
        ));
        return crate::tui_render::screen_frame::ScreenFrameResult {
            frame: output,
            scroll_offset: frame.scroll_offset,
        };
    }
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

fn dashboard_runtime_version() -> String {
    read_aimux_runtime_version()
}

fn render_dashboard_subscreen_snapshot(
    viewport: DashboardViewport,
    controller: &mut DashboardController,
    endpoint: Option<&ProjectServiceEndpoint>,
    scroll_offset: usize,
) -> crate::tui_render::screen_frame::ScreenFrameResult {
    let (resource, error) = match dashboard_screen_resource_path(controller.screen) {
        Some(path) => match endpoint {
            Some(endpoint) => match fetch_dashboard_resource(endpoint, path) {
                Ok(resource) => (Some(resource), None),
                Err(error) => (None, Some(error.to_string())),
            },
            None => (None, Some("Project-service endpoint unavailable".into())),
        },
        None => (None, None),
    };
    controller.set_subscreen_actions(dashboard_screen_actions(
        controller.screen,
        resource.as_ref(),
    ));
    let frame = render_dashboard_subscreen_frame(&DashboardSubscreenRenderInput {
        screen: controller.screen,
        resource: resource.as_ref(),
        error: error.as_deref(),
        selected_index: controller.subscreen_index,
        cols: viewport.cols,
        rows: viewport.rows,
        scroll_offset,
        footer_message: controller.footer_message.as_deref(),
        details_sidebar_visible: controller.details_sidebar_visible,
        runtime_label: Some("tmux"),
        version: Some(&dashboard_runtime_version()),
        is_dev_runtime: cfg!(debug_assertions),
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
        controller.footer_message = Some(format!("No thread for {session_id}"));
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
    if session.scribe == Some(false) {
        return false;
    }
    session.scribe == Some(true)
        || session.team.as_ref().and_then(|team| team.role.as_deref()) == Some("scribe")
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

fn worktree_cache_cleanup_summary(result: &serde_json::Value) -> String {
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
    format!(
        "Removed {} from {target_count} cache item(s); {failed} failed.",
        crate::dashboard_service_input::format_worktree_cache_bytes(reclaimed_bytes)
    )
}

fn parse_desktop_state_snapshot(contents: &str) -> Result<DesktopStateSnapshot> {
    serde_json::from_str::<DesktopStateSnapshot>(contents).or_else(|_| {
        serde_json::from_str::<DesktopStateGoldenFixture>(contents)
            .map(|fixture| fixture.runtime_full)
            .map_err(anyhow::Error::from)
    })
}

fn restore_dashboard_navigation_for_render(
    ui_state: Option<&DashboardUiStatePersistence>,
    controller: &mut DashboardController,
    snapshot: &DesktopStateSnapshot,
    render_requested_by_input: bool,
) {
    if render_requested_by_input {
        return;
    }
    let Some(ui_state) = ui_state else {
        return;
    };
    ui_state.restore_navigation(&mut controller.navigation, snapshot);
}

#[cfg(test)]
mod tests {
    use super::*;
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
        restore_dashboard_navigation_for_render(Some(&ui_state), &mut controller, &reordered, true);

        assert_eq!(controller.navigation.item_index, 1);
        let Some(DashboardEntryRef::Session(selected)) =
            controller.navigation.selected_entry(&reordered)
        else {
            panic!("expected selected session");
        };
        assert_eq!(selected.id, expected_id);
        fs::remove_dir_all(root).ok();
    }
}
