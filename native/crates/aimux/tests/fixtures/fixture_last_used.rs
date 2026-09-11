use std::fs;
use std::path::PathBuf;

use aimux::project_service::usage::{
    MarkLastUsedOptions, last_used_path, load_last_used_state, mark_last_used,
};
use serde_json::{Value, json};

const LAST_USED: &str =
    include_str!("../../../../../testdata/contracts/v1/runtime-state/last-used.json");

#[test]
fn fixture_last_used_matches_typescript() {
    let contract: Value =
        serde_json::from_str(LAST_USED).expect("valid runtime-state/last-used fixture");
    let cases = contract["cases"].as_array().expect("last-used cases");
    assert_eq!(cases.len(), 5, "unexpected last-used case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = last_used_contract(case);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} runtime-state/last-used parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn last_used_contract(case: &Value) -> Value {
    with_state_dir(|state_dir| match case["api"].as_str().unwrap_or_default() {
        "markSequence" => {
            for mark in case["input"]["marks"].as_array().into_iter().flatten() {
                mark_last_used(state_dir, mark_options(mark));
            }
            summarize_mark_sequence(case, &load_last_used_state(state_dir))
        }
        "seedAndMark" => {
            let path = last_used_path(state_dir);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("create last-used parent");
            }
            fs::write(
                &path,
                serde_json::to_string(&case["input"]["seed"]).expect("serialize seed"),
            )
            .expect("write seed");
            mark_last_used(state_dir, mark_options(&case["input"]["mark"]));
            summarize_seed_and_mark(case, &load_last_used_state(state_dir))
        }
        _ => Value::Null,
    })
}

fn summarize_mark_sequence(case: &Value, state: &Value) -> Value {
    match case["name"].as_str().unwrap_or_default() {
        "keeps recent ordering monotonic when older usage marks arrive late" => json!({
            "projectRecentIdsFirst2": first_ids(&state["projectRecentIds"], 2),
            "client1RecentIdsFirst2": first_ids(&state["clients"]["client-1"]["recentIds"], 2),
            "updatedAt": state["updatedAt"],
            "client1UpdatedAt": state["clients"]["client-1"]["updatedAt"],
        }),
        "does not let an older mark overwrite a newer item timestamp" => {
            json!({ "itemLastUsedAt": state["items"]["agent-a"]["lastUsedAt"] })
        }
        "keeps each client's recency independent from other clients using the same item" => json!({
            "projectRecentIdsFirst2": first_ids(&state["projectRecentIds"], 2),
            "client1RecentIdsFirst2": first_ids(&state["clients"]["client-1"]["recentIds"], 2),
            "client2RecentIdsFirst1": first_ids(&state["clients"]["client-2"]["recentIds"], 1),
        }),
        _ => state.clone(),
    }
}

fn summarize_seed_and_mark(case: &Value, state: &Value) -> Value {
    match case["name"].as_str().unwrap_or_default() {
        "prunes per-client item timestamps to the recent id limit" => {
            let items = state["clients"]["client-1"]["items"]
                .as_object()
                .map(|items| items.len())
                .unwrap_or_default();
            json!({
                "recentIdsCount": state["clients"]["client-1"]["recentIds"].as_array().map(Vec::len).unwrap_or_default(),
                "itemCount": items,
                "agent69LastUsedAt": state["clients"]["client-1"]["items"]["agent-69"]["lastUsedAt"],
                "hasAgent0": state["clients"]["client-1"]["items"].get("agent-0").is_some(),
            })
        }
        "seeds legacy client recency timestamps from saved order" => {
            json!({ "client1RecentIdsFirst2": first_ids(&state["clients"]["client-1"]["recentIds"], 2) })
        }
        _ => state.clone(),
    }
}

fn first_ids(value: &Value, count: usize) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .take(count)
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn mark_options(mark: &Value) -> MarkLastUsedOptions {
    MarkLastUsedOptions {
        item_id: mark["itemId"].as_str().unwrap_or_default().into(),
        client_session: mark
            .get("clientSession")
            .and_then(Value::as_str)
            .map(str::to_owned),
        used_at: mark
            .get("usedAt")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

fn with_state_dir(callback: impl FnOnce(&PathBuf) -> Value) -> Value {
    let dir = std::env::temp_dir().join(format!(
        "aimux-last-used-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos()
    ));
    fs::create_dir_all(&dir).expect("create temp state dir");
    let result = callback(&dir);
    let _ = fs::remove_dir_all(&dir);
    result
}
