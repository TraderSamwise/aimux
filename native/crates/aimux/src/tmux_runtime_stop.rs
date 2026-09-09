use crate::tmux::{TmuxRuntimeManager, is_tmux_client_session_for_host};

pub trait TmuxRuntimeStopManager {
    fn is_available(&mut self) -> bool;
    fn project_session_name(&mut self, project_root: &str) -> String;
    fn list_session_names(&mut self) -> Vec<String>;
    fn has_session(&mut self, session_name: &str) -> bool;
    fn kill_session(&mut self, session_name: &str) -> Result<(), String>;
}

impl TmuxRuntimeStopManager for TmuxRuntimeManager {
    fn is_available(&mut self) -> bool {
        TmuxRuntimeManager::is_available(self)
    }

    fn project_session_name(&mut self, project_root: &str) -> String {
        self.get_project_session(project_root).session_name
    }

    fn list_session_names(&mut self) -> Vec<String> {
        TmuxRuntimeManager::list_session_names(self)
    }

    fn has_session(&mut self, session_name: &str) -> bool {
        TmuxRuntimeManager::has_session(self, session_name)
    }

    fn kill_session(&mut self, session_name: &str) -> Result<(), String> {
        TmuxRuntimeManager::kill_session(self, session_name)
    }
}

pub fn list_managed_project_session_names<T: TmuxRuntimeStopManager>(
    tmux: &mut T,
    project_root: &str,
) -> Vec<String> {
    let host_session = tmux.project_session_name(project_root);
    let mut sessions = tmux
        .list_session_names()
        .into_iter()
        .filter(|session_name| {
            session_name == &host_session
                || is_tmux_client_session_for_host(session_name, &host_session)
        })
        .collect::<Vec<_>>();
    sessions.sort_by_key(|session_name| u8::from(session_name == &host_session));
    sessions
}

pub fn stop_project_tmux_runtime<T: TmuxRuntimeStopManager>(
    tmux: &mut T,
    project_root: &str,
    persist_snapshots_before_stop: impl FnOnce(&mut T, &str) -> Result<(), String>,
) -> Result<Vec<String>, String> {
    if !tmux.is_available() {
        return Ok(Vec::new());
    }
    persist_snapshots_before_stop(tmux, project_root)?;
    let mut killed = Vec::new();
    for session_name in list_managed_project_session_names(tmux, project_root) {
        if !tmux.has_session(&session_name) {
            continue;
        }
        tmux.kill_session(&session_name)?;
        killed.push(session_name);
    }
    Ok(killed)
}
