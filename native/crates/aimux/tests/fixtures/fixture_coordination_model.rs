use aimux::project_service::coordination_worklist::{
    build_coordination_model, build_coordination_view, build_coordination_worklist,
    is_notification_stale,
};
use serde_json::{Value, json};

const COORDINATION_MODEL: &str =
    include_str!("../../../../../testdata/contracts/v1/coordination/model.json");

#[test]
fn fixture_coordination_model_matches_typescript() {
    let contract: Value =
        serde_json::from_str(COORDINATION_MODEL).expect("valid coordination fixture");
    let cases = contract["cases"].as_array().expect("coordination cases");
    assert_eq!(cases.len(), 22, "unexpected coordination model case count");
    let mut failures = Vec::new();
    for case in cases {
        let input = &case["input"];
        let sessions = array(input, "sessions");
        let teammates = array(input, "teammates");
        let services = array(input, "services");
        let notifications = array(input, "notifications");
        let threads = array(input, "threads");
        let actual = match case["api"].as_str().unwrap_or_default() {
            "buildCoordinationModel" => {
                build_coordination_model(&sessions, &teammates, &services, &notifications, &threads)
            }
            "buildCoordinationWorklist" => {
                let model = input.get("model").cloned().unwrap_or_else(|| {
                    build_coordination_model(
                        &sessions,
                        &teammates,
                        &services,
                        &notifications,
                        &threads,
                    )
                });
                build_coordination_worklist(
                    &model,
                    &threads,
                    input["currentParticipant"].as_str().unwrap_or("user"),
                )
            }
            "buildCoordinationView" => build_coordination_view(
                &sessions,
                &teammates,
                &services,
                &notifications,
                &threads,
                input["currentParticipant"].as_str().unwrap_or("user"),
            ),
            "isNotificationStale" => Value::Bool(is_notification_stale(
                input["liveLabel"].as_str(),
                input["hasUnreadNeedsInput"].as_bool().unwrap_or(false),
            )),
            _ => Value::Null,
        };
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
        "{} coordination model parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn array(input: &Value, key: &str) -> Vec<Value> {
    input
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}
