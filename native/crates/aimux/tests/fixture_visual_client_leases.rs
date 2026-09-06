use aimux::visual_client_leases_contract::{parse_visual_client_kind, run_registry_steps};
use serde_json::{Value, json};

const VISUAL_CLIENT_LEASES: &str =
    include_str!("../../../../testdata/contracts/v1/visual-client-leases/leases.json");

#[test]
fn fixture_visual_client_leases_matches_typescript() {
    let contract: Value =
        serde_json::from_str(VISUAL_CLIENT_LEASES).expect("valid visual-client-leases fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("visual-client-leases cases");
    assert_eq!(cases.len(), 12, "unexpected visual-client-leases case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = match case["api"].as_str().unwrap_or_default() {
            "parseVisualClientKind" => Value::String(
                parse_visual_client_kind(case["input"]["value"].as_str()).to_owned(),
            ),
            "VisualClientLeaseRegistry" => run_registry_steps(
                case["input"]["initialNow"]
                    .as_str()
                    .expect("registry initialNow"),
                case["input"]["steps"]
                    .as_array()
                    .map(Vec::as_slice)
                    .expect("registry steps"),
            ),
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
        "{} visual-client-leases parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}
