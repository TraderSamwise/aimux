use aimux::dashboard_project_events::{
    DashboardProjectEvent, DashboardProjectRefreshState, ProjectEventsSseDecoder,
    event_requests_desktop_state,
};
use serde_json::json;

#[test]
fn decodes_project_update_sse_frames_across_chunks() {
    let mut decoder = ProjectEventsSseDecoder::default();
    assert!(
        decoder
            .push_chunk(b"event: project_update\ndata: {\"type\":\"project")
            .expect("first chunk")
            .is_empty()
    );
    let events = decoder
        .push_chunk(b"_update\",\"views\":[\"desktop-state\"]}\n\n")
        .expect("second chunk");

    assert_eq!(events.len(), 1);
    let DashboardProjectEvent::ProjectUpdate(payload) = &events[0] else {
        panic!("expected project update");
    };
    assert_eq!(payload["type"], "project_update");
    assert_eq!(payload["views"], json!(["desktop-state"]));
}

#[test]
fn decodes_multiline_data_and_ignores_unknown_event_names() {
    let mut decoder = ProjectEventsSseDecoder::default();
    let events = decoder
        .push_chunk(
            b": heartbeat\nevent: alert\ndata: {\"type\":\"alert\",\ndata: \"sessionId\":\"codex-1\"}\n\nevent: nope\ndata: {\"type\":\"nope\"}\n\n",
        )
        .expect("decode frames");

    assert_eq!(events.len(), 1);
    let DashboardProjectEvent::Alert(payload) = &events[0] else {
        panic!("expected alert");
    };
    assert_eq!(payload["sessionId"], "codex-1");
}

#[test]
fn overflow_reports_limit_and_resets_decoder() {
    let mut decoder = ProjectEventsSseDecoder::new(48);
    let error = decoder
        .push_chunk(b"data: this frame is too large for the configured decoder limit")
        .expect_err("overflow");

    assert_eq!(error.limit(), 48);
    let events = decoder
        .push_chunk(b"event: ready\ndata: {\"type\":\"ready\"}\n\n")
        .expect("decoder recovers after overflow");
    assert!(matches!(
        events.as_slice(),
        [DashboardProjectEvent::Ready(_)]
    ));
}

#[test]
fn refresh_state_coalesces_desktop_state_updates() {
    let mut state = DashboardProjectRefreshState::default();
    let event = DashboardProjectEvent::ProjectUpdate(
        json!({ "type": "project_update", "views": ["notifications", "team"] })
            .as_object()
            .expect("object")
            .clone(),
    );

    state.observe(&event);
    assert!(state.refresh_pending());
    assert!(state.take_refresh_request());
    assert!(state.refresh_in_flight());
    assert!(!state.take_refresh_request());
    state.observe(&event);
    assert!(state.refresh_pending());
    assert!(!state.take_refresh_request());
    state.complete_refresh();
    assert!(state.take_refresh_request());
}

#[test]
fn ready_refreshes_but_plain_alert_does_not() {
    let ready = DashboardProjectEvent::Ready(
        json!({ "type": "ready" })
            .as_object()
            .expect("object")
            .clone(),
    );
    let alert = DashboardProjectEvent::Alert(
        json!({ "type": "alert", "sessionId": "codex-1" })
            .as_object()
            .expect("object")
            .clone(),
    );

    assert!(event_requests_desktop_state(&ready));
    assert!(!event_requests_desktop_state(&alert));
}

#[test]
fn handles_crlf_and_ignores_invalid_payload_shapes() {
    let mut decoder = ProjectEventsSseDecoder::default();
    let events = decoder
        .push_chunk(
            b"event: alert\r\ndata: nope\r\n\r\nevent: project_update\r\ndata: []\r\n\r\nevent: alert\r\ndata: {\"title\":\"kept\"}\r\n\r\n",
        )
        .expect("decode frames");

    assert_eq!(events.len(), 1);
    assert_eq!(events[0].payload()["title"], "kept");
}
