#![cfg(unix)]

mod support;

use aimux::daemon_state::{
    MetadataState, metadata_state_path, save_metadata_state, try_load_metadata_state,
};
use aimux::project_api_contract::routes;
use aimux::project_service::agent_output::{
    AgentOutputCaptureRuntime, BoundedAgentOutputCaptureRuntime, SystemAgentOutputCaptureRuntime,
    route_agent_output_request, route_agent_output_request_async,
    route_agent_output_request_with_runtime,
};
use aimux::project_service::attachments::get_attachment_record;
use aimux::project_service::prompt_context::set_prompt_context;
use aimux::project_service::router::ProjectServiceRequestContext;
use aimux::runtime_topology::{coerce_runtime_topology, runtime_topology_path};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use support::TestIsolation;

const CHILD_CASE: &str = "AIMUX_DELIVERY_SEAM_CASE";
const ARTIFACT: &str = "AIMUX_DELIVERY_SEAM_ARTIFACT";
const TEST_NAME: &str = "production_delivery_executors_preserve_payload_and_failures";

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
struct Observation {
    case: String,
    steps: Vec<String>,
    loaded: Option<String>,
    file_existed_at_paste: Option<bool>,
    succeeded: bool,
    delivery: Option<Value>,
}

struct ParentArtifacts(PathBuf);

impl Drop for ParentArtifacts {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0)
            && error.kind() != std::io::ErrorKind::NotFound
        {
            let cause = format!(
                "delivery artifact cleanup {} failed: {error}",
                self.0.display()
            );
            if thread::panicking() {
                eprintln!("{cause}");
            } else {
                panic!("{cause}");
            }
        }
    }
}

#[test]
fn production_delivery_executors_preserve_payload_and_failures() {
    if let Some(case) = std::env::var_os(CHILD_CASE) {
        run_child(case.to_str().expect("child case is UTF-8"));
        return;
    }
    let root = ParentArtifacts(std::env::temp_dir().join(format!(
        "aimux-delivery-seams-parent-{}",
        std::process::id()
    )));
    fs::create_dir(&root.0).expect("create parent artifact directory");
    let mut observations = BTreeMap::new();
    for executor in ["system", "bounded"] {
        for outcome in ["ok", "load-fail", "paste-fail"] {
            let case = format!("direct:{executor}:{outcome}");
            observations.insert(case.clone(), run_isolated_child(&root.0, &case));
        }
    }
    for executor in ["system", "bounded", "async"] {
        for route in ["agents", "pane"] {
            for outcome in ["ok", "load-fail", "paste-fail"] {
                let case = format!("route:{executor}:{outcome}:{route}");
                observations.insert(case.clone(), run_isolated_child(&root.0, &case));
            }
        }
    }
    for outcome in ["expired", "cancelled", "cancel-after-load", "deadline-load"] {
        let case = format!("direct:bounded:{outcome}");
        observations.insert(case.clone(), run_isolated_child(&root.0, &case));
    }
    for route in ["agents", "pane"] {
        let case = format!("route:async:deadline-load:{route}");
        observations.insert(case.clone(), run_isolated_child(&root.0, &case));
    }
    assert_eq!(observations.len(), 30, "every scenario must execute");
    assert_observations_match(
        &observations["route:async:deadline-load:agents"],
        &observations["route:async:deadline-load:pane"],
    );
    for outcome in ["ok", "load-fail", "paste-fail"] {
        assert_observations_match(
            &observations[&format!("direct:system:{outcome}")],
            &observations[&format!("direct:bounded:{outcome}")],
        );
        let expected = &observations[&format!("route:system:{outcome}:agents")];
        for executor in ["system", "bounded", "async"] {
            for route in ["agents", "pane"] {
                assert_observations_match(
                    expected,
                    &observations[&format!("route:{executor}:{outcome}:{route}")],
                );
            }
        }
    }
}

#[test]
fn production_submit_verification_distinguishes_three_outcomes_across_routes() {
    if let Some(case) = std::env::var_os(CHILD_CASE) {
        run_child(case.to_str().expect("selected composer case"));
        return;
    }
    let root = ParentArtifacts(std::env::temp_dir().join(format!(
        "aimux-submit-verification-parent-{}",
        std::process::id()
    )));
    fs::create_dir(&root.0).expect("create submit artifact directory");
    let mut observations = BTreeMap::new();
    for outcome in [
        "verified",
        "head-loss",
        "two-markers",
        "unreadable",
        "stuck",
        "capture-fail",
    ] {
        for executor in ["system", "bounded", "async"] {
            for route in ["agents", "pane"] {
                let case = format!("composer:{executor}:{outcome}:{route}");
                observations.insert(case.clone(), run_isolated_child(&root.0, &case));
            }
        }
        let expected = &observations[&format!("composer:system:{outcome}:agents")];
        for executor in ["system", "bounded", "async"] {
            for route in ["agents", "pane"] {
                assert_observations_match(
                    expected,
                    &observations[&format!("composer:{executor}:{outcome}:{route}")],
                );
            }
        }
    }
    assert_eq!(observations.len(), 36, "all concrete submit cases execute");
}

#[test]
fn production_routes_preserve_receipt_errors_before_and_after_irreversible_input() {
    if let Some(case) = std::env::var_os(CHILD_CASE) {
        run_child(case.to_str().expect("selected receipt case"));
        return;
    }
    let root = ParentArtifacts(std::env::temp_dir().join(format!(
        "aimux-receipt-errors-parent-{}",
        std::process::id()
    )));
    fs::create_dir(&root.0).expect("receipt-error artifacts");
    let mut completed = 0;
    for executor in ["system", "async"] {
        for route in ["agents", "pane"] {
            for outcome in ["receipt-before", "receipt-after", "receipt-after-missing"] {
                run_isolated_child(&root.0, &format!("receipt:{executor}:{outcome}:{route}"));
                completed += 1;
            }
        }
    }
    assert_eq!(completed, 12);
}

fn assert_observations_match(left: &Observation, right: &Observation) {
    assert_eq!(left.steps, right.steps, "{} vs {}", left.case, right.case);
    assert_eq!(left.loaded, right.loaded, "{} vs {}", left.case, right.case);
    assert_eq!(
        left.file_existed_at_paste, right.file_existed_at_paste,
        "{} vs {}",
        left.case, right.case
    );
    assert_eq!(
        left.succeeded, right.succeeded,
        "{} vs {}",
        left.case, right.case
    );
    assert_eq!(
        left.delivery, right.delivery,
        "{} vs {}",
        left.case, right.case
    );
}

fn run_isolated_child(root: &Path, case: &str) -> Observation {
    let label = case.replace(':', "-");
    let artifact = root.join(format!("{label}.json"));
    let stdout_path = root.join(format!("{label}.stdout"));
    let stderr_path = root.join(format!("{label}.stderr"));
    let mut child = Command::new(std::env::current_exe().expect("current integration test"))
        .args(["--exact", TEST_NAME, "--nocapture", "--test-threads=1"])
        .env(CHILD_CASE, case)
        .env(ARTIFACT, &artifact)
        .stdout(Stdio::from(
            fs::File::create(&stdout_path).expect("child stdout"),
        ))
        .stderr(Stdio::from(
            fs::File::create(&stderr_path).expect("child stderr"),
        ))
        .spawn()
        .expect("spawn concrete delivery test child");
    let deadline = Instant::now() + Duration::from_secs(40);
    let (status, timed_out) = loop {
        if let Some(status) = child.try_wait().expect("poll delivery test child") {
            break (status, false);
        }
        if Instant::now() >= deadline {
            child.kill().expect("kill timed-out delivery test child");
            break (
                child.wait().expect("reap timed-out delivery test child"),
                true,
            );
        }
        thread::sleep(Duration::from_millis(20));
    };
    let stdout = fs::read_to_string(stdout_path).expect("read complete child stdout");
    let stderr = fs::read_to_string(stderr_path).expect("read complete child stderr");
    assert!(
        !timed_out && status.success(),
        "delivery child {case}: status={status}, timed_out={timed_out}\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    let raw = fs::read_to_string(&artifact).unwrap_or_else(|error| {
        panic!(
            "delivery child {case} executed no completed scenario: {error}\nstdout:\n{stdout}\nstderr:\n{stderr}"
        )
    });
    let observation: Observation = serde_json::from_str(&raw).expect("child observation JSON");
    assert_eq!(observation.case, case, "the selected scenario must execute");
    assert!(
        !observation.steps.is_empty() || case.starts_with("receipt:"),
        "the production executor must run"
    );
    observation
}

fn run_child(case: &str) {
    let parts = case.split(':').collect::<Vec<_>>();
    assert!(parts.len() == 3 || parts.len() == 4, "unknown case {case}");
    let (kind, executor, outcome) = (parts[0], parts[1], parts[2]);
    let isolation = TestIsolation::new("delivery-seams");
    let recorder = isolation.root().join("recorder");
    fs::create_dir(&recorder).expect("create private recorder");
    let binary = recorder.join("tmux-recorder");
    fs::write(&binary, SHIM).expect("write concrete-command recorder");
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).expect("executable recorder");
    // SAFETY: This is an isolated child running exactly one selected test, before runtime startup.
    unsafe {
        std::env::set_var("AIMUX_TMUX_BIN", &binary);
        std::env::set_var("AIMUX_DELIVERY_TEST_DIR", &recorder);
        std::env::set_var("AIMUX_DELIVERY_TEST_OUTCOME", outcome);
    }
    aimux::async_runtime::init_process_runtime().expect("child process runtime");
    if kind == "receipt" {
        run_receipt_failure_child(case, &isolation, &recorder, executor, outcome, parts[3]);
        return;
    }
    let cancelled = Arc::new(AtomicBool::new(outcome == "cancelled"));
    let deadline = if outcome == "expired" {
        Instant::now() - Duration::from_secs(1)
    } else if outcome == "deadline-load" {
        Instant::now() + Duration::from_secs(2)
    } else {
        Instant::now() + Duration::from_secs(20)
    };
    let mut bounded = BoundedAgentOutputCaptureRuntime::new(deadline, Arc::clone(&cancelled));
    let cancellation = (outcome == "cancel-after-load").then(|| {
        let recorder = recorder.clone();
        thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !recorder.join("load-ready").exists() {
                assert!(
                    Instant::now() < deadline,
                    "concrete load never reached cancellation seam"
                );
                thread::sleep(Duration::from_millis(5));
            }
            cancelled.store(true, Ordering::SeqCst);
            fs::write(recorder.join("release-load"), b"release").expect("release loaded command");
        })
    });
    let project = isolation.root().join("project");
    let mut delivery = None;
    let success_expected = matches!(
        outcome,
        "ok" | "verified" | "head-loss" | "two-markers" | "unreadable"
    );
    let (expected, result) = match kind {
        "direct" => {
            let prompt = numbered_prompt();
            assert!(prompt.len() > 4_000, "exercise the old chunk boundary");
            let result = match executor {
                "system" => SystemAgentOutputCaptureRuntime.paste_text("@1", &prompt),
                "bounded" => bounded.paste_text("@1", &prompt),
                _ => panic!("unknown direct executor {executor}"),
            };
            (prompt, result)
        }
        "route" | "composer" => {
            let (tool, text) = if kind == "composer" {
                ("codex", multipart_prompt())
            } else {
                ("shell", numbered_prompt())
            };
            let (context, body, expected) = route_fixture(&project, tool, text);
            let route = match parts[3] {
                "agents" => routes::agents::INPUT,
                "pane" => routes::live_pane::INPUT,
                _ => panic!("unknown route in {case}"),
            };
            let response = match executor {
                "system" => route_agent_output_request(&context, "POST", route, Some(&body)),
                "bounded" => route_agent_output_request_with_runtime(
                    &context,
                    "POST",
                    route,
                    Some(&body),
                    &mut bounded,
                ),
                "async" => {
                    let irreversible = AtomicBool::new(false);
                    let response = {
                        // aimux-async-seam: test - drives the production async input route and concrete subprocess paste.
                        aimux::async_runtime::block_on_named("test:delivery-seam-route", async {
                            route_agent_output_request_async(
                                &context,
                                "POST",
                                route,
                                Some(&body),
                                Some(&irreversible),
                            )
                            .await
                        })
                    };
                    assert!(
                        irreversible.load(Ordering::SeqCst),
                        "actual async route reached delivery"
                    );
                    response
                }
                _ => panic!("unknown route executor {executor}"),
            }
            .expect("production input route handled request");
            let receipt = &response.body["delivery"];
            if !success_expected {
                assert_eq!(
                    response.body["error"], receipt["notice"],
                    "{case}: HTTP failure wrappers must retain inspect-before-retry advice"
                );
            }
            assert_eq!(
                receipt["verified"],
                outcome == "verified",
                "{case}: actual submission evidence"
            );
            assert_eq!(
                receipt["state"],
                if success_expected {
                    "delivered"
                } else {
                    "failed"
                }
            );
            if success_expected && outcome != "verified" {
                assert!(
                    receipt["notice"]
                        .as_str()
                        .expect("unverified submission is visible")
                        .contains("Ready does not confirm an answer")
                );
            }
            let metadata = try_load_metadata_state(context.project_state_dir())
                .expect("receipt metadata readable");
            assert_eq!(
                metadata.sessions["shell-1"]["inputDelivery"], *receipt,
                "{case}: callers and later lane reads share the receipt"
            );
            let notice = receipt.get("notice").and_then(Value::as_str).map(|notice| {
                if !success_expected {
                    let cause = receipt["error"].as_str().expect("original child cause");
                    assert!(
                        notice.contains(cause),
                        "{case}: notice preserves child cause"
                    );
                    assert!(notice.contains("Inspect the terminal before retrying"));
                    notice.replace(cause, "<original child cause>")
                } else {
                    notice.to_owned()
                }
            });
            delivery = Some(
                json!({"state":receipt["state"], "verified":receipt["verified"], "notice":notice, "displayLabel":receipt["displayLabel"]}),
            );
            let result = if success_expected {
                assert_eq!(response.status, 200, "{}", response.body);
                assert_eq!(response.body["accepted"], true);
                Ok(())
            } else {
                assert_eq!(response.status, 500, "{}", response.body);
                assert_ne!(response.body["accepted"], true);
                Err(response.body["error"]
                    .as_str()
                    .expect("route reports delivery error")
                    .to_owned())
            };
            (expected, result)
        }
        _ => panic!("unknown delivery kind {kind}"),
    };
    if let Some(cancellation) = cancellation {
        cancellation.join().expect("cancellation seam completed");
    }
    let succeeded = result.is_ok();
    if success_expected {
        result.expect("production paste succeeded");
    } else {
        let error = result.expect_err("a failed concrete paste must never become success");
        let cause = match outcome {
            "load-fail" => "injected load-buffer child failure",
            "paste-fail" => "injected paste-buffer child failure",
            "expired" => "timed out",
            "cancelled" | "cancel-after-load" => "cancelled",
            "deadline-load" => "timed out",
            "stuck" => "remained visible",
            "capture-fail" => "injected capture-pane child failure",
            _ => panic!("unknown outcome {outcome}"),
        };
        assert!(
            error.contains(cause),
            "original child cause {cause:?} lost: {error}"
        );
    }
    let steps = fs::read_to_string(recorder.join("steps"))
        .expect("real command executor recorded steps")
        .lines()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let delivery_steps = steps
        .iter()
        .filter(|step| step.as_str() != "capture-pane")
        .cloned()
        .collect::<Vec<_>>();
    let expected_steps: &[&str] = match outcome {
        "verified" | "head-loss" | "two-markers" | "unreadable" | "stuck" | "capture-fail" => {
            &["load-buffer", "set-option", "send-keys"]
        }
        "ok" if kind == "route" => &["load-buffer", "paste-buffer", "send-keys"],
        "ok" => &["load-buffer", "paste-buffer"],
        "load-fail" | "cancel-after-load" | "deadline-load" => &["load-buffer", "delete-buffer"],
        "paste-fail" => &["load-buffer", "paste-buffer", "delete-buffer"],
        "expired" | "cancelled" => &["delete-buffer"],
        _ => panic!("unknown outcome {outcome}"),
    };
    let expected_steps = expected_steps
        .iter()
        .map(|step| {
            if kind == "route" && *step == "paste-buffer" {
                "if-shell"
            } else {
                *step
            }
        })
        .collect::<Vec<_>>();
    assert_eq!(
        delivery_steps, expected_steps,
        "{case}: no carriage return after failure"
    );
    assert!(
        !recorder.join("buffer-bytes").exists(),
        "named prompt buffer must be removed"
    );
    let loaded = if matches!(outcome, "expired" | "cancelled") {
        assert!(
            !recorder.join("loaded").exists(),
            "spent budget must not load prompt"
        );
        None
    } else {
        let loaded = fs::read(recorder.join("loaded")).expect("concrete load read staging file");
        assert_eq!(
            loaded,
            expected.as_bytes(),
            "{case}: whole prompt bytes must survive"
        );
        let staged =
            fs::read_to_string(recorder.join("staged-path")).expect("observed staging path");
        assert!(
            !Path::new(&staged).exists(),
            "staged user prompt must be removed"
        );
        Some(
            String::from_utf8(loaded)
                .expect("prompt UTF-8")
                .replace(project.to_str().expect("project UTF-8"), "<project>"),
        )
    };
    let file_existed_at_paste = if matches!(
        outcome,
        "ok" | "paste-fail"
            | "verified"
            | "head-loss"
            | "two-markers"
            | "unreadable"
            | "stuck"
            | "capture-fail"
    ) {
        let observation = fs::read_to_string(recorder.join("file-existed-at-paste"))
            .expect("concrete paste observed staging file lifetime");
        assert_eq!(
            observation, "false",
            "{case}: prompt file must be gone before paste"
        );
        Some(false)
    } else {
        assert!(
            !recorder.join("file-existed-at-paste").exists(),
            "no paste after failed load"
        );
        None
    };
    let observation = Observation {
        case: case.to_owned(),
        steps,
        loaded,
        file_existed_at_paste,
        succeeded,
        delivery,
    };
    fs::write(
        std::env::var_os(ARTIFACT).expect("parent artifact path"),
        serde_json::to_vec(&observation).expect("serialize completed observation"),
    )
    .expect("publish completed child scenario");
    eprintln!("completed concrete delivery scenario {case}");
}

fn run_receipt_failure_child(
    case: &str,
    isolation: &TestIsolation,
    recorder: &Path,
    executor: &str,
    outcome: &str,
    route: &str,
) {
    let (context, body, expected) = route_fixture(
        &isolation.root().join("project"),
        "codex",
        multipart_prompt(),
    );
    let path = metadata_state_path(context.project_state_dir());
    if outcome == "receipt-before" {
        fs::write(&path, "corrupt receipt metadata").expect("inject before-send parse error");
    }
    // SAFETY: One isolated selected test owns this process and recorder.
    unsafe {
        std::env::set_var("AIMUX_DELIVERY_TEST_METADATA_PATH", &path);
    }
    let endpoint = if route == "agents" {
        routes::agents::INPUT
    } else {
        routes::live_pane::INPUT
    };
    let irreversible = AtomicBool::new(false);
    let response = match executor {
        "system" => route_agent_output_request(&context, "POST", endpoint, Some(&body)),
        "async" => {
            // aimux-async-seam: test - injects actual input route receipt storage failures.
            aimux::async_runtime::block_on_named("test:receipt-storage-route", async {
                route_agent_output_request_async(
                    &context,
                    "POST",
                    endpoint,
                    Some(&body),
                    Some(&irreversible),
                )
                .await
            })
        }
        _ => panic!("unknown receipt executor"),
    }
    .expect("actual input route");
    let steps = match fs::read_to_string(recorder.join("steps")) {
        Ok(steps) => steps.lines().map(str::to_owned).collect::<Vec<_>>(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => panic!("read command observations: {error}"),
    };
    let after_send = outcome != "receipt-before";
    let loaded = if after_send {
        assert_eq!(response.status, 200, "{}", response.body);
        assert_eq!(response.body["accepted"], true);
        assert_eq!(response.body["delivery"]["verified"], true);
        assert_eq!(response.body["delivery"]["state"], "delivered");
        let storage_cause = if outcome == "receipt-after-missing" {
            "reserved input delivery receipt is missing"
        } else {
            "parse metadata state"
        };
        assert!(
            response.body["delivery"]["receiptError"]
                .as_str()
                .unwrap()
                .contains(storage_cause)
        );
        let notice = response.body["delivery"]["notice"].as_str().unwrap();
        assert!(
            notice.contains("could not be saved")
                && notice.contains("Inspect the terminal before retrying")
        );
        assert_eq!(
            steps
                .iter()
                .filter(|step| step.as_str() == "send-keys")
                .count(),
            1
        );
        assert_eq!(
            fs::read_to_string(recorder.join("loaded")).unwrap(),
            expected
        );
        assert_eq!(
            fs::read_to_string(recorder.join("file-existed-at-paste")).unwrap(),
            "false"
        );
        assert!(!recorder.join("buffer-bytes").exists());
        assert!(!recorder.join("open-frame").exists());
        let staged = fs::read_to_string(recorder.join("staged-path")).unwrap();
        assert!(
            !Path::new(&staged).exists(),
            "receipt path leaked staged body"
        );
        Some(expected)
    } else {
        assert_eq!(response.status, 500, "{}", response.body);
        assert!(
            response.body["error"]
                .as_str()
                .unwrap()
                .contains("parse metadata state")
        );
        assert_ne!(response.body["accepted"], true);
        assert!(
            steps.is_empty(),
            "receipt reservation must fail before paste or Enter"
        );
        None
    };
    if executor == "async" {
        assert_eq!(irreversible.load(Ordering::SeqCst), after_send);
    }
    if outcome == "receipt-after-missing" {
        assert!(
            !path.exists(),
            "completion cannot invent a missing reservation"
        );
    } else {
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "corrupt receipt metadata",
            "failed reads must not replace corruption with absence"
        );
    }
    let observation = Observation {
        case: case.to_owned(),
        steps,
        loaded,
        file_existed_at_paste: after_send.then_some(false),
        succeeded: after_send,
        delivery: response.body.get("delivery").cloned(),
    };
    fs::write(
        std::env::var_os(ARTIFACT).expect("artifact path"),
        serde_json::to_vec(&observation).unwrap(),
    )
    .expect("completed receipt scenario");
}

fn numbered_prompt() -> String {
    (1..=80).map(|index| format!(
        "{index}. Preserve this entire café λ message, including its literal newline and trailing item {index}."
    )).collect::<Vec<_>>().join("\n")
}

fn multipart_prompt() -> String {
    let first = "Important original head instructions must survive completely. ";
    let second = "Second pasted block includes an independent final instruction. ";
    format!(
        "{}{}{}{}",
        first,
        "a".repeat(4577 - first.len()),
        second,
        "z".repeat(3941 - second.len())
    )
}

fn route_fixture(
    project: &Path,
    tool: &str,
    text: String,
) -> (ProjectServiceRequestContext, Value, String) {
    let state = project.join("state");
    fs::create_dir_all(&state).expect("route project state");
    let timestamp = "2026-10-18T00:00:00.000Z";
    let topology = coerce_runtime_topology(&json!({
        "version": 1, "generatedAt": timestamp,
        "rigs": [{"id":"rig", "name":"aimux-test", "projectRoot":project, "createdAt":timestamp, "updatedAt":timestamp}],
        "nodes": [{"id":"node", "rigId":"rig", "logicalId":"shell-1", "toolConfigKey":tool, "createdAt":timestamp}],
        "bindings": [{"id":"binding", "nodeId":"node", "tmuxSession":"aimux-test", "tmuxWindowId":"@1", "tmuxWindowIndex":1, "updatedAt":timestamp}],
        "sessions": [{"id":"shell-1", "nodeId":"node", "status":"running", "command":tool, "createdAt":timestamp, "updatedAt":timestamp}]
    })).expect("valid live shell topology");
    fs::write(
        runtime_topology_path(&state),
        serde_yaml::to_string(&topology).expect("topology YAML"),
    )
    .expect("write route topology");
    save_metadata_state(
        &state,
        &MetadataState {
            version: 1,
            sessions: BTreeMap::new(),
        },
    )
    .expect("write route metadata");
    set_prompt_context(&state, "shell-1", "page=/delivery\nmode=review")
        .expect("real prompt context");
    let attachments = project.join(".aimux/attachments");
    fs::create_dir_all(&attachments).expect("attachment store");
    let content = attachments.join("att_notes.md");
    fs::write(&content, b"note").expect("attachment content");
    fs::write(attachments.join("att_notes.json"), serde_json::to_vec(&json!({
        "id":"att_notes", "sessionId":"shell-1", "filename":"notes.md", "mimeType":"text/markdown", "sizeBytes":4, "contentPath":content
    })).expect("attachment JSON")).expect("attachment record");
    let attachment = get_attachment_record(project, "att_notes", Some("shell-1"))
        .expect("real attachment getter accepts this session-bound fixture");
    assert_eq!(
        attachment["contentPath"],
        content.to_str().expect("attachment path UTF-8")
    );
    let body = json!({
        "sessionId":"shell-1", "text":text, "force":true, "attachmentIds":["att_notes"],
        "sharedChatActor":{"role":"owner", "displayName":"Sam Reviewer"}
    });
    let expected = format!(
        "[aimux context] page=/delivery mode=review [/aimux context] [Sam Reviewer] {}\n\nAttached files:\n- notes.md (text/markdown, 4 bytes): {}",
        text,
        content.display()
    );
    (
        ProjectServiceRequestContext::with_project_state_dir(project, &state),
        body,
        expected,
    )
}

const SHIM: &str = r##"#!/bin/sh
set -eu
fail() { printf '%s\n' "recorder rejected command: $*" >&2; exit 97; }
dir=${AIMUX_DELIVERY_TEST_DIR:?}
outcome=${AIMUX_DELIVERY_TEST_OUTCOME:?}
record_paste() {
  staged=$(/bin/cat "$dir/staged-path")
  if [ -e "$staged" ]; then printf '%s' true; else printf '%s' false; fi > "$dir/file-existed-at-paste"
  [ -f "$dir/buffer-bytes" ] || fail "paste without loaded buffer"
  if [ "$outcome" = paste-fail ]; then printf '%s\n' 'injected paste-buffer child failure' >&2; exit 74; fi
  /bin/rm "$dir/buffer-bytes"
}
[ "$#" -ge 3 ] || fail "missing private socket"
[ "$1" = -S ] && [ "$2" = "${AIMUX_TMUX_SOCKET_PATH:?}" ] || fail "foreign socket"
[ "$2" = "${dir%/recorder}/tmux.sock" ] || fail "socket outside owned isolation"
shift 2
printf '%s\n' "$1" >> "$dir/steps"
case "$1" in
load-buffer)
  [ "$#" -eq 4 ] && [ "$2" = -b ] || fail "load argv"
  case "$3" in aimux-prompt-*) ;; *) fail "unmanaged buffer" ;; esac
  [ -f "$4" ] || fail "missing staging file"
  printf '%s' "$3" > "$dir/buffer-name"
  printf '%s' "$4" > "$dir/staged-path"
  /bin/cp "$4" "$dir/loaded"
  /bin/cp "$4" "$dir/buffer-bytes"
  case "$outcome" in
    load-fail) printf '%s\n' 'injected load-buffer child failure' >&2; exit 73 ;;
    deadline-load) exec /bin/sleep 20 ;;
    cancel-after-load)
      printf '%s' ready > "$dir/load-ready"
      while [ ! -f "$dir/release-load" ]; do /bin/sleep 0.01; done
      ;;
  esac
  ;;
set-option)
  [ "$#" -eq 46 ] || fail "framed command count"
  token=$6
  case "$token" in aimux-prompt-*) ;; *) fail "foreign frame token" ;; esac
  buffer=$(/bin/cat "$dir/buffer-name")
  expected="set-option -p -t @1 @aimux-input-paste-frame $token ; send-keys -t @1 -H 1b 5b 32 30 30 7e ; paste-buffer -d -r -b $buffer -t @1 ; send-keys -t @1 -H 1b 5b 32 30 31 7e ; set-option -pu -t @1 @aimux-input-paste-frame ; display-message -p AIMUX_FRAMED_PASTE_OK"
  [ "$*" = "$expected" ] || fail "framed group argv"
  printf '%s' "$token" > "$dir/open-frame"
  record_paste
  /bin/rm "$dir/open-frame"
  printf 'AIMUX_FRAMED_PASTE_OK\n'
  ;;
paste-buffer|if-shell)
  if [ "$1" = if-shell ]; then
    case "$5" in
      '#{==:#{@aimux-input-paste-frame},aimux-prompt-'*)
        [ "$#" -eq 6 ] && [ "$2" = -F ] && [ "$3" = -t ] && [ "$4" = @1 ] || fail "frame cleanup argv"
        [ "$6" = "'send-keys' '-t' '@1' '-H' '1b' '5b' '32' '30' '31' '7e'; 'set-option' '-pu' '-t' '@1' '@aimux-input-paste-frame'" ] || fail "frame cleanup command"
        if [ -f "$dir/open-frame" ]; then
          token=$(/bin/cat "$dir/open-frame")
          if [ "$5" = "#{==:#{@aimux-input-paste-frame},$token}" ]; then /bin/rm "$dir/open-frame"; fi
        fi
        exit 0
        ;;
    esac
    [ "$#" -eq 7 ] && [ "$2" = -F ] && [ "$3" = -t ] && [ "$4" = @1 ] && [ "$5" = '#{==:#{bracket_paste_flag},1}' ] || fail "atomic paste guard argv"
    buffer=$(/bin/cat "$dir/buffer-name")
    [ "$6" = "'paste-buffer' '-d' '-p' '-r' '-b' '$buffer' '-t' '@1'; display-message -p AIMUX_GUARDED_PASTE_OK" ] || fail "guarded paste command"
    [ "$7" = "'if-shell' '-F' '-t' '@1' '#{==:#{bracket_paste_flag},0}' 'display-message -p AIMUX_GUARDED_PASTE_REFUSED' 'display-message -p AIMUX_GUARDED_PASTE_UNAVAILABLE'" ] || fail "guard refusal or unavailable marker"
  else
  [ "$#" -eq 8 ] && [ "$2" = -d ] && [ "$3" = -p ] && [ "$4" = -r ] && [ "$5" = -b ] && [ "$7" = -t ] && [ "$8" = @1 ] || fail "paste argv"
  [ "$6" = "$(/bin/cat "$dir/buffer-name")" ] || fail "wrong paste buffer"
  fi
  record_paste
  if [ "$1" = if-shell ]; then printf 'AIMUX_GUARDED_PASTE_OK\n'; fi
  ;;
delete-buffer)
  [ "$#" -eq 3 ] && [ "$2" = -b ] || fail "cleanup argv"
  case "$3" in aimux-prompt-*) ;; *) fail "foreign cleanup buffer" ;; esac
  if [ -f "$dir/buffer-name" ]; then [ "$3" = "$(/bin/cat "$dir/buffer-name")" ] || fail "wrong cleanup buffer"; fi
  /bin/rm -f "$dir/buffer-bytes"
  ;;
send-keys)
  [ "$#" -eq 5 ] && [ "$2" = -t ] && [ "$3" = @1 ] && [ "$4" = -H ] && [ "$5" = 0d ] || fail "submit argv"
  printf '%s' submitted > "$dir/submitted"
  if [ "$outcome" = receipt-after ]; then printf '%s' 'corrupt receipt metadata' > "${AIMUX_DELIVERY_TEST_METADATA_PATH:?}"; fi
  if [ "$outcome" = receipt-after-missing ]; then /bin/rm "${AIMUX_DELIVERY_TEST_METADATA_PATH:?}"; fi
  ;;
capture-pane)
  [ "$#" -eq 7 ] && [ "$2" = -p ] && [ "$3" = -J ] && [ "$4" = -t ] && [ "$5" = @1 ] && [ "$6" = -S ] || fail "capture argv"
  case "$7" in -60|-20) ;; *) fail "capture range" ;; esac
  if [ ! -f "$dir/loaded" ]; then printf '> \n'; exit 0; fi
  if [ -f "$dir/submitted" ]; then
    case "$outcome" in
      stuck) printf '> '; /bin/cat "$dir/loaded"; printf '\n' ;;
      two-markers) printf '> [Pasted Content 4577 chars][Pasted Content 3941 chars]\n' ;;
      unreadable) printf 'Custom opaque TUI\n' ;;
      capture-fail) printf '%s\n' 'injected capture-pane child failure' >&2; exit 75 ;;
      *) printf '> \n' ;;
    esac
  else
    # This artificial complete-display peer is not a provider TUI.
    # Only its rendered whitespace folds; loaded transport bytes remain literal.
    case "$outcome" in
      verified|receipt-after|receipt-after-missing) printf '> '; /usr/bin/tr '\n' ' ' < "$dir/loaded"; printf '\n' ;;
      head-loss) printf '> '; /usr/bin/tail -c 200 "$dir/loaded"; printf '\n' ;;
      two-markers) printf '> [Pasted Content 4577 chars][Pasted Content 3941 chars]\n' ;;
      unreadable) printf 'Custom opaque TUI\n' ;;
      *) printf '> '; /bin/cat "$dir/loaded"; printf '\n' ;;
    esac
  fi
  ;;
*) fail "unexpected command $1" ;;
esac
"##;
