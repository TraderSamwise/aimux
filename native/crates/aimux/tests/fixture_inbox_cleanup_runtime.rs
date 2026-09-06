use serde::Deserialize;

const INBOX_CLEANUP_RUNTIME: &str =
    include_str!("../../../../testdata/contracts/v1/notifications/inbox-cleanup-runtime.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    api: String,
}

#[test]
#[ignore = "checklist: persistenceMethods.cleanupInbox dashboard refresh side effects belong to fenced dashboard/runtime implementation"]
fn fixture_inbox_cleanup_runtime_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(INBOX_CLEANUP_RUNTIME).expect("inbox cleanup runtime fixture parses");
    assert_eq!(contract.cases.len(), 2);
    assert!(contract
        .cases
        .iter()
        .all(|case| !case.id.is_empty() && case.api == "persistenceMethods.cleanupInbox"));
}
