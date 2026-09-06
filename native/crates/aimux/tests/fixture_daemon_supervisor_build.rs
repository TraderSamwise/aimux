use aimux::daemon_supervisor::StaleClientBuildError;
use aimux::project_service_manifest::{
    build_stamp_generation, is_stale_against_daemon, should_keep_unresponsive_daemon,
};
use serde_json::{Map, Value, json};

const DAEMON_SUPERVISOR_BUILD: &str =
    include_str!("../../../../testdata/contracts/v1/daemon-supervisor/build-generation.json");

#[test]
fn fixture_daemon_supervisor_build_matches_typescript() {
    let contract: Value =
        serde_json::from_str(DAEMON_SUPERVISOR_BUILD).expect("valid daemon supervisor fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("daemon supervisor cases");
    assert_eq!(cases.len(), 4, "unexpected daemon supervisor case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = daemon_supervisor_actual(case);
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
        "{} daemon-supervisor/build-generation parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn daemon_supervisor_actual(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "buildStampGenerationBatch" => Value::Array(
            case["input"]["stamps"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
                .map(|(index, stamp)| {
                    let mut output = Map::new();
                    if case["output"][index].get("stamp").is_some() {
                        output.insert("stamp".into(), stamp.clone());
                    }
                    output.insert(
                        "generation".into(),
                        json!(build_stamp_generation(Some(stamp))),
                    );
                    Value::Object(output)
                })
                .collect(),
        ),
        "isStaleAgainstDaemonBatch" => Value::Array(
            case["input"]["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|item| {
                    let mut output = Map::new();
                    if let Some(daemon_stamp) = item.get("daemonStamp") {
                        output.insert("daemonStamp".into(), daemon_stamp.clone());
                    }
                    if let Some(own_stamp) = item.get("ownStamp") {
                        output.insert("ownStamp".into(), own_stamp.clone());
                    }
                    output.insert(
                        "stale".into(),
                        json!(is_stale_against_daemon(
                            item.get("daemonStamp"),
                            item.get("ownStamp")
                        )),
                    );
                    Value::Object(output)
                })
                .collect(),
        ),
        "StaleClientBuildError" => {
            let error = StaleClientBuildError {
                daemon_build_stamp: case["input"]["daemonBuildStamp"]
                    .as_str()
                    .expect("daemon stamp")
                    .to_owned(),
                client_build_stamp: case["input"]["clientBuildStamp"]
                    .as_str()
                    .expect("client stamp")
                    .to_owned(),
            };
            json!({
                "name": "StaleClientBuildError",
                "daemonBuildStamp": error.daemon_build_stamp,
                "clientBuildStamp": error.client_build_stamp,
                "message": error.to_string(),
            })
        }
        "shouldKeepUnresponsiveDaemonBatch" => Value::Array(
            case["input"]["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|item| {
                    let adopt_existing = item["options"]["adoptExisting"].as_bool();
                    let daemon_pid_alive = item["daemonPidAlive"].as_bool().unwrap_or(false);
                    json!({
                        "options": item["options"],
                        "daemonPidAlive": daemon_pid_alive,
                        "keep": should_keep_unresponsive_daemon(adopt_existing, daemon_pid_alive),
                    })
                })
                .collect(),
        ),
        api => json!({ "error": format!("unknown daemon supervisor api: {api}") }),
    }
}
