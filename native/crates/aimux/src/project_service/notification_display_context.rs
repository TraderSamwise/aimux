use serde_json::Value;
use std::path::Path;

use super::router::ProjectServiceRequestContext;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NotificationDisplayContext {
    pub worktree_path: Option<String>,
    pub worktree_name: Option<String>,
    pub branch: Option<String>,
}

pub fn project_display_name(project_root: &Path) -> String {
    project_root
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(trimmed_str)
        .unwrap_or("aimux")
        .to_owned()
}

pub fn resolve_session_display_context(
    context: &ProjectServiceRequestContext,
    session_id: &str,
    worktree_path: Option<&str>,
) -> NotificationDisplayContext {
    let mut resolved = metadata_session_display_context(context, session_id);
    if let Some(worktree_path) = worktree_path.and_then(trimmed_str) {
        let worktree = worktree_display_context(context, worktree_path);
        resolved = merge_display_context(resolved, worktree);
    }
    resolved
}

fn metadata_session_display_context(
    context: &ProjectServiceRequestContext,
    session_id: &str,
) -> NotificationDisplayContext {
    let Some(desktop) = context.desktop_state.as_ref() else {
        return NotificationDisplayContext::default();
    };
    let session = ["sessions", "teammates"]
        .into_iter()
        .filter_map(|key| desktop.get(key).and_then(Value::as_array))
        .flat_map(|items| items.iter())
        .find(|item| item.get("id").and_then(Value::as_str) == Some(session_id));
    let Some(session) = session else {
        return NotificationDisplayContext::default();
    };
    let worktree_path = session.get("worktreePath").and_then(Value::as_str);
    let mut display = worktree_path
        .map(|path| worktree_display_context(context, path))
        .unwrap_or_default();
    if let Some(path) = worktree_path.and_then(trimmed_str) {
        display.worktree_path.get_or_insert_with(|| path.to_owned());
    }
    display
}

fn worktree_display_context(
    context: &ProjectServiceRequestContext,
    worktree_path: &str,
) -> NotificationDisplayContext {
    let path = trimmed_str(worktree_path).unwrap_or("");
    let Some(desktop) = context.desktop_state.as_ref() else {
        return NotificationDisplayContext {
            worktree_path: (!path.is_empty()).then(|| path.to_owned()),
            worktree_name: path_basename(path),
            branch: None,
        };
    };
    let worktree = desktop
        .get("worktrees")
        .and_then(Value::as_array)
        .and_then(|worktrees| {
            worktrees.iter().find(|worktree| {
                worktree.get("path").and_then(Value::as_str) == Some(path)
                    || worktree.get("resolvedPath").and_then(Value::as_str) == Some(path)
            })
        });
    if let Some(worktree) = worktree {
        return NotificationDisplayContext {
            worktree_path: worktree
                .get("path")
                .and_then(Value::as_str)
                .and_then(trimmed_str)
                .map(str::to_owned)
                .or_else(|| (!path.is_empty()).then(|| path.to_owned())),
            worktree_name: worktree
                .get("name")
                .and_then(Value::as_str)
                .and_then(trimmed_str)
                .map(str::to_owned)
                .or_else(|| path_basename(path)),
            branch: worktree
                .get("branch")
                .and_then(Value::as_str)
                .and_then(trimmed_str)
                .map(str::to_owned),
        };
    }
    NotificationDisplayContext {
        worktree_path: (!path.is_empty()).then(|| path.to_owned()),
        worktree_name: path_basename(path),
        branch: None,
    }
}

fn merge_display_context(
    base: NotificationDisplayContext,
    override_context: NotificationDisplayContext,
) -> NotificationDisplayContext {
    NotificationDisplayContext {
        worktree_path: override_context.worktree_path.or(base.worktree_path),
        worktree_name: override_context.worktree_name.or(base.worktree_name),
        branch: override_context.branch.or(base.branch),
    }
}

fn path_basename(path: &str) -> Option<String> {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(trimmed_str)
        .map(str::to_owned)
}

fn trimmed_str(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}
