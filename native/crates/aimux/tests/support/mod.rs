#![allow(dead_code)]

use aimux::project_service::router::ProjectServiceRequestContext;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Mutex, MutexGuard};

static ENV_LOCK: Mutex<()> = Mutex::new(());
static PORT_SEQUENCE: AtomicU16 = AtomicU16::new(0);

pub struct TestIsolation {
    _guard: MutexGuard<'static, ()>,
    root: PathBuf,
    home: PathBuf,
    aimux_home: PathBuf,
    tmux_socket: PathBuf,
    daemon_port: u16,
    previous_env: Vec<(&'static str, Option<std::ffi::OsString>)>,
}

impl TestIsolation {
    pub fn new(label: &str) -> Self {
        let guard = ENV_LOCK.lock().expect("test env lock");
        let root = PathBuf::from("/tmp").join(format!(
            "amx-test-{label}-{}-{}",
            std::process::id(),
            PORT_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let home = root.join("home");
        let aimux_home = root.join("aimux-home");
        let tmux_socket = root.join("tmux.sock");
        fs::create_dir_all(&home).expect("create isolated home");
        fs::create_dir_all(&aimux_home).expect("create isolated aimux home");

        let daemon_port = 47_000 + (PORT_SEQUENCE.fetch_add(1, Ordering::Relaxed) % 1_000);
        let previous_env = capture_env();
        let isolation = Self {
            _guard: guard,
            root,
            home,
            aimux_home,
            tmux_socket,
            daemon_port,
            previous_env,
        };
        isolation.set_process_env();
        isolation
    }

    pub fn project_context(
        &self,
        project_root: impl AsRef<Path>,
        project_state_dir: impl AsRef<Path>,
    ) -> ProjectServiceRequestContext {
        ProjectServiceRequestContext::with_project_state_dir(
            project_root.as_ref(),
            project_state_dir.as_ref(),
        )
        .with_live_window_ids(default_live_window_ids())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn aimux_home(&self) -> &Path {
        &self.aimux_home
    }

    pub fn daemon_port(&self) -> u16 {
        self.daemon_port
    }

    pub fn apply_to_command<'a>(&self, command: &'a mut Command) -> &'a mut Command {
        command
            .env("HOME", &self.home)
            .env("AIMUX_HOME", &self.aimux_home)
            .env("AIMUX_TMUX_SOCKET_PATH", &self.tmux_socket)
            .env("AIMUX_DAEMON_PORT", self.daemon_port.to_string())
    }

    pub fn project_service_pids(&self) -> Vec<u32> {
        let state_path = self.aimux_home.join("daemon/state.json");
        let Ok(raw) = fs::read_to_string(state_path) else {
            return Vec::new();
        };
        let Ok(state) = serde_json::from_str::<serde_json::Value>(&raw) else {
            return Vec::new();
        };
        state
            .get("projects")
            .and_then(serde_json::Value::as_object)
            .into_iter()
            .flat_map(|projects| projects.values())
            .filter_map(|project| project.get("pid").and_then(serde_json::Value::as_u64))
            .filter_map(|pid| u32::try_from(pid).ok())
            .collect()
    }

    fn set_process_env(&self) {
        // SAFETY: Tests that use this helper hold ENV_LOCK until drop, so env
        // mutation is serialized within the test process.
        unsafe {
            std::env::set_var("HOME", &self.home);
            std::env::set_var("AIMUX_HOME", &self.aimux_home);
            std::env::set_var("AIMUX_TMUX_SOCKET_PATH", &self.tmux_socket);
            std::env::set_var("AIMUX_DAEMON_PORT", self.daemon_port.to_string());
        }
        let daemon_dir = self.aimux_home.join("daemon");
        fs::create_dir_all(&daemon_dir).expect("create isolated daemon dir");
        fs::write(
            self.aimux_home
                .join(aimux::runtime_safety_guard::TEST_ISOLATION_MARKER),
            format!(
                r#"{{"ownerPid":{},"kind":"cargo-test"}}"#,
                std::process::id()
            ),
        )
        .expect("write isolated aimux home marker");
        fs::write(
            daemon_dir.join("daemon.json"),
            format!(
                r#"{{"pid":{},"port":{},"startedAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}}"#,
                std::process::id(),
                self.daemon_port
            ),
        )
        .expect("write isolated daemon info");
    }
}

impl Drop for TestIsolation {
    fn drop(&mut self) {
        for pid in self.project_service_pids() {
            terminate_pid(pid);
        }
        // SAFETY: The same ENV_LOCK held during setup is still held here.
        unsafe {
            for (key, previous) in &self.previous_env {
                match previous {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[cfg(unix)]
fn terminate_pid(pid: u32) {
    let pid = pid.to_string();
    let _ = Command::new("kill").arg("-TERM").arg(&pid).status();
    for _ in 0..30 {
        if !pid_alive(&pid) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let _ = Command::new("kill").arg("-KILL").arg(pid).status();
}

#[cfg(not(unix))]
fn terminate_pid(_pid: u32) {}

#[cfg(unix)]
fn pid_alive(pid: &str) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(pid)
        .status()
        .is_ok_and(|status| status.success())
}

pub fn live_window_ids(ids: &[&str]) -> BTreeSet<String> {
    ids.iter().map(|id| (*id).to_owned()).collect()
}

fn default_live_window_ids() -> BTreeSet<String> {
    live_window_ids(&[
        "@1",
        "@2",
        "@3",
        "@4",
        "@5",
        "@6",
        "@7",
        "@8",
        "@9",
        "@10",
        "@lead",
        "@worker",
        "@reviewer",
        "@one",
        "@two",
        "@other",
    ])
}

fn capture_env() -> Vec<(&'static str, Option<std::ffi::OsString>)> {
    [
        "HOME",
        "AIMUX_HOME",
        "AIMUX_TMUX_SOCKET_PATH",
        "AIMUX_DAEMON_PORT",
    ]
    .into_iter()
    .map(|key| (key, std::env::var_os(key)))
    .collect()
}
