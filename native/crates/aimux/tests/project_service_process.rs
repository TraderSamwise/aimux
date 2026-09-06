use aimux::daemon_state::{MetadataState, load_metadata_endpoint, save_metadata_state};
#[cfg(unix)]
use aimux::expose_socket::{expose_socket_path, expose_socket_path_file};
use aimux::project_service::agent_output::AgentOutputCaptureRuntime;
use aimux::project_service::dispatcher::{ProjectServiceStreamKind, ProjectServiceStreamPlan};
use aimux::project_service::http::prepare_project_service_sse_response;
#[cfg(unix)]
use aimux::project_service::process::start_project_expose_socket;
use aimux::project_service::process::{
    ProjectServiceStartup, desired_project_service_port, handle_project_service_connection,
    publish_project_service_endpoint, write_project_service_response,
    write_project_service_response_with_runtime,
};
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::runtime_topology::{coerce_runtime_topology, runtime_topology_path};
use aimux::tmux::CapturePaneOptions;
use serde_json::json;
use std::collections::BTreeMap;
use std::fs::{create_dir_all, read_to_string, remove_dir_all, write};
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct FakeStreamRuntime {
    output: String,
    calls: Vec<(String, CapturePaneOptions)>,
}

impl AgentOutputCaptureRuntime for FakeStreamRuntime {
    fn capture_pane(
        &mut self,
        window_id: &str,
        options: CapturePaneOptions,
    ) -> Result<String, String> {
        self.calls.push((window_id.to_owned(), options));
        Ok(self.output.clone())
    }
}

#[test]
fn desired_project_service_port_matches_project_id_hash_lane() {
    let first = desired_project_service_port("project-alpha");
    let second = desired_project_service_port("project-alpha");
    let other = desired_project_service_port("project-beta");

    assert_eq!(first, second);
    assert!((43_000..53_000).contains(&first));
    assert_ne!(first, other);
}

#[test]
fn publishes_metadata_endpoint_json_and_text() {
    let project = temp_project("endpoint");
    let state_dir = project.join("state");

    let endpoint = publish_project_service_endpoint(&state_dir, 45_123).expect("publish endpoint");

    assert_eq!(endpoint.host, "127.0.0.1");
    assert_eq!(endpoint.port, 45_123);
    assert_eq!(
        load_metadata_endpoint(&state_dir).expect("endpoint json"),
        endpoint
    );
    assert_eq!(
        read_to_string(state_dir.join("metadata-api.txt")).expect("endpoint text"),
        "http://127.0.0.1:45123\n"
    );
    cleanup(project);
}

#[test]
fn project_service_connection_routes_http_to_rust_project_router() {
    let project = temp_project("connection");
    let state_dir = project.join("state");
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let mut stream = MemoryStream::new(
        b"POST /set-status HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 36\r\n\r\n{\"session\":\"codex-1\",\"text\":\"ready\"}",
    );

    handle_project_service_connection(&mut stream, &context).expect("connection");

    let response = String::from_utf8(stream.output).expect("response");
    assert!(response.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(response.contains("content-type: application/json\r\n"));
    assert!(response.ends_with(r#"{"ok":true}"#));

    let mut health = MemoryStream::new(b"GET /health HTTP/1.1\r\n\r\n");
    handle_project_service_connection(&mut health, &context).expect("health");
    let health_response = String::from_utf8(health.output).expect("health response");
    assert!(health_response.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(health_response.contains("\"ok\":true"));
    assert!(health_response.contains("\"projectStateDir\""));
    assert!(health_response.contains("\"serviceInfo\""));
    cleanup(project);
}

#[test]
fn stream_response_writer_keeps_sse_connection_alive_until_client_disconnects() {
    let response = prepare_project_service_sse_response(
        200,
        b"event: ready\ndata: {\"ok\":true}\n\n".to_vec(),
        Some(ProjectServiceStreamPlan {
            kind: ProjectServiceStreamKind::ProjectEvents,
            session_id: None,
            start_line: None,
            interval_ms: 100,
            mode: None,
        }),
        Default::default(),
    );
    let mut writer = DisconnectAfterWrites::new(2);

    let error = write_project_service_response(&mut writer, &response).expect_err("disconnect");

    assert!(matches!(
        error,
        aimux::daemon::listener::DaemonListenerError::Io(_)
    ));
    let output = String::from_utf8(writer.output).expect("sse response");
    assert!(output.starts_with("HTTP/1.1 200 OK\r\n"));
    assert!(output.contains("content-type: text/event-stream\r\n"));
    assert!(output.contains("event: ready\ndata: {\"ok\":true}\n\n"));
    assert!(output.contains(": keepalive\n\n"));
}

#[test]
fn output_stream_writer_emits_native_chat_output_frames() {
    let project = temp_project("output-stream");
    let state_dir = project.join("state");
    write_output_stream_state(&state_dir);
    let context = ProjectServiceRequestContext::with_project_state_dir(&project, &state_dir);
    let response = prepare_project_service_sse_response(
        200,
        b"event: ready\ndata: {\"sessionId\":\"codex-1\"}\n\n".to_vec(),
        Some(ProjectServiceStreamPlan {
            kind: ProjectServiceStreamKind::AgentOutput,
            session_id: Some("codex-1".into()),
            start_line: Some(-120),
            interval_ms: 100,
            mode: Some("chat".into()),
        }),
        Default::default(),
    );
    let mut writer = DisconnectAfterWrites::new(2);
    let mut runtime = FakeStreamRuntime {
        output: "› Build it\n• Working (12s • esc to interrupt)\n• Built it.".into(),
        calls: Vec::new(),
    };

    let error = write_project_service_response_with_runtime(
        &mut writer,
        &response,
        Some(&context),
        &mut runtime,
    )
    .expect_err("disconnect");

    assert!(matches!(
        error,
        aimux::daemon::listener::DaemonListenerError::Io(_)
    ));
    assert!(!runtime.calls.is_empty());
    assert_eq!(runtime.calls[0].0, "@1");
    let output = String::from_utf8(writer.output).expect("sse response");
    assert!(output.contains("event: ready\ndata: {\"sessionId\":\"codex-1\"}\n\n"));
    assert!(output.contains("event: output\n"));
    assert!(output.contains("\"sessionId\":\"codex-1\""));
    assert!(output.contains("\"activityText\":\"Working (12s)\""));
    assert!(output.contains("\"messages\":["));
    assert!(!output.contains("\"parsed\""));
    assert!(!output.contains("\"outputAnsi\""));
    cleanup(project);
}

#[cfg(unix)]
#[test]
fn project_service_expose_socket_publishes_and_cleans_up_path() {
    let project = temp_project("expose-socket");
    let state_dir = project.join("state");
    let startup = ProjectServiceStartup {
        project_id: "project".into(),
        project_root: project.clone(),
        project_state_dir: state_dir.clone(),
        desired_port: 0,
    };

    let socket_path = expose_socket_path(&state_dir);
    let path_file = expose_socket_path_file(&state_dir);
    let guard = start_project_expose_socket(&startup).expect("start expose socket");

    assert!(socket_path.exists());
    assert_eq!(
        read_to_string(&path_file).expect("socket path file"),
        format!("{}\n", socket_path.display())
    );

    drop(guard);
    assert!(!socket_path.exists());
    assert!(!path_file.exists());
    cleanup(project);
}

struct MemoryStream {
    input: Vec<u8>,
    offset: usize,
    output: Vec<u8>,
}

struct DisconnectAfterWrites {
    writes_left: usize,
    output: Vec<u8>,
}

impl DisconnectAfterWrites {
    fn new(writes_left: usize) -> Self {
        Self {
            writes_left,
            output: Vec::new(),
        }
    }
}

impl Write for DisconnectAfterWrites {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        if self.writes_left == 0 {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "client disconnected",
            ));
        }
        self.writes_left -= 1;
        self.output.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl MemoryStream {
    fn new(input: &[u8]) -> Self {
        Self {
            input: input.to_vec(),
            offset: 0,
            output: Vec::new(),
        }
    }
}

impl Read for MemoryStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.offset >= self.input.len() {
            return Ok(0);
        }
        let count = buffer.len().min(self.input.len() - self.offset);
        buffer[..count].copy_from_slice(&self.input[self.offset..self.offset + count]);
        self.offset += count;
        Ok(count)
    }
}

impl Write for MemoryStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.output.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn temp_project(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-rust-project-service-process-{label}-{}-{}",
        std::process::id(),
        TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    cleanup(path.clone());
    path
}

fn cleanup(path: PathBuf) {
    let _ = remove_dir_all(path);
}

fn write_output_stream_state(state_dir: &PathBuf) {
    create_dir_all(state_dir).unwrap();
    write(
        runtime_topology_path(state_dir),
        serde_yaml::to_string(
            &coerce_runtime_topology(&json!({
                "version": 1,
                "generatedAt": "2026-09-05T00:00:00.000Z",
                "rigs": [
                    { "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
                ],
                "nodes": [
                    { "id": "node-live", "rigId": "rig-1", "logicalId": "codex-1", "toolConfigKey": "codex", "createdAt": "2026-09-05T00:00:00.000Z" }
                ],
                "edges": [],
                "bindings": [
                    { "id": "binding-live", "nodeId": "node-live", "tmuxSession": "aimux-repo", "tmuxWindowId": "@1", "tmuxWindowIndex": 1, "tmuxWindowName": "codex", "updatedAt": "2026-09-05T00:00:00.000Z" }
                ],
                "sessions": [
                    { "id": "codex-1", "nodeId": "node-live", "status": "running", "command": "codex", "createdAt": "2026-09-05T00:00:00.000Z", "updatedAt": "2026-09-05T00:00:00.000Z" }
                ],
                "services": [],
                "worktrees": [],
                "worktreeGraveyard": [],
                "teamRoles": [],
                "remoteClients": [],
                "lifecycleOperations": [],
                "exchangeRefs": []
            }))
            .unwrap(),
        )
        .unwrap(),
    )
    .unwrap();
    save_metadata_state(
        state_dir,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::new(),
        },
    )
    .unwrap();
}
