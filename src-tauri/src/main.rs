use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use rfd::FileDialog;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::ffi::CStr;
use std::fs;
use std::io::{Read, Write};
use std::process::Command;
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
  #[serde(default)]
  service_info: Option<Value>,
}

// What the frontend actually receives — one flat blob per project
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSnapshot {
  id: String,
  name: String,
  path: String,
  daemon_alive: bool,
  service_alive: bool,
  service_endpoint_alive: bool,
  service_info: Option<Value>,
  sessions: Vec<Value>,
  statusline: Option<Value>,
  worktrees: Vec<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatResponse {
  daemon_alive: bool,
  projects: Vec<ProjectSnapshot>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedImage {
  path: String,
  name: String,
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
  project_path: String,
  tty_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TmuxWindowMetadata {
  session_id: String,
}

fn tmux_output(args: &[&str], context: &str) -> Result<String, String> {
  let output = Command::new("tmux")
    .args(args)
    .env("PATH", shell_path())
    .output()
    .map_err(|error| format!("{context}: failed to spawn tmux: {error}"))?;
  if !output.status.success() {
    return Err(format!(
      "{context}: tmux {} failed: {}",
      args.join(" "),
      preview_bytes(&output.stderr, 400)
    ));
  }
  Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn pty_tty_path(master: &dyn MasterPty) -> Option<String> {
  #[cfg(unix)]
  {
    let fd = master.as_raw_fd()?;
    let ptr = unsafe { libc::ttyname(fd) };
    if ptr.is_null() {
      return None;
    }
    return Some(unsafe { CStr::from_ptr(ptr) }.to_string_lossy().to_string());
  }
  #[allow(unreachable_code)]
  None
}

fn tty_path_for_pid(pid: u32) -> Option<String> {
  let output = Command::new("ps")
    .args(["-o", "tty=", "-p", &pid.to_string()])
    .env("PATH", shell_path())
    .output()
    .ok()?;
  if !output.status.success() {
    return None;
  }
  let tty = String::from_utf8_lossy(&output.stdout).trim().to_string();
  if tty.is_empty() || tty == "?" || tty == "??" {
    return None;
  }
  if tty.starts_with('/') {
    return Some(tty);
  }
  Some(format!("/dev/{tty}"))
}

fn find_project_sessions(project_path: &str) -> Result<Vec<String>, String> {
  let output = tmux_output(&["list-sessions", "-F", "#{session_name}"], "tmux list sessions")?;
  let mut matches = Vec::new();
  for session_name in output.lines().filter(|line| !line.trim().is_empty()) {
    let root = tmux_output(
      &["show-options", "-v", "-t", session_name, "@aimux-project-root"],
      "tmux show project root",
    )
    .unwrap_or_default();
    if root == project_path {
      matches.push(session_name.to_string());
    }
  }
  Ok(matches)
}

fn find_window_for_session(project_path: &str, aimux_session_id: &str) -> Result<String, String> {
  for session_name in find_project_sessions(project_path)? {
    let output = tmux_output(
      &["list-windows", "-t", &session_name, "-F", "#{window_id}"],
      "tmux list windows",
    )?;
    for window_id in output.lines().filter(|line| !line.trim().is_empty()) {
      let raw = match tmux_output(
        &["show-window-options", "-v", "-t", window_id, "@aimux-meta"],
        "tmux show window metadata",
      ) {
        Ok(value) => value,
        Err(_) => continue,
      };
      let Ok(metadata) = serde_json::from_str::<TmuxWindowMetadata>(&raw) else {
        continue;
      };
      if metadata.session_id == aimux_session_id {
        return Ok(window_id.to_string());
      }
    }
  }
  Err(format!(
    "no tmux window found for session {} in {}",
    aimux_session_id, project_path
  ))
}

fn find_dashboard_window(project_path: &str) -> Result<String, String> {
  for session_name in find_project_sessions(project_path)? {
    let output = tmux_output(
      &["list-windows", "-t", &session_name, "-F", "#{window_id}\t#{window_name}"],
      "tmux list windows",
    )?;
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
      let mut parts = line.split('\t');
      let Some(window_id) = parts.next() else {
        continue;
      };
      let Some(window_name) = parts.next() else {
        continue;
      };
      if window_name == "dashboard" || window_name.starts_with("dashboard-") {
        return Ok(window_id.to_string());
      }
    }
  }
  Err(format!("no dashboard tmux window found in {}", project_path))
}

fn switch_tmux_client_to_window(client_tty: &str, window_id: &str) -> Result<(), String> {
  let _ = tmux_output(
    &["switch-client", "-c", client_tty, "-t", window_id],
    "tmux switch client",
  )?;
  Ok(())
}

fn terminal_client_tty(session_id: u32, session: &TerminalSession) -> Result<String, String> {
  if let Some(tty_path) = session.tty_path.clone() {
    return Ok(tty_path);
  }

  let child_pid = session
    .child
    .lock()
    .map_err(|_| "terminal child lock is poisoned".to_string())?
    .process_id()
    .ok_or_else(|| format!("terminal session {session_id} has no child pid"))?;

  tty_path_for_pid(child_pid)
    .ok_or_else(|| format!("terminal session {session_id} has no PTY tty path"))
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
        .map(|state| (state, true))
        .unwrap_or_else(|| (DesktopStateResponse::default(), false));

      ProjectSnapshot {
        id: project.id,
        name: project.name,
        path: project.path,
        daemon_alive: true,
        service_alive: project.service_alive,
        service_endpoint_alive: desktop_state.1,
        service_info: desktop_state.0.service_info,
        sessions: desktop_state.0.sessions,
        statusline: desktop_state.0.statusline,
        worktrees: desktop_state.0.worktrees,
      }
    })
    .collect();

  Some(HeartbeatResponse {
    daemon_alive: true,
    projects,
  })
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
async fn ensure_daemon_project(project_path: String) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let endpoint = project_service_endpoint(&project_path)?;
    Ok(serde_json::json!({
      "ok": true,
      "serviceEndpoint": {
        "host": endpoint.host,
        "port": endpoint.port,
      }
    }))
  })
  .await
  .map_err(|error| format!("ensure_daemon_project task failed: {error}"))?
}

#[tauri::command]
async fn restart_daemon() -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let node = resolve_node();
    let entrypoint = aimux_entrypoint();
    let output = Command::new(&node)
      .arg(&entrypoint)
      .args(["daemon", "restart"])
      .current_dir(repo_root())
      .env("PATH", shell_path())
      .output()
      .map_err(|e| format!("restart_daemon: failed to spawn command: {e}"))?;

    if !output.status.success() {
      return Err(format!(
        "restart_daemon: command failed\nstdout={:?}\nstderr={:?}",
        preview_bytes(&output.stdout, 400),
        preview_bytes(&output.stderr, 400)
      ));
    }

    Ok(serde_json::json!({ "ok": true }))
  })
  .await
  .map_err(|error| format!("restart_daemon task failed: {error}"))?
}

#[tauri::command]
async fn restart_project_service(project_path: String) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let node = resolve_node();
    let entrypoint = aimux_entrypoint();
    let output = Command::new(&node)
      .arg(&entrypoint)
      .args(["host", "restart", "--serve"])
      .current_dir(&project_path)
      .env("PATH", shell_path())
      .output()
      .map_err(|e| format!("restart_project_service: failed to spawn command: {e}"))?;

    if !output.status.success() {
      return Err(format!(
        "restart_project_service: command failed\nstdout={:?}\nstderr={:?}",
        preview_bytes(&output.stdout, 400),
        preview_bytes(&output.stderr, 400)
      ));
    }

    Ok(serde_json::json!({ "ok": true }))
  })
  .await
  .map_err(|error| format!("restart_project_service task failed: {error}"))?
}

#[tauri::command]
async fn restart_control_plane(project_path: String) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let node = resolve_node();
    let entrypoint = aimux_entrypoint();

    let daemon_restart = Command::new(&node)
      .arg(&entrypoint)
      .args(["daemon", "restart"])
      .current_dir(repo_root())
      .env("PATH", shell_path())
      .output()
      .map_err(|e| format!("restart_control_plane: failed to restart daemon: {e}"))?;
    if !daemon_restart.status.success() {
      return Err(format!(
        "restart_control_plane: daemon restart failed\nstdout={:?}\nstderr={:?}",
        preview_bytes(&daemon_restart.stdout, 400),
        preview_bytes(&daemon_restart.stderr, 400)
      ));
    }

    std::thread::sleep(Duration::from_millis(500));

    let service_restart = Command::new(&node)
      .arg(&entrypoint)
      .args(["host", "restart", "--serve"])
      .current_dir(&project_path)
      .env("PATH", shell_path())
      .output()
      .map_err(|e| format!("restart_control_plane: failed to restart project service: {e}"))?;
    if !service_restart.status.success() {
      return Err(format!(
        "restart_control_plane: project service restart failed\nstdout={:?}\nstderr={:?}",
        preview_bytes(&service_restart.stdout, 400),
        preview_bytes(&service_restart.stderr, 400)
      ));
    }

    Ok(serde_json::json!({ "ok": true }))
  })
  .await
  .map_err(|error| format!("restart_control_plane task failed: {error}"))?
}

#[tauri::command]
fn pick_images() -> Result<Vec<PickedImage>, String> {
  let files = FileDialog::new()
    .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp", "bmp"])
    .pick_files()
    .unwrap_or_default();

  Ok(files
    .into_iter()
    .map(|path| PickedImage {
      name: path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("image")
        .to_string(),
      path: path.to_string_lossy().to_string(),
    })
    .collect())
}

// ── Commands: agent lifecycle ──────────────────────────────────────

#[tauri::command]
async fn agent_spawn(project_path: String, tool: String, worktree: Option<String>) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let body = serde_json::json!({
      "tool": tool,
      "worktreePath": worktree,
      "open": false,
    });
    project_service_json(&project_path, "POST", "/agents/spawn", Some(&body), "agent spawn")
  })
  .await
  .map_err(|error| format!("agent_spawn task failed: {error}"))?
}

#[tauri::command]
async fn agent_stop(project_path: String, session_id: String) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let body = serde_json::json!({ "sessionId": session_id });
    project_service_json(&project_path, "POST", "/agents/stop", Some(&body), "agent stop")
  })
  .await
  .map_err(|error| format!("agent_stop task failed: {error}"))?
}

#[tauri::command]
async fn agent_kill(project_path: String, session_id: String) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let body = serde_json::json!({ "sessionId": session_id });
    project_service_json(&project_path, "POST", "/agents/kill", Some(&body), "agent kill")
  })
  .await
  .map_err(|error| format!("agent_kill task failed: {error}"))?
}

#[tauri::command]
async fn agent_fork(project_path: String, session_id: String, tool: Option<String>, worktree: Option<String>) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let body = serde_json::json!({
      "sourceSessionId": session_id,
      "tool": tool.unwrap_or_else(|| "claude".to_string()),
      "worktreePath": worktree,
      "open": false,
    });
    project_service_json(&project_path, "POST", "/agents/fork", Some(&body), "agent fork")
  })
  .await
  .map_err(|error| format!("agent_fork task failed: {error}"))?
}

#[tauri::command]
async fn agent_rename(project_path: String, session_id: String, label: Option<String>) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let body = serde_json::json!({
      "sessionId": session_id,
      "label": label,
    });
    project_service_json(&project_path, "POST", "/agents/rename", Some(&body), "agent rename")
  })
  .await
  .map_err(|error| format!("agent_rename task failed: {error}"))?
}

#[tauri::command]
async fn agent_migrate(project_path: String, session_id: String, worktree: String) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let body = serde_json::json!({
      "sessionId": session_id,
      "worktreePath": worktree,
    });
    project_service_json(&project_path, "POST", "/agents/migrate", Some(&body), "agent migrate")
  })
  .await
  .map_err(|error| format!("agent_migrate task failed: {error}"))?
}

#[tauri::command]
async fn agent_read(project_path: String, session_id: String, start_line: Option<i32>) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let start_line = start_line.unwrap_or(-120);
    project_service_json(
      &project_path,
      "GET",
      &format!("/agents/output?sessionId={session_id}&startLine={start_line}"),
      None,
      "agent read",
    )
  })
  .await
  .map_err(|error| format!("agent_read task failed: {error}"))?
}

#[tauri::command]
async fn agent_history(project_path: String, session_id: String, last_n: Option<i32>) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let last_n = last_n.unwrap_or(20);
    project_service_json(
      &project_path,
      "GET",
      &format!("/agents/history?sessionId={session_id}&lastN={last_n}"),
      None,
      "agent history",
    )
  })
  .await
  .map_err(|error| format!("agent_history task failed: {error}"))?
}

#[tauri::command]
async fn agent_send(
  project_path: String,
  session_id: String,
  data: String,
  parts: Option<Value>,
  submit: Option<bool>,
) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let body = serde_json::json!({
      "sessionId": session_id,
      "data": data,
      "parts": parts,
      "submit": submit.unwrap_or(true),
    });
    project_service_json(&project_path, "POST", "/agents/input", Some(&body), "agent send")
  })
  .await
  .map_err(|error| format!("agent_send task failed: {error}"))?
}

#[tauri::command]
async fn attachment_ingest_path(project_path: String, path: String) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let body = serde_json::json!({
      "path": path,
    });
    project_service_json(&project_path, "POST", "/attachments", Some(&body), "attachment ingest")
  })
  .await
  .map_err(|error| format!("attachment_ingest_path task failed: {error}"))?
}

#[tauri::command]
async fn attachment_ingest_base64(
  project_path: String,
  filename: String,
  mime_type: String,
  content_base64: String,
) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let body = serde_json::json!({
      "filename": filename,
      "mimeType": mime_type,
      "contentBase64": content_base64,
    });
    project_service_json(&project_path, "POST", "/attachments", Some(&body), "attachment ingest")
  })
  .await
  .map_err(|error| format!("attachment_ingest_base64 task failed: {error}"))?
}

#[tauri::command]
async fn worktree_create(project_path: String, name: String) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let body = serde_json::json!({ "name": name });
    project_service_json(&project_path, "POST", "/worktrees/create", Some(&body), "worktree create")
  })
  .await
  .map_err(|error| format!("worktree_create task failed: {error}"))?
}

#[tauri::command]
async fn worktree_remove(project_path: String, path: String) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let body = serde_json::json!({ "path": path });
    project_service_json(&project_path, "POST", "/worktrees/remove", Some(&body), "worktree remove")
  })
  .await
  .map_err(|error| format!("worktree_remove task failed: {error}"))?
}

#[tauri::command]
async fn worktree_list(project_path: String) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let response: Value = project_service_json(&project_path, "GET", "/worktrees", None, "worktree list")?;
    Ok(response
      .get("worktrees")
      .cloned()
      .unwrap_or_else(|| Value::Array(Vec::new())))
  })
  .await
  .map_err(|error| format!("worktree_list task failed: {error}"))?
}

#[tauri::command]
async fn graveyard_list(project_path: String) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let response: Value = project_service_json(&project_path, "GET", "/graveyard", None, "graveyard list")?;
    Ok(response
      .get("entries")
      .cloned()
      .unwrap_or_else(|| Value::Array(Vec::new())))
  })
  .await
  .map_err(|error| format!("graveyard_list task failed: {error}"))?
}

#[tauri::command]
async fn graveyard_resurrect(project_path: String, session_id: String) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let body = serde_json::json!({ "sessionId": session_id });
    project_service_json(
      &project_path,
      "POST",
      "/graveyard/resurrect",
      Some(&body),
      "graveyard resurrect",
    )
  })
  .await
  .map_err(|error| format!("graveyard_resurrect task failed: {error}"))?
}

#[tauri::command]
async fn workflow_list(project_path: String, participant: Option<String>) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let mut path = String::from("/workflow");
    if let Some(participant) = participant.filter(|value| !value.trim().is_empty()) {
      path.push_str(&format!("?participant={participant}"));
    }
    project_service_json(&project_path, "GET", &path, None, "workflow list")
  })
  .await
  .map_err(|error| format!("workflow_list task failed: {error}"))?
}

#[tauri::command]
async fn threads_list(project_path: String, session_id: Option<String>) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let mut path = String::from("/threads");
    if let Some(session_id) = session_id.filter(|value| !value.trim().is_empty()) {
      path.push_str(&format!("?session={session_id}"));
    }
    project_service_json(&project_path, "GET", &path, None, "threads list")
  })
  .await
  .map_err(|error| format!("threads_list task failed: {error}"))?
}

#[tauri::command]
async fn thread_get(project_path: String, thread_id: String) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    project_service_json(
      &project_path,
      "GET",
      &format!("/threads/{thread_id}"),
      None,
      "thread get",
    )
  })
  .await
  .map_err(|error| format!("thread_get task failed: {error}"))?
}

#[tauri::command]
async fn thread_send(
  project_path: String,
  thread_id: Option<String>,
  from: Option<String>,
  to: Option<Vec<String>>,
  assignee: Option<String>,
  tool: Option<String>,
  worktree_path: Option<String>,
  kind: Option<String>,
  body: String,
  title: Option<String>,
) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let payload = serde_json::json!({
      "threadId": thread_id,
      "from": from.unwrap_or_else(|| "user".to_string()),
      "to": to,
      "assignee": assignee,
      "tool": tool,
      "worktreePath": worktree_path,
      "kind": kind.unwrap_or_else(|| "request".to_string()),
      "body": body,
      "title": title,
    });
    project_service_json(&project_path, "POST", "/threads/send", Some(&payload), "thread send")
  })
  .await
  .map_err(|error| format!("thread_send task failed: {error}"))?
}

#[tauri::command]
async fn thread_status(
  project_path: String,
  thread_id: String,
  status: String,
  owner: Option<String>,
  waiting_on: Option<Vec<String>>,
) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let payload = serde_json::json!({
      "threadId": thread_id,
      "status": status,
      "owner": owner,
      "waitingOn": waiting_on,
    });
    project_service_json(&project_path, "POST", "/threads/status", Some(&payload), "thread status")
  })
  .await
  .map_err(|error| format!("thread_status task failed: {error}"))?
}

#[tauri::command]
async fn handoff_send(
  project_path: String,
  body: String,
  to: Option<Vec<String>>,
  assignee: Option<String>,
  tool: Option<String>,
  worktree_path: Option<String>,
  from: Option<String>,
  title: Option<String>,
) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let payload = serde_json::json!({
      "from": from.unwrap_or_else(|| "user".to_string()),
      "to": to,
      "assignee": assignee,
      "tool": tool,
      "body": body,
      "title": title,
      "worktreePath": worktree_path,
    });
    project_service_json(&project_path, "POST", "/handoff", Some(&payload), "handoff send")
  })
  .await
  .map_err(|error| format!("handoff_send task failed: {error}"))?
}

#[tauri::command]
async fn handoff_accept(project_path: String, thread_id: String, from: Option<String>, body: Option<String>) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let payload = serde_json::json!({
      "threadId": thread_id,
      "from": from.unwrap_or_else(|| "user".to_string()),
      "body": body,
    });
    project_service_json(&project_path, "POST", "/handoff/accept", Some(&payload), "handoff accept")
  })
  .await
  .map_err(|error| format!("handoff_accept task failed: {error}"))?
}

#[tauri::command]
async fn handoff_complete(project_path: String, thread_id: String, from: Option<String>, body: Option<String>) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let payload = serde_json::json!({
      "threadId": thread_id,
      "from": from.unwrap_or_else(|| "user".to_string()),
      "body": body,
    });
    project_service_json(&project_path, "POST", "/handoff/complete", Some(&payload), "handoff complete")
  })
  .await
  .map_err(|error| format!("handoff_complete task failed: {error}"))?
}

#[tauri::command]
async fn task_assign(
  project_path: String,
  description: String,
  to: Option<String>,
  assignee: Option<String>,
  tool: Option<String>,
  prompt: Option<String>,
  kind: Option<String>,
  diff: Option<String>,
  worktree_path: Option<String>,
  from: Option<String>,
) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let payload = serde_json::json!({
      "from": from.unwrap_or_else(|| "user".to_string()),
      "to": to,
      "assignee": assignee,
      "tool": tool,
      "description": description,
      "prompt": prompt,
      "type": kind.unwrap_or_else(|| "task".to_string()),
      "diff": diff,
      "worktreePath": worktree_path,
    });
    project_service_json(&project_path, "POST", "/tasks/assign", Some(&payload), "task assign")
  })
  .await
  .map_err(|error| format!("task_assign task failed: {error}"))?
}

#[tauri::command]
async fn task_accept(project_path: String, task_id: String, from: Option<String>, body: Option<String>) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let payload = serde_json::json!({
      "taskId": task_id,
      "from": from.unwrap_or_else(|| "user".to_string()),
      "body": body,
    });
    project_service_json(&project_path, "POST", "/tasks/accept", Some(&payload), "task accept")
  })
  .await
  .map_err(|error| format!("task_accept task failed: {error}"))?
}

#[tauri::command]
async fn task_block(project_path: String, task_id: String, from: Option<String>, body: Option<String>) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let payload = serde_json::json!({
      "taskId": task_id,
      "from": from.unwrap_or_else(|| "user".to_string()),
      "body": body,
    });
    project_service_json(&project_path, "POST", "/tasks/block", Some(&payload), "task block")
  })
  .await
  .map_err(|error| format!("task_block task failed: {error}"))?
}

#[tauri::command]
async fn task_complete(project_path: String, task_id: String, from: Option<String>, body: Option<String>) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let payload = serde_json::json!({
      "taskId": task_id,
      "from": from.unwrap_or_else(|| "user".to_string()),
      "body": body,
    });
    project_service_json(&project_path, "POST", "/tasks/complete", Some(&payload), "task complete")
  })
  .await
  .map_err(|error| format!("task_complete task failed: {error}"))?
}

#[tauri::command]
async fn task_reopen(project_path: String, task_id: String, from: Option<String>, body: Option<String>) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let payload = serde_json::json!({
      "taskId": task_id,
      "from": from.unwrap_or_else(|| "user".to_string()),
      "body": body,
    });
    project_service_json(&project_path, "POST", "/tasks/reopen", Some(&payload), "task reopen")
  })
  .await
  .map_err(|error| format!("task_reopen task failed: {error}"))?
}

#[tauri::command]
async fn review_approve(project_path: String, task_id: String, from: Option<String>, body: Option<String>) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let payload = serde_json::json!({
      "taskId": task_id,
      "from": from.unwrap_or_else(|| "user".to_string()),
      "body": body,
    });
    project_service_json(&project_path, "POST", "/reviews/approve", Some(&payload), "review approve")
  })
  .await
  .map_err(|error| format!("review_approve task failed: {error}"))?
}

#[tauri::command]
async fn review_request_changes(project_path: String, task_id: String, from: Option<String>, body: Option<String>) -> Result<Value, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let payload = serde_json::json!({
      "taskId": task_id,
      "from": from.unwrap_or_else(|| "user".to_string()),
      "body": body,
    });
    project_service_json(
      &project_path,
      "POST",
      "/reviews/request-changes",
      Some(&payload),
      "review request changes",
    )
  })
  .await
  .map_err(|error| format!("review_request_changes task failed: {error}"))?
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
  command.cwd(&project);
  command.env("PATH", shell_path());

  let child = pair
    .slave
    .spawn_command(command)
    .map_err(|error| format!("failed to spawn aimux terminal: {error}"))?;
  let tty_path = pty_tty_path(&*pair.master);

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
    project_path: project.clone(),
    tty_path,
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
fn focus_terminal_agent(
  state: State<TerminalRegistry>,
  session_id: u32,
  project_path: String,
  agent_id: String,
) -> Result<(), String> {
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

  if session.project_path != project_path {
    return Err(format!(
      "terminal session {} is attached to {}, not {}",
      session_id, session.project_path, project_path
    ));
  }

  let client_tty = terminal_client_tty(session_id, &session)?;
  let window_id = find_window_for_session(&project_path, &agent_id)?;
  switch_tmux_client_to_window(&client_tty, &window_id)
}

#[tauri::command]
fn focus_terminal_dashboard(
  state: State<TerminalRegistry>,
  session_id: u32,
  project_path: String,
) -> Result<(), String> {
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

  if session.project_path != project_path {
    return Err(format!(
      "terminal session {} is attached to {}, not {}",
      session_id, session.project_path, project_path
    ));
  }

  let client_tty = terminal_client_tty(session_id, &session)?;
  let window_id = find_dashboard_window(&project_path)?;
  switch_tmux_client_to_window(&client_tty, &window_id)
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
      pick_images,
      restart_daemon,
      restart_project_service,
      restart_control_plane,
      agent_spawn,
      agent_stop,
      agent_kill,
      agent_fork,
      agent_rename,
      agent_migrate,
      agent_read,
      agent_history,
      agent_send,
      attachment_ingest_path,
      attachment_ingest_base64,
      worktree_create,
      worktree_remove,
      worktree_list,
      graveyard_list,
      graveyard_resurrect,
      workflow_list,
      threads_list,
      thread_get,
      thread_send,
      thread_status,
      handoff_send,
      handoff_accept,
      handoff_complete,
      task_assign,
      task_accept,
      task_block,
      task_complete,
      task_reopen,
      review_approve,
      review_request_changes,
      spawn_aimux,
      focus_terminal_agent,
      focus_terminal_dashboard,
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
