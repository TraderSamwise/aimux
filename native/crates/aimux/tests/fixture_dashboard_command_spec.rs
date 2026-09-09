use aimux::dashboard_command_spec::run_dashboard_command_spec_contract_case;
use serde::Deserialize;
use serde_json::{Value, json};

const COMMAND_SPEC: &str =
    include_str!("../../../../testdata/contracts/v1/dashboard/command-spec.json");

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
    name: String,
    source: String,
    api: String,
    input: Value,
    output: Value,
}

#[test]
fn fixture_dashboard_command_spec_contract_matches_rust() {
    let contract: Contract =
        serde_json::from_str(COMMAND_SPEC).expect("dashboard command-spec fixture parses");
    assert_eq!(contract.source, "src/dashboard/command-spec.test.ts");
    assert_eq!(contract.case_count, 9);
    assert_eq!(contract.cases.len(), contract.case_count);

    let mut failures = Vec::new();
    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, contract.source);
        assert_eq!(case.api, "getDashboardCommandSpec");
        assert!(!case.input.is_null());
        assert!(!case.output.is_null());
        let actual = run_dashboard_command_spec_contract_case(&case.name, &case.input);
        assert_phase8_env_hardening(&actual);
        let actual = normalize_phase8_dashboard_env_unsets(normalize_dashboard_stamps(actual));
        let expected =
            normalize_phase8_dashboard_env_unsets(normalize_dashboard_stamps(case.output));
        if actual != expected {
            failures.push(json!({
                "id": case.id,
                "name": case.name,
                "expected": expected,
                "actual": actual,
            }));
        }
    }

    assert!(
        failures.is_empty(),
        "{} dashboard command-spec parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn assert_phase8_env_hardening(value: &Value) {
    for command in dashboard_command_strings(value) {
        assert!(
            command.contains("-u 'AIMUX_ROOT'"),
            "dashboard command must unset stale AIMUX_ROOT: {command}"
        );
        assert!(
            command.contains("-u 'AIMUX_NATIVE_BIN'"),
            "dashboard command must unset stale AIMUX_NATIVE_BIN: {command}"
        );
    }
}

fn dashboard_command_strings(value: &Value) -> Vec<&str> {
    match value {
        Value::Object(object) => {
            let mut commands = Vec::new();
            if let Some(command) = object
                .get("dashboardCommand")
                .and_then(|command| command.get("args"))
                .and_then(Value::as_array)
                .and_then(|args| args.get(1))
                .and_then(Value::as_str)
            {
                commands.push(command);
            }
            for child in object.values() {
                commands.extend(dashboard_command_strings(child));
            }
            commands
        }
        Value::Array(values) => values
            .iter()
            .flat_map(dashboard_command_strings)
            .collect::<Vec<_>>(),
        _ => Vec::new(),
    }
}

fn normalize_phase8_dashboard_env_unsets(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(
            text.replace(" -u 'AIMUX_ROOT'", "")
                .replace(" -u 'AIMUX_NATIVE_BIN'", ""),
        ),
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, normalize_phase8_dashboard_env_unsets(value)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(normalize_phase8_dashboard_env_unsets)
                .collect(),
        ),
        value => value,
    }
}

fn normalize_dashboard_stamps(value: Value) -> Value {
    let mut stamps = Vec::<String>::new();
    normalize_dashboard_stamps_inner(value, &mut stamps)
}

fn normalize_dashboard_stamps_inner(value: Value, stamps: &mut Vec<String>) -> Value {
    match value {
        Value::Object(mut object) => {
            if let Some(Value::String(stamp)) = object.get("dashboardBuildStamp") {
                let index = stamps
                    .iter()
                    .position(|existing| existing == stamp)
                    .unwrap_or_else(|| {
                        stamps.push(stamp.clone());
                        stamps.len() - 1
                    });
                object.insert(
                    "dashboardBuildStamp".into(),
                    Value::String(format!("<stamp:{}>", index + 1)),
                );
            }
            Value::Object(
                object
                    .into_iter()
                    .map(|(key, value)| (key, normalize_dashboard_stamps_inner(value, stamps)))
                    .collect(),
            )
        }
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| normalize_dashboard_stamps_inner(value, stamps))
                .collect(),
        ),
        value => value,
    }
}
