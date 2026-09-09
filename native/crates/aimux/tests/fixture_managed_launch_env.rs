use aimux::managed_launch_env::{
    build_managed_launch_env, wrap_command_with_managed_launch_env_from_env,
};
use serde_json::{Map, Value, json};

const MANAGED_LAUNCH_ENV: &str =
    include_str!("../../../../testdata/contracts/v1/launch/managed-env.json");

#[test]
fn fixture_managed_launch_env_matches_typescript() {
    let contract: Value =
        serde_json::from_str(MANAGED_LAUNCH_ENV).expect("valid launch/managed-env fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("managed launch env cases");
    assert_eq!(cases.len(), 5, "unexpected managed launch env case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = managed_launch_actual(case);
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
        "{} launch/managed-env parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn managed_launch_actual(case: &Value) -> Value {
    match case["api"].as_str().unwrap_or_default() {
        "buildManagedLaunchEnv" => {
            let env = env_pairs(&case["input"]["env"]);
            let extra = env_pairs(case["input"].get("extraEnv").unwrap_or(&Value::Null));
            let mut built = build_managed_launch_env(env);
            for (key, value) in extra {
                built.insert(key, value);
            }
            json!(built)
        }
        "wrapCommandWithManagedLaunchEnv" => {
            let (command, args) = wrap_command_with_managed_launch_env_from_env(
                case["input"]["command"].as_str().unwrap_or_default(),
                case["input"]["args"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>(),
                env_pairs(&case["input"]["env"]),
                env_pairs(case["input"].get("extraEnv").unwrap_or(&Value::Null)),
            );
            if case["output"].get("firstArg").is_some() {
                json!({
                    "command": command,
                    "firstArg": args.first().cloned(),
                    "contains": bool_map(&args, &case["output"]["contains"], true),
                    "excludes": bool_map(&args, &case["output"]["excludes"], false),
                    "penultimate": args.get(args.len().saturating_sub(2)).cloned(),
                    "last": args.last().cloned(),
                })
            } else {
                json!({
                    "command": command,
                    "contains": bool_map(&args, &case["output"]["contains"], true),
                })
            }
        }
        api => json!({ "error": format!("unknown managed launch env api: {api}") }),
    }
}

fn env_pairs(value: &Value) -> Vec<(String, String)> {
    value
        .as_object()
        .into_iter()
        .flat_map(Map::iter)
        .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_owned())))
        .collect()
}

fn bool_map(args: &[String], expected: &Value, contains_value: bool) -> Value {
    let mut output = Map::new();
    for key in expected.as_object().into_iter().flat_map(Map::keys) {
        let contains = args.iter().any(|arg| arg == key);
        output.insert(
            key.clone(),
            Value::Bool(if contains_value { contains } else { !contains }),
        );
    }
    Value::Object(output)
}
