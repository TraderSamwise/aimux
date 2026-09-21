use aimux::core_cli::{
    CoreCliAction, CoreCliContext, CoreCliOperation, CoreCliOutputMode, CoreCliPlanError,
    CoreLoopActorContext, classify_core_cli,
};
use aimux::core_cli_executor::{
    JOB_ADDRESS_CONFLICT_EXIT_CODE, JOB_CANCELLED_EXIT_CODE, JOB_DETACHED_EXIT_CODE,
    JOB_FAILED_EXIT_CODE, JOB_STREAM_LOST_EXIT_CODE,
};
use serde_json::{Value, json};

const FIXTURE: &str = include_str!("../../../../../testdata/contracts/v1/cli/jobs-command.json");

#[test]
fn fixture_cli_jobs_matches_native_contract() {
    let contract: Value = serde_json::from_str(FIXTURE).expect("valid cli/jobs fixture");
    let parsing = contract["parsing"].as_array().expect("parsing cases");
    let mut failures = Vec::new();
    for case in parsing {
        let args = case["args"]
            .as_array()
            .expect("args")
            .iter()
            .map(|value| value.as_str().expect("arg"))
            .collect::<Vec<_>>();
        let actual = classify_job_args(&args);
        if actual != case["output"] {
            failures.push(json!({
                "id": case["id"],
                "expected": case["output"],
                "actual": actual,
            }));
        }
    }
    let exit_codes = contract["exitCodes"].as_array().expect("exit codes");
    for row in exit_codes {
        let label = row[0].as_str().expect("label");
        let expected = row[1].as_i64().expect("code");
        let actual = match label {
            "cli-invalid-arguments" => CoreCliPlanError::InvalidArguments {
                args: vec!["run".to_owned()],
                message: "bad".to_owned(),
            }
            .exit_code(),
            "cli-unsupported" => CoreCliPlanError::Unsupported {
                args: vec!["unknown".to_owned()],
            }
            .exit_code(),
            "job-failed" => JOB_FAILED_EXIT_CODE,
            "job-cancelled" => JOB_CANCELLED_EXIT_CODE,
            "job-detached" => JOB_DETACHED_EXIT_CODE,
            "job-stream-lost" => JOB_STREAM_LOST_EXIT_CODE,
            "job-address-conflict" => JOB_ADDRESS_CONFLICT_EXIT_CODE,
            other => panic!("unknown exit-code label {other}"),
        };
        if i64::from(actual) != expected {
            failures.push(json!({
                "id": format!("exit-code-{label}"),
                "expected": expected,
                "actual": actual,
            }));
        }
    }
    assert!(
        failures.is_empty(),
        "{} cli/jobs parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn classify_job_args(args: &[&str]) -> Value {
    match classify_core_cli(args, &context()) {
        Ok(plan) => json!({
            "operation": operation_name(plan.operation),
            "action": action_name(&plan.action),
            "outputMode": match plan.output_mode {
                CoreCliOutputMode::Json => "json",
                CoreCliOutputMode::Text => "text",
            },
        }),
        Err(error) => {
            let message = error.to_string();
            json!({
                "errorCode": error.exit_code(),
                "errorContains": if message.contains("requires --tool") {
                    "requires --tool"
                } else {
                    message.as_str()
                },
            })
        }
    }
}

fn operation_name(operation: CoreCliOperation) -> &'static str {
    match operation {
        CoreCliOperation::JobRun => "job-run",
        CoreCliOperation::JobShow => "job-show",
        CoreCliOperation::JobList => "job-list",
        CoreCliOperation::JobTail => "job-tail",
        CoreCliOperation::JobWait => "job-wait",
        CoreCliOperation::JobCancel => "job-cancel",
        CoreCliOperation::JobNotify => "job-notify",
        CoreCliOperation::JobTmuxAttach => "job-tmux-attach",
        _ => "other",
    }
}

fn action_name(action: &CoreCliAction) -> &'static str {
    match action {
        CoreCliAction::JobRun { .. } => "run",
        CoreCliAction::JobEventStream { .. } => "event-stream",
        CoreCliAction::JobTmuxAttach { .. } => "tmux-attach",
        CoreCliAction::TextRoute { .. } => "text-route",
        _ => "other",
    }
}

fn context() -> CoreCliContext {
    CoreCliContext {
        current_working_dir: "/repo".to_owned(),
        current_project_root: "/repo".to_owned(),
        daemon_running: true,
        has_credentials: false,
        loop_actor: CoreLoopActorContext::default(),
    }
}
