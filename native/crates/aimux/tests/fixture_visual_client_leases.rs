use aimux::project_service::visual_clients::{
    ProjectHotSnapshotCoordinator, VisualClientLeaseRoute,
};
use aimux::visual_client_leases_contract::{
    parse_iso_millis, parse_visual_client_kind, run_registry_steps,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::Path;

const VISUAL_CLIENT_LEASES: &str =
    include_str!("../../../../testdata/contracts/v1/visual-client-leases/leases.json");

#[test]
fn fixture_visual_client_leases_matches_typescript() {
    let contract: Value =
        serde_json::from_str(VISUAL_CLIENT_LEASES).expect("valid visual-client-leases fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("visual-client-leases cases");
    assert_eq!(
        cases.len(),
        12,
        "unexpected visual-client-leases case count"
    );

    let mut failures = Vec::new();
    for case in cases {
        let actual = match case["api"].as_str().unwrap_or_default() {
            "parseVisualClientKind" => {
                Value::String(parse_visual_client_kind(case["input"]["value"].as_str()).to_owned())
            }
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

#[test]
fn project_service_preview_route_lease_adapter_matches_typescript_registry() {
    let contract: Value =
        serde_json::from_str(VISUAL_CLIENT_LEASES).expect("valid visual-client-leases fixture");
    let case = contract["cases"]
        .as_array()
        .expect("visual-client-leases cases")
        .iter()
        .find(|case| case["id"] == "visual-client-leases-010")
        .expect("route replay source case");
    let now_ms = parse_iso_millis(
        case["input"]["initialNow"]
            .as_str()
            .expect("fixture initialNow"),
    )
    .expect("parse fixture initialNow");
    let steps = case["input"]["steps"].as_array().expect("fixture steps");
    let coordinator = ProjectHotSnapshotCoordinator::default();

    for step in steps.iter().take(2) {
        let input = &step["input"];
        let mut params = BTreeMap::new();
        for key in ["id", "kind", "ttlMs"] {
            if let Some(value) = input.get(key) {
                params.insert(route_param_name(key).to_owned(), param_text(value));
            }
        }
        coordinator.touch_route_lease_at(
            &params,
            VisualClientLeaseRoute {
                surface: input["surface"].as_str().expect("surface"),
                requested_preview: input["requestedPreview"].as_bool().unwrap_or(false),
                requested_chat_preview: input["requestedChatPreview"].as_bool().unwrap_or(false),
                default_kind: None,
            },
            Path::new("/repo"),
            Path::new("/state"),
            now_ms,
        );
    }

    assert_eq!(
        coordinator.snapshot_at(now_ms),
        case["output"][2]["snapshot"]
    );
}

fn route_param_name(key: &str) -> &str {
    match key {
        "id" => "clientId",
        "kind" => "clientKind",
        "ttlMs" => "clientTtlMs",
        _ => key,
    }
}

fn param_text(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}
