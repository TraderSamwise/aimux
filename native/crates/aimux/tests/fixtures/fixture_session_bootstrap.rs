use aimux::session_bootstrap::{
    ForkSourceSnapshot, LAUNCH_PREAMBLE_ARGV_BUDGET_BYTES, build_aimux_agent_instructions,
    build_codex_migration_continuity_preamble, build_fork_preamble,
    build_tool_switch_continuity_preamble, can_resume_with_backend_session_id,
    cap_launch_preamble_for_argv, compose_tool_launch, get_tool_resume_args, seed_fork_artifacts,
    strip_tool_action_args, summarize_fork_source_activity,
};
use serde_json::{Map, Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const ACTION_ARGS: &str =
    include_str!("../../../../../testdata/contracts/v1/session-bootstrap/action-args.json");
const PREAMBLE: &str =
    include_str!("../../../../../testdata/contracts/v1/session-bootstrap/preamble.json");

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

#[test]
fn fixture_session_bootstrap_preamble_matches_typescript() {
    let contract: Value =
        serde_json::from_str(PREAMBLE).expect("valid session-bootstrap/preamble fixture");
    let cases = contract["cases"].as_array().expect("preamble cases");
    assert_eq!(cases.len(), 14, "unexpected preamble case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = preamble_actual(case);
        if !preamble_output_matches(case, &actual) {
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
        "{} session-bootstrap/preamble parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

#[test]
fn seed_fork_artifacts_does_not_copy_source_live_snapshot_as_target_live_context() {
    let root = temp_path("session-bootstrap-fork-artifacts");
    fs::create_dir_all(root.join(".git")).expect("project root");
    let source_context = root.join(".aimux/context/claude-source");
    fs::create_dir_all(&source_context).expect("source context");
    fs::write(
        source_context.join("live.md"),
        "# claude-source Live Snapshot\n\nsix-month-old source transcript\n",
    )
    .expect("source live");

    let snapshot = ForkSourceSnapshot {
        history_text: None,
        live_text: Some("# claude-source Live Snapshot\n\nsix-month-old source transcript".into()),
        plan_text: None,
        status_text: None,
    };
    seed_fork_artifacts(
        &root,
        "claude-source",
        "claude-target",
        "claude",
        Some("/repo/worktree"),
        &snapshot,
    );

    let target_context = root.join(".aimux/context/claude-target");
    assert!(
        !target_context.join("live.md").exists(),
        "forked sessions must not receive source live.md as their own live context"
    );
    let summary = fs::read_to_string(target_context.join("summary.md")).expect("target summary");
    assert!(
        summary.contains("Treat this file as carried-over prior context from the source session.")
    );
    assert!(summary.contains("## Live Terminal Snapshot"));
    assert!(summary.contains("six-month-old source transcript"));
    let plan = fs::read_to_string(root.join(".aimux/plans/claude-target.md")).expect("target plan");
    assert!(
        plan.contains("Review .aimux/context/claude-target/summary.md"),
        "forked plan should point at the inherited summary"
    );
    assert!(
        !plan.contains("summary.md and live.md"),
        "forked plan must not present source live.md as target live context"
    );

    fs::remove_dir_all(root).expect("cleanup");
}

fn preamble_output_matches(case: &Value, actual: &Value) -> bool {
    let expected = &case["output"];
    if case["id"].as_str() != Some("session-bootstrap-preamble-006") {
        return actual == expected;
    }

    actual.get("budget") == expected.get("budget")
        && actual.get("overflowPath") == expected.get("overflowPath")
        && actual.get("overflowTextIncludesTail") == expected.get("overflowTextIncludesTail")
        && actual
            .get("capped")
            .and_then(Value::as_str)
            .is_some_and(capped_overflow_preamble_is_valid)
        && actual
            .get("cappedByteLength")
            .and_then(Value::as_u64)
            .is_some_and(|length| length <= LAUNCH_PREAMBLE_ARGV_BUDGET_BYTES as u64)
}

fn capped_overflow_preamble_is_valid(capped: &str) -> bool {
    capped.starts_with("line 0 of carried-over context\n")
        && capped.contains(
            "[Preamble truncated to fit the terminal launch limit. Read <projectRoot>/.aimux/context/claude-fork/launch-preamble.md for the full text before you start.]",
        )
        && !capped.contains("line 1999 of carried-over context")
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

fn preamble_actual(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "buildAimuxAgentInstructions" => {
            let session_id = case["input"]["sessionId"].as_str();
            let include_teammates = case["input"]["includeTeammateCreationInstructions"]
                .as_bool()
                .unwrap_or(true);
            json!(build_aimux_agent_instructions(
                session_id,
                include_teammates
            ))
        }
        "canResumeWithBackendSessionIdBatch" => Value::Array(
            case["input"]["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|item| {
                    can_resume_with_backend_session_id(
                        item.get("toolCfg"),
                        item.get("backendSessionId").and_then(Value::as_str),
                    )
                })
                .map(Value::Bool)
                .collect(),
        ),
        "getToolResumeArgsBatch" => Value::Array(
            case["input"]["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|item| {
                    get_tool_resume_args(
                        item.get("toolCfg"),
                        item.get("backendSessionId").and_then(Value::as_str),
                    )
                    .map(Value::from)
                    .unwrap_or(Value::Null)
                })
                .collect(),
        ),
        "capLaunchPreambleForArgv" => cap_preamble_actual(case),
        "summarizeForkSourceActivity" => json!(summarize_fork_source_activity(
            &snapshot_from_value(&case["input"]["snapshot"])
        )),
        "buildForkPreamble" => {
            let root = temp_path("session-bootstrap-fork-preamble");
            fs::create_dir_all(root.join(".git")).expect("project root");
            let output = build_fork_preamble(
                &root,
                case["input"]["sourceSessionId"].as_str().expect("source"),
                case["input"]["targetSessionId"].as_str().expect("target"),
                Some("Source Agent"),
                Some("coder"),
                Some("/repo/.aimux/worktrees/feature"),
                &snapshot_from_value(&case["input"]["snapshot"]),
            );
            let normalized = normalize_project_root(Value::String(output), &root);
            fs::remove_dir_all(root).expect("cleanup");
            normalized
        }
        "buildToolSwitchContinuityPreamble" => {
            let root = temp_path("session-bootstrap-tool-switch");
            fs::create_dir_all(root.join(".git")).expect("project root");
            let output = build_tool_switch_continuity_preamble(
                &root,
                case["input"]["sessionId"].as_str().expect("session"),
                case["input"]["sourceTool"].as_str().expect("source tool"),
                case["input"]["targetTool"].as_str().expect("target tool"),
                &snapshot_from_value(&case["input"]["snapshot"]),
                case["input"]["instruction"].as_str(),
            );
            let normalized = normalize_project_root(Value::String(output), &root);
            fs::remove_dir_all(root).expect("cleanup");
            normalized
        }
        "buildCodexMigrationContinuityPreamble" => {
            let root = temp_path("session-bootstrap-migration");
            fs::create_dir_all(root.join(".git")).expect("project root");
            let output = build_codex_migration_continuity_preamble(
                &root,
                case["input"]["sessionId"].as_str().expect("session"),
                case["input"]["sourceWorktreePath"]
                    .as_str()
                    .expect("source worktree"),
                case["input"]["targetWorktreePath"]
                    .as_str()
                    .expect("target worktree"),
                &snapshot_from_value(&case["input"]["snapshot"]),
                case["input"]["instruction"].as_str(),
            );
            let normalized = normalize_project_root(Value::String(output), &root);
            fs::remove_dir_all(root).expect("cleanup");
            normalized
        }
        api => json!({ "error": format!("unknown preamble api: {api}") }),
    }
}

fn cap_preamble_actual(case: &Value) -> Value {
    let mode = case["input"]["mode"].as_str().unwrap_or_default();
    match mode {
        "fits" => {
            let preamble = case["input"]["preamble"].as_str().expect("preamble");
            let capped = cap_launch_preamble_for_argv(Path::new("."), "claude-fits", preamble);
            json!({
                "capped": capped,
                "cappedByteLength": capped.len(),
            })
        }
        "overflow" => {
            let root = temp_path("session-bootstrap-overflow");
            fs::create_dir_all(root.join(".git")).expect("project root");
            let lines = case["input"]["preambleLines"].as_u64().expect("lines");
            let preamble = (0..lines)
                .map(|index| format!("line {index} of carried-over context"))
                .collect::<Vec<_>>()
                .join("\n");
            let capped = cap_launch_preamble_for_argv(&root, "claude-fork", &preamble);
            let overflow_path = root
                .join(".aimux")
                .join("context")
                .join("claude-fork")
                .join("launch-preamble.md");
            let output = json!({
                "capped": capped,
                "cappedByteLength": capped.len(),
                "overflowPath": overflow_path.to_string_lossy(),
                "overflowTextIncludesTail": fs::read_to_string(&overflow_path)
                    .map(|text| text.contains("line 1999 of carried-over context"))
                    .unwrap_or(false),
                "budget": LAUNCH_PREAMBLE_ARGV_BUDGET_BYTES,
            });
            let normalized = normalize_project_root(output, &root);
            fs::remove_dir_all(root).expect("cleanup");
            normalized
        }
        "blocked" => {
            let root = temp_path("session-bootstrap-blocked");
            fs::create_dir_all(&root).expect("root");
            let not_a_directory = root.join("file-where-a-repo-should-be");
            fs::write(&not_a_directory, "").expect("blocked path");
            let [text, count] = case["input"]["repeat"]
                .as_array()
                .expect("repeat")
                .as_slice()
            else {
                panic!("repeat");
            };
            let preamble = text
                .as_str()
                .expect("repeat text")
                .repeat(count.as_u64().expect("repeat count") as usize);
            let capped = cap_launch_preamble_for_argv(&not_a_directory, "claude-fork", &preamble);
            let output = json!({
                "capped": capped,
                "cappedByteLength": capped.len(),
                "wroteOverflow": not_a_directory
                    .join(".aimux")
                    .join("context")
                    .join("claude-fork")
                    .join("launch-preamble.md")
                    .exists(),
                "budget": LAUNCH_PREAMBLE_ARGV_BUDGET_BYTES,
            });
            let normalized = normalize_project_root(output, &root);
            fs::remove_dir_all(root).expect("cleanup");
            normalized
        }
        _ => json!({ "error": format!("unknown cap mode: {mode}") }),
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

fn snapshot_from_value(value: &Value) -> ForkSourceSnapshot {
    ForkSourceSnapshot {
        history_text: optional_string(value, "historyText"),
        live_text: optional_string(value, "liveText"),
        plan_text: optional_string(value, "planText"),
        status_text: optional_string(value, "statusText"),
    }
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn normalize_project_root(value: Value, root: &Path) -> Value {
    let root = root.to_string_lossy();
    let mut normalized = normalize_string_token(value, &root, "<projectRoot>");
    if let Some(object) = normalized.as_object_mut()
        && let Some(capped) = object.get("capped").and_then(Value::as_str)
    {
        object.insert("cappedByteLength".into(), json!(capped.len()));
    }
    normalized
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

fn temp_path(label: &str) -> PathBuf {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_millis();
    std::env::temp_dir().join(format!("{label}-{millis}-{}", std::process::id()))
}
