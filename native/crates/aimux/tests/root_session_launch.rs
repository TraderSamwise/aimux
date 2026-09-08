use aimux::root_session_launch::{
    RootSessionLaunchMode, launchable_offline_session_ids, parse_root_resume_args,
    resume_saved_sessions_from_state_dir,
};
use aimux::{
    daemon_state::{MetadataApiEndpoint, save_metadata_endpoint},
    runtime_topology::{coerce_runtime_topology, runtime_topology_path, write_runtime_topology},
};
use serde_json::json;
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU16, Ordering},
    },
    thread::{self, JoinHandle},
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT_PORT_OFFSET: AtomicU16 = AtomicU16::new(0);

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_millis();
        let path = std::env::temp_dir().join(format!(
            "aimux-root-session-launch-{label}-{}-{millis}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create temp dir");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct ResumeServer {
    port: u16,
    requests: Arc<Mutex<Vec<String>>>,
    handle: Option<JoinHandle<()>>,
}

impl ResumeServer {
    fn start(expected_requests: usize) -> Self {
        let listener = bind_private_listener();
        let port = listener.local_addr().expect("listener address").port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let thread_requests = Arc::clone(&requests);
        let handle = thread::spawn(move || {
            for _ in 0..expected_requests {
                let (mut stream, _) = listener.accept().expect("accept resume request");
                let request = read_http_request(&mut stream);
                thread_requests.lock().expect("requests lock").push(request);
                let body = r#"{"ok":true}"#;
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream
                    .write_all(response.as_bytes())
                    .expect("write response");
            }
        });
        Self {
            port,
            requests,
            handle: Some(handle),
        }
    }

    fn finish(mut self) -> Vec<String> {
        if let Some(handle) = self.handle.take() {
            handle.join().expect("resume server thread");
        }
        self.requests.lock().expect("requests lock").clone()
    }
}

fn bind_private_listener() -> TcpListener {
    for _ in 0..1000 {
        let offset = NEXT_PORT_OFFSET.fetch_add(1, Ordering::Relaxed) % 900;
        let port = 46050 + offset;
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            return listener;
        }
    }
    panic!("no available private high port");
}

fn read_http_request(stream: &mut impl Read) -> String {
    let mut bytes = Vec::new();
    let mut scratch = [0_u8; 1024];
    loop {
        let read = stream.read(&mut scratch).expect("read request");
        assert!(read > 0, "connection closed before headers");
        bytes.extend_from_slice(&scratch[..read]);
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let headers_end = bytes
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("headers end")
        + 4;
    let headers = String::from_utf8_lossy(&bytes[..headers_end]);
    let content_length = headers
        .lines()
        .find_map(|line| line.strip_prefix("content-length: "))
        .or_else(|| {
            headers
                .lines()
                .find_map(|line| line.strip_prefix("Content-Length: "))
        })
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(0);
    while bytes.len() < headers_end + content_length {
        let read = stream.read(&mut scratch).expect("read request body");
        assert!(read > 0, "connection closed before body");
        bytes.extend_from_slice(&scratch[..read]);
    }
    String::from_utf8(bytes).expect("utf8 request")
}

fn seed_resume_topology(project_root: &Path, state_dir: &Path, port: u16) {
    fs::create_dir_all(state_dir).expect("create state dir");
    let project_root = project_root.to_string_lossy();
    let topology = coerce_runtime_topology(&json!({
        "version": 1,
        "generatedAt": "2026-09-09T00:00:00.000Z",
        "rigs": [{
            "id": "rig-1",
            "name": "aimux",
            "projectRoot": project_root,
            "createdAt": "2026-09-09T00:00:00.000Z",
            "updatedAt": "2026-09-09T00:00:00.000Z"
        }],
        "nodes": [
            { "id": "node-codex-old", "rigId": "rig-1", "logicalId": "codex-old", "kind": "agent", "label": "codex-old", "cwd": project_root, "status": "offline", "createdAt": "2026-09-09T00:00:00.000Z", "updatedAt": "2026-09-09T00:00:00.000Z" },
            { "id": "node-claude-old", "rigId": "rig-1", "logicalId": "claude-old", "kind": "agent", "label": "claude-old", "cwd": project_root, "status": "offline", "createdAt": "2026-09-09T00:00:00.000Z", "updatedAt": "2026-09-09T00:00:00.000Z" },
            { "id": "node-codex-live", "rigId": "rig-1", "logicalId": "codex-live", "kind": "agent", "label": "codex-live", "cwd": project_root, "status": "running", "createdAt": "2026-09-09T00:00:00.000Z", "updatedAt": "2026-09-09T00:00:00.000Z" }
        ],
        "sessions": [
            { "id": "codex-old", "nodeId": "node-codex-old", "tool": "codex", "toolConfigKey": "codex", "command": "codex", "args": [], "status": "offline", "createdAt": "2026-09-09T00:00:00.000Z", "updatedAt": "2026-09-09T00:00:00.000Z" },
            { "id": "claude-old", "nodeId": "node-claude-old", "tool": "claude", "toolConfigKey": "claude", "command": "claude", "args": [], "status": "offline", "createdAt": "2026-09-09T00:00:00.000Z", "updatedAt": "2026-09-09T00:00:00.000Z" },
            { "id": "codex-live", "nodeId": "node-codex-live", "tool": "codex", "toolConfigKey": "codex", "command": "codex", "args": [], "status": "running", "createdAt": "2026-09-09T00:00:00.000Z", "updatedAt": "2026-09-09T00:00:00.000Z" }
        ],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "bindings": [],
        "edges": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    }))
    .expect("coerce topology");
    write_runtime_topology(runtime_topology_path(state_dir), &topology).expect("write topology");
    save_metadata_endpoint(
        state_dir,
        &MetadataApiEndpoint {
            host: "127.0.0.1".into(),
            port,
            pid: std::process::id() as i32,
            updated_at: "2026-09-09T00:00:00.000Z".into(),
        },
    )
    .expect("save metadata endpoint");
}

fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

#[test]
fn root_resume_parser_accepts_optional_tool_filter_only() {
    assert_eq!(
        parse_root_resume_args(&args(&["--resume"]))
            .unwrap()
            .tool_filter,
        None
    );
    assert_eq!(
        parse_root_resume_args(&args(&["--resume", "codex"]))
            .unwrap()
            .tool_filter,
        Some("codex".into())
    );
    let restore = parse_root_resume_args(&args(&["--restore", "claude"])).unwrap();
    assert_eq!(restore.mode, RootSessionLaunchMode::Restore);
    assert_eq!(restore.tool_filter, Some("claude".into()));
    assert!(parse_root_resume_args(&args(&["--resume", "--json"])).is_none());
    let request = parse_root_resume_args(&args(&["--resume", "codex", "extra"])).unwrap();
    assert_eq!(request.tool_filter, Some("codex".into()));
    assert_eq!(request.ignored_args, ["extra"]);
}

#[test]
fn launchable_offline_sessions_filter_by_tool_fields() {
    let topology = json!({
        "version": 1,
        "generatedAt": "2026-09-06T00:00:00.000Z",
        "rigs": [{ "id": "rig-1", "name": "aimux", "projectRoot": "/repo", "createdAt": "2026-09-06T00:00:00.000Z", "updatedAt": "2026-09-06T00:00:00.000Z" }],
        "nodes": [
            { "id": "node-1", "rigId": "rig-1", "kind": "agent", "label": "codex", "cwd": "/repo", "status": "offline", "createdAt": "2026-09-06T00:00:00.000Z", "updatedAt": "2026-09-06T00:00:00.000Z" },
            { "id": "node-2", "rigId": "rig-1", "kind": "agent", "label": "claude", "cwd": "/repo", "status": "offline", "createdAt": "2026-09-06T00:00:00.000Z", "updatedAt": "2026-09-06T00:00:00.000Z" },
            { "id": "node-3", "rigId": "rig-1", "kind": "agent", "label": "live", "cwd": "/repo", "status": "running", "createdAt": "2026-09-06T00:00:00.000Z", "updatedAt": "2026-09-06T00:00:00.000Z" }
        ],
        "sessions": [
            { "id": "codex-old", "nodeId": "node-1", "tool": "codex", "toolConfigKey": "codex", "command": "codex", "args": [], "status": "offline", "createdAt": "2026-09-06T00:00:00.000Z", "updatedAt": "2026-09-06T00:00:00.000Z" },
            { "id": "claude-old", "nodeId": "node-2", "tool": "claude", "toolConfigKey": "claude", "command": "claude", "args": [], "status": "offline", "createdAt": "2026-09-06T00:00:00.000Z", "updatedAt": "2026-09-06T00:00:00.000Z" },
            { "id": "codex-live", "nodeId": "node-3", "tool": "codex", "toolConfigKey": "codex", "command": "codex", "args": [], "status": "running", "createdAt": "2026-09-06T00:00:00.000Z", "updatedAt": "2026-09-06T00:00:00.000Z" }
        ],
        "services": [],
        "worktrees": [],
        "worktreeGraveyard": [],
        "bindings": [],
        "edges": [],
        "teamRoles": [],
        "remoteClients": [],
        "lifecycleOperations": [],
        "exchangeRefs": []
    });

    assert_eq!(
        launchable_offline_session_ids(&topology, None),
        ["codex-old", "claude-old"]
    );
    assert_eq!(
        launchable_offline_session_ids(&topology, Some("codex")),
        ["codex-old"]
    );
    assert!(launchable_offline_session_ids(&topology, Some("aider")).is_empty());
}

#[test]
fn resume_and_restore_post_node_compatible_requests_to_project_service() {
    let project = TempDir::new("resume-project");
    let state = TempDir::new("resume-state");
    let server = ResumeServer::start(3);
    seed_resume_topology(project.path(), state.path(), server.port);

    let resume = resume_saved_sessions_from_state_dir(
        project.path(),
        state.path(),
        RootSessionLaunchMode::Resume,
        Some("codex"),
    )
    .expect("resume saved codex sessions");
    assert_eq!(resume.resumed, ["codex-old"]);
    assert!(resume.failed.is_empty());

    let restore = resume_saved_sessions_from_state_dir(
        project.path(),
        state.path(),
        RootSessionLaunchMode::Restore,
        None,
    )
    .expect("restore saved sessions");
    assert_eq!(restore.resumed, ["codex-old", "claude-old"]);
    assert!(restore.failed.is_empty());

    let requests = server.finish();
    assert_eq!(requests.len(), 3);
    assert!(requests[0].starts_with("POST /agents/resume HTTP/1.1"));
    assert!(requests[0].contains(r#""sessionId":"codex-old""#));
    assert!(requests[0].contains(r#""fresh":false"#));
    assert!(requests[1].contains(r#""sessionId":"codex-old""#));
    assert!(requests[1].contains(r#""fresh":true"#));
    assert!(requests[2].contains(r#""sessionId":"claude-old""#));
    assert!(requests[2].contains(r#""fresh":true"#));
}
