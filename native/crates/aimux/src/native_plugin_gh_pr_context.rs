use crate::plugin_api::{
    NativePlugin, NativePluginApi, NativePluginApiRequest, NativePluginCapability,
    NativePluginEventKind, NativePluginManifest,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Default, Clone)]
pub struct GithubPrContextPlugin;

impl GithubPrContextPlugin {
    pub fn collect_targets(&self, api: &mut NativePluginApi<'_>) -> Result<Value, String> {
        let statusline = api.call(NativePluginApiRequest::ReadStatuslineSnapshot)?;
        let state = api.call(NativePluginApiRequest::ReadDaemonStateSnapshot)?;
        let metadata = api.call(NativePluginApiRequest::ReadMetadataState)?;
        let topology = api.call(NativePluginApiRequest::ReadRuntimeTopology {
            statuses: Some(vec!["running".to_owned(), "idle".to_owned()]),
        })?;
        Ok(collect_targets_from_state(
            &statusline,
            &state,
            &metadata,
            topology.get("sessions").unwrap_or(&topology),
        ))
    }

    fn refresh_all(&self, api: &mut NativePluginApi<'_>) -> Result<(), String> {
        let targets = self.collect_targets(api)?;
        for target in targets.as_array().into_iter().flatten() {
            let Some(session_id) = target.get("id").and_then(Value::as_str) else {
                continue;
            };
            let Some(worktree_path) = target.get("worktreePath").and_then(Value::as_str) else {
                continue;
            };
            if let Some(context) = pr_context_for_worktree(api, worktree_path)? {
                api.call(NativePluginApiRequest::SetSessionContext {
                    session_id: session_id.to_owned(),
                    context,
                })?;
            }
        }
        Ok(())
    }
}

impl NativePlugin for GithubPrContextPlugin {
    fn manifest(&self) -> NativePluginManifest {
        NativePluginManifest {
            name: "gh-pr-context".to_owned(),
            display_name: "GitHub PR Context".to_owned(),
            builtin: true,
            subscriptions: vec![
                NativePluginEventKind::SessionLifecycle,
                NativePluginEventKind::Activity,
            ],
            capabilities: vec![
                NativePluginCapability::Subprocess {
                    name: "git".to_owned(),
                    command: "git".to_owned(),
                    cwd_scopes: vec!["worktreeInventory".to_owned()],
                },
                NativePluginCapability::Subprocess {
                    name: "gh".to_owned(),
                    command: "gh".to_owned(),
                    cwd_scopes: vec!["worktreeInventory".to_owned()],
                },
            ],
        }
    }

    fn start(&mut self, api: &mut NativePluginApi<'_>) -> Result<(), String> {
        api.call(NativePluginApiRequest::SubscribeEvents {
            kinds: self.manifest().subscriptions,
        })?;
        self.refresh_all(api)
    }

    fn on_event(&mut self, _event: Value, api: &mut NativePluginApi<'_>) -> Result<(), String> {
        self.refresh_all(api)
    }
}

pub(crate) fn collect_targets_from_state(
    statusline: &Value,
    state: &Value,
    metadata: &Value,
    topology_sessions: &Value,
) -> Value {
    let statusline_by_id = sessions_by_id(statusline.get("sessions").and_then(Value::as_array));
    let mut seen = BTreeSet::new();
    let mut targets = Vec::new();
    if let Some(sessions) = topology_sessions.as_array() {
        for session in sessions {
            let Some(id) = non_empty_string(session.get("id")) else {
                continue;
            };
            if !seen.insert(id.to_owned()) {
                continue;
            }
            let statusline_session = statusline_by_id.get(id);
            let context = metadata
                .get("sessions")
                .and_then(|sessions| sessions.get(id))
                .and_then(|session| session.get("context"));
            if let Some(worktree_path) = first_string([
                session.get("worktreePath"),
                statusline_session.and_then(|session| session.get("worktreePath")),
                context.and_then(|context| context.get("worktreePath")),
                context.and_then(|context| context.get("cwd")),
            ]) {
                targets.push(json!({ "id": id, "worktreePath": worktree_path }));
            }
        }
    }
    if let Some(services) = state.get("services").and_then(Value::as_array) {
        for service in services {
            let Some(id) = non_empty_string(service.get("id")) else {
                continue;
            };
            if !seen.insert(id.to_owned()) {
                continue;
            }
            if let Some(worktree_path) = non_empty_string(service.get("worktreePath")) {
                targets.push(json!({ "id": id, "worktreePath": worktree_path }));
            }
        }
    }
    Value::Array(targets)
}

fn pr_context_for_worktree(
    api: &mut NativePluginApi<'_>,
    worktree_path: &str,
) -> Result<Option<Value>, String> {
    let branch = declared_subprocess_stdout(
        api,
        "git",
        "git",
        &["branch", "--show-current"],
        Some(worktree_path),
    )?;
    if branch.trim().is_empty() {
        return Ok(None);
    }
    let pr_json = declared_subprocess_stdout(
        api,
        "gh",
        "gh",
        &[
            "pr",
            "view",
            "--json",
            "number,title,url,headRefName,baseRefName,state,author",
        ],
        Some(worktree_path),
    )?;
    if pr_json.trim().is_empty() {
        return Ok(None);
    }
    let pr = serde_json::from_str::<Value>(&pr_json).map_err(|error| error.to_string())?;
    Ok(Some(json!({ "branch": branch.trim(), "pr": pr })))
}

fn declared_subprocess_stdout(
    api: &mut NativePluginApi<'_>,
    capability: &str,
    command: &str,
    args: &[&str],
    cwd: Option<&str>,
) -> Result<String, String> {
    let output = api.call(NativePluginApiRequest::RunDeclaredSubprocess {
        capability: capability.to_owned(),
        command: command.to_owned(),
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
        cwd: cwd.map(str::to_owned),
        timeout_ms: Some(10_000),
    })?;
    if output.get("ok").and_then(Value::as_bool) != Some(true) {
        return Ok(String::new());
    }
    Ok(output
        .get("stdout")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned())
}

fn sessions_by_id(sessions: Option<&Vec<Value>>) -> BTreeMap<String, &Value> {
    let mut by_id = BTreeMap::new();
    if let Some(sessions) = sessions {
        for session in sessions {
            if let Some(id) = session.get("id").and_then(Value::as_str) {
                by_id.insert(id.to_owned(), session);
            }
        }
    }
    by_id
}

fn first_string<'a>(values: impl IntoIterator<Item = Option<&'a Value>>) -> Option<&'a str> {
    values
        .into_iter()
        .flatten()
        .find_map(|value| non_empty_string(Some(value)))
}

fn non_empty_string(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}
