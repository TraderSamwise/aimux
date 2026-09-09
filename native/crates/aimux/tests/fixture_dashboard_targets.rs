use serde::Deserialize;
use serde_json::{Value, json};

use aimux::dashboard_targets::run_dashboard_targets_contract_case;

const TARGETS: &str = include_str!("../../../../testdata/contracts/v1/dashboard/targets.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    source: String,
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
fn fixture_dashboard_targets_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(TARGETS).expect("dashboard targets fixture parses");
    assert_eq!(contract.source, "src/dashboard/targets.test.ts");
    assert_eq!(contract.case_count, 4);
    assert_eq!(contract.cases.len(), contract.case_count);

    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, contract.source);
        assert!(matches!(
            case.api.as_str(),
            "findLiveDashboardTarget" | "resolveDashboardTarget"
        ));
        assert!(!case.input.is_null());
        assert!(case.output.get("calls").and_then(Value::as_array).is_some());
        let actual =
            normalize_dashboard_stamps(run_dashboard_targets_contract_case(&case.id, &case.input));
        let expected = normalize_dashboard_stamps(case.output);
        assert_eq!(actual, expected, "{} ({})", case.id, case.api);
    }
}

fn normalize_dashboard_stamps(value: Value) -> Value {
    let mut stamps = Vec::<String>::new();
    normalize_dashboard_stamps_inner(value, &mut stamps)
}

fn normalize_dashboard_stamps_inner(value: Value, stamps: &mut Vec<String>) -> Value {
    match value {
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| normalize_dashboard_stamps_inner(value, stamps))
                .collect(),
        ),
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, normalize_dashboard_stamps_inner(value, stamps)))
                .collect(),
        ),
        Value::String(text) => {
            let text =
                normalize_dashboard_launcher_command(&normalize_dashboard_launcher_path(&text));
            if !is_dashboard_stamp(&text) {
                return Value::String(text);
            }
            let index = stamps
                .iter()
                .position(|existing| existing == &text)
                .unwrap_or_else(|| {
                    stamps.push(text);
                    stamps.len() - 1
                });
            json!(format!("<stamp:{}>", index + 1))
        }
        value => value,
    }
}

fn normalize_dashboard_launcher_path(value: &str) -> String {
    const MARKER: &str = "/dist/launcher-bin.js";
    let mut rest = value;
    let mut normalized = String::new();
    while let Some(marker_start) = rest.find(MARKER) {
        let prefix = &rest[..marker_start];
        let path_start = prefix.rfind('\'').map_or(0, |index| index + 1);
        normalized.push_str(&prefix[..path_start]);
        normalized.push_str("<repo>/dist/launcher-bin.js");
        rest = &rest[marker_start + MARKER.len()..];
    }
    normalized.push_str(rest);
    normalized
}

fn normalize_dashboard_launcher_command(value: &str) -> String {
    value.replace("env -u 'AIMUX_ROOT' -u 'AIMUX_NATIVE_BIN' ", "env ")
}

fn is_dashboard_stamp(value: &str) -> bool {
    let Some((left, right)) = value.split_once('-') else {
        return false;
    };
    left.len() == 16
        && right.len() == 16
        && left.bytes().all(|byte| byte.is_ascii_hexdigit())
        && right.bytes().all(|byte| byte.is_ascii_hexdigit())
}
