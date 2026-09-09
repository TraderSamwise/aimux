use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use aimux::runtime_topology::empty_runtime_topology;
use aimux::runtime_topology_services::{
    list_topology_service_states, remove_topology_service, remove_topology_services_for_worktree,
    topology_service_to_service_state, upsert_topology_service, upsert_topology_services,
};
use aimux::runtime_topology_worktrees::{
    delete_topology_worktree_graveyard_entry, list_topology_worktree_graveyard,
    list_topology_worktree_states, move_topology_worktree_to_graveyard, remove_topology_worktree,
    resurrect_topology_worktree_from_graveyard, upsert_topology_worktree,
};
use serde_json::{Value, json};

const RUNTIME_TOPOLOGY_WORKTREES: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-topology/worktrees.json");
const RUNTIME_TOPOLOGY_SERVICES: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-topology/services.json");
const NOW: &str = "2026-05-25T00:00:00.000Z";
const LATER: &str = "2026-05-25T01:00:00.000Z";
const LATEST: &str = "2026-05-25T02:00:00.000Z";
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn fixture_runtime_topology_worktrees_matches_typescript() {
    assert_contract(
        RUNTIME_TOPOLOGY_WORKTREES,
        5,
        "runtime-topology/worktrees",
        runtime_topology_worktrees_contract,
    );
}

#[test]
fn fixture_runtime_topology_services_matches_typescript() {
    assert_contract(
        RUNTIME_TOPOLOGY_SERVICES,
        6,
        "runtime-topology/services",
        runtime_topology_services_contract,
    );
}

fn assert_contract(fixture: &str, expected_count: usize, label: &str, run: fn(&Value) -> Value) {
    let contract: Value = serde_json::from_str(fixture).expect("valid topology fixture");
    let cases = contract["cases"].as_array().expect("topology cases");
    assert_eq!(cases.len(), expected_count, "unexpected {label} case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = run(case);
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
        "{} {label} parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn runtime_topology_worktrees_contract(case: &Value) -> Value {
    with_temp_project(|repo, tmp, roots| {
        let mut topology = empty_runtime_topology();
        let output = match case["api"].as_str().unwrap_or_default() {
            "upsert-list" => {
                let worktree = denormalize_worktree(case["input"]["worktree"].clone(), &repo, &tmp);
                upsert_topology_worktree(
                    &mut topology,
                    &worktree,
                    case["input"]["status"].as_str().unwrap_or_default(),
                    &repo.to_string_lossy(),
                    NOW,
                );
                json!({ "active": list_topology_worktree_states(&topology, Some(&["active"])) })
            }
            "move-graveyard" => {
                let worktree = denormalize_worktree(case["input"]["worktree"].clone(), &repo, &tmp);
                let path = string_field(&worktree, "path").unwrap_or_default();
                upsert_topology_worktree(
                    &mut topology,
                    &worktree,
                    "active",
                    &repo.to_string_lossy(),
                    NOW,
                );
                let moved = move_topology_worktree_to_graveyard(
                    &mut topology,
                    &path,
                    &repo.to_string_lossy(),
                    LATER,
                    case["input"]["reason"].as_str(),
                );
                let graveyard_paths = list_topology_worktree_graveyard(&topology, false)
                    .into_iter()
                    .filter_map(|entry| string_field(&entry, "path"))
                    .collect::<Vec<_>>();
                json!({
                    "moved": moved,
                    "graveyardStates": list_topology_worktree_states(&topology, Some(&["graveyard"])),
                    "graveyardPaths": graveyard_paths,
                })
            }
            "delete-graveyard-entry" => {
                let worktree = denormalize_worktree(case["input"]["worktree"].clone(), &repo, &tmp);
                let path = string_field(&worktree, "path").unwrap_or_default();
                upsert_topology_worktree(
                    &mut topology,
                    &worktree,
                    "active",
                    &repo.to_string_lossy(),
                    NOW,
                );
                move_topology_worktree_to_graveyard(
                    &mut topology,
                    &path,
                    &repo.to_string_lossy(),
                    LATER,
                    None,
                );
                let deleted =
                    delete_topology_worktree_graveyard_entry(&mut topology, &path, LATEST);
                json!({
                    "deleted": deleted,
                    "visibleGraveyard": list_topology_worktree_graveyard(&topology, false),
                    "allGraveyard": list_topology_worktree_graveyard(&topology, true),
                })
            }
            "resurrect-graveyard-entry" => {
                let worktree = denormalize_worktree(case["input"]["worktree"].clone(), &repo, &tmp);
                let path = string_field(&worktree, "path").unwrap_or_default();
                upsert_topology_worktree(
                    &mut topology,
                    &worktree,
                    "active",
                    &repo.to_string_lossy(),
                    NOW,
                );
                move_topology_worktree_to_graveyard(
                    &mut topology,
                    &path,
                    &repo.to_string_lossy(),
                    LATER,
                    None,
                );
                let resurrected = resurrect_topology_worktree_from_graveyard(
                    &mut topology,
                    &path,
                    &repo.to_string_lossy(),
                    LATEST,
                );
                json!({
                    "resurrected": resurrected,
                    "graveyard": list_topology_worktree_graveyard(&topology, false),
                    "active": list_topology_worktree_states(&topology, Some(&["active"])),
                })
            }
            "remove-worktree" => {
                let worktree = denormalize_worktree(case["input"]["worktree"].clone(), &repo, &tmp);
                let path = string_field(&worktree, "path").unwrap_or_default();
                upsert_topology_worktree(
                    &mut topology,
                    &worktree,
                    "active",
                    &repo.to_string_lossy(),
                    NOW,
                );
                let removed = remove_topology_worktree(&mut topology, &path, LATER);
                json!({
                    "removed": removed,
                    "worktrees": list_topology_worktree_states(&topology, None),
                    "graveyard": list_topology_worktree_graveyard(&topology, false),
                })
            }
            api => json!({ "error": format!("unknown runtime-topology/worktrees api: {api}") }),
        };
        normalize_value(output, &roots)
    })
}

fn runtime_topology_services_contract(case: &Value) -> Value {
    with_temp_project(|repo, _tmp, roots| {
        let mut topology = empty_runtime_topology();
        let output = match case["api"].as_str().unwrap_or_default() {
            "upsert-running" => {
                let service =
                    denormalize_value(case["input"]["service"].clone(), &repo, Path::new(""));
                upsert_topology_service(
                    &mut topology,
                    &service,
                    "running",
                    &repo.to_string_lossy(),
                    NOW,
                );
                json!({
                    "services": topology["services"],
                    "nodes": topology["nodes"],
                    "bindings": topology["bindings"],
                    "state": topology_service_to_service_state(&topology["services"][0], &topology),
                })
            }
            "upsert-running-then-stopped" => {
                let service = case["input"]["service"].clone();
                let mut live_service = service.as_object().cloned().unwrap_or_default();
                live_service.insert("tmuxTarget".into(), case["input"]["tmuxTarget"].clone());
                upsert_topology_service(
                    &mut topology,
                    &Value::Object(live_service),
                    "running",
                    &repo.to_string_lossy(),
                    NOW,
                );
                upsert_topology_service(
                    &mut topology,
                    &service,
                    "stopped",
                    &repo.to_string_lossy(),
                    LATER,
                );
                json!({
                    "bindings": topology["bindings"],
                    "stopped": list_topology_service_states(&topology, Some(&["stopped"])),
                })
            }
            "upsert-stopped-with-target" => {
                upsert_topology_service(
                    &mut topology,
                    &case["input"]["service"],
                    "stopped",
                    &repo.to_string_lossy(),
                    NOW,
                );
                json!({
                    "bindings": topology["bindings"],
                    "stopped": list_topology_service_states(&topology, Some(&["stopped"])),
                })
            }
            "batch-upsert-stopped" => {
                let services = case["input"]["services"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                upsert_topology_services(
                    &mut topology,
                    &services,
                    "stopped",
                    &repo.to_string_lossy(),
                    NOW,
                );
                json!({
                    "stopped": list_topology_service_states(&topology, Some(&["stopped"])),
                    "bindings": topology["bindings"],
                })
            }
            "remove-service" => {
                upsert_topology_service(
                    &mut topology,
                    &case["input"]["service"],
                    "stopped",
                    &repo.to_string_lossy(),
                    NOW,
                );
                let rig_id = topology["rigs"][0]["id"].clone();
                topology["lifecycleOperations"] = Value::Array(vec![json!({
                    "id": "op-remove-service",
                    "rigId": rig_id,
                    "kind": "service.remove",
                    "status": "pending",
                    "targetKind": "service",
                    "targetId": "service-web",
                    "startedAt": NOW,
                    "updatedAt": NOW,
                })]);
                let removed = remove_topology_service(&mut topology, "service-web", LATER);
                json!({
                    "removed": removed,
                    "services": topology["services"],
                    "nodes": topology["nodes"],
                    "lifecycleOperations": topology["lifecycleOperations"],
                })
            }
            "remove-services-for-worktree" => {
                let worktree_path = denormalize_string(
                    case["input"]["worktreePath"].as_str().unwrap_or_default(),
                    &repo,
                    Path::new(""),
                );
                let keep_path = denormalize_string(
                    case["input"]["keepPath"].as_str().unwrap_or_default(),
                    &repo,
                    Path::new(""),
                );
                upsert_topology_service(
                    &mut topology,
                    &json!({ "id": "service-a", "command": "zsh", "worktreePath": worktree_path }),
                    "stopped",
                    &repo.to_string_lossy(),
                    NOW,
                );
                upsert_topology_service(
                    &mut topology,
                    &json!({ "id": "service-b", "command": "zsh", "worktreePath": keep_path }),
                    "stopped",
                    &repo.to_string_lossy(),
                    LATER,
                );
                let removed =
                    remove_topology_services_for_worktree(&mut topology, &worktree_path, LATER);
                json!({
                    "removed": removed,
                    "serviceIds": ids(&topology["services"]),
                    "nodeIds": ids(&topology["nodes"]),
                })
            }
            api => json!({ "error": format!("unknown runtime-topology/services api: {api}") }),
        };
        normalize_value(output, &roots)
    })
}

fn ids(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["id"].as_str().map(str::to_owned))
        .collect()
}

fn denormalize_worktree(value: Value, repo: &Path, tmp: &Path) -> Value {
    let mut map = value.as_object().cloned().unwrap_or_default();
    for key in ["path", "basePath"] {
        if let Some(path) = map.get(key).and_then(Value::as_str) {
            map.insert(
                key.into(),
                Value::String(denormalize_string(path, repo, tmp)),
            );
        }
    }
    Value::Object(map)
}

fn denormalize_value(value: Value, repo: &Path, tmp: &Path) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| denormalize_value(item, repo, tmp))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, denormalize_value(value, repo, tmp)))
                .collect(),
        ),
        Value::String(text) => Value::String(denormalize_string(&text, repo, tmp)),
        value => value,
    }
}

fn denormalize_string(value: &str, repo: &Path, tmp: &Path) -> String {
    let replaced = value.replace("<repo>", &repo.to_string_lossy());
    if let Some(rest) = replaced.strip_prefix("<tmp>/") {
        return tmp.join(rest).to_string_lossy().into_owned();
    }
    if !replaced.starts_with('/') && !replaced.starts_with('<') {
        return tmp.join(replaced).to_string_lossy().into_owned();
    }
    replaced
}

fn with_temp_project(
    run: impl FnOnce(PathBuf, PathBuf, BTreeMap<String, PathBuf>) -> Value,
) -> Value {
    let repo = temp_dir("runtime-topology-worktrees-services-repo");
    let tmp = std::env::temp_dir();
    let roots = BTreeMap::from([("repo".into(), repo.clone()), ("tmp".into(), tmp.clone())]);
    let output = run(repo.clone(), tmp, roots);
    let _ = fs::remove_dir_all(repo);
    output
}

fn normalize_value(value: Value, roots: &BTreeMap<String, PathBuf>) -> Value {
    let mut worktree_ids = BTreeMap::new();
    let mut graveyard_ids = BTreeMap::new();
    let mut rig_ids = BTreeMap::new();
    normalize_value_with_tokens(
        value,
        roots,
        &mut worktree_ids,
        &mut graveyard_ids,
        &mut rig_ids,
    )
}

fn normalize_value_with_tokens(
    value: Value,
    roots: &BTreeMap<String, PathBuf>,
    worktree_ids: &mut BTreeMap<String, String>,
    graveyard_ids: &mut BTreeMap<String, String>,
    rig_ids: &mut BTreeMap<String, String>,
) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| {
                    normalize_value_with_tokens(item, roots, worktree_ids, graveyard_ids, rig_ids)
                })
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| {
                    if key == "rigId" {
                        let text = value.as_str().unwrap_or_default().to_owned();
                        let next = rig_ids.len() + 1;
                        let token = rig_ids
                            .entry(text)
                            .or_insert_with(|| format!("<rig:{next}>"));
                        return (key, Value::String(token.clone()));
                    }
                    (
                        key,
                        normalize_value_with_tokens(
                            value,
                            roots,
                            worktree_ids,
                            graveyard_ids,
                            rig_ids,
                        ),
                    )
                })
                .collect(),
        ),
        Value::String(text) if text.starts_with("worktree-graveyard:") => {
            let next = graveyard_ids.len() + 1;
            let token = graveyard_ids
                .entry(text)
                .or_insert_with(|| format!("<worktree-graveyard-id:{next}>"));
            Value::String(token.clone())
        }
        Value::String(text) if text.starts_with("worktree:") => {
            let next = worktree_ids.len() + 1;
            let token = worktree_ids
                .entry(text)
                .or_insert_with(|| format!("<worktree-id:{next}>"));
            Value::String(token.clone())
        }
        Value::String(text) => {
            let mut normalized = text;
            for (label, root) in roots {
                let root = root.to_string_lossy();
                let root = root.trim_end_matches('/');
                normalized = normalized.replace(root, &format!("<{label}>"));
            }
            Value::String(normalized)
        }
        value => value,
    }
}

fn temp_dir(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-{label}-fixture-{}-{}",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("mkdir temp dir");
    path
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}
