use aimux::core_cli_routing::is_core_cli_command;
use serde::Deserialize;
use serde_json::{Value, json};
use std::fs;
use std::path::Path;

const FIXTURE: &str = include_str!("../../../../testdata/contracts/v1/core-command/ownership.json");

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
fn core_command_ownership_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(FIXTURE).expect("core command ownership fixture parses");
    assert_eq!(contract.cases.len(), 3);

    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run_case(&case.input);
        if actual != case.output {
            failures.push(json!({
                "id": case.id,
                "name": case.name,
                "expected": case.output,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} core-command ownership parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(input: &Value) -> Value {
    match input.get("api").and_then(Value::as_str).unwrap_or_default() {
        "isCoreCliCommand" => classify_commands(input),
        "installedShimFastPaths" => installed_shim_fast_paths(input),
        "nodeCoreFallbackBacklog" => node_core_fallback_backlog(input),
        api => panic!("unknown core command ownership api: {api}"),
    }
}

fn classify_commands(input: &Value) -> Value {
    let commands = input["commands"].as_array().expect("commands");
    json!({
        "commands": commands.iter().map(|entry| entry["command"].clone()).collect::<Vec<_>>(),
        "classifications": commands.iter().map(|entry| {
            let args = string_args(&entry["args"]);
            json!({
                "command": entry["command"],
                "args": entry["args"],
                "isCoreCliCommand": is_core_cli_command(&args),
            })
        }).collect::<Vec<_>>(),
        "invalidClassifications": input["invalidProbes"].as_array().into_iter().flatten().map(|probe| {
            let args = string_args(probe);
            json!({
                "args": probe,
                "isCoreCliCommand": is_core_cli_command(&args),
            })
        }).collect::<Vec<_>>(),
    })
}

fn installed_shim_fast_paths(input: &Value) -> Value {
    let shim = fs::read_to_string(repo_root().join("scripts/installed-aimux-shim.sh"))
        .expect("installed shim reads");
    let present_needles = input["fastPaths"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| {
            entry["shimNeedle"]
                .as_str()
                .is_some_and(|needle| shim.contains(needle))
        })
        .map(|entry| entry["command"].clone())
        .collect::<Vec<_>>();
    json!({
        "containsAimuxNodeBin": shim.contains("AIMUX_NODE_BIN"),
        "presentNeedles": present_needles,
    })
}

fn node_core_fallback_backlog(input: &Value) -> Value {
    json!({
        "backlog": input["commands"].as_array().into_iter().flatten().filter(|entry| {
            entry["disposition"].as_str() == Some("node-core-fallback")
        }).map(|entry| entry["command"].clone()).collect::<Vec<_>>()
    })
}

fn string_args(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.as_str().map(ToOwned::to_owned))
        .collect()
}

fn repo_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .expect("repo root")
}
