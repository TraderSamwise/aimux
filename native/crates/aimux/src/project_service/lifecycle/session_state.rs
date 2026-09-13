use serde_json::Value;
use std::path::{Path, PathBuf};

use crate::daemon_state::mutate_metadata_state;

use super::ids::now_iso;
use super::object_value;

pub(super) fn relocate_claude_transcript(
    source_cwd: &str,
    target_cwd: &str,
    backend_session_id: &str,
) -> bool {
    relocate_claude_transcript_in_projects_dir(
        source_cwd,
        target_cwd,
        backend_session_id,
        claude_projects_dir(),
    )
}

fn relocate_claude_transcript_in_projects_dir(
    source_cwd: &str,
    target_cwd: &str,
    backend_session_id: &str,
    projects_dir: impl AsRef<Path>,
) -> bool {
    let from =
        claude_transcript_path_in_projects_dir(source_cwd, backend_session_id, &projects_dir);
    let to = claude_transcript_path_in_projects_dir(target_cwd, backend_session_id, &projects_dir);
    if from == to {
        return true;
    }
    if !from.exists() {
        return false;
    }
    if let Some(parent) = to.parent()
        && std::fs::create_dir_all(parent).is_err()
    {
        return false;
    }
    std::fs::copy(from, to).is_ok()
}

fn claude_transcript_path_in_projects_dir(
    cwd: &str,
    backend_session_id: &str,
    projects_dir: impl AsRef<Path>,
) -> PathBuf {
    projects_dir
        .as_ref()
        .join(encode_claude_project_path(cwd))
        .join(format!("{backend_session_id}.jsonl"))
}

fn claude_projects_dir() -> PathBuf {
    let base = std::env::var_os("CLAUDE_CONFIG_DIR")
        .and_then(|value| {
            let path = PathBuf::from(value);
            (!path.as_os_str().is_empty()).then_some(path)
        })
        .or_else(|| {
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|home| home.join(".claude"))
        })
        .unwrap_or_else(|| PathBuf::from(".claude"));
    base.join("projects")
}

fn encode_claude_project_path(cwd: &str) -> String {
    cwd.chars()
        .map(|char| {
            if char == '/' || char == '.' {
                '-'
            } else {
                char
            }
        })
        .collect()
}

pub(super) fn clear_session_transcript_path(project_state_dir: &Path, session_id: &str) {
    let _ = mutate_metadata_state(project_state_dir, |state| {
        let Some(Value::Object(session)) = state.sessions.get_mut(session_id) else {
            return false;
        };
        let Some(Value::Object(context)) = session.get_mut("context") else {
            return false;
        };
        if context.remove("transcriptPath").is_none() {
            return false;
        }
        session.insert("updatedAt".into(), Value::String(now_iso()));
        true
    });
}

pub(super) fn set_session_control_flags(
    project_state_dir: &Path,
    session_id: &str,
    overseer: bool,
    scribe: bool,
) {
    let role = if overseer {
        Some("overseer")
    } else if scribe {
        Some("scribe")
    } else {
        None
    };
    set_session_control_role(project_state_dir, session_id, role);
}

pub(super) fn set_session_control_role(
    project_state_dir: &Path,
    session_id: &str,
    role: Option<&str>,
) {
    let Some(role) = role.map(str::trim).filter(|role| !role.is_empty()) else {
        return;
    };
    if role == "coder" {
        return;
    }
    let overseer = role == "overseer";
    let scribe = role == "scribe";
    if !overseer && !scribe {
        // Generic supervisor roles still need durable project-control metadata.
    }
    let now = now_iso();
    let _ = mutate_metadata_state(project_state_dir, |state| {
        for (id, session) in &mut state.sessions {
            if id == session_id {
                continue;
            }
            if let Value::Object(map) = session {
                if overseer && map.remove("overseer").is_some() {
                    map.insert("updatedAt".into(), Value::String(now.clone()));
                }
                if scribe && map.remove("scribe").is_some() {
                    map.insert("updatedAt".into(), Value::String(now.clone()));
                }
                if session_has_supervisor_role(map, role) {
                    clear_supervisor_role(map, role);
                    map.insert("updatedAt".into(), Value::String(now.clone()));
                }
            }
        }
        let mut current = state
            .sessions
            .remove(session_id)
            .map(object_value)
            .unwrap_or_default();
        current.insert("projectControl".into(), Value::Bool(true));
        current.insert("role".into(), Value::String(role.to_owned()));
        let team = current
            .entry("team")
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        if !team.is_object() {
            *team = Value::Object(serde_json::Map::new());
        }
        if let Value::Object(team) = team {
            team.insert("teamId".into(), Value::String(role.to_owned()));
            team.insert("parentSessionId".into(), Value::String(String::new()));
            team.insert("role".into(), Value::String(role.to_owned()));
        }
        if overseer {
            current.insert("overseer".into(), Value::Bool(true));
        }
        if scribe {
            current.insert("scribe".into(), Value::Bool(true));
        }
        current.insert("updatedAt".into(), Value::String(now));
        state
            .sessions
            .insert(session_id.to_owned(), Value::Object(current));
        true
    });
}

fn session_has_supervisor_role(map: &serde_json::Map<String, Value>, role: &str) -> bool {
    map.get("projectControl").and_then(Value::as_bool) == Some(true)
        && (map.get("role").and_then(Value::as_str).map(str::trim) == Some(role)
            || map
                .get("team")
                .and_then(|team| team.get("role"))
                .and_then(Value::as_str)
                .map(str::trim)
                == Some(role))
}

fn clear_supervisor_role(map: &mut serde_json::Map<String, Value>, role: &str) {
    if map.get("role").and_then(Value::as_str).map(str::trim) == Some(role) {
        map.remove("role");
    }
    if let Some(Value::Object(team)) = map.get_mut("team") {
        if team.get("role").and_then(Value::as_str).map(str::trim) == Some(role) {
            team.remove("role");
        }
        if team.get("teamId").and_then(Value::as_str).map(str::trim) == Some(role) {
            team.remove("teamId");
        }
        if team.is_empty() {
            map.remove("team");
        }
    }
    map.insert("projectControl".into(), Value::Bool(false));
}
