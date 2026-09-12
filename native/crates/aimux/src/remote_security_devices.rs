use crate::async_subprocess::AsyncCommand;
use crate::paths::PathResolver;
use crate::remote_credentials::load_credentials;
use serde_json::Value;

pub fn list_remote_security_devices(pending: bool) -> Result<Vec<Value>, String> {
    let path = if pending {
        "/security/devices/pending"
    } else {
        "/security/devices"
    };
    let response = security_request(path, "GET", None)?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(response_error(
            &response,
            if pending {
                "Could not list pending remote devices"
            } else {
                "Could not list remote devices"
            },
        ));
    }
    response
        .get("devices")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| {
            if pending {
                "Could not list pending remote devices".into()
            } else {
                "Could not list remote devices".into()
            }
        })
}

pub fn update_remote_security_device(
    device_id: &str,
    action: &str,
    approval_code: Option<&str>,
) -> Result<Value, String> {
    let path = format!(
        "/security/devices/{}/{}",
        encode_path_component(device_id),
        action
    );
    let body =
        approval_code.map(|approval_code| serde_json::json!({ "approvalCode": approval_code }));
    let response = security_request(&path, "POST", body)?;
    if response.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(response_error(
            &response,
            &format!("Could not {action} remote device"),
        ));
    }
    response
        .get("device")
        .cloned()
        .ok_or_else(|| format!("Could not {action} remote device"))
}

fn security_request(path: &str, method: &str, body: Option<Value>) -> Result<Value, String> {
    let resolver = PathResolver::from_env();
    let Some(credentials) = load_credentials(&resolver) else {
        return Err("Not logged in. Run `aimux login` first.".into());
    };
    let url = format!("{}{}", relay_http_url(&credentials.relay_url)?, path);
    let mut command = AsyncCommand::new("curl");
    command
        .args(["--silent", "--show-error", "--max-time", "15"])
        .args(["--request", method])
        .args([
            "--header",
            &format!("Authorization: Bearer {}", credentials.token),
        ])
        .args(["--write-out", "\n%{http_code}"]);
    if let Some(body) = body {
        command
            .args(["--header", "Content-Type: application/json"])
            .args(["--data-binary", &body.to_string()]);
    }
    let output = command
        .arg(&url)
        .output()
        .map_err(|error| format!("Could not run curl for remote security request: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if stderr.is_empty() {
            format!("curl exited with {}", output.status)
        } else {
            stderr
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let (body, status) = stdout.rsplit_once('\n').unwrap_or((&stdout, ""));
    let status = status.trim().parse::<u16>().unwrap_or(0);
    let json: Value = serde_json::from_str(body.trim()).map_err(|error| error.to_string())?;
    if status >= 400 {
        return Err(response_error(&json, &format!("Relay returned {status}")));
    }
    Ok(json)
}

fn relay_http_url(relay_url: &str) -> Result<String, String> {
    let trimmed = relay_url.trim().trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("wss:") {
        return Ok(format!("https:{rest}"));
    }
    if let Some(rest) = trimmed.strip_prefix("ws:") {
        return Ok(format!("http:{rest}"));
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return Ok(trimmed.to_owned());
    }
    Err(format!("Invalid relay URL: {relay_url}"))
}

fn response_error(response: &Value, fallback: &str) -> String {
    response
        .get("error")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback)
        .to_owned()
}

fn encode_path_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}
