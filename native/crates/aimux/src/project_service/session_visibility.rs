use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::team_contract::{is_overseer_session, is_scribe_session};

pub const LIVE_SESSION_STATUSES: &[&str] = &["starting", "running", "idle"];
pub const DASHBOARD_SESSION_STATUSES: &[&str] = &["starting", "running", "idle", "offline"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionLivenessPolicy {
    LiveOnly,
    Dashboard,
}

impl SessionLivenessPolicy {
    pub fn allows_status(self, status: Option<&str>) -> bool {
        let Some(status) = status else {
            return false;
        };
        match self {
            Self::LiveOnly => LIVE_SESSION_STATUSES.contains(&status),
            Self::Dashboard => DASHBOARD_SESSION_STATUSES.contains(&status),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionRolePolicy {
    IncludeAll,
    Switchable(SwitchableRolePolicy),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwitchableRolePolicy {
    pub include_overseer: bool,
    pub scope_all_worktrees: bool,
    pub scoped_worktree_path: String,
    pub current_window_id: Option<String>,
    pub teammate_parent_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentVisibilityRule {
    pub liveness: SessionLivenessPolicy,
    pub roles: SessionRolePolicy,
}

impl AgentVisibilityRule {
    pub fn expose_switchable(roles: SwitchableRolePolicy) -> Self {
        Self {
            liveness: SessionLivenessPolicy::LiveOnly,
            roles: SessionRolePolicy::Switchable(roles),
        }
    }

    pub fn dashboard() -> Self {
        Self {
            liveness: SessionLivenessPolicy::Dashboard,
            roles: SessionRolePolicy::IncludeAll,
        }
    }

    pub fn allows_session_status(&self, status: Option<&str>) -> bool {
        self.liveness.allows_status(status)
    }

    pub fn allows(&self, input: AgentVisibilityInput<'_>) -> bool {
        if let Some(status) = input.status
            && !self.allows_session_status(Some(status))
        {
            return false;
        }
        match &self.roles {
            SessionRolePolicy::IncludeAll => true,
            SessionRolePolicy::Switchable(policy) => switchable_roles_allow(policy, &input),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct AgentVisibilityInput<'a> {
    pub status: Option<&'a str>,
    pub alive: bool,
    pub metadata: &'a Value,
    pub kind: Option<&'a str>,
    pub worktree_path: Option<&'a str>,
    pub window_name: Option<&'a str>,
    pub window_id: Option<&'a str>,
}

fn switchable_roles_allow(policy: &SwitchableRolePolicy, input: &AgentVisibilityInput<'_>) -> bool {
    if input.window_name.is_some_and(is_dashboard_window_name) {
        return false;
    }
    if !input.alive && input.window_id != policy.current_window_id.as_deref() {
        return false;
    }
    if is_scribe_session(Some(input.metadata)) {
        return false;
    }
    let overseer = is_overseer_session(Some(input.metadata));
    if !policy.include_overseer && overseer {
        return false;
    }
    if policy.include_overseer && overseer {
        if policy.scope_all_worktrees {
            return true;
        }
        return input_worktree_matches_scope(input, &policy.scoped_worktree_path);
    }
    if let Some(parent_session_id) = policy.teammate_parent_session_id.as_deref()
        && !policy.scope_all_worktrees
    {
        return input.kind != Some("service")
            && team_string_field(input.metadata, "parentSessionId") == Some(parent_session_id);
    }
    if team_string_field(input.metadata, "parentSessionId").is_some_and(|id| !id.is_empty()) {
        return false;
    }
    policy.scope_all_worktrees || input_worktree_matches_scope(input, &policy.scoped_worktree_path)
}

fn input_worktree_matches_scope(
    input: &AgentVisibilityInput<'_>,
    scoped_worktree_path: &str,
) -> bool {
    clean_path_string(input.worktree_path.unwrap_or("")) == scoped_worktree_path
}

fn is_dashboard_window_name(name: &str) -> bool {
    name == "dashboard" || name.starts_with("dashboard-")
}

fn team_string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get("team")
        .and_then(Value::as_object)
        .and_then(|team| team.get(key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn clean_path_string(path: &str) -> String {
    path_clean(Path::new(path)).to_string_lossy().into_owned()
}

fn path_clean(path: &Path) -> PathBuf {
    let mut output = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                output.push(component)
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                output.pop();
            }
            std::path::Component::Normal(part) => output.push(part),
        }
    }
    output
}
