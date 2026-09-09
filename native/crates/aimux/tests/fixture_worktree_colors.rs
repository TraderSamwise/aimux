use aimux::project_service::worktree_colors_contract::{
    rgb_from_worktree_color_code, worktree_color_ansi, worktree_color_ansi_for_code,
    worktree_color_code, worktree_color_hex, worktree_color_hex_for_code, worktree_color_key,
};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;

const WORKTREE_COLORS: &str =
    include_str!("../../../../testdata/contracts/v1/worktrees/colors.json");

#[test]
fn fixture_worktree_colors_match_typescript() {
    let contract: Value =
        serde_json::from_str(WORKTREE_COLORS).expect("valid worktree-colors fixture");
    let cases = contract["cases"].as_array().expect("worktree color cases");
    assert_eq!(cases.len(), 6, "unexpected worktree-colors case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = match case["api"].as_str().unwrap_or_default() {
            "colorSummary" => color_summary(&case["input"]),
            "codeList" => json!({
                "before": array_field(&case["input"], "before").iter().map(worktree_color_code).collect::<Vec<_>>(),
                "after": array_field(&case["input"], "after").iter().map(worktree_color_code).collect::<Vec<_>>(),
            }),
            "paletteSize" => {
                let count = case["input"]["count"].as_u64().unwrap_or(0);
                let prefix = case["input"]["prefix"].as_str().unwrap_or_default();
                let mut hexes = BTreeSet::new();
                for index in 0..count {
                    hexes.insert(worktree_color_hex(
                        &json!({ "path": format!("{prefix}{index}") }),
                    ));
                }
                json!({ "uniqueHexCount": hexes.len() })
            }
            "distanceSummary" => distance_summary(&case["input"]),
            "keyList" => Value::Array(
                array_field(&case["input"], "inputs")
                    .iter()
                    .map(|input| {
                        worktree_color_key(input)
                            .map(Value::String)
                            .unwrap_or(Value::Null)
                    })
                    .collect(),
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
        "{} worktree-colors parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn color_summary(input: &Value) -> Value {
    let code = worktree_color_code(input);
    json!({
        "key": worktree_color_key(input),
        "code": code,
        "rgb": rgb_from_worktree_color_code(code),
        "hex": worktree_color_hex(input),
        "hexForCode": worktree_color_hex_for_code(code),
        "ansi": worktree_color_ansi(input),
        "ansiForCode": worktree_color_ansi_for_code(code),
    })
}

fn distance_summary(input: &Value) -> Value {
    let root = input["root"].as_str().unwrap_or_default();
    let names = input["names"].as_array().cloned().unwrap_or_default();
    let inputs = names
        .iter()
        .filter_map(Value::as_str)
        .map(|name| {
            if name == "main" {
                json!({ "path": root, "name": name })
            } else {
                json!({ "path": format!("{root}/.aimux/worktrees/{name}"), "name": name })
            }
        })
        .collect::<Vec<_>>();
    let codes = inputs.iter().map(worktree_color_code).collect::<Vec<_>>();
    let mut distances = Vec::new();
    for (index, code) in codes.iter().enumerate() {
        for other in codes.iter().skip(index + 1) {
            distances.push(color_distance(*code, *other));
        }
    }
    let mut hex_by_name = Map::new();
    for (input, code) in inputs.iter().zip(codes) {
        hex_by_name.insert(
            input["name"].as_str().unwrap_or_default().into(),
            Value::String(worktree_color_hex_for_code(code)),
        );
    }
    json!({
        "hexByName": Value::Object(hex_by_name),
        "minimumDistance": distances.into_iter().fold(f64::INFINITY, f64::min),
    })
}

fn color_distance(a: i64, b: i64) -> f64 {
    let left = rgb_from_worktree_color_code(a);
    let right = rgb_from_worktree_color_code(b);
    let component = |value: &Value, key: &str| value[key].as_f64().unwrap_or(0.0);
    ((component(&left, "r") - component(&right, "r")).powi(2)
        + (component(&left, "g") - component(&right, "g")).powi(2)
        + (component(&left, "b") - component(&right, "b")).powi(2))
    .sqrt()
}

fn array_field<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
