use aimux::async_runtime::{AsyncTaskKind, doctor_tasks_report};
use aimux::dashboard_client::ProjectServiceEndpoint;
use aimux::dashboard_event_stream::{
    DashboardEventStreamMessage, build_project_event_stream_request,
    spawn_dashboard_project_event_stream, spawn_dashboard_project_event_stream_with_capacity,
};
use aimux::dashboard_project_events::DashboardProjectEvent;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

#[test]
fn builds_project_events_sse_request() {
    let request = build_project_event_stream_request(&ProjectServiceEndpoint {
        host: "127.0.0.1".into(),
        port: 49152,
    });

    assert_eq!(
        request,
        "GET /events HTTP/1.1\r\nHost: 127.0.0.1:49152\r\nAccept: text/event-stream\r\nConnection: close\r\n\r\n"
    );
}

#[test]
fn decodes_chunked_project_event_stream() {
    let (endpoint, server) = serve_once(|mut stream| {
        let request = read_request_text(&mut stream);
        assert!(request.starts_with("GET /events HTTP/1.1\r\n"));
        assert!(request.contains("Accept: text/event-stream\r\n"));
        let body = b"event: ready\ndata: {\"ok\":true}\n\nevent: project_update\ndata: {\"views\":[\"desktop-state\"]}\n\n";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
            body.len(),
            String::from_utf8_lossy(body)
        );
        stream
            .write_all(response.as_bytes())
            .expect("write response");
    });

    let handle = spawn_dashboard_project_event_stream(endpoint);
    let messages = collect_messages(&handle, 4);
    drop(handle);
    server.join().expect("server");

    // The subscription is announced before anything it carries: an idle project
    // delivers no events for minutes, and the dashboard has to be able to tell
    // "connected and quiet" from "still down".
    assert_eq!(messages.first(), Some(&DashboardEventStreamMessage::Opened));
    assert!(matches!(
        messages.get(1),
        Some(DashboardEventStreamMessage::Event(DashboardProjectEvent::Ready(payload)))
            if payload.get("ok").and_then(|value| value.as_bool()) == Some(true)
    ));
    assert!(matches!(
        messages.get(2),
        Some(DashboardEventStreamMessage::Event(DashboardProjectEvent::ProjectUpdate(payload)))
            if payload
                .get("views")
                .and_then(|value| value.as_array())
                .is_some_and(|views| views.iter().any(|view| view.as_str() == Some("desktop-state")))
    ));
    assert_eq!(messages.last(), Some(&DashboardEventStreamMessage::Ended));
}

#[test]
fn event_stream_reader_is_registered_as_async_task() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let port = listener.local_addr().expect("local addr").port();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let _ = read_request_text(&mut stream);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .expect("write headers");
        ready_tx.send(()).expect("ready");
        // Held until released, not for a fixed sleep. The registration guard is
        // dropped when the future completes, and the future completes when this
        // socket closes -- so a sleep makes the window in which the task is
        // observable exactly that long, and a main thread starved for 250ms
        // finds the task already gone and reports "async task registered"
        // without a hint that load was the cause. It HAD the same shape as the
        // drop test below, and half its budget, which is why it is fixed here
        // too; both are now capped rather than slept.
        let _ = release_rx.recv_timeout(Duration::from_secs(5));
    });

    let endpoint = ProjectServiceEndpoint {
        host: "127.0.0.1".into(),
        port,
    };
    let handle = spawn_dashboard_project_event_stream(endpoint);
    ready_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("stream opened");
    let task = wait_for_dashboard_event_stream_task(port).expect("async task registered");
    let _ = release_tx.send(());
    assert_eq!(task.kind, AsyncTaskKind::Async);
    drop(handle);
    server.join().expect("server");
}

#[test]
fn bounded_channel_preserves_fast_stream_events_for_slow_dashboard() {
    let (endpoint, server) = serve_once(|mut stream| {
        let _ = read_request_text(&mut stream);
        let body = b"event: ready\ndata: {\"sequence\":1}\n\nevent: project_update\ndata: {\"sequence\":2}\n\nevent: alert\ndata: {\"sequence\":3}\n\n";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
            body.len(),
            String::from_utf8_lossy(body)
        );
        stream
            .write_all(response.as_bytes())
            .expect("write response");
    });

    let handle = spawn_dashboard_project_event_stream_with_capacity(endpoint, 1);
    thread::sleep(Duration::from_millis(50));
    let messages = collect_messages(&handle, 5);
    drop(handle);
    server.join().expect("server");

    assert_eq!(messages.first(), Some(&DashboardEventStreamMessage::Opened));
    assert!(matches!(
        messages.get(1),
        Some(DashboardEventStreamMessage::Event(DashboardProjectEvent::Ready(payload)))
            if payload.get("sequence").and_then(|value| value.as_i64()) == Some(1)
    ));
    assert!(matches!(
        messages.get(2),
        Some(DashboardEventStreamMessage::Event(DashboardProjectEvent::ProjectUpdate(payload)))
            if payload.get("sequence").and_then(|value| value.as_i64()) == Some(2)
    ));
    assert!(matches!(
        messages.get(3),
        Some(DashboardEventStreamMessage::Event(DashboardProjectEvent::Alert(payload)))
            if payload.get("sequence").and_then(|value| value.as_i64()) == Some(3)
    ));
    assert_eq!(messages.last(), Some(&DashboardEventStreamMessage::Ended));
}

#[test]
fn reports_non_success_stream_response() {
    let (endpoint, server) = serve_once(|mut stream| {
        let _ = read_request_text(&mut stream);
        stream
            .write_all(
                b"HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nContent-Length: 4\r\n\r\nnope",
            )
            .expect("write response");
    });

    let handle = spawn_dashboard_project_event_stream(endpoint);
    let messages = collect_messages(&handle, 1);
    drop(handle);
    server.join().expect("server");

    assert_eq!(
        messages,
        vec![DashboardEventStreamMessage::Error(
            "project event stream failed: 503".into()
        )]
    );
}

#[test]
fn reports_stream_framing_errors_instead_of_ending_silently() {
    let (endpoint, server) = serve_once(|mut stream| {
        let _ = read_request_text(&mut stream);
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\nnot-hex\r\n",
            )
            .expect("write response");
    });

    let handle = spawn_dashboard_project_event_stream(endpoint);
    let messages = collect_messages(&handle, 2);
    drop(handle);
    server.join().expect("server");

    assert_eq!(
        messages,
        vec![
            DashboardEventStreamMessage::Opened,
            DashboardEventStreamMessage::Error("invalid event stream chunk size: not-hex".into())
        ]
    );
}

#[test]
fn dropping_stream_handle_does_not_wait_for_silent_peer_timeout() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let port = listener.local_addr().expect("local addr").port();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    // The server holds the connection until the test RELEASES it, rather than
    // for a fixed sleep.
    //
    // With a sleep, what the test measures is `SERVER_HOLD - epsilon`, where
    // epsilon is however long the test took to wake up after the server's
    // ready signal -- so the margin erodes with exactly the load the bound was
    // widened for. Holding until released takes epsilon out of it: a drop that
    // blocks on the server waits for a release that only comes after the drop,
    // so it waits the whole hold however busy the machine is. It also costs
    // nothing on success, where the release arrives immediately.
    // Two different jobs, two different numbers, because collapsing them into
    // one leaves a silent false PASS.
    //
    // `SERVER_HOLD` is only a safety cap so a wedged test cannot hang a CI
    // worker; nothing legitimate waits on it. `BLOCKING_DROP` is the
    // assertion. When the bound was `SERVER_HOLD / 2` the two were the same
    // constant, and a main thread starved for longer than the hold let the
    // server time out on its own: the socket closes, the task completes, and a
    // genuinely blocking `Drop` then returns instantly and PASSES. That is a
    // load-dependent false pass where the shape before it was a
    // load-dependent false failure -- rarer and silent, which is worse.
    //
    // And `BLOCKING_DROP` is not "the quantity it must not have waited for",
    // unlike the bound in `daemon_jobs`. `join.abort()` is an atomic store and
    // a wake, so a healthy drop is microseconds and a blocking one is the whole
    // hold; anything between is a round number, and this one is chosen for a
    // wide margin on both sides rather than derived.
    const SERVER_HOLD: Duration = Duration::from_secs(60);
    const BLOCKING_DROP: Duration = Duration::from_millis(1_500);
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let _ = read_request_text(&mut stream);
        ready_tx.send(()).expect("ready");
        let _ = release_rx.recv_timeout(SERVER_HOLD);
    });
    let handle = spawn_dashboard_project_event_stream(ProjectServiceEndpoint {
        host: "127.0.0.1".into(),
        port,
    });
    ready_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("stream opened request");

    // Dropping the handle must not wait for the server. `Drop` is
    // `join.abort()`; the regression is making it block on the task, and the
    // task ends when the server's socket closes.
    //
    // The bound was 100ms and bare -- no message, no stated invariant -- the
    // shape that fails on a loaded machine and tells whoever finds it nothing.
    // My first repair made it 400ms against a 500ms sleep, which a review
    // showed was worse: a blocking drop measures `500ms - epsilon`, so the
    // assertion only fired while the test woke within 100ms of the server, and
    // at the 200ms of delay the same commit called ordinary a fully blocking
    // drop measured 300ms and PASSED. It detected the regression only in the
    // regime where the old bound was already fine. The prove-failure hid it,
    // because a `Drop` that sleeps 500ms is stronger than the real regression
    // and independent of epsilon.
    //
    // The release above removes epsilon, so half the hold is a real margin.
    let start = Instant::now();
    drop(handle);
    let dropped_in = start.elapsed();
    // Before the assertion, so a failure does not also leave the server
    // sitting out its whole hold.
    let _ = release_tx.send(());
    assert!(
        dropped_in < BLOCKING_DROP,
        "dropping the stream handle took {dropped_in:?} against a \
         {BLOCKING_DROP:?} bound. `join.abort()` is microseconds, and the \
         server is released only after this drop, so anything on this scale \
         means the drop waited for the server instead of aborting"
    );
    server.join().expect("server");
}

fn serve_once(
    handle: impl FnOnce(TcpStream) + Send + 'static,
) -> (ProjectServiceEndpoint, JoinHandle<()>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind");
    let port = listener.local_addr().expect("local addr").port();
    let join = thread::spawn(move || {
        let (stream, _) = listener.accept().expect("accept");
        handle(stream);
    });
    (
        ProjectServiceEndpoint {
            host: "127.0.0.1".into(),
            port,
        },
        join,
    )
}

fn read_request_text(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .expect("set timeout");
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 1024];
    while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
        let count = stream.read(&mut buffer).expect("read request");
        assert_ne!(count, 0, "connection closed before request headers ended");
        bytes.extend_from_slice(&buffer[..count]);
    }
    String::from_utf8(bytes).expect("utf8 request")
}

fn collect_messages(
    handle: &aimux::dashboard_event_stream::DashboardEventStreamHandle,
    expected: usize,
) -> Vec<DashboardEventStreamMessage> {
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut messages = Vec::new();
    while messages.len() < expected && Instant::now() < deadline {
        match handle.try_recv() {
            Ok(message) => messages.push(message),
            Err(std::sync::mpsc::TryRecvError::Empty) => thread::sleep(Duration::from_millis(10)),
            Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
        }
    }
    messages
}

fn wait_for_dashboard_event_stream_task(
    port: u16,
) -> Option<aimux::async_runtime::AsyncTaskSnapshot> {
    let needle = format!("dashboard:project-event-stream 127.0.0.1:{port}");
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if let Some(task) = doctor_tasks_report()
            .tasks
            .into_iter()
            .find(|task| task.name == needle)
        {
            return Some(task);
        }
        thread::sleep(Duration::from_millis(10));
    }
    None
}
