use serde_json::{json, Map, Value};

pub fn run_tool_picker_contract_case(input: &Value) -> Value {
    match input.get("api").and_then(Value::as_str).unwrap_or_default() {
        "formatEnvDefaults" => Value::String(format_env_defaults(input.get("env"))),
        "defaultsLaunchOverride" => defaults_launch_override(value_field(input, "tool")),
        api => panic!("unknown tool picker api: {api}"),
    }
}

fn format_env_defaults(env: Option<&Value>) -> String {
    env.and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .map(|(key, value)| {
                    format!(
                        "{key}={}",
                        quote_shell_arg(value.as_str().unwrap_or_default())
                    )
                })
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
}

fn defaults_launch_override(tool: &Value) -> Value {
    let default_args = tool
        .get("defaultArgs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let has_env = tool
        .get("defaultEnv")
        .and_then(Value::as_object)
        .map(|object| !object.is_empty())
        .unwrap_or(false);
    if default_args.is_empty() && !has_env {
        return Value::Null;
    }

    let mut args = vec![json!("--base")];
    args.extend(default_args);
    let mut output = Map::new();
    output.insert("command".to_owned(), json!("claude"));
    output.insert("args".to_owned(), Value::Array(args));
    if has_env {
        output.insert(
            "env".to_owned(),
            tool.get("defaultEnv").cloned().unwrap_or(Value::Null),
        );
    }
    Value::Object(output)
}

fn quote_shell_arg(arg: &str) -> String {
    if arg.is_empty() {
        return "''".to_owned();
    }
    if arg
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || "_./:=@%+,-".contains(ch))
    {
        return arg.to_owned();
    }
    format!("'{}'", arg.replace('\'', "'\\''"))
}

fn value_field<'a>(value: &'a Value, field: &str) -> &'a Value {
    value.get(field).unwrap_or(&Value::Null)
}
