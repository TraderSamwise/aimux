use aimux::core_command_contract::CORE_API_ROUTES;
use aimux::daemon::process::handle_daemon_runtime_request;
use aimux::daemon::runtime::{
    ProjectServiceLauncher, ProjectServiceProcessVerifier, RealDaemonRuntime,
};
use aimux::daemon::server::DaemonHttpRequest;
use aimux::daemon_state::{
    save_daemon_state, save_metadata_endpoint, AimuxDaemonInfo, DaemonState, MetadataApiEndpoint,
    ProjectServiceState, ProjectServiceStatus,
};
use aimux::paths::PathResolver;
use aimux::project_api_contract::routes as project_routes;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::fs::{self, remove_dir_all};
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn thread_routes_round_trip_through_daemon_http_to_project_service() {
    let fixture = CoordinationHttpFixture::new("thread-routes");
    let project = fixture.project("repo");
    let project_text = project.to_string_lossy().into_owned();
    let project_query = percent_encode_query_value(&project_text);
    let server = ScriptedHttpServer::spawn(vec![
        json!([
            {
                "thread": {
                    "id": "thread-1",
                    "title": "Decision",
                    "kind": "conversation",
                    "status": "open",
                    "unreadBy": ["codex-1"],
                    "waitingOn": ["claude-1"]
                },
                "latestMessage": {
                    "from": "sam",
                    "kind": "request",
                    "body": "Need a call"
                }
            }
        ]),
        json!({
            "thread": {
                "id": "thread-1",
                "title": "Decision",
                "kind": "conversation",
                "status": "open",
                "participants": ["sam", "claude-1"],
                "waitingOn": ["claude-1"]
            },
            "messages": [
                {
                    "id": "msg-1",
                    "ts": "2026-09-05T00:00:00.000Z",
                    "from": "sam",
                    "kind": "request",
                    "body": "Need a call"
                }
            ]
        }),
        json!({ "thread": { "id": "thread-2", "status": "open" } }),
        json!({ "thread": { "id": "thread-1" }, "message": { "id": "msg-2" } }),
        json!({ "thread": { "id": "thread-1", "status": "done" } }),
        json!({ "ok": true }),
    ]);
    let mut runtime = fixture.runtime_for_project(&project, server.port);

    let listed = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "GET",
            &format!(
                "{}?project={}&session=%20claude-1%20",
                CORE_API_ROUTES.thread_list_text, project_query
            ),
            None,
        ),
    );
    assert_eq!(listed.status, 200);
    assert!(text_body(&listed).contains("thread-1  conversation  open unread=1 waiting=claude-1"));

    let shown = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "GET",
            &format!(
                "{}?project={}&threadId=thread-1",
                CORE_API_ROUTES.thread_show_text, project_query
            ),
            None,
        ),
    );
    assert_eq!(shown.status, 200);
    assert!(text_body(&shown).contains("Decision (conversation)"));
    assert!(text_body(&shown).contains("Need a call"));

    let opened = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.thread_open_text,
            Some(json!({
                "project": project_text,
                "title": "Follow-up",
                "from": "sam",
                "participants": "claude-1,codex-1",
                "kind": "handoff"
            })),
        ),
    );
    assert_eq!(opened.status, 200);
    assert_eq!(text_body(&opened), "thread-2\n");

    let replied = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.thread_send_text,
            Some(json!({
                "project": project_text,
                "threadId": "thread-1",
                "from": "sam",
                "to": "claude-1,codex-1",
                "kind": "reply",
                "body": "ack"
            })),
        ),
    );
    assert_eq!(replied.status, 200);
    assert_eq!(text_body(&replied), "msg-2\n");

    let resolved = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.thread_status_text,
            Some(json!({
                "project": project_text,
                "threadId": "thread-1",
                "status": "done",
                "owner": "sam",
                "waitingOn": "claude-1,codex-1"
            })),
        ),
    );
    assert_eq!(resolved.status, 200);
    assert_eq!(text_body(&resolved), "thread thread-1\nstatus done\n");

    let seen = handle_daemon_runtime_request(
        &mut runtime,
        request(
            "POST",
            CORE_API_ROUTES.thread_mark_seen_text,
            Some(json!({
                "project": project_text,
                "threadId": "thread-1",
                "session": "claude-1"
            })),
        ),
    );
    assert_eq!(seen.status, 200);
    assert_eq!(text_body(&seen), "ok\n");

    let requests = server.join();
    assert_request_path(&requests[0], "GET", "/threads?session=claude-1");
    assert_request_path(&requests[1], "GET", "/threads/thread-1");
    assert_request_path(&requests[2], "POST", project_routes::threads::OPEN);
    assert_eq!(
        request_json_body(&requests[2]),
        json!({
            "title": "Follow-up",
            "from": "sam",
            "participants": ["claude-1", "codex-1"],
            "kind": "handoff"
        })
    );
    assert_request_path(&requests[3], "POST", project_routes::threads::SEND);
    assert_eq!(
        request_json_body(&requests[3]),
        json!({
            "threadId": "thread-1",
            "from": "sam",
            "to": ["claude-1", "codex-1"],
            "kind": "reply",
            "body": "ack"
        })
    );
    assert_request_path(&requests[4], "POST", project_routes::threads::STATUS);
    assert_eq!(
        request_json_body(&requests[4]),
        json!({
            "threadId": "thread-1",
            "status": "done",
            "owner": "sam",
            "waitingOn": ["claude-1", "codex-1"]
        })
    );
    assert_request_path(&requests[5], "POST", project_routes::threads::MARK_SEEN);
    assert_eq!(
        request_json_body(&requests[5]),
        json!({ "threadId": "thread-1", "session": "claude-1" })
    );
    fixture.cleanup();
}

#[derive(Debug)]
struct CoordinationHttpFixture {
    root: PathBuf,
    home: PathBuf,
}

impl CoordinationHttpFixture {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-rust-coordination-http-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = remove_dir_all(&root);
        let home = root.join("home");
        fs::create_dir_all(&home).expect("home");
        Self { root, home }
    }

    fn resolver(&self) -> PathResolver {
        PathResolver::new(
            &self.root,
            &self.home,
            Some(self.home.join(".aimux").to_string_lossy().into_owned()),
        )
    }

    fn project(&self, name: &str) -> PathBuf {
        let project = self.root.join(name);
        fs::create_dir_all(project.join(".git")).expect("project git");
        project
    }

    fn runtime_for_project(&self, project: &Path, endpoint_port: u16) -> RealDaemonRuntime {
        let mut resolver = self.resolver();
        let entry = resolver
            .register_project(project)
            .expect("register project")
            .expect("project entry");
        let pid = std::process::id() as i32;
        save_daemon_state(
            resolver.daemon_state_path(),
            &DaemonState {
                version: 1,
                updated_at: Some(json!("now")),
                projects: Map::from_iter([(
                    entry.id.clone(),
                    serde_json::to_value(ProjectServiceState {
                        project_id: entry.id,
                        project_root: project.to_string_lossy().into_owned(),
                        pid,
                        started_at: "then".into(),
                        updated_at: "now".into(),
                        status: Some(ProjectServiceStatus::Running),
                        restart_count: Some(0),
                        last_restart_at: None,
                        last_exit: None,
                    })
                    .expect("service json"),
                )]),
            },
        )
        .expect("daemon state");
        save_metadata_endpoint(
            resolver.project_state_dir_for(project),
            &MetadataApiEndpoint {
                host: "127.0.0.1".into(),
                port: endpoint_port,
                pid,
                updated_at: "now".into(),
            },
        )
        .expect("endpoint");
        RealDaemonRuntime::with_project_service_launcher_and_process_verifier(
            resolver,
            AimuxDaemonInfo {
                pid,
                port: 46_200,
                started_at: "then".into(),
                updated_at: "now".into(),
            },
            Arc::new(PanicLauncher),
            Arc::new(FakeProcessVerifier::native([pid])),
            0,
        )
    }

    fn cleanup(self) {
        let _ = remove_dir_all(self.root);
    }
}

#[derive(Debug)]
struct PanicLauncher;

impl ProjectServiceLauncher for PanicLauncher {
    fn launch(
        &self,
        _project_id: &str,
        _project_root: &Path,
        _project_state_dir: &Path,
    ) -> Result<i32, String> {
        panic!("coordination HTTP tests must reuse the scripted project-service endpoint")
    }

    fn terminate(&self, _service: &ProjectServiceState, _force: bool) -> Result<(), String> {
        Ok(())
    }
}

struct FakeProcessVerifier {
    native: BTreeSet<i32>,
}

impl FakeProcessVerifier {
    fn native(pids: impl IntoIterator<Item = i32>) -> Self {
        Self {
            native: pids.into_iter().collect(),
        }
    }
}

impl ProjectServiceProcessVerifier for FakeProcessVerifier {
    fn is_live(&self, pid: i32) -> bool {
        self.native.contains(&pid)
    }

    fn is_live_native_project_service(&self, service: &ProjectServiceState) -> bool {
        self.native.contains(&service.pid)
    }

    fn live_project_service_pids(&self, _project_id: &str, _project_root: &str) -> Vec<i32> {
        Vec::new()
    }
}

struct ScriptedHttpServer {
    port: u16,
    handle: std::thread::JoinHandle<Vec<String>>,
}

impl ScriptedHttpServer {
    fn spawn(responses: Vec<Value>) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test listener");
        let port = listener.local_addr().expect("listener addr").port();
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for response in responses {
                let (mut stream, _) = listener.accept().expect("accept");
                let request = read_http_request(&mut stream);
                let body = response.to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n",
                    body.len()
                );
                stream
                    .write_all(response.as_bytes())
                    .expect("write headers");
                stream.write_all(body.as_bytes()).expect("write body");
                requests.push(request);
            }
            requests
        });
        Self { port, handle }
    }

    fn join(self) -> Vec<String> {
        self.handle.join().expect("server thread")
    }
}

fn request(method: &str, path: &str, body: Option<Value>) -> DaemonHttpRequest {
    DaemonHttpRequest {
        method: method.into(),
        path: path.into(),
        headers: Default::default(),
        body_chunks: body
            .map(|value| vec![value.to_string().into_bytes()])
            .unwrap_or_default(),
        stopping: false,
        issued_at: "issued".into(),
    }
}

fn text_body(response: &aimux::daemon::http::PreparedDaemonResponse) -> String {
    String::from_utf8(response.body.clone()).expect("text body")
}

fn read_http_request(stream: &mut TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_millis(20)))
        .expect("set test request timeout");
    let mut buffer = Vec::new();
    let mut chunk = [0_u8; 1024];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => buffer.extend_from_slice(&chunk[..count]),
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                break;
            }
            Err(error) => panic!("read request: {error}"),
        }
        if request_is_complete(&buffer) {
            break;
        }
    }
    String::from_utf8_lossy(&buffer).into_owned()
}

fn request_is_complete(buffer: &[u8]) -> bool {
    let Some(header_end) = find_header_end(buffer) else {
        return false;
    };
    let headers = String::from_utf8_lossy(&buffer[..header_end]);
    let Some(content_length) = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    }) else {
        return true;
    };
    buffer.len() >= header_end + 4 + content_length
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

fn assert_request_path(request: &str, method: &str, path: &str) {
    let mut parts = request.lines().next().unwrap_or_default().split(' ');
    assert_eq!(parts.next(), Some(method));
    assert_eq!(parts.next(), Some(path));
}

fn request_json_body(request: &str) -> Value {
    let body = request
        .split_once("\r\n\r\n")
        .map(|(_, body)| body.trim())
        .unwrap_or_default();
    if body.is_empty() {
        json!({})
    } else {
        serde_json::from_str(body).expect("request JSON body")
    }
}

fn percent_encode_query_value(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}
