use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use crate::config::load_config_for_project;
use crate::daemon_state::{is_pid_alive, load_metadata_state};
use crate::paths::basename_like_node_posix;
use crate::project_service::router::ProjectServiceRequestContext;
use crate::runtime_topology::{
    list_topology_session_states, read_runtime_topology, runtime_topology_path,
};
use crate::session_bootstrap::scribe_team;
use crate::session_launch::resolve_default_scribe_launch;
use crate::user_facing_errors::user_facing_error_message;

use super::json_helpers::*;
use super::runtime_adapter::ProjectLifecycleRuntime;
use super::{
    AgentSessionLaunchInput, launch_agent_session, now_iso, set_session_control_flags,
    string_record_entries,
};

const DEFAULT_SCRIBE_CLAIM_RETRY: Duration = Duration::from_millis(100);
const DEFAULT_SCRIBE_CLAIM_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_SCRIBE_CLAIM_STALE: Duration = Duration::from_secs(60);

pub fn ensure_default_scribe_agent(
    context: &ProjectServiceRequestContext,
    runtime: &mut impl ProjectLifecycleRuntime,
) -> Value {
    let project_state_dir = context.project_state_dir();
    let config = load_config_for_project(context.project_root());
    let launch = resolve_default_scribe_launch(&config);
    if launch.get("reason").and_then(Value::as_str).is_some() {
        return launch;
    }
    if let Some(session_id) = find_existing_live_scribe(&project_state_dir) {
        return json!({
            "created": false,
            "reason": "existing",
            "sessionId": session_id,
        });
    }
    let _claim = match claim_default_scribe_creation(&project_state_dir) {
        Ok(claim) => claim,
        Err(error) => {
            return json!({
                "created": false,
                "reason": "claim-error",
                "error": error,
            });
        }
    };
    if let Some(session_id) = find_existing_live_scribe(&project_state_dir) {
        return json!({
            "created": false,
            "reason": "existing",
            "sessionId": session_id,
        });
    }
    let Some(tool_key) = trimmed_string(launch.get("toolConfigKey")) else {
        return json!({ "created": false, "reason": "unknown-tool" });
    };
    let Some(command) = trimmed_string(launch.get("command")) else {
        return json!({ "created": false, "reason": "missing-command" });
    };
    let mut launch_env = string_record_entries(launch.get("env"));
    launch_env.push(("AIMUX_SCRIBE".to_owned(), "1".to_owned()));
    let executable = basename_like_node_posix(&command);
    let session_id = if executable.is_empty() {
        format!("{command}-scribe")
    } else {
        format!("{executable}-scribe")
    };
    match launch_agent_session(
        context,
        runtime,
        AgentSessionLaunchInput {
            session_id,
            tool_key: tool_key.clone(),
            command,
            args: string_array_field(launch.get("args")),
            worktree_path: None,
            label: None,
            team: Some(scribe_team()),
            extra_preamble: None,
            launch_env,
            backend_session_id_override: None,
            detached: true,
            suppress_startup_preamble: false,
            persist_args: None,
            allow_replace_session: false,
            mark_overseer: false,
            mark_scribe: true,
        },
    ) {
        Ok(result) => json!({
            "created": true,
            "sessionId": result.session_id,
            "toolConfigKey": tool_key,
        }),
        Err(error) => json!({
            "created": false,
            "reason": "launch-error",
            "error": user_facing_error_message(&error),
        }),
    }
}

fn find_existing_live_scribe(project_state_dir: &Path) -> Option<String> {
    let metadata = load_metadata_state(project_state_dir);
    let topology =
        read_runtime_topology(runtime_topology_path(project_state_dir)).unwrap_or_else(|_| {
            json!({
                "version": 1,
                "rigs": [],
                "nodes": [],
                "edges": [],
                "bindings": [],
                "sessions": [],
                "services": [],
                "worktrees": [],
                "worktreeGraveyard": [],
                "teamRoles": [],
                "remoteClients": [],
                "lifecycleOperations": [],
                "exchangeRefs": []
            })
        });
    list_topology_session_states(&topology, None)
        .into_iter()
        .find(|session| {
            is_live_scribe_status(
                session
                    .get("status")
                    .or_else(|| session.get("lifecycle"))
                    .and_then(Value::as_str),
            ) && is_scribe_session(session, &metadata.sessions)
        })
        .and_then(|session| trimmed_string(session.get("id")))
        .inspect(|session_id| {
            set_session_control_flags(project_state_dir, session_id, false, true);
        })
}

fn is_live_scribe_status(status: Option<&str>) -> bool {
    matches!(
        status,
        None | Some("planned" | "starting" | "running" | "idle")
    )
}

pub(crate) fn is_scribe_session(
    session: &Value,
    metadata_sessions: &BTreeMap<String, Value>,
) -> bool {
    let session_id = string_field(session, "id");
    let mut probe = session.as_object().cloned().unwrap_or_default();
    if let Some(metadata) = metadata_sessions.get(&session_id) {
        for key in ["overseer", "scribe", "projectControl"] {
            if let Some(value) = metadata.get(key).cloned() {
                probe.insert(key.into(), value);
            }
        }
    }
    crate::team_contract::is_scribe_session(Some(&Value::Object(probe)))
}

struct DefaultScribeClaim {
    lock_path: PathBuf,
    token: String,
}

impl Drop for DefaultScribeClaim {
    fn drop(&mut self) {
        let owner_path = self.lock_path.join("owner");
        if matches!(fs::read_to_string(owner_path), Ok(contents) if contents == self.token) {
            let _ = fs::remove_dir_all(&self.lock_path);
        }
    }
}

fn claim_default_scribe_creation(project_state_dir: &Path) -> Result<DefaultScribeClaim, String> {
    let lock_path = project_state_dir.join("default-scribe-create.lock");
    let token = format!("{}.{}", std::process::id(), now_iso());
    let started = Instant::now();
    loop {
        match fs::create_dir(&lock_path) {
            Ok(()) => {
                fs::write(lock_path.join("owner"), token.as_bytes())
                    .map_err(|error| error.to_string())?;
                return Ok(DefaultScribeClaim { lock_path, token });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if recover_stale_default_scribe_claim(&lock_path) {
                    continue;
                }
                if started.elapsed() >= DEFAULT_SCRIBE_CLAIM_TIMEOUT {
                    return Err("Timed out waiting for default scribe creation claim".to_owned());
                }
                thread::sleep(DEFAULT_SCRIBE_CLAIM_RETRY);
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

fn recover_stale_default_scribe_claim(lock_path: &Path) -> bool {
    if let Ok(owner) = fs::read_to_string(lock_path.join("owner"))
        && let Some(pid) = owner
            .split('.')
            .next()
            .and_then(|value| value.parse::<i32>().ok())
        && pid > 0
    {
        if is_pid_alive(pid) {
            return false;
        }
        let _ = fs::remove_dir_all(lock_path);
        return true;
    }
    if let Ok(metadata) = fs::metadata(lock_path)
        && let Ok(modified) = metadata.modified()
        && modified
            .elapsed()
            .is_ok_and(|age| age >= DEFAULT_SCRIBE_CLAIM_STALE)
    {
        let _ = fs::remove_dir_all(lock_path);
        return true;
    }
    false
}
