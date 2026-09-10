use serde_json::Value;
use std::fs;
use std::path::Path;

use crate::daemon_state::load_metadata_state;
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};

use super::router::ProjectServiceRequestContext;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NotificationDisplayContext {
    pub label: Option<String>,
    pub command: Option<String>,
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
    let mut resolved = stored_metadata_session_display_context(context, session_id);
    resolved = merge_display_context(
        resolved,
        topology_session_display_context(context, session_id),
    );
    resolved = merge_display_context(
        resolved,
        desktop_session_display_context(context, session_id),
    );
    if let Some(worktree_path) = worktree_path.and_then(trimmed_str) {
        let worktree = worktree_display_context(context, worktree_path);
        resolved = merge_display_context(resolved, worktree);
    }
    resolved
}

fn stored_metadata_session_display_context(
    context: &ProjectServiceRequestContext,
    session_id: &str,
) -> NotificationDisplayContext {
    let metadata = load_metadata_state(context.project_state_dir());
    let Some(session) = metadata.sessions.get(session_id) else {
        return NotificationDisplayContext::default();
    };
    let session_context = session.get("context").unwrap_or(&Value::Null);
    NotificationDisplayContext {
        label: None,
        command: None,
        worktree_path: session_context
            .get("worktreePath")
            .and_then(Value::as_str)
            .and_then(trimmed_str)
            .map(str::to_owned),
        worktree_name: session_context
            .get("worktreeName")
            .and_then(Value::as_str)
            .and_then(trimmed_str)
            .map(str::to_owned),
        branch: session_context
            .get("branch")
            .and_then(Value::as_str)
            .and_then(trimmed_str)
            .map(str::to_owned),
    }
}

fn topology_session_display_context(
    context: &ProjectServiceRequestContext,
    session_id: &str,
) -> NotificationDisplayContext {
    let Ok(topology) = read_runtime_topology(runtime_topology_path(context.project_state_dir()))
    else {
        return NotificationDisplayContext::default();
    };
    let Some(session) = list_topology_session_states(&topology, None)
        .into_iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(session_id))
    else {
        return NotificationDisplayContext::default();
    };
    session_display_context(context, &session)
}

fn desktop_session_display_context(
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
    session_display_context(context, session)
}

fn session_display_context(
    context: &ProjectServiceRequestContext,
    session: &Value,
) -> NotificationDisplayContext {
    let worktree_path = session.get("worktreePath").and_then(Value::as_str);
    let mut display = worktree_path
        .map(|path| worktree_display_context(context, path))
        .unwrap_or_default();
    display.label = session
        .get("team")
        .and_then(Value::as_object)
        .and_then(|team| team.get("label"))
        .and_then(Value::as_str)
        .and_then(trimmed_str)
        .map(str::to_owned)
        .or_else(|| {
            session
                .get("label")
                .and_then(Value::as_str)
                .and_then(trimmed_str)
                .map(str::to_owned)
        });
    display.command = session
        .get("command")
        .and_then(Value::as_str)
        .and_then(trimmed_str)
        .map(str::to_owned)
        .or_else(|| {
            session
                .get("toolConfigKey")
                .and_then(Value::as_str)
                .and_then(trimmed_str)
                .map(str::to_owned)
        })
        .or_else(|| {
            session
                .get("tool")
                .and_then(Value::as_str)
                .and_then(trimmed_str)
                .map(str::to_owned)
        });
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
    if let Some(desktop) = context.desktop_state.as_ref() {
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
                label: None,
                command: None,
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
    }
    if let Ok(topology) = read_runtime_topology(runtime_topology_path(context.project_state_dir()))
        && let Some(worktree) = topology
            .get("worktrees")
            .and_then(Value::as_array)
            .and_then(|worktrees| {
                worktrees.iter().find(|worktree| {
                    worktree
                        .get("path")
                        .and_then(Value::as_str)
                        .is_some_and(|candidate| same_or_parent_path(path, candidate))
                        || worktree
                            .get("resolvedPath")
                            .and_then(Value::as_str)
                            .is_some_and(|candidate| same_or_parent_path(path, candidate))
                })
            })
    {
        let matched_path = worktree
            .get("path")
            .and_then(Value::as_str)
            .and_then(trimmed_str)
            .unwrap_or(path);
        let is_main = same_or_parent_path(matched_path, &context.project_root.to_string_lossy())
            && same_or_parent_path(&context.project_root.to_string_lossy(), matched_path);
        return NotificationDisplayContext {
            label: None,
            command: None,
            worktree_path: Some(matched_path.to_owned()),
            worktree_name: worktree
                .get("name")
                .and_then(Value::as_str)
                .and_then(trimmed_str)
                .map(str::to_owned)
                .or_else(|| {
                    if is_main {
                        Some("Main Checkout".to_owned())
                    } else {
                        path_basename(matched_path)
                    }
                }),
            branch: worktree
                .get("branch")
                .and_then(Value::as_str)
                .and_then(trimmed_str)
                .map(str::to_owned),
        };
    }
    let project_root = context.project_root.to_string_lossy();
    if same_or_parent_path(path, &project_root) {
        return NotificationDisplayContext {
            label: None,
            command: None,
            worktree_path: Some(project_root.into_owned()),
            worktree_name: Some("Main Checkout".to_owned()),
            branch: git_branch_for_path(&context.project_root),
        };
    }
    NotificationDisplayContext {
        label: None,
        command: None,
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
        label: override_context.label.or(base.label),
        command: override_context.command.or(base.command),
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

fn git_branch_for_path(path: &Path) -> Option<String> {
    let dot_git = path.join(".git");
    let head_path = if dot_git.is_dir() {
        dot_git.join("HEAD")
    } else {
        let gitdir = fs::read_to_string(&dot_git).ok()?;
        let gitdir = gitdir.trim().strip_prefix("gitdir:")?.trim();
        let gitdir_path = Path::new(gitdir);
        if gitdir_path.is_absolute() {
            gitdir_path.join("HEAD")
        } else {
            path.join(gitdir_path).join("HEAD")
        }
    };
    let head = fs::read_to_string(head_path).ok()?;
    let head = trimmed_str(&head)?;
    let branch_ref = head.strip_prefix("ref:")?.trim();
    branch_ref
        .rsplit('/')
        .next()
        .and_then(trimmed_str)
        .map(str::to_owned)
}

fn same_or_parent_path(path: &str, candidate_parent: &str) -> bool {
    let path = normalize_path_text(path);
    let candidate_parent = normalize_path_text(candidate_parent);
    if path.is_empty() || candidate_parent.is_empty() {
        return false;
    }
    path == candidate_parent || path.starts_with(&format!("{candidate_parent}/"))
}

fn normalize_path_text(path: &str) -> String {
    path.trim().trim_end_matches('/').to_owned()
}

fn trimmed_str(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}
