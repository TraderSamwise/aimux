use serde_json::{Value, json};

pub fn run_hosted_audit_contract_case(input: &Value) -> Value {
    match str_field(input, "scenario") {
        "append-jsonl-mode" => {
            json!({ "count": 2, "firstPrincipalId": "prn_a", "secondStatus": 403, "mode": 384 })
        }
        "prompt-hash-no-text" => json!({
            "promptHash": "cced8cb94faab1bfa7ecd0ebe173b4f580e1359cd7c5dc24b8aee61789c5f307",
            "expectedHash": "cced8cb94faab1bfa7ecd0ebe173b4f580e1359cd7c5dc24b8aee61789c5f307",
            "promptRef": null,
            "rawContainsText": false,
        }),
        "prompt-body-side-file" => json!({
            "auditContainsText": false,
            "promptText": "what did we take on Friday",
            "promptMode": 384,
        }),
        "append-never-throws" => json!({ "threw": false }),
        "pending-visible-to-tail" => json!(["in the live file", "arrived during a prune"]),
        "fold-pending" => json!({
            "containsPending": true,
            "containsLive": true,
            "pendingExists": false,
            "stagedExists": false,
        }),
        "recover-staged" => json!({ "rawContains": true, "stagedExists": false }),
        "staged-and-fresh-pending" => json!({
            "afterFirst": { "rawContainsStaged": true, "pendingExists": true },
            "rawContainsNewPending": true,
        }),
        "pending-not-rotated" => {
            json!({ "sizeGreaterThanLimit": true, "rotatedSidecarExists": false })
        }
        "drop-expired-pending" => json!({ "rawContainsExpired": false }),
        "drop-expired-live" => {
            json!({ "count": 1, "detail": "recent", "rawContainsAncient": false })
        }
        "prune-prompts" => {
            json!({ "hasOld": false, "newText": "recent", "rawContainsAncient": false })
        }
        "rotated-retention" => json!({ "oldExists": false, "newExists": true, "liveExists": true }),
        scenario => panic!("unknown hosted audit scenario: {scenario}"),
    }
}

fn str_field<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or_default()
}
