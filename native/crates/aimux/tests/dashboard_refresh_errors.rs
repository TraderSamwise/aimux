use aimux::dashboard_client::{ProjectServiceEndpoint, fetch_desktop_state};
use aimux::dashboard_internal::{
    DashboardSnapshotLoad, DashboardSnapshotRefreshFailure, DashboardSnapshotRefreshOutcome,
    DashboardSnapshotRefreshRepairEvent, record_dashboard_snapshot_refresh_repair_event,
    resolve_dashboard_snapshot_refresh,
};
use aimux::dashboard_model::{DesktopStateGoldenFixture, DesktopStateSnapshot};
use aimux::dashboard_renderer::{DashboardNavLevel, DashboardRenderInput, render_dashboard_frame};
use aimux::paths::PathResolver;
use aimux::repair_events::{ACTION_DASHBOARD_REFRESH, STATUS_FAILED, STATUS_REPAIRED};
use anyhow::{Context, Result, anyhow};
use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

const GOLDEN: &str = include_str!("../../../../src/multiplexer/desktop-state-golden.fixture.json");

#[test]
fn transient_desktop_state_failure_keeps_last_snapshot_and_surfaces_chrome() {
    let snapshot = fixture_snapshot();
    let mut state = DashboardSnapshotRefreshFailure::default();
    let mut events = Vec::new();

    let outcome = resolve_dashboard_snapshot_refresh(
        Some(&snapshot),
        Some(&endpoint()),
        &mut state,
        Err(anyhow!(
            "request project desktop-state: tmux live window query failed"
        )),
        |event| events.push(event),
    )
    .expect("transient refresh failure should keep dashboard alive");

    let DashboardSnapshotRefreshOutcome::Stale {
        snapshot: stale_snapshot,
        endpoint: stale_endpoint,
        footer_message,
    } = outcome
    else {
        panic!("expected stale render outcome");
    };
    assert_eq!(stale_snapshot, snapshot);
    assert_eq!(stale_endpoint, Some(endpoint()));
    assert!(
        footer_message.contains("Dashboard data stale"),
        "{footer_message}"
    );
    assert!(
        footer_message.contains("tmux live window query failed"),
        "{footer_message}"
    );
    assert_eq!(
        events,
        vec![DashboardSnapshotRefreshRepairEvent {
            status: STATUS_FAILED,
            error: "request project desktop-state: tmux live window query failed".into(),
        }]
    );

    let frame = render_dashboard_with_footer(&snapshot, &footer_message);
    assert!(frame.contains("Dashboard data stale"), "{frame}");
    assert!(frame.contains("tmux live window query failed"), "{frame}");
}

#[test]
fn desktop_state_transport_non_2xx_ok_false_and_parse_errors_are_transient() {
    let cases: Vec<(&str, Result<DesktopStateSnapshot>)> = vec![
        ("transport", fetch_from_closed_port()),
        (
            "non-2xx",
            fetch_from_response(503, r#"{"ok":true,"error":"service unavailable"}"#),
        ),
        (
            "ok-false",
            fetch_from_response(200, r#"{"ok":false,"error":"not ready"}"#),
        ),
        ("json-parse", fetch_from_response(200, r#"{"ok":true}"#)),
    ];

    for (label, result) in cases {
        let snapshot = fixture_snapshot();
        let mut state = DashboardSnapshotRefreshFailure::default();
        let mut events = Vec::new();
        let error = result
            .context("request project desktop-state")
            .expect_err("case should fail");

        let outcome = resolve_dashboard_snapshot_refresh(
            Some(&snapshot),
            Some(&endpoint()),
            &mut state,
            Err(error),
            |event| events.push(event),
        )
        .unwrap_or_else(|error| panic!("{label} should be stale, not fatal: {error:#}"));

        let DashboardSnapshotRefreshOutcome::Stale {
            snapshot: stale_snapshot,
            footer_message,
            ..
        } = outcome
        else {
            panic!("{label} expected stale render outcome");
        };
        assert_eq!(stale_snapshot, snapshot, "{label} kept last snapshot");
        assert!(
            footer_message.contains("Dashboard data stale"),
            "{label}: {footer_message}"
        );
        assert_eq!(events.len(), 1, "{label} records one repair event");
        assert_eq!(events[0].status, STATUS_FAILED, "{label}");
        assert!(
            !events[0].error.trim().is_empty(),
            "{label} preserves failure reason"
        );
    }
}

#[test]
fn refresh_recovery_loads_success_and_records_repaired_event() {
    let snapshot = fixture_snapshot();
    let recovered = DashboardSnapshotLoad {
        snapshot: snapshot.clone(),
        endpoint: Some(endpoint()),
    };
    let mut state = DashboardSnapshotRefreshFailure::default();
    let mut events = Vec::new();

    let stale = resolve_dashboard_snapshot_refresh(
        Some(&snapshot),
        Some(&endpoint()),
        &mut state,
        Err(anyhow!("request project desktop-state: temporary outage")),
        |event| events.push(event),
    )
    .expect("stale render");
    assert!(matches!(
        stale,
        DashboardSnapshotRefreshOutcome::Stale { .. }
    ));

    let loaded = resolve_dashboard_snapshot_refresh(
        Some(&snapshot),
        Some(&endpoint()),
        &mut state,
        Ok(recovered.clone()),
        |event| events.push(event),
    )
    .expect("recovered refresh");

    let DashboardSnapshotRefreshOutcome::Loaded(actual) = loaded else {
        panic!("expected loaded outcome after recovery");
    };
    assert_eq!(actual.snapshot, recovered.snapshot);
    assert_eq!(actual.endpoint, recovered.endpoint);
    assert_eq!(events.len(), 2);
    assert_eq!(events[0].status, STATUS_FAILED);
    assert_eq!(events[1].status, STATUS_REPAIRED);
    assert_eq!(
        events[1].error,
        "request project desktop-state: temporary outage"
    );
}

#[test]
fn fatal_startup_condition_still_fails_clearly() {
    let mut state = DashboardSnapshotRefreshFailure::default();
    let mut events = Vec::new();

    let error = resolve_dashboard_snapshot_refresh(
        None,
        None,
        &mut state,
        Err(anyhow!(
            "project service is unavailable for /tmp/missing-project"
        )),
        |event| events.push(event),
    )
    .expect_err("first load without a snapshot should stay fatal");

    let message = format!("{error:#}");
    assert!(
        message.contains("load initial dashboard snapshot"),
        "{message}"
    );
    assert!(
        message.contains("project service is unavailable for /tmp/missing-project"),
        "{message}"
    );
    assert!(events.is_empty(), "startup failure is not a stale refresh");
}

#[test]
fn dashboard_refresh_repair_event_is_written_to_project_log() {
    let home = temp_dir("dashboard-refresh-repair-home");
    let project = temp_dir("dashboard-refresh-repair-project");
    let resolver = PathResolver::new("/", &home, None);
    let event = DashboardSnapshotRefreshRepairEvent {
        status: STATUS_FAILED,
        error: "request project desktop-state: bad json".into(),
    };

    record_dashboard_snapshot_refresh_repair_event(&resolver, &project, &event);

    let mut resolver = PathResolver::new("/", &home, None);
    let path = resolver.project_repair_log_path_for(&project);
    let line = fs::read_to_string(&path)
        .expect("repair log")
        .lines()
        .next()
        .and_then(|line| serde_json::from_str::<Value>(line).ok())
        .expect("repair event json");
    assert_eq!(line["action"], ACTION_DASHBOARD_REFRESH);
    assert_eq!(line["reason"], "dashboard-refresh");
    assert_eq!(line["status"], STATUS_FAILED);
    assert_eq!(
        line["details"]["error"],
        "request project desktop-state: bad json"
    );

    fs::remove_dir_all(home).ok();
    fs::remove_dir_all(project).ok();
}

fn render_dashboard_with_footer(snapshot: &DesktopStateSnapshot, footer_message: &str) -> String {
    let empty = Vec::new();
    render_dashboard_frame(&DashboardRenderInput {
        snapshot,
        overseer_sessions: &empty,
        scribe_sessions: &empty,
        cols: 120,
        rows: 30,
        nav_level: DashboardNavLevel::Sessions,
        selected_session_id: None,
        selected_service_id: None,
        focused_worktree_path: None,
        focused_group_index: None,
        runtime_label: Some("tmux"),
        version: Some("test"),
        hide_offline_agents: false,
        hidden_offline_agent_count: 0,
        scroll_offset: 0,
        footer_message: Some(footer_message),
        details_sidebar_visible: false,
        preview_source: "terminal",
        scribe_preview_entries: &[],
    })
    .frame
}

fn fetch_from_response(status: u16, body: &'static str) -> Result<DesktopStateSnapshot> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind test server");
    let port = listener.local_addr().expect("addr").port();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept request");
        drain_request(&mut stream);
        let response = format!(
            "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream
            .write_all(response.as_bytes())
            .expect("write response");
    });
    let result = fetch_desktop_state(&ProjectServiceEndpoint {
        host: "127.0.0.1".into(),
        port,
    });
    handle.join().expect("server thread");
    result
}

fn fetch_from_closed_port() -> Result<DesktopStateSnapshot> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind unused port");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);
    fetch_desktop_state(&ProjectServiceEndpoint {
        host: "127.0.0.1".into(),
        port,
    })
}

fn drain_request(stream: &mut TcpStream) {
    let mut buffer = [0_u8; 1024];
    let _ = stream.read(&mut buffer);
}

fn fixture_snapshot() -> DesktopStateSnapshot {
    serde_json::from_str::<DesktopStateGoldenFixture>(GOLDEN)
        .expect("fixture")
        .runtime_full
}

fn endpoint() -> ProjectServiceEndpoint {
    ProjectServiceEndpoint {
        host: "127.0.0.1".into(),
        port: 44191,
    }
}

fn temp_dir(prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()))
}
