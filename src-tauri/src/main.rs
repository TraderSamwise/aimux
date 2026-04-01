use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
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
struct ProjectInfo {
  id: String,
  name: String,
  path: String,
  last_seen: Option<String>,
  service_alive: bool,
  statusline: Option<Value>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatResponse {
  projects: Vec<ProjectInfo>,
}

fn preview_bytes(bytes: &[u8], limit: usize) -> String {
  let take = bytes.len().min(limit);
  String::from_utf8_lossy(&bytes[..take]).trim().to_string()
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

// ── Commands: unified heartbeat ───────────────────────────────────

static LAST_STATUSLINES: LazyLock<Mutex<HashMap<String, Value>>> =
  LazyLock::new(|| Mutex::new(HashMap::new()));

#[tauri::command]
fn heartbeat() -> Result<HeartbeatResponse, String> {
  let cwd = repo_root();
  let response: HeartbeatResponse = match run_aimux_json(&cwd, &["daemon", "projects", "--json"], "daemon projects") {
    Ok(response) => response,
    Err(_) => {
      let _: Value = run_aimux_json(&cwd, &["daemon", "ensure", "--json"], "daemon ensure")?;
      run_aimux_json(&cwd, &["daemon", "projects", "--json"], "daemon projects")?
    }
  };

  let projects = response
    .projects
    .into_iter()
    .map(|project| {
      let project_dir = aimux_global_dir().join("projects").join(&project.id);
      let statusline = read_statusline_cached(&project.id, &project_dir).or(project.statusline.clone());
      ProjectInfo {
        statusline,
        ..project
      }
    })
    .collect();

  Ok(HeartbeatResponse { projects })
}

fn read_statusline_cached(project_id: &str, project_dir: &Path) -> Option<Value> {
  let fresh = read_statusline_file(project_dir);
  let mut cache = LAST_STATUSLINES.lock().unwrap_or_else(|e| e.into_inner());

  match fresh {
    Some(data) => {
      let fresh_count = data
        .get("sessions")
        .and_then(Value::as_array)
        .map(|a| a.len())
        .unwrap_or(0);

      if let Some(cached) = cache.get(project_id) {
        let cached_count = cached
          .get("sessions")
          .and_then(Value::as_array)
          .map(|a| a.len())
          .unwrap_or(0);

        if fresh_count == 0 && cached_count > 0 {
          return Some(cached.clone());
        }
      }

      cache.insert(project_id.to_string(), data.clone());
      Some(data)
    }
    None => cache.get(project_id).cloned(),
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
fn ensure_daemon_project(project_path: String) -> Result<Value, String> {
  let cwd = Path::new(&project_path);
  let _: Value = run_aimux_json(&repo_root(), &["daemon", "ensure", "--json"], "daemon ensure")?;
  run_aimux_json(
    cwd,
    &["daemon", "project-ensure", "--project", &project_path, "--json"],
    "daemon project ensure",
  )
}

// ── Commands: agent lifecycle ──────────────────────────────────────

// Fire-and-forget: spawn CLI process and return immediately.
// Result shows up in next heartbeat via statusline.
fn fire_and_forget(project_path: &str, args: &[&str]) -> Result<Value, String> {
  let mut cmd_args: Vec<String> = vec![aimux_entrypoint().to_string_lossy().to_string()];
  cmd_args.extend(args.iter().map(|s| s.to_string()));

  std::process::Command::new(resolve_node())
    .args(&cmd_args)
    .current_dir(project_path)
    .env("PATH", shell_path())
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::null())
    .spawn()
    .map_err(|e| format!("failed to run command: {e}"))?;

  Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
fn agent_spawn(project_path: String, tool: String, worktree: Option<String>) -> Result<Value, String> {
  let mut args = vec!["spawn", "--tool", &tool, "--project", &project_path, "--json", "--no-open"];
  let wt_ref;
  if let Some(ref wt) = worktree {
    wt_ref = wt.as_str();
    args.push("--worktree");
    args.push(wt_ref);
  }
  fire_and_forget(&project_path, &args)
}

#[tauri::command]
fn agent_stop(project_path: String, session_id: String) -> Result<Value, String> {
  // Run on a background thread so UI doesn't freeze, but let the process complete
  let pp = project_path.clone();
  let sid = session_id.clone();
  std::thread::spawn(move || {
    let _ = std::process::Command::new(resolve_node())
      .arg(aimux_entrypoint())
      .args(["stop", &sid, "--project", &pp, "--json"])
      .current_dir(&pp)
      .env("PATH", shell_path())
      .output();
  });
  Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
fn agent_kill(project_path: String, session_id: String) -> Result<Value, String> {
  let pp = project_path.clone();
  let sid = session_id.clone();
  std::thread::spawn(move || {
    let _ = std::process::Command::new(resolve_node())
      .arg(aimux_entrypoint())
      .args(["kill", &sid, "--project", &pp, "--json"])
      .current_dir(&pp)
      .env("PATH", shell_path())
      .output();
  });
  Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
fn agent_fork(project_path: String, session_id: String, tool: Option<String>, worktree: Option<String>) -> Result<Value, String> {
  let mut args = vec!["fork", &session_id, "--project", &project_path, "--json", "--no-open"];
  let tool_ref;
  if let Some(ref t) = tool {
    tool_ref = t.as_str();
    args.push("--tool");
    args.push(tool_ref);
  }
  let wt_ref;
  if let Some(ref wt) = worktree {
    wt_ref = wt.as_str();
    args.push("--worktree");
    args.push(wt_ref);
  }
  fire_and_forget(&project_path, &args)
}

#[tauri::command]
fn worktree_create(project_path: String, name: String) -> Result<Value, String> {
  // Worktree create is fast (git operation) — keep synchronous so we can report errors
  run_aimux_json(
    Path::new(&project_path),
    &["worktree", "create", &name, "--project", &project_path, "--json"],
    "worktree create",
  )
}

#[tauri::command]
fn worktree_list(project_path: String) -> Result<Value, String> {
  run_aimux_json(
    Path::new(&project_path),
    &["worktree", "list", "--project", &project_path, "--json"],
    "worktree list",
  )
}

#[tauri::command]
fn graveyard_list(project_path: String) -> Result<Value, String> {
  run_aimux_json(
    Path::new(&project_path),
    &["graveyard", "list", "--project", &project_path, "--json"],
    "graveyard list",
  )
}

#[tauri::command]
fn graveyard_resurrect(project_path: String, session_id: String) -> Result<Value, String> {
  run_aimux_json(
    Path::new(&project_path),
    &["graveyard", "resurrect", &session_id, "--project", &project_path, "--json"],
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
      heartbeat,
      ensure_daemon_project,
      agent_spawn,
      agent_stop,
      agent_kill,
      agent_fork,
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
