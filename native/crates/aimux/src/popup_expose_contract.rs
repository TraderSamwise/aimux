use serde_json::{Map, Value};

pub fn run_popup_expose_contract_case(input: &Value) -> Value {
    let options = input.get("options").unwrap_or(&Value::Null);
    let mut output = Map::new();
    output.insert(
        "projectRoot".to_owned(),
        Value::String(resolve_option_path(options, "projectRoot")),
    );
    output.insert(
        "projectStateDir".to_owned(),
        Value::String(resolve_option_path(options, "projectStateDir")),
    );
    for field in [
        "currentClientSession",
        "clientTty",
        "currentWindow",
        "currentWindowId",
        "currentPath",
        "paneId",
        "aimuxHome",
    ] {
        if let Some(value) = options.get(field) {
            output.insert(field.to_owned(), value.clone());
        }
    }
    Value::Object(output)
}

fn resolve_option_path(options: &Value, field: &str) -> String {
    let raw = options
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or_default();
    resolve_path(raw)
}

fn resolve_path(path: &str) -> String {
    let absolute = path.starts_with('/');
    let mut parts: Vec<&str> = if absolute { Vec::new() } else { vec!["<cwd>"] };
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            value => parts.push(value),
        }
    }
    if absolute {
        let joined = parts.join("/");
        if joined.is_empty() {
            "/".to_owned()
        } else {
            format!("/{joined}")
        }
    } else {
        parts.join("/")
    }
}
