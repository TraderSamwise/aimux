use aimux::paths::{PathResolver, ProjectEntry, ProjectsRegistry};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};

const PATHS_BEHAVIOR: &str =
    include_str!("../../../../../testdata/contracts/v1/paths/behavior.json");
const BASE: &str = "/tmp/aimux-contract-paths";
const HOME: &str = "/tmp/aimux-contract-paths-home";
const DEFAULT_HOME: &str = "/Users/sam";

#[test]
fn fixture_paths_behavior_matches_typescript() {
    let contract: Value = serde_json::from_str(PATHS_BEHAVIOR).expect("valid paths fixture");
    let cases = contract["cases"].as_array().expect("paths cases");
    assert_eq!(cases.len(), 7, "unexpected paths case count");
    let mut failures = Vec::new();
    for case in cases {
        reset();
        let actual = paths_actual(case);
        reset();
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
        "{} paths/behavior parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn paths_actual(case: &Value) -> Value {
    let input = denormalize(&case["input"]);
    match case["api"].as_str().unwrap_or_default() {
        "getProjectIdFor" => {
            let repo_root = input["repoRoot"].as_str().expect("repo root");
            let worktree_path = input["worktreePath"].as_str().expect("worktree path");
            let mut resolver = PathResolver::new("/", DEFAULT_HOME, None);
            let root_id = resolver.project_id_for(repo_root);
            let worktree_id = resolver.project_id_for(worktree_path);
            ok(json!({
                "rootId": root_id,
                "worktreeId": worktree_id,
                "equal": root_id == worktree_id,
            }))
        }
        "logPaths" => {
            let repo_root = input["repoRoot"].as_str().expect("repo root");
            let mut resolver = PathResolver::new("/", DEFAULT_HOME, None);
            ok(json!({
                "daemonLogPath": resolver.daemon_log_path(),
                "daemonStdioLogPath": resolver.daemon_stdio_log_path(),
                "projectLogPath": resolver.project_log_path_for(repo_root),
            }))
        }
        "aimuxHomeOverride" => {
            let aimux_home = input["aimuxHome"].as_str().expect("aimux home");
            let resolver = PathResolver::new("/", DEFAULT_HOME, Some(aimux_home.to_owned()));
            ok(json!({
                "globalAimuxDir": resolver.global_aimux_dir(),
                "daemonLogPath": resolver.daemon_log_path(),
            }))
        }
        "initPathsRegistry" => registry_actual(&input),
        api => json!({ "ok": false, "error": format!("unknown paths api: {api}") }),
    }
}

fn registry_actual(input: &Value) -> Value {
    let aimux_home = input["aimuxHome"].as_str().expect("aimux home");
    let repo_root = PathBuf::from(input["repoRoot"].as_str().expect("repo root"));
    if input["git"].as_bool().unwrap_or(true) {
        fs::create_dir_all(repo_root.join(".git")).expect("git dir");
    } else {
        fs::create_dir_all(&repo_root).expect("repo dir");
    }
    let mut resolver = PathResolver::new("/", DEFAULT_HOME, Some(aimux_home.to_owned()));
    if let Some(existing) = input["existingProjects"].as_u64() {
        let projects = if existing == 600 {
            (0..existing)
                .map(|index| {
                    let prefix = if index % 2 == 0 {
                        "/tmp/claude-501"
                    } else {
                        "/private/tmp/claude-501"
                    };
                    let root = format!("{prefix}/aimux-metadata-server-{index}");
                    ProjectEntry {
                        id: format!("aimux-metadata-server-{index}-{index}"),
                        name: format!("aimux-metadata-server-{index}"),
                        repo_root: root,
                        last_seen: "1970-01-01T00:00:00.000Z".to_owned(),
                    }
                })
                .collect::<Vec<_>>()
        } else {
            (0..existing)
                .map(|index| {
                    let root = PathBuf::from(aimux_home)
                        .join("valid-projects")
                        .join(format!("project-{index}"));
                    fs::create_dir_all(root.join(".git")).expect("valid project");
                    ProjectEntry {
                        id: format!("project-{index}-{index}"),
                        name: format!("project-{index}"),
                        repo_root: root.to_string_lossy().into_owned(),
                        last_seen: "1970-01-01T00:00:00.000Z".to_owned(),
                    }
                })
                .collect::<Vec<_>>()
        };
        fs::create_dir_all(aimux_home).expect("aimux home");
        fs::write(
            Path::new(aimux_home).join("projects.json"),
            serde_json::to_string_pretty(&ProjectsRegistry {
                version: 1,
                projects,
            })
            .expect("registry"),
        )
        .expect("write registry");
    }
    match resolver.register_project(&repo_root) {
        Ok(_) => ok(json!(resolver.list_projects().expect("list projects"))),
        Err(error) => json!({ "ok": false, "error": normalize(Value::String(error.to_string())) }),
    }
}

fn ok(value: Value) -> Value {
    json!({ "ok": true, "value": normalize(value) })
}

fn normalize(value: Value) -> Value {
    normalize_timestamps(normalize_string_token(
        normalize_string_token(
            normalize_string_token(value, DEFAULT_HOME, "<home>"),
            BASE,
            "<base>",
        ),
        HOME,
        "<aimuxHome>",
    ))
}

fn normalize_timestamps(value: Value) -> Value {
    match value {
        Value::String(value) if is_iso_timestamp(&value) => Value::String("<ts:1>".to_owned()),
        Value::Array(values) => {
            Value::Array(values.into_iter().map(normalize_timestamps).collect())
        }
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, normalize_timestamps(value)))
                .collect(),
        ),
        value => value,
    }
}

fn is_iso_timestamp(value: &str) -> bool {
    value.len() == "1970-01-01T00:00:00.000Z".len()
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value.as_bytes().get(10) == Some(&b'T')
        && value.ends_with('Z')
}

fn normalize_string_token(value: Value, needle: &str, replacement: &str) -> Value {
    match value {
        Value::String(value) => Value::String(value.replace(needle, replacement)),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| normalize_string_token(value, needle, replacement))
                .collect(),
        ),
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, normalize_string_token(value, needle, replacement)))
                .collect(),
        ),
        value => value,
    }
}

fn denormalize(value: &Value) -> Value {
    denormalize_string_token(
        denormalize_string_token(
            denormalize_string_token(value.clone(), "<home>", DEFAULT_HOME),
            "<base>",
            BASE,
        ),
        "<aimuxHome>",
        HOME,
    )
}

fn denormalize_string_token(value: Value, needle: &str, replacement: &str) -> Value {
    match value {
        Value::String(value) => Value::String(value.replace(needle, replacement)),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| denormalize_string_token(value, needle, replacement))
                .collect(),
        ),
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, denormalize_string_token(value, needle, replacement)))
                .collect(),
        ),
        value => value,
    }
}

fn reset() {
    let _ = fs::remove_dir_all(BASE);
    let _ = fs::remove_dir_all(HOME);
    let _ = fs::remove_dir_all("/tmp/aimux-transient-project-contract");
    fs::create_dir_all(BASE).expect("base");
}
