use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
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

fn is_pid_alive(pid: u32) -> bool {
  unsafe { libc::kill(pid as i32, 0) == 0 }
}

// ── Data types ────────────────────────────────────────────────────

#[derive(Deserialize)]
struct ProjectsRegistry {
  projects: Vec<ProjectEntry>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProjectEntry {
  id: String,
  name: String,
  repo_root: String,
  last_seen: Option<String>,
}

#[derive(Deserialize)]
struct MetadataEndpoint {
  host: String,
  port: u16,
  pid: u32,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProjectInfo {
  id: String,
  name: String,
  path: String,
  last_seen: Option<String>,
  host_alive: bool,
  host_port: Option<u16>,
  statusline: Option<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatResponse {
  projects: Vec<ProjectInfo>,
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

// ── Commands: unified heartbeat ───────────────────────────────────

#[tauri::command]
fn heartbeat() -> Result<HeartbeatResponse, String> {
  let registry_path = aimux_global_dir().join("projects.json");
  let content = fs::read_to_string(&registry_path)
    .map_err(|e| format!("failed to read projects.json: {e}"))?;
  let registry: ProjectsRegistry =
    serde_json::from_str(&content).map_err(|e| format!("invalid projects.json: {e}"))?;

  let projects = registry
    .projects
    .into_iter()
    .map(|entry| {
      let project_dir = aimux_global_dir().join("projects").join(&entry.id);
      let (host_alive, host_port) = check_host(&project_dir);
      let statusline = read_statusline_file(&project_dir);
      ProjectInfo {
        id: entry.id,
        name: entry.name,
        path: entry.repo_root,
        last_seen: entry.last_seen,
        host_alive,
        host_port,
        statusline,
      }
    })
    .collect();

  Ok(HeartbeatResponse { projects })
}

fn check_host(project_dir: &Path) -> (bool, Option<u16>) {
  let endpoint_path = project_dir.join("metadata-api.json");
  let content = match fs::read_to_string(&endpoint_path) {
    Ok(c) if !c.trim().is_empty() => c,
    _ => return (false, None),
  };
  let endpoint: MetadataEndpoint = match serde_json::from_str(&content) {
    Ok(e) => e,
    Err(_) => return (false, None),
  };
  if is_pid_alive(endpoint.pid) {
    (true, Some(endpoint.port))
  } else {
    (false, None)
  }
}

fn read_statusline_file(project_dir: &Path) -> Option<Value> {
  let path = project_dir.join("statusline.json");
  let content = fs::read_to_string(&path).ok()?;
  let mut data: Value = serde_json::from_str(&content).ok()?;

  // Strip heavy fields the UI doesn't need
  if let Some(meta) = data.get_mut("metadata").and_then(Value::as_object_mut) {
    for (_key, entry) in meta.iter_mut() {
      if let Some(obj) = entry.as_object_mut() {
        obj.remove("logs");
        if let Some(derived) = obj.get_mut("derived").and_then(Value::as_object_mut) {
          derived.remove("events");
        }
      }
    }
  }
  Some(data)
}

// ── Commands: host management ─────────────────────────────────────

#[tauri::command]
fn ensure_host(project_path: String) -> Result<Value, String> {
  // Check if host is already running via `aimux host status --json`
  let output = std::process::Command::new(resolve_node())
    .arg(aimux_entrypoint())
    .args(["host", "status", "--json"])
    .current_dir(&project_path)
    .env("PATH", shell_path())
    .output()
    .map_err(|e| format!("failed to check host status: {e}"))?;

  let status: Value = serde_json::from_slice(&output.stdout)
    .map_err(|e| format!("invalid host status JSON: {e}"))?;

  // If host is running, return its info
  if status.get("host").is_some_and(|h| !h.is_null()) {
    return Ok(status);
  }

  // No host — spawn `aimux serve` in background
  std::process::Command::new(resolve_node())
    .arg(aimux_entrypoint())
    .arg("serve")
    .current_dir(&project_path)
    .env("PATH", shell_path())
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .spawn()
    .map_err(|e| format!("failed to spawn aimux serve: {e}"))?;

  // Give it a moment to start, then re-check
  std::thread::sleep(std::time::Duration::from_millis(1500));

  let output2 = std::process::Command::new(resolve_node())
    .arg(aimux_entrypoint())
    .args(["host", "status", "--json"])
    .current_dir(&project_path)
    .env("PATH", shell_path())
    .output()
    .map_err(|e| format!("failed to re-check host status: {e}"))?;

  serde_json::from_slice(&output2.stdout)
    .map_err(|e| format!("invalid host status JSON after spawn: {e}"))
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
      heartbeat,
      ensure_host,
      spawn_aimux,
      write_terminal,
      resize_terminal,
      close_terminal
    ])
    .setup(|app| {
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
