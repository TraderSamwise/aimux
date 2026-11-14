//! One way to ask the relay something with the daemon's own token.
//!
//! This was private to the security-devices module, and a second caller is
//! what makes it shared rather than copied: two copies of "how do we talk to
//! the relay" is two places for a header, a timeout or a status rule to
//! drift, and the status rule in particular is the difference between a
//! refusal a person can act on and `curl exited with 1`.

use crate::async_subprocess::AsyncCommand;
use crate::paths::PathResolver;
use crate::remote::remote_credentials::load_credentials;
use serde_json::Value;

/// Ask the relay, as this machine, and come back with its answer or a reason.
///
/// The daemon token is the credential because these routes are a machine
/// speaking about itself; a browser session has no machine to speak for and
/// the relay refuses one by name.
pub fn relay_request(path: &str, method: &str, body: Option<Value>) -> Result<Value, String> {
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
        .map_err(|error| format!("Could not run curl for a relay request: {error}"))?;
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
    // A refused request carries the relay's own sentence, which is the one
    // worth showing: "Another machine owns that checkout and is connected
    // right now" tells somebody what to do, and `Relay returned 409` does not.
    if status >= 400 {
        return Err(response_error(&json, &format!("Relay returned {status}")));
    }
    Ok(json)
}

pub fn relay_http_url(relay_url: &str) -> Result<String, String> {
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

pub fn response_error(response: &Value, fallback: &str) -> String {
    response
        .get("error")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(fallback)
        .to_owned()
}
