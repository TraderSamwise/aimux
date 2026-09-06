use crate::atomic_write::write_json_atomic;
use crate::dashboard_controller::DashboardScreen;
use crate::paths::PathResolver;
use anyhow::{Context, Result, anyhow};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone)]
pub struct DashboardUiStatePersistence {
    path: PathBuf,
    client_session: String,
    last_screen: Option<DashboardScreen>,
}

impl DashboardUiStatePersistence {
    pub fn for_project(project_root: &Path) -> Result<Self> {
        let mut resolver = PathResolver::from_env();
        let project_state_dir = resolver.project_state_dir_for(project_root);
        let session = current_tmux_session().ok_or_else(|| anyhow!("tmux session unavailable"))?;
        Self::new(project_state_dir, &session)
    }

    pub fn new(project_state_dir: impl AsRef<Path>, client_session: &str) -> Result<Self> {
        let client_key = dashboard_client_key(client_session);
        if client_key.is_empty() {
            return Err(anyhow!("dashboard client session is empty"));
        }
        let path = project_state_dir
            .as_ref()
            .join(format!("dashboard-ui-client-{client_key}.json"));
        let last_screen = read_dashboard_screen(&path);
        Ok(Self {
            path,
            client_session: client_session.to_owned(),
            last_screen,
        })
    }

    pub fn load_screen(&self) -> Option<DashboardScreen> {
        self.last_screen
    }

    pub fn persist_screen(&mut self, screen: DashboardScreen) -> Result<bool> {
        if self.last_screen == Some(screen) {
            return Ok(false);
        }
        let mut snapshot = fs::read_to_string(&self.path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| Value::Object(Default::default()));
        snapshot["screen"] = Value::String(screen.as_str().to_owned());
        write_json_atomic(&self.path, &snapshot)
            .with_context(|| format!("write dashboard ui state {}", self.path.display()))?;
        self.last_screen = Some(screen);
        Ok(true)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn client_session(&self) -> &str {
        &self.client_session
    }
}

pub fn dashboard_client_key(session: &str) -> String {
    session
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn read_dashboard_screen(path: &Path) -> Option<DashboardScreen> {
    let raw = fs::read_to_string(path).ok()?;
    let value = serde_json::from_str::<Value>(&raw).ok()?;
    let screen = value.get("screen").and_then(Value::as_str)?;
    DashboardScreen::parse(screen)
}

fn current_tmux_session() -> Option<String> {
    let output = Command::new("tmux")
        .args(["display-message", "-p", "#{session_name}"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let session = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!session.is_empty()).then_some(session)
}
