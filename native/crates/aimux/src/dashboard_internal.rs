use crate::config::load_config_for_project;
use crate::dashboard_client::{
    ProjectServiceEndpoint, execute_dashboard_action, fetch_desktop_state,
    resolve_project_service_endpoint,
};
use crate::dashboard_controller::{DashboardController, DashboardControllerEffect};
use crate::dashboard_event_stream::{
    DashboardEventStreamHandle, DashboardEventStreamMessage, spawn_dashboard_project_event_stream,
};
use crate::dashboard_focus::DashboardFocusState;
use crate::dashboard_launch_options::render_launch_options_overlay;
use crate::dashboard_model::{DesktopStateGoldenFixture, DesktopStateSnapshot};
use crate::dashboard_navigation::DashboardEntryRef;
use crate::dashboard_project_events::{
    DashboardProjectEvent, DashboardProjectRefreshState, dashboard_alert_footer_flash,
};
use crate::dashboard_readiness::mark_native_dashboard_ready;
use crate::dashboard_renderer::{DashboardRenderInput, render_dashboard_frame};
use crate::dashboard_service_input::render_service_input_overlay;
use crate::dashboard_terminal::{DashboardTerminalGuard, read_dashboard_keys};
use crate::dashboard_tool_picker::{enabled_dashboard_tools, render_tool_picker_overlay};
use crate::dashboard_tui_visibility::{
    DashboardTuiVisibilityState, consume_dashboard_tui_visibility_wake,
    read_dashboard_tui_visibility_for_state, read_tmux_tui_visibility,
};
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
    let mut controller = None;
    let mut focus_state = DashboardFocusState::default();
    let mut ready_marked = false;
    let mut scroll_offset = 0;
    let mut latest_snapshot = None;
    let mut latest_endpoint = None;
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
        if drain_dashboard_event_stream(
            &mut event_stream,
            &mut event_stream_retry_at,
            &mut refresh_state,
            controller.as_mut(),
        ) {
            render_now = true;
        }

        let dashboard_visible = if visibility_state.started_in_dashboard {
            read_dashboard_tui_visibility_for_state(
                &mut visibility_state,
                false,
                elapsed_millis(clock_start),
                read_tmux_tui_visibility,
            )
            .visible
        } else {
            true
        };
        if !dashboard_visible {
            thread::sleep(DASHBOARD_HIDDEN_POLL_INTERVAL);
            continue;
        }
        if consume_dashboard_tui_visibility_wake(&mut visibility_state) {
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
            let controller =
                controller.get_or_insert_with(|| DashboardController::new(&loaded.snapshot));
            let frame =
                render_dashboard_snapshot(&options, controller, &loaded.snapshot, scroll_offset);
            stdout.write_all(frame.frame.as_bytes())?;
            stdout.flush()?;
            scroll_offset = frame.scroll_offset;
            if !ready_marked {
                let _ = mark_native_dashboard_ready(&options.project_root);
                ready_marked = true;
            }
            latest_snapshot = Some(loaded.snapshot);
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
            for key in keys {
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

fn drain_dashboard_event_stream(
    event_stream: &mut Option<DashboardEventStreamHandle>,
    retry_at: &mut Option<Instant>,
    refresh_state: &mut DashboardProjectRefreshState,
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
                refresh_state.observe(&event);
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
    scroll_offset: usize,
) -> crate::tui_render::screen_frame::ScreenFrameResult {
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
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
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
    frame
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

fn parse_desktop_state_snapshot(contents: &str) -> Result<DesktopStateSnapshot> {
    serde_json::from_str::<DesktopStateSnapshot>(contents).or_else(|_| {
        serde_json::from_str::<DesktopStateGoldenFixture>(contents)
            .map(|fixture| fixture.runtime_full)
            .map_err(anyhow::Error::from)
    })
}
