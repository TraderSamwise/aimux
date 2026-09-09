use serde_json::{Value, json};

const PROD_WEB_APP_URL: &str = "https://aimux.app";
const PROD_RELAY_URL: &str = "wss://relay.aimux.app";
const DEV_WEB_APP_URL: &str = "http://localhost:8081";
const DEFAULT_WEB_DAEMON_URL: &str = "http://localhost:43190";

pub fn connection_targets_contract(api: &str, input: &Value) -> Value {
    let env = input.get("env").unwrap_or(&Value::Null);
    match api {
        "cliTargets" => cli_targets_contract(env),
        "cliDevelopment" => json!({ "development": is_development_runtime(env) }),
        "app" => app_contract(env),
        _ => json!({ "error": format!("unknown connection targets api: {api}") }),
    }
}

fn cli_targets_contract(env: &Value) -> Value {
    json!({
        "webAppUrl": clean_url(optional_env(env, "AIMUX_WEB_APP_URL").unwrap_or_else(|| {
            if is_development_runtime(env) {
                DEV_WEB_APP_URL.to_owned()
            } else {
                PROD_WEB_APP_URL.to_owned()
            }
        })),
        "relayUrl": clean_url(optional_env(env, "AIMUX_RELAY_URL").unwrap_or_else(|| PROD_RELAY_URL.to_owned())),
    })
}

fn app_contract(env: &Value) -> Value {
    let mode = match resolve_app_connection_mode(env) {
        Ok(mode) => mode,
        Err(error) => return json!({ "error": error }),
    };
    let daemon_url = if mode == "local" {
        Some(clean_url(
            optional_env(env, "EXPO_PUBLIC_AIMUX_DAEMON_URL")
                .unwrap_or_else(|| DEFAULT_WEB_DAEMON_URL.to_owned()),
        ))
    } else {
        None
    };
    let relay_url = if mode == "relay" {
        Some(clean_url(
            optional_env(env, "EXPO_PUBLIC_AIMUX_RELAY_URL")
                .unwrap_or_else(|| PROD_RELAY_URL.to_owned()),
        ))
    } else {
        None
    };
    json!({
        "mode": mode,
        "daemonUrl": daemon_url,
        "relayUrl": relay_url,
    })
}

fn resolve_app_connection_mode(env: &Value) -> Result<&'static str, String> {
    match optional_env(env, "EXPO_PUBLIC_AIMUX_CONNECTION_MODE").as_deref() {
        Some("local") => Ok("local"),
        Some("relay") => Ok("relay"),
        Some(explicit) => Err(format!(
            "EXPO_PUBLIC_AIMUX_CONNECTION_MODE must be \"local\" or \"relay\", got {explicit}"
        )),
        None if optional_env(env, "NODE_ENV").as_deref() == Some("production") => Ok("relay"),
        None => Ok("local"),
    }
}

fn is_development_runtime(env: &Value) -> bool {
    optional_env(env, "AIMUX_ENV").as_deref() == Some("development")
}

fn optional_env(env: &Value, key: &str) -> Option<String> {
    env.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn clean_url(value: String) -> String {
    value
        .strip_suffix('/')
        .map(ToOwned::to_owned)
        .unwrap_or(value)
}
