use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const FIXTURE: &str =
    include_str!("../../../../../testdata/contracts/v1/tmux/sync-exec-inventory.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
struct Case {
    id: String,
    name: String,
    input: Value,
    output: Value,
}

#[test]
fn tmux_sync_exec_inventory_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("tmux sync exec inventory fixture parses");
    assert_eq!(contract.cases.len(), 5);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_case(&case.input);
        let expected = if case.input.get("api").and_then(Value::as_str) == Some("syncTmuxCallers") {
            assert_source_path_list_output(&case.output);
            normalize_expected_for_deleted_sources(case.output)
        } else {
            case.output
        };
        if actual != expected {
            failures.push(json!({
                "id": case.id,
                "name": case.name,
                "expected": expected,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} tmux sync-exec inventory parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(input: &Value) -> Value {
    match input.get("api").and_then(Value::as_str).unwrap_or_default() {
        "syncTmuxCallers" => {
            let callers = sync_tmux_callers(input);
            let allowed = string_set(&input["allowedSyncCallers"]);
            let off_loop = string_set(&input["offLoopFiles"]);
            json!({
                "callers": callers,
                "unexpected": callers.into_iter().filter(|file| !allowed.contains(file) && !off_loop.contains(file)).collect::<Vec<_>>(),
            })
        }
        "allowedSorted" => {
            let allowed = string_array(&input["allowedSyncCallers"]);
            let mut sorted = allowed.clone();
            sorted.sort();
            json!({
                "sorted": sorted,
                "isSorted": allowed == sorted,
            })
        }
        "allowedDuplicates" => {
            let allowed = string_array(&input["allowedSyncCallers"]);
            let duplicates = allowed
                .iter()
                .enumerate()
                .filter(|(index, entry)| allowed[..*index].contains(entry))
                .map(|(_, entry)| entry.clone())
                .collect::<Vec<_>>();
            json!({ "duplicates": duplicates })
        }
        "staleAllowed" => {
            let callers = sync_tmux_callers(input);
            let caller_set = callers.into_iter().collect::<HashSet<_>>();
            let stale = string_array(&input["allowedSyncCallers"])
                .into_iter()
                .filter(|file| source_file_exists(file))
                .filter(|file| !caller_set.contains(file))
                .collect::<Vec<_>>();
            json!({ "stale": stale })
        }
        "methodPatternProbes" => json!({
            "matches": string_array(&input["probes"]).into_iter().map(|probe| has_sync_tmux_call(&probe, &string_array(&input["syncTmuxMethods"]))).collect::<Vec<_>>()
        }),
        api => panic!("unknown tmux sync exec inventory api: {api}"),
    }
}

fn sync_tmux_callers(input: &Value) -> Vec<String> {
    let methods = string_array(&input["syncTmuxMethods"]);
    list_source_files("src")
        .into_iter()
        .filter(|file| has_sync_tmux_call(&read_source(file), &methods))
        .collect()
}

fn has_sync_tmux_call(text: &str, methods: &[String]) -> bool {
    methods.iter().any(|method| {
        let needle = format!(".{method}");
        let mut offset = 0;
        while let Some(index) = text[offset..].find(&needle) {
            let after = offset + index + needle.len();
            let rest = &text[after..];
            let trimmed = rest.trim_start_matches(|character: char| character.is_whitespace());
            if trimmed.starts_with('(') {
                return true;
            }
            offset = after;
        }
        false
    })
}

fn list_source_files(root: &str) -> Vec<String> {
    let mut files = Vec::new();
    visit(&repo_root().join(root), &mut files);
    files.sort();
    files
}

fn visit(path: &Path, files: &mut Vec<String>) {
    let Ok(meta) = fs::metadata(path) else {
        return;
    };
    if meta.is_dir() {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if matches!(name, "node_modules" | "dist" | "release" | ".git") {
            return;
        }
        let mut entries = fs::read_dir(path)
            .unwrap_or_else(|err| panic!("read directory {}: {err}", path.display()))
            .collect::<Result<Vec<_>, _>>()
            .expect("directory entries");
        entries.sort_by_key(|entry| entry.path());
        for entry in entries {
            visit(&entry.path(), files);
        }
        return;
    }
    if !meta.is_file() {
        return;
    }
    let rel = path
        .strip_prefix(repo_root())
        .expect("path under repo")
        .to_string_lossy()
        .replace('\\', "/");
    if rel.ends_with(".ts") && !rel.ends_with(".test.ts") {
        files.push(rel);
    }
}

fn read_source(path: &str) -> String {
    fs::read_to_string(repo_root().join(path)).unwrap_or_else(|err| panic!("read {path}: {err}"))
}

fn source_file_exists(path: &str) -> bool {
    repo_root().join(path).exists()
}

fn assert_source_path_list_output(output: &Value) {
    for key in ["callers", "unexpected"] {
        for path in string_array(&output[key]) {
            assert!(
                path.starts_with("src/") && path.ends_with(".ts"),
                "recorded {key} entry is not a TypeScript source path: {path}"
            );
        }
    }
}

fn normalize_expected_for_deleted_sources(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .filter(|item| item.as_str().is_none_or(source_file_exists))
                .collect(),
        ),
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, normalize_expected_for_deleted_sources(value)))
                .collect(),
        ),
        value => value,
    }
}

fn string_array(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.as_str().map(ToOwned::to_owned))
        .collect()
}

fn string_set(value: &Value) -> HashSet<String> {
    string_array(value).into_iter().collect()
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repo root")
}
