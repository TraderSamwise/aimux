use crate::config::load_config_for_project;
use crate::dashboard_client::{
    ProjectServiceEndpoint, execute_dashboard_action, fetch_dashboard_resource,
    fetch_desktop_state, refresh_dashboard_statusline, resolve_project_service_endpoint,
};
use crate::dashboard_controller::{
    DashboardController, DashboardControllerEffect, DashboardScreen, DashboardSubscreenAction,
};
use crate::dashboard_event_stream::{
    DashboardEventStreamHandle, DashboardEventStreamMessage, spawn_dashboard_project_event_stream,
};
use crate::dashboard_focus::DashboardFocusState;
use crate::dashboard_launch_options::render_launch_options_overlay;
use crate::dashboard_model::{
    DesktopStateGoldenFixture, DesktopStateSnapshot, filter_dashboard_visible_model,
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
use crate::dashboard_service_input::{
    render_service_input_overlay, render_teammate_picker_overlay,
    render_worktree_cache_cleanup_confirm_overlay, render_worktree_input_overlay,
    render_worktree_list_overlay, render_worktree_remove_confirm_overlay,
};
use crate::dashboard_terminal::{DashboardTerminalGuard, read_dashboard_keys};
use crate::dashboard_tool_picker::{enabled_dashboard_tools, render_tool_picker_overlay};
use crate::dashboard_tui_visibility::{
    DashboardTuiVisibilityState, consume_dashboard_tui_visibility_wake, mark_dashboard_tui_visible,
    read_dashboard_tui_visibility_for_loop, read_tmux_tui_visibility,
};
use crate::dashboard_ui_state::DashboardUiStatePersistence;
use anyhow::{Context, Result};
use std::fs;
use std::io::{self, Write};
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

const DASHBOARD_KEY_POLL_INTERVAL: Duration = Duration::from_millis(50);
const DASHBOARD_HIDDEN_POLL_INTERVAL: Duration = Duration::from_millis(250);
const DASHBOARD_STREAM_RETRY_INTERVAL: Duration = Duration::from_secs(2);
const DASHBOARD_FALLBACK_REFRESH_INTERVAL: Duration = Duration::from_secs(30);

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
    let mut last_render = Instant::now();
    let clock_start = Instant::now();
    let mut stdout = io::stdout();
    let mut stdin = io::stdin();
    let _terminal = if options.once {
        None
    } else {
        Some(DashboardTerminalGuard::enter(&mut stdout).context("enter dashboard terminal")?)
    };

    loop {
        let now = elapsed_millis(clock_start);
        let mut dashboard_visible = if visibility_state.started_in_dashboard {
            read_dashboard_tui_visibility_for_loop(
                &mut visibility_state,
                now,
                read_tmux_tui_visibility,
            )
            .visible
        } else {
            true
        };
        if !dashboard_visible {
            let keys = read_dashboard_keys(&mut stdin).context("read dashboard key")?;
            if keys.iter().any(|key| key.is_focus_in()) {
                mark_dashboard_tui_visible(&mut visibility_state, now, None);
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

        if render_now || last_render.elapsed() >= DASHBOARD_FALLBACK_REFRESH_INTERVAL {
            let loaded = load_dashboard_snapshot(&options)?;
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
                controller
            });
            let frame = render_dashboard_snapshot(
                &options,
                controller,
                &visible_model.snapshot,
                loaded.endpoint.as_ref(),
                visible_model.hidden_offline_agent_count,
                scroll_offset,
            );
            stdout.write_all(frame.frame.as_bytes())?;
            stdout.flush()?;
            let statusline_client_session = ui_state.as_mut().and_then(|ui_state| {
                ui_state
                    .persist_screen(controller.screen)
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

        let keys = read_dashboard_keys(&mut stdin).context("read dashboard key")?;
        if !keys.is_empty() {
            let Some(snapshot) = latest_snapshot.as_ref() else {
                render_now = true;
                thread::sleep(DASHBOARD_KEY_POLL_INTERVAL);
                continue;
            };
            let controller = controller.get_or_insert_with(|| DashboardController::new(snapshot));
            for key in keys.into_iter().filter(|key| !key.is_focus_in()) {
                match controller.handle_key(snapshot, key) {
                    DashboardControllerEffect::Quit => return Ok(()),
                    DashboardControllerEffect::Request(request) => {
                        if let Some(endpoint) = latest_endpoint.as_ref() {
                            if let Err(error) = execute_dashboard_action(endpoint, &request) {
                                controller.footer_message = Some(error.to_string());
                            }
                        } else {
                            controller.footer_message =
                                Some("Dashboard action requires a project-service endpoint".into());
                        }
                        render_now = true;
                    }
                    DashboardControllerEffect::WorktreeCacheCleanupPreview(request) => {
                        if let Some(endpoint) = latest_endpoint.as_ref() {
                            match execute_dashboard_action(endpoint, &request)
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
                    }
                    DashboardControllerEffect::WorktreeCacheCleanupApply(request) => {
                        if let Some(endpoint) = latest_endpoint.as_ref() {
                            match execute_dashboard_action(endpoint, &request)
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
                    }
                    DashboardControllerEffect::OpenAgentToolPicker(mode) => {
                        let config = load_config_for_project(&options.project_root);
                        controller.open_tool_picker(enabled_dashboard_tools(&config), mode);
                        render_now = true;
                    }
                    DashboardControllerEffect::Render => {
                        render_now = true;
                    }
                    DashboardControllerEffect::Ignored => {}
                }
            }
        }
        thread::sleep(DASHBOARD_KEY_POLL_INTERVAL);
    }
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

fn sync_dashboard_focus(
    focus_state: &mut DashboardFocusState,
    controller: &DashboardController,
    snapshot: &DesktopStateSnapshot,
    endpoint: &ProjectServiceEndpoint,
) -> bool {
    let plan = focus_state.plan_sync(snapshot, &controller.navigation);
    let mut synced_seen = false;
    for request in plan.requests {
        if execute_dashboard_action(endpoint, &request).is_ok()
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

fn render_dashboard_snapshot(
    options: &NativeDashboardOptions,
    controller: &mut DashboardController,
    snapshot: &DesktopStateSnapshot,
    endpoint: Option<&ProjectServiceEndpoint>,
    hidden_offline_agent_count: usize,
    scroll_offset: usize,
) -> crate::tui_render::screen_frame::ScreenFrameResult {
    if controller.screen != DashboardScreen::Dashboard {
        return render_dashboard_subscreen_snapshot(options, controller, endpoint, scroll_offset);
    }
    controller.navigation.clamp(snapshot);
    let (selected_session_id, selected_service_id) =
        match controller.navigation.selected_entry(snapshot) {
            Some(DashboardEntryRef::Session(session)) => (Some(session.id.as_str()), None),
            Some(DashboardEntryRef::Service(service)) => (None, Some(service.id.as_str())),
            None => (None, None),
        };
    let focused_worktree_path = controller.navigation.focused_worktree_path(snapshot);
    let frame = render_dashboard_frame(&DashboardRenderInput {
        snapshot,
        cols: options.cols,
        rows: options.rows,
        nav_level: controller.navigation.level,
        selected_session_id,
        selected_service_id,
        focused_worktree_path,
        runtime_label: Some("native"),
        version: None,
        is_dev_runtime: cfg!(debug_assertions),
        hide_offline_agents: controller.hide_offline_agents,
        hidden_offline_agent_count,
        scroll_offset,
        footer_message: controller.footer_message.as_deref(),
        details_sidebar_visible: controller.details_sidebar_visible,
    });
    if let Some(launch_options) = controller.launch_options.as_ref() {
        let mut output = frame.frame;
        let selected_tool = controller
            .tool_picker
            .as_ref()
            .and_then(|picker| picker.selected_tool());
        output.push_str(&render_launch_options_overlay(
            launch_options,
            selected_tool,
            options.cols,
            options.rows,
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
            options.cols,
            options.rows,
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
            options.cols,
            options.rows,
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
            options.cols,
            options.rows,
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
            options.cols,
            options.rows,
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
            options.cols,
            options.rows,
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
            options.cols,
            options.rows,
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
            options.cols,
            options.rows,
        ) {
            let mut output = frame.frame;
            output.push_str(&overlay);
            return crate::tui_render::screen_frame::ScreenFrameResult {
                frame: output,
                scroll_offset: frame.scroll_offset,
            };
        }
    }
    frame
}

fn render_dashboard_subscreen_snapshot(
    options: &NativeDashboardOptions,
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
    render_dashboard_subscreen_frame(&DashboardSubscreenRenderInput {
        screen: controller.screen,
        resource: resource.as_ref(),
        error: error.as_deref(),
        selected_index: controller.subscreen_index,
        cols: options.cols,
        rows: options.rows,
        scroll_offset,
        footer_message: controller.footer_message.as_deref(),
        details_sidebar_visible: controller.details_sidebar_visible,
    })
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
