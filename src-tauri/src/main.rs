use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};

// ── Helpers ───────────────────────────────────────────────────────

fn aimux_global_dir() -> PathBuf {
  dirs::home_dir()
    .expect("HOME not set")
    .join(".aimux")
}

fn repo_root() -> PathBuf {
  Path::new(env!("CARGO_MANIFEST_DIR"))
    .parent()
    .expect("src-tauri should have a parent directory")
    .to_path_buf()
}

fn aimux_entrypoint() -> PathBuf {
  repo_root().join("bin").join("aimux")
}

fn resolve_node() -> PathBuf {
  let candidates = [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  ];
  for candidate in &candidates {
    if Path::new(candidate).exists() {
      return PathBuf::from(candidate);
    }
  }
  PathBuf::from("node")
}

fn shell_path() -> String {
  let base = std::env::var("PATH").unwrap_or_default();
  let extras = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  let mut parts: Vec<&str> = if base.is_empty() {
    vec![]
  } else {
    base.split(':').collect()
  };
  for extra in &extras {
    if !parts.contains(extra) {
      parts.push(extra);
    }
  }
  parts.join(":")
}

// ── Data types ────────────────────────────────────────────────────

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DaemonInfo {
  pid: u32,
  port: u16,
  started_at: String,
  updated_at: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ServiceEndpoint {
  host: String,
  port: u16,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DaemonProject {
  id: String,
  name: String,
  path: String,
  #[serde(default)]
  last_seen: Option<String>,
  #[serde(default)]
  service_alive: bool,
  #[serde(default)]
  service_endpoint: Option<ServiceEndpoint>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonProjectsResponse {
  projects: Vec<DaemonProject>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DesktopStateResponse {
  #[serde(default)]
  sessions: Vec<Value>,
  #[serde(default)]
  statusline: Option<Value>,
  #[serde(default)]
  worktrees: Vec<Value>,
}

// What the frontend actually receives — one flat blob per project
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSnapshot {
  id: String,
  name: String,
  path: String,
  service_alive: bool,
  sessions: Vec<Value>,
  statusline: Option<Value>,
  worktrees: Vec<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatResponse {
  projects: Vec<ProjectSnapshot>,
}

fn preview_bytes(bytes: &[u8], limit: usize) -> String {
  let take = bytes.len().min(limit);
  String::from_utf8_lossy(&bytes[..take]).trim().to_string()
}

fn daemon_info_path() -> PathBuf {
  aimux_global_dir().join("daemon").join("daemon.json")
}

fn load_daemon_info() -> Option<DaemonInfo> {
  let content = fs::read_to_string(daemon_info_path()).ok()?;
  if content.trim().is_empty() {
    return None;
  }
  serde_json::from_str(&content).ok()
}

fn http_json_request<T: DeserializeOwned>(
  host: &str,
  port: u16,
  method: &str,
  path: &str,
  body: Option<&Value>,
  context: &str,
) -> Result<T, String> {
  let address = format!("{host}:{port}");
  let mut stream = TcpStream::connect(&address)
    .map_err(|e| format!("{context}: failed to connect to {address}: {e}"))?;
  let timeout = Some(Duration::from_secs(5));
  let _ = stream.set_read_timeout(timeout);
  let _ = stream.set_write_timeout(timeout);

  let body_text = body.map(|value| value.to_string()).unwrap_or_default();
  let request = if body.is_some() {
    format!(
      "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
      body_text.len(),
      body_text
    )
  } else {
    format!("{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n")
  };

  stream
    .write_all(request.as_bytes())
    .and_then(|_| stream.flush())
    .map_err(|e| format!("{context}: failed to write request: {e}"))?;
  let _ = stream.shutdown(Shutdown::Write);

  let mut response = Vec::new();
  stream
    .read_to_end(&mut response)
    .map_err(|e| format!("{context}: failed to read response: {e}"))?;

  let Some(header_end) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
    return Err(format!(
      "{context}: invalid HTTP response from {address}: {:?}",
      preview_bytes(&response, 400)
    ));
  };

  let header_text = String::from_utf8_lossy(&response[..header_end]).to_string();
  let body_bytes = &response[header_end + 4..];
  let status_line = header_text.lines().next().unwrap_or_default();
  let status_code = status_line
    .split_whitespace()
    .nth(1)
    .and_then(|value| value.parse::<u16>().ok())
    .unwrap_or(0);

  if !(200..300).contains(&status_code) {
    return Err(format!(
      "{context}: server returned {status_code}\nresponse={:?}",
      preview_bytes(body_bytes, 400)
    ));
  }

  serde_json::from_slice(body_bytes).map_err(|e| {
    format!(
      "{context}: invalid JSON response\nresponse={:?}\nerror={e}",
      preview_bytes(body_bytes, 400)
    )
  })
}

fn ensure_daemon_http() -> Result<DaemonInfo, String> {
  if let Some(info) = load_daemon_info() {
    if http_json_request::<Value>(&"127.0.0.1", info.port, "GET", "/health", None, "daemon health").is_ok() {
      return Ok(info);
    }
  }
  let _: Value = run_aimux_json(&repo_root(), &["daemon", "ensure", "--json"], "daemon ensure")?;
  let info = load_daemon_info().ok_or_else(|| "daemon info file missing after startup".to_string())?;
  let _: Value = http_json_request(&"127.0.0.1", info.port, "GET", "/health", None, "daemon health")?;
  Ok(info)
}

fn daemon_json<T: DeserializeOwned>(
  method: &str,
  path: &str,
  body: Option<&Value>,
  context: &str,
) -> Result<T, String> {
  let info = ensure_daemon_http()?;
  http_json_request("127.0.0.1", info.port, method, path, body, context)
}

fn project_service_endpoint(project_path: &str) -> Result<ServiceEndpoint, String> {
  let ensure_body = serde_json::json!({ "projectRoot": project_path });
  let _: Value = daemon_json("POST", "/projects/ensure", Some(&ensure_body), "daemon project ensure")?;

  let deadline = Instant::now() + Duration::from_secs(5);
  while Instant::now() < deadline {
    let response: DaemonProjectsResponse = daemon_json("GET", "/projects", None, "daemon projects")?;
    if let Some(project) = response.projects.into_iter().find(|project| project.path == project_path) {
      if let Some(endpoint) = project.service_endpoint {
        return Ok(endpoint);
      }
    }
    std::thread::sleep(Duration::from_millis(100));
  }

  Err(format!(
    "project service endpoint for {} did not become available in time",
    project_path
  ))
}

fn project_service_json<T: DeserializeOwned>(
  project_path: &str,
  method: &str,
  path: &str,
  body: Option<&Value>,
  context: &str,
) -> Result<T, String> {
  let endpoint = project_service_endpoint(project_path)?;
  http_json_request(&endpoint.host, endpoint.port, method, path, body, context)
}

fn run_aimux_json<T: DeserializeOwned>(
  cwd: &Path,
  args: &[&str],
  context: &str,
) -> Result<T, String> {
  let node = resolve_node();
  let entrypoint = aimux_entrypoint();
  let output = std::process::Command::new(&node)
    .arg(&entrypoint)
    .args(args)
    .current_dir(cwd)
    .env("PATH", shell_path())
    .output()
    .map_err(|e| {
      format!(
        "{context}: failed to spawn command\nnode={}\nentrypoint={}\ncwd={}\nerror={e}",
        node.display(),
        entrypoint.display(),
        cwd.display()
      )
    })?;

  if !output.status.success() || output.stdout.is_empty() {
    let stdout = preview_bytes(&output.stdout, 400);
    let stderr = preview_bytes(&output.stderr, 400);
    return Err(format!(
      "{context}: command did not produce valid JSON stdout\nnode={}\nentrypoint={}\ncwd={}\nargs={:?}\nexit={}\nstdout={:?}\nstderr={:?}",
      node.display(),
      entrypoint.display(),
      cwd.display(),
      args,
      output.status,
      stdout,
      stderr
    ));
  }

  serde_json::from_slice(&output.stdout).map_err(|e| {
    let stdout = preview_bytes(&output.stdout, 400);
    let stderr = preview_bytes(&output.stderr, 400);
    format!(
      "{context}: invalid JSON response\nnode={}\nentrypoint={}\ncwd={}\nargs={:?}\nexit={}\nstdout={:?}\nstderr={:?}\nerror={e}",
      node.display(),
      entrypoint.display(),
      cwd.display(),
      args,
      output.status,
      stdout,
      stderr
    )
  })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputPayload {
  session_id: u32,
  data: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TerminalExitPayload {
  session_id: u32,
  code: Option<i32>,
}

// ── Terminal registry ─────────────────────────────────────────────

#[derive(Default)]
struct TerminalRegistryInner {
  next_id: AtomicU32,
  sessions: Mutex<HashMap<u32, Arc<TerminalSession>>>,
}

#[derive(Clone, Default)]
struct TerminalRegistry(Arc<TerminalRegistryInner>);

struct TerminalSession {
  master: Mutex<Box<dyn MasterPty + Send>>,
  writer: Mutex<Box<dyn Write + Send>>,
  child: Mutex<Box<dyn Child + Send>>,
}

// ── Heartbeat (background thread → event) ─────────────────────────

fn build_heartbeat() -> Option<HeartbeatResponse> {
  let response: DaemonProjectsResponse = daemon_json("GET", "/projects", None, "daemon projects").ok()?;

  let projects = response
    .projects
    .into_iter()
    .map(|project| {
      let desktop_state = project
        .service_endpoint
        .as_ref()
        .and_then(|endpoint| {
          http_json_request::<DesktopStateResponse>(
            &endpoint.host,
            endpoint.port,
            "GET",
            "/desktop-state",
            None,
            "desktop state",
          )
          .ok()
        })
        .unwrap_or_default();

      ProjectSnapshot {
        id: project.id,
        name: project.name,
        path: project.path,
        service_alive: project.service_alive,
        sessions: desktop_state.sessions,
        statusline: desktop_state.statusline,
        worktrees: desktop_state.worktrees,
      }
    })
    .collect();

  Some(HeartbeatResponse { projects })
}

fn start_heartbeat_thread(app: tauri::AppHandle) {
  std::thread::spawn(move || {
    loop {
      if let Some(response) = build_heartbeat() {
        let _ = app.emit("heartbeat", &response);
      }
      std::thread::sleep(std::time::Duration::from_millis(1500));
    }
  });
}

// ── Commands: host management ─────────────────────────────────────

#[tauri::command]
fn ensure_daemon_project(project_path: String) -> Result<Value, String> {
  let endpoint = project_service_endpoint(&project_path)?;
  Ok(serde_json::json!({
    "ok": true,
    "serviceEndpoint": {
      "host": endpoint.host,
      "port": endpoint.port,
    }
  }))
}

// ── Commands: agent lifecycle ──────────────────────────────────────

#[tauri::command]
fn agent_spawn(project_path: String, tool: String, worktree: Option<String>) -> Result<Value, String> {
  let body = serde_json::json!({
    "tool": tool,
    "worktreePath": worktree,
    "open": false,
  });
  project_service_json(&project_path, "POST", "/agents/spawn", Some(&body), "agent spawn")
}

#[tauri::command]
fn agent_stop(project_path: String, session_id: String) -> Result<Value, String> {
  let body = serde_json::json!({ "sessionId": session_id });
  project_service_json(&project_path, "POST", "/agents/stop", Some(&body), "agent stop")
}

#[tauri::command]
fn agent_kill(project_path: String, session_id: String) -> Result<Value, String> {
  let body = serde_json::json!({ "sessionId": session_id });
  project_service_json(&project_path, "POST", "/agents/kill", Some(&body), "agent kill")
}

#[tauri::command]
fn agent_fork(project_path: String, session_id: String, tool: Option<String>, worktree: Option<String>) -> Result<Value, String> {
  let body = serde_json::json!({
    "sourceSessionId": session_id,
    "tool": tool.unwrap_or_else(|| "claude".to_string()),
    "worktreePath": worktree,
    "open": false,
  });
  project_service_json(&project_path, "POST", "/agents/fork", Some(&body), "agent fork")
}

#[tauri::command]
fn agent_rename(project_path: String, session_id: String, label: Option<String>) -> Result<Value, String> {
  let body = serde_json::json!({
    "sessionId": session_id,
    "label": label,
  });
  project_service_json(&project_path, "POST", "/agents/rename", Some(&body), "agent rename")
}

#[tauri::command]
fn agent_migrate(project_path: String, session_id: String, worktree: String) -> Result<Value, String> {
  let body = serde_json::json!({
    "sessionId": session_id,
    "worktreePath": worktree,
  });
  project_service_json(&project_path, "POST", "/agents/migrate", Some(&body), "agent migrate")
}

#[tauri::command]
fn worktree_create(project_path: String, name: String) -> Result<Value, String> {
  let body = serde_json::json!({ "name": name });
  project_service_json(&project_path, "POST", "/worktrees/create", Some(&body), "worktree create")
}

#[tauri::command]
fn worktree_list(project_path: String) -> Result<Value, String> {
  let response: Value = project_service_json(&project_path, "GET", "/worktrees", None, "worktree list")?;
  Ok(response
    .get("worktrees")
    .cloned()
    .unwrap_or_else(|| Value::Array(Vec::new())))
}

#[tauri::command]
fn graveyard_list(project_path: String) -> Result<Value, String> {
  let response: Value = project_service_json(&project_path, "GET", "/graveyard", None, "graveyard list")?;
  Ok(response
    .get("entries")
    .cloned()
    .unwrap_or_else(|| Value::Array(Vec::new())))
}

#[tauri::command]
fn graveyard_resurrect(project_path: String, session_id: String) -> Result<Value, String> {
  let body = serde_json::json!({ "sessionId": session_id });
  project_service_json(
    &project_path,
    "POST",
    "/graveyard/resurrect",
    Some(&body),
    "graveyard resurrect",
  )
}

// ── Commands: terminal PTY ────────────────────────────────────────

#[tauri::command]
fn spawn_aimux(
  app: tauri::AppHandle,
  state: State<TerminalRegistry>,
  project: String,
  args: Vec<String>,
  cols: u16,
  rows: u16,
) -> Result<u32, String> {
  let pty_system = native_pty_system();
  let pair = pty_system
    .openpty(PtySize {
      rows,
      cols,
      pixel_width: 0,
      pixel_height: 0,
    })
    .map_err(|error| format!("failed to create PTY: {error}"))?;

  let mut command = CommandBuilder::new(resolve_node());
  command.arg(aimux_entrypoint().to_string_lossy().to_string());
  for arg in args {
    command.arg(arg);
  }
  command.cwd(project);
  command.env("PATH", shell_path());

  let child = pair
    .slave
    .spawn_command(command)
    .map_err(|error| format!("failed to spawn aimux terminal: {error}"))?;

  let writer = pair
    .master
    .take_writer()
    .map_err(|error| format!("failed to acquire PTY writer: {error}"))?;
  let mut reader = pair
    .master
    .try_clone_reader()
    .map_err(|error| format!("failed to acquire PTY reader: {error}"))?;

  let session_id = state.0.next_id.fetch_add(1, Ordering::Relaxed) + 1;
  let session = Arc::new(TerminalSession {
    master: Mutex::new(pair.master),
    writer: Mutex::new(writer),
    child: Mutex::new(child),
  });
  state
    .0
    .sessions
    .lock()
    .map_err(|_| "terminal session registry is poisoned".to_string())?
    .insert(session_id, session.clone());

  let registry = state.inner().clone();
  std::thread::spawn(move || {
    let mut buffer = [0_u8; 8192];
    loop {
      match reader.read(&mut buffer) {
        Ok(0) => break,
        Ok(count) => {
          let data = String::from_utf8_lossy(&buffer[..count]).to_string();
          let _ = app.emit(
            "terminal-output",
            TerminalOutputPayload {
              session_id,
              data,
            },
          );
        }
        Err(_) => break,
      }
    }

    let code = session
      .child
      .lock()
      .ok()
      .and_then(|mut child| child.wait().ok())
      .map(|status| status.exit_code() as i32);

    if let Ok(mut sessions) = registry.0.sessions.lock() {
      sessions.remove(&session_id);
    }

    let _ = app.emit("terminal-exit", TerminalExitPayload { session_id, code });
  });

  Ok(session_id)
}

#[tauri::command]
fn write_terminal(state: State<TerminalRegistry>, session_id: u32, data: String) -> Result<(), String> {
  let sessions = state
    .0
    .sessions
    .lock()
    .map_err(|_| "terminal session registry is poisoned".to_string())?;
  let session = sessions
    .get(&session_id)
    .cloned()
    .ok_or_else(|| format!("terminal session {session_id} not found"))?;
  drop(sessions);

  let mut writer = session
    .writer
    .lock()
    .map_err(|_| "terminal writer lock is poisoned".to_string())?;
  writer
    .write_all(data.as_bytes())
    .and_then(|_| writer.flush())
    .map_err(|error| format!("failed to write terminal input: {error}"))
}

#[tauri::command]
fn resize_terminal(state: State<TerminalRegistry>, session_id: u32, cols: u16, rows: u16) -> Result<(), String> {
  let sessions = state
    .0
    .sessions
    .lock()
    .map_err(|_| "terminal session registry is poisoned".to_string())?;
  let session = sessions
    .get(&session_id)
    .cloned()
    .ok_or_else(|| format!("terminal session {session_id} not found"))?;
  drop(sessions);

  let master = session
    .master
    .lock()
    .map_err(|_| "terminal master lock is poisoned".to_string())?;
  master
    .resize(PtySize {
      rows,
      cols,
      pixel_width: 0,
      pixel_height: 0,
    })
    .map_err(|error| format!("failed to resize PTY: {error}"))
}

#[tauri::command]
fn close_terminal(state: State<TerminalRegistry>, session_id: u32) -> Result<(), String> {
  let session: Arc<TerminalSession> = state
    .0
    .sessions
    .lock()
    .map_err(|_| "terminal session registry is poisoned".to_string())?
    .remove(&session_id)
    .ok_or_else(|| format!("terminal session {session_id} not found"))?;

  let result = session
    .child
    .lock()
    .map_err(|_| "terminal child lock is poisoned".to_string())?
    .kill()
    .map_err(|error| format!("failed to kill terminal session: {error}"));
  result
}

// ── App entry ─────────────────────────────────────────────────────

fn main() {
  tauri::Builder::default()
    .manage(TerminalRegistry::default())
    .invoke_handler(tauri::generate_handler![
      ensure_daemon_project,
      agent_spawn,
      agent_stop,
      agent_kill,
      agent_fork,
      agent_rename,
      agent_migrate,
      worktree_create,
      worktree_list,
      graveyard_list,
      graveyard_resurrect,
      spawn_aimux,
      write_terminal,
      resize_terminal,
      close_terminal
    ])
    .setup(|app| {
      // Start heartbeat background thread
      start_heartbeat_thread(app.handle().clone());

      if let Some(window) = app.get_webview_window("main") {
        let registry = app.state::<TerminalRegistry>().inner().clone();
        window.on_window_event(move |event| {
          if let tauri::WindowEvent::Destroyed = event {
            if let Ok(sessions) = registry.0.sessions.lock() {
              for session in sessions.values() {
                if let Ok(mut child) = session.child.lock() {
                  let _ = child.kill();
                }
              }
            }
          }
        });
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running aimux desktop");
}
