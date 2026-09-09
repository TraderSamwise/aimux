use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

pub fn run_gh_pr_context_contract_case(input: &Value) -> Value {
    match input.get("api").and_then(Value::as_str).unwrap_or_default() {
        "collectGithubPrTargets" => collect_github_pr_targets(
            input.get("statusline").unwrap_or(&Value::Null),
            input.get("state").unwrap_or(&Value::Null),
            input.get("metadata").unwrap_or(&Value::Null),
            input.get("topologySessions").unwrap_or(&Value::Null),
        ),
        api => panic!("unknown gh-pr-context contract api: {api}"),
    }
}

fn collect_github_pr_targets(
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
            let id = match session.get("id").and_then(Value::as_str) {
                Some(id) if !id.is_empty() => id,
                _ => continue,
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
                targets.push(json!({
                    "id": id,
                    "worktreePath": worktree_path,
                }));
            }
        }
    }

    if let Some(services) = state.get("services").and_then(Value::as_array) {
        for service in services {
            let id = match service.get("id").and_then(Value::as_str) {
                Some(id) if !id.is_empty() => id,
                _ => continue,
            };
            if !seen.insert(id.to_owned()) {
                continue;
            }
            if let Some(worktree_path) = service.get("worktreePath").and_then(Value::as_str) {
                targets.push(json!({
                    "id": id,
                    "worktreePath": worktree_path,
                }));
            }
        }
    }

    Value::Array(targets)
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
        .find_map(|value| value.as_str().filter(|value| !value.is_empty()))
}
