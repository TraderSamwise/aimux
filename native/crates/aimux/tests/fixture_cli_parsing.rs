use aimux::process_args::command_arg_value_matches;
use aimux::shell_args::{parse_env_assignments, parse_shell_args};
use serde_json::{Value, json};

const CLI_PARSING: &str = include_str!("../../../../testdata/contracts/v1/cli/parsing.json");

#[test]
fn fixture_cli_parsing_matches_typescript() {
    let contract: Value = serde_json::from_str(CLI_PARSING).expect("valid cli/parsing fixture");
    let cases = contract["cases"].as_array().expect("cli parsing cases");
    assert_eq!(cases.len(), 14, "unexpected cli parsing case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = cli_parsing_actual(case);
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
        "{} cli/parsing parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn cli_parsing_actual(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "commandArgValueMatches" => json!({
            "ok": true,
            "value": command_arg_value_matches(
                case["input"]["args"].as_str().expect("args"),
                case["input"]["flag"].as_str().expect("flag"),
                case["input"]["expected"].as_str().expect("expected"),
            )
        }),
        "parseShellArgs" => result_json(parse_shell_args(
            case["input"]["input"].as_str().expect("input"),
        )),
        "parseEnvAssignments" => result_json(parse_env_assignments(
            case["input"]["input"].as_str().expect("input"),
        )),
        api => json!({ "ok": false, "error": format!("unknown cli parsing api: {api}") }),
    }
}

fn result_json<T: serde::Serialize>(result: Result<T, String>) -> Value {
    match result {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}
