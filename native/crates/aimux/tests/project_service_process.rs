use aimux::daemon_state::load_metadata_endpoint;
use aimux::project_service::process::{
    desired_project_service_port, handle_project_service_connection,
    publish_project_service_endpoint,
};
use aimux::project_service::router::ProjectServiceRequestContext;
use std::fs::{read_to_string, remove_dir_all};
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

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

struct MemoryStream {
    input: Vec<u8>,
    offset: usize,
    output: Vec<u8>,
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
