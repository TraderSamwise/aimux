use aimux::multiplexer_notifications::run_multiplexer_notifications_contract_case;
use serde::Deserialize;
use serde_json::Value;

const MULTIPLEXER_NOTIFICATIONS: &str =
    include_str!("../../../../testdata/contracts/v1/multiplexer/notifications.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    source: String,
    subject: String,
    case_count: usize,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    source: String,
    api: String,
    input: Value,
    output: Value,
}

#[test]
fn fixture_multiplexer_notifications_contract_is_captured() {
    let contract: Contract = serde_json::from_str(MULTIPLEXER_NOTIFICATIONS)
        .expect("multiplexer notifications fixture parses");
    assert_eq!(contract.source, "src/multiplexer/notifications.test.ts");
    assert_eq!(contract.subject, "multiplexer notification host helpers");
    assert_eq!(contract.case_count, 5);
    assert_eq!(contract.cases.len(), contract.case_count);

    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, contract.source);
        assert!(matches!(
            case.api.as_str(),
            "applyCoordinationModel"
                | "applyCoordinationFilter"
                | "notificationTargetLabel+notificationTargetState"
                | "notificationMutationInputForItem"
        ));
        let actual = run_multiplexer_notifications_contract_case(&case.api, &case.input);
        assert_eq!(
            actual, case.output,
            "multiplexer notifications parity failure for {}",
            case.id
        );
    }
}
