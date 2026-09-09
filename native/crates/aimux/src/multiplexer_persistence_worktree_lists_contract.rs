use serde_json::{Value, json};

const NOW: &str = "2026-06-01T00:00:00.000Z";

pub fn run_multiplexer_persistence_worktree_lists_contract_case(api: &str, input: &Value) -> Value {
    match api {
        "listDesktopWorktrees" => json!({ "returned": raw_worktrees() }),
        "listProjectedDesktopWorktrees" => {
            let mut worktrees = raw_worktrees();
            apply_worktree_pending_actions(
                &mut worktrees,
                array_at(input, &["host", "pendingActions"]),
            );
            json!({ "returned": worktrees })
        }
        api => panic!("unknown multiplexer persistence worktree-list api: {api}"),
    }
}

fn raw_worktrees() -> Vec<Value> {
    vec![
        json!({
            "name": "repo",
            "path": "/repo",
            "branch": "master",
            "isBare": false,
            "createdAt": "<createdAt:main>",
        }),
        json!({
            "name": "demo",
            "path": "/repo/.aimux/worktrees/demo",
            "branch": "demo",
            "isBare": false,
            "createdAt": "<createdAt:demo>",
        }),
    ]
}

fn apply_worktree_pending_actions(worktrees: &mut [Value], actions: Vec<Value>) {
    for action in actions {
        if string_field(&action, "target") != "worktree" {
            continue;
        }
        let path = string_field(&action, "path");
        let kind = string_field(&action, "kind");
        for worktree in worktrees
            .iter_mut()
            .filter(|worktree| string_field(worktree, "path") == path)
        {
            set_field(worktree, "pending", json!(true));
            set_field(
                worktree,
                "removing",
                json!(matches!(kind.as_str(), "removing" | "graveyarding")),
            );
            set_field(worktree, "pendingAction", json!(kind));
            set_field(worktree, "pendingStartedAt", json!(NOW));
            set_field(worktree, "optimistic", json!(true));
        }
    }
}

fn set_field(value: &mut Value, key: &str, new_value: Value) {
    if let Some(object) = value.as_object_mut() {
        object.insert(key.into(), new_value);
    }
}

fn array_at(value: &Value, path: &[&str]) -> Vec<Value> {
    let found = path.iter().fold(value, |current, key| {
        current.get(*key).unwrap_or(&Value::Null)
    });
    found.as_array().cloned().unwrap_or_default()
}

fn string_field(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}
