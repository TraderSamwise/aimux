use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectsResponse {
  projects: Vec<Value>,
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
  // GUI apps on macOS don't inherit the shell PATH. Try common locations.
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
  // Fallback — hope it's in PATH
  PathBuf::from("node")
}

fn shell_path() -> String {
  // Build a reasonable PATH for child processes
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

fn run_aimux_json(args: &[&str], cwd: &Path) -> Result<Value, String> {
  let output = Command::new(resolve_node())
    .arg(aimux_entrypoint())
    .args(args)
    .current_dir(cwd)
    .env("PATH", shell_path())
    .output()
    .map_err(|error| format!("failed to launch aimux: {error}"))?;

  if !output.status.success() {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    return Err(if stderr.is_empty() {
      format!("aimux exited with {}", output.status)
    } else {
      stderr
    });
  }

  serde_json::from_slice::<Value>(&output.stdout).map_err(|error| format!("invalid aimux JSON: {error}"))
}

#[tauri::command]
fn list_projects() -> Result<ProjectsResponse, String> {
  let value = run_aimux_json(&["projects", "list", "--json"], &repo_root())?;
  let projects = value
    .get("projects")
    .and_then(Value::as_array)
    .cloned()
    .ok_or_else(|| "aimux did not return a projects array".to_string())?;
  Ok(ProjectsResponse { projects })
}

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
  let session = state
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

fn main() {
  tauri::Builder::default()
    .manage(TerminalRegistry::default())
    .invoke_handler(tauri::generate_handler![
      list_projects,
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
