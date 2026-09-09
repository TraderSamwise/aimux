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
    if !overseer && !scribe {
        return;
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
            }
        }
        let mut current = state
            .sessions
            .remove(session_id)
            .map(object_value)
            .unwrap_or_default();
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
