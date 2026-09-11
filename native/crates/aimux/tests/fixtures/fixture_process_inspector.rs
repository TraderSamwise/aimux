use aimux::process_inspector::{
    ProjectServiceProcessIdentity, is_aimux_project_service_process_args, is_exited_process_state,
    list_process_args_from_ps_output, read_process_args_from_ps_output,
    read_process_cwd_from_lsof_output,
};
use serde_json::{Value, json};

const PROCESS_INSPECTOR: &str =
    include_str!("../../../../../testdata/contracts/v1/process/inspector.json");

#[test]
fn fixture_process_inspector_matches_typescript() {
    let contract: Value =
        serde_json::from_str(PROCESS_INSPECTOR).expect("valid process-inspector fixture");
    let cases = contract["cases"].as_array().expect("process cases");
    assert_eq!(cases.len(), 12, "unexpected process-inspector case count");

    let mut failures = Vec::new();
    for case in cases {
        let input = &case["input"];
        let actual = match case["api"].as_str().unwrap_or_default() {
            "readProcessArgs" => {
                if input["psStatus"].as_i64().unwrap_or(0) == 0 {
                    optional_string(read_process_args_from_ps_output(
                        input["psStdout"].as_str().unwrap_or_default(),
                    ))
                } else {
                    Value::Null
                }
            }
            "listProcessArgs" => Value::Array(
                list_process_args_from_ps_output(input["psStdout"].as_str().unwrap_or_default())
                    .into_iter()
                    .map(|entry| json!({ "pid": entry.pid, "args": entry.args }))
                    .collect(),
            ),
            "readProcessCwd" => optional_string(read_process_cwd_from_lsof_output(
                input["lsofStdout"].as_str().unwrap_or_default(),
            )),
            "isExitedProcessState" => Value::Bool(is_exited_process_state(
                input["state"].as_str().unwrap_or_default(),
            )),
            "isAimuxProjectServiceProcess" => {
                let expected = ProjectServiceProcessIdentity {
                    project_id: input["expected"]["projectId"].as_str().map(str::to_owned),
                    project_root: input["expected"]["projectRoot"].as_str().map(str::to_owned),
                };
                let cwd = input["lsofStdout"]
                    .as_str()
                    .and_then(read_process_cwd_from_lsof_output);
                Value::Bool(is_aimux_project_service_process_args(
                    input["psStdout"].as_str().unwrap_or_default(),
                    cwd.as_deref(),
                    &expected,
                ))
            }
            _ => Value::Null,
        };
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "name": case["name"],
                "api": case["api"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} process-inspector parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn optional_string(value: Option<String>) -> Value {
    value.map(Value::String).unwrap_or(Value::Null)
}
