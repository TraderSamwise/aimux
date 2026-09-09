use aimux::service_notify_contract::{
    run_local_ui_server_contract_case, run_notify_alert_contract_case,
};
use serde::Deserialize;
use serde_json::Value;

const LOCAL_UI: &str =
    include_str!("../../../../testdata/contracts/v1/service/local-ui-server.json");
const NOTIFY_ALERT: &str =
    include_str!("../../../../testdata/contracts/v1/notifications/notify-alert.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    name: String,
    input: Value,
    output: Value,
}

#[test]
fn local_ui_server_contract_matches_typescript() {
    let contract: Contract = serde_json::from_str(LOCAL_UI).expect("local ui fixture parses");
    assert_eq!(contract.cases.len(), 6);
    assert_contract(
        contract,
        run_local_ui_server_contract_case,
        "local ui server",
    );
}

#[test]
fn notify_alert_contract_matches_typescript() {
    let contract: Contract =
        serde_json::from_str(NOTIFY_ALERT).expect("notify alert fixture parses");
    assert_eq!(contract.cases.len(), 9);
    assert_contract(contract, run_notify_alert_contract_case, "notify alert");
}

#[test]
fn notify_alert_adds_chat_deep_link_to_real_notification_records() {
    let input = serde_json::json!({
        "event": {
            "type": "alert",
            "kind": "needs_input",
            "sessionId": "codex-u1iogs",
            "title": "claude-1 needs input",
            "message": "waiting for input",
            "ts": "2026-06-06T00:00:00.000Z",
            "projectRoot": "/Users/sam/cs/aimux",
            "notificationId": "notice 1"
        }
    });

    let output = run_notify_alert_contract_case(&input);

    assert_eq!(output["returnValue"], true);
    assert_eq!(
        output["desktopCalls"][0],
        serde_json::json!({
            "title": "claude-1 needs input",
            "message": "waiting for input",
            "sound": true,
            "deepLinkUrl": "aimux:///agent/codex-u1iogs/chat?project=%2FUsers%2Fsam%2Fcs%2Faimux&notificationId=notice+1&focusToken=notice+1"
        })
    );
}

fn assert_contract(contract: Contract, run: fn(&Value) -> Value, label: &str) {
    let mut failures = Vec::new();
    for case in contract.cases {
        let actual = run(&case.input);
        if actual != case.output {
            failures.push(format!(
                "{} ({})\nexpected: {}\nactual:   {}",
                case.id, case.name, case.output, actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{label} parity failures:\n{}",
        failures.join("\n\n")
    );
}
