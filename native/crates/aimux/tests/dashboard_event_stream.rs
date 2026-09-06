use aimux::dashboard_client::ProjectServiceEndpoint;
use aimux::dashboard_event_stream::{
    DashboardEventStreamMessage, build_project_event_stream_request,
    spawn_dashboard_project_event_stream,
};
use aimux::dashboard_project_events::DashboardProjectEvent;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
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
    let messages = collect_messages(&handle, 3);
    drop(handle);
    server.join().expect("server");

    assert!(matches!(
        messages.first(),
        Some(DashboardEventStreamMessage::Event(DashboardProjectEvent::Ready(payload)))
            if payload.get("ok").and_then(|value| value.as_bool()) == Some(true)
    ));
    assert!(matches!(
        messages.get(1),
        Some(DashboardEventStreamMessage::Event(DashboardProjectEvent::ProjectUpdate(payload)))
            if payload
                .get("views")
                .and_then(|value| value.as_array())
                .is_some_and(|views| views.iter().any(|view| view.as_str() == Some("desktop-state")))
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
