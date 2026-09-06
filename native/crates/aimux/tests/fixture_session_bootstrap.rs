use aimux::session_bootstrap::{compose_tool_launch, strip_tool_action_args};
use serde_json::{Map, Value, json};

const ACTION_ARGS: &str =
    include_str!("../../../../testdata/contracts/v1/session-bootstrap/action-args.json");

#[test]
fn fixture_session_bootstrap_action_args_matches_typescript() {
    let contract: Value =
        serde_json::from_str(ACTION_ARGS).expect("valid session-bootstrap/action-args fixture");
    let cases = contract["cases"].as_array().expect("action args cases");
    assert_eq!(cases.len(), 9, "unexpected action args case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = action_args_actual(case);
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
        "{} session-bootstrap/action-args parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn action_args_actual(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "stripToolActionArgsBatch" => Value::Array(
            case["input"]["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|item| {
                    let args = string_array(&item["args"]);
                    let stripped = strip_tool_action_args(item.get("toolCfg"), &args);
                    let mut output = Map::new();
                    if let Some(tool_cfg) = item.get("toolCfg") {
                        output.insert("toolCfg".into(), tool_cfg.clone());
                    }
                    output.insert("args".into(), json!(args));
                    output.insert("stripped".into(), json!(stripped));
                    Value::Object(output)
                })
                .collect(),
        ),
        "composeToolLaunch" => {
            let action = string_array(&case["input"]["action"]);
            let saved = string_array(&case["input"]["saved"]);
            compose_tool_launch(&case["input"]["toolCfg"], &action, &saved)
        }
        "composeRepeatedLaunch" => {
            let tool_cfg = &case["input"]["toolCfg"];
            let action = string_array(&case["input"]["action"]);
            let mut remembered = string_array(&case["input"]["saved"]);
            let iterations = case["input"]["iterations"].as_u64().unwrap_or(0);
            Value::Array(
                (0..iterations)
                    .map(|launch_count| {
                        let result = compose_tool_launch(tool_cfg, &action, &remembered);
                        let launch = string_array(&result["launch"]);
                        let persist = string_array(&result["persist"]);
                        let output = json!({
                            "launchCount": launch_count,
                            "launch": launch,
                            "persist": persist,
                            "resumeVerbCount": launch.iter().filter(|arg| arg.as_str() == "resume").count(),
                        });
                        remembered = string_array(&result["persist"]);
                        output
                    })
                    .collect(),
            )
        }
        "composeOnDiskRows" => Value::Array(
            case["input"]["rows"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|row| {
                    let tool_cfg = &row["toolCfg"];
                    let saved = string_array(&row["saved"]);
                    let new_id = case["input"]["newId"].as_str().unwrap_or_default();
                    let action = tool_cfg["resumeArgs"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(|arg| arg.replace("{sessionId}", new_id))
                        .collect::<Vec<_>>();
                    let result = compose_tool_launch(tool_cfg, &action, &saved);
                    let launch = string_array(&result["launch"]);
                    json!({
                        "saved": saved,
                        "launch": launch,
                        "persist": result["persist"],
                        "resumeVerbCount": resume_verb_count(&launch),
                        "containsNewId": launch.iter().any(|arg| arg == new_id),
                    })
                })
                .collect(),
        ),
        "composePersistedLaunchRegression" => {
            let tool_cfg = &case["input"]["toolCfg"];
            let action = string_array(&case["input"]["action"]);
            let saved = string_array(&case["input"]["saved"]);
            let first = compose_tool_launch(tool_cfg, &action, &saved);
            let launch = string_array(&first["launch"]);
            let relaunched = compose_tool_launch(tool_cfg, &action, &launch);
            let relaunch = string_array(&relaunched["launch"]);
            json!({
                "launch": launch,
                "launchResumeCount": launch.iter().filter(|arg| arg.as_str() == "resume").count(),
                "relaunched": relaunch,
                "relaunchedResumeCount": relaunch.iter().filter(|arg| arg.as_str() == "resume").count(),
            })
        }
        api => json!({ "error": format!("unknown action args api: {api}") }),
    }
}

fn string_array(value: &Value) -> Vec<String> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn resume_verb_count(args: &[String]) -> usize {
    args.iter()
        .filter(|arg| arg.as_str() == "resume" || arg.as_str() == "--resume")
        .count()
}
