use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use serde_json::{Map, Value, json};

use crate::core_command_transport::{
    DaemonHttpMethod, DaemonJsonRequest, execute_loopback_json_request,
};

pub const MAX_STATUSLINE_BYTES: u64 = 1024 * 1024;

pub fn parse_statusline_payload(session_id: &str, bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() as u64 > MAX_STATUSLINE_BYTES {
        return Err("Claude statusline stdin exceeds 1 MiB".to_owned());
    }
    let payload: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("invalid Claude statusline JSON: {error}"))?;
    if !payload.is_object() {
        return Err("Claude statusline payload must be an object".to_owned());
    }
    let rate_limits = match payload.get("rate_limits") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::Object(windows)) => {
            let mut sanitized = Map::new();
            for (name, window) in windows {
                if name.len() > 64
                    || !name
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                {
                    return Err("invalid Claude rate-limit window identifier".to_owned());
                }
                if window.is_null() {
                    sanitized.insert(name.clone(), Value::Null);
                    continue;
                }
                let window = window
                    .as_object()
                    .ok_or("Claude rate-limit window must be an object")?;
                let mut fields = Map::new();
                for field in ["used_percentage", "resets_at", "used_usd", "limit_usd"] {
                    if let Some(value) = window.get(field) {
                        if !value.is_null() && !value.is_number() {
                            return Err(format!("Claude rate-limit {field} must be numeric"));
                        }
                        fields.insert(field.to_owned(), value.clone());
                    }
                }
                match window.get("period") {
                    None | Some(Value::Null) => {}
                    Some(Value::String(period))
                        if !period.trim().is_empty() && period.len() <= 64 =>
                    {
                        fields.insert("period".to_owned(), Value::String(period.clone()));
                    }
                    Some(_) => return Err(
                        "Claude rate-limit period must be a nonempty string of at most 64 bytes"
                            .to_owned(),
                    ),
                }
                sanitized.insert(name.clone(), Value::Object(fields));
            }
            Value::Object(sanitized)
        }
        Some(_) => return Err("Claude rate_limits must be an object or null".to_owned()),
    };
    Ok(json!({ "sessionId": session_id, "rateLimits": rate_limits }))
}

pub fn collect_statusline(
    endpoint_file: &Path,
    session_id: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let payload = match parse_statusline_payload(session_id, bytes) {
        Ok(payload) => payload,
        Err(reason) => {
            return match report_statusline_error(endpoint_file, session_id, &reason) {
                Ok(()) => Err(reason),
                Err(report_error) => Err(format!(
                    "{reason}; reporting collection error failed: {report_error}"
                )),
            };
        }
    };
    post_statusline_payload(endpoint_file, session_id, &payload)
}

fn report_statusline_error(
    endpoint_file: &Path,
    session_id: &str,
    reason: &str,
) -> Result<(), String> {
    post_statusline_payload(
        endpoint_file,
        session_id,
        &json!({"sessionId":session_id,"collectorError":reason.chars().scan(0usize, |bytes, character| {
            *bytes += character.len_utf8();
            (*bytes <= 1024).then_some(character)
        }).collect::<String>()}),
    )
}

fn post_statusline_payload(
    endpoint_file: &Path,
    session_id: &str,
    payload: &Value,
) -> Result<(), String> {
    let metadata = std::fs::metadata(endpoint_file).map_err(|error| {
        format!(
            "cannot read Claude usage endpoint {}: {error}",
            endpoint_file.display()
        )
    })?;
    if !metadata.is_file() {
        return Err(format!(
            "Claude usage endpoint {} must be a regular file",
            endpoint_file.display()
        ));
    }
    let file = std::fs::File::open(endpoint_file).map_err(|error| {
        format!(
            "cannot read Claude usage endpoint {}: {error}",
            endpoint_file.display()
        )
    })?;
    let mut endpoint = String::new();
    file.take(4097)
        .read_to_string(&mut endpoint)
        .map_err(|error| {
            format!(
                "cannot read Claude usage endpoint {}: {error}",
                endpoint_file.display()
            )
        })?;
    if endpoint.len() > 4096 || endpoint.trim().is_empty() {
        return Err(format!(
            "Claude usage endpoint {} is empty or exceeds 4096 bytes",
            endpoint_file.display()
        ));
    }
    let request = DaemonJsonRequest {
        url: format!(
            "{}/usage/claude/statusline",
            endpoint.trim().trim_end_matches('/')
        ),
        method: DaemonHttpMethod::Post,
        headers: BTreeMap::from([
            ("content-type".to_owned(), "application/json".to_owned()),
            ("x-aimux-session-id".to_owned(), session_id.to_owned()),
        ]),
        body: Some(payload.to_string()),
        timeout_ms: Some(1000),
    };
    let response = execute_loopback_json_request(&request)
        .map_err(|error| format!("Claude usage POST /usage/claude/statusline failed: {error}"))?;
    if !(200..300).contains(&response.status)
        || response.json.get("ok").and_then(Value::as_bool) == Some(false)
    {
        let reason = response
            .json
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("service did not provide an error reason");
        return Err(format!(
            "Claude usage POST /usage/claude/statusline failed: HTTP {}: {reason}",
            response.status,
        ));
    }
    Ok(())
}

pub fn run_statusline(
    endpoint_file: &Path,
    session_id: &str,
    forward_command: Option<&str>,
) -> Result<i32, String> {
    run_statusline_with_source(endpoint_file, session_id, forward_command, None)
}

pub fn run_statusline_with_source(
    endpoint_file: &Path,
    session_id: &str,
    forward_command: Option<&str>,
    settings_source: Option<&Path>,
) -> Result<i32, String> {
    let mut input = Vec::new();
    std::io::stdin()
        .lock()
        .take(MAX_STATUSLINE_BYTES + 1)
        .read_to_end(&mut input)
        .map_err(|error| format!("cannot read Claude statusline stdin: {error}"))?;
    if input.len() as u64 > MAX_STATUSLINE_BYTES {
        return Err("Claude statusline stdin exceeds 1 MiB".to_owned());
    }
    let mut forwarded = forward_command.map(str::to_owned);
    let source_error = if let Some(source) = settings_source {
        match crate::tool_hooks::refresh_claude_hook_settings(source) {
            Ok(command) => {
                forwarded = command;
                None
            }
            Err(reason) => Some(reason),
        }
    } else {
        None
    };
    let mut collection = collect_statusline(endpoint_file, session_id, &input);
    if let Some(reason) = source_error {
        let reason = match report_statusline_error(endpoint_file, session_id, &reason) {
            Ok(()) => reason,
            Err(report_error) => {
                format!("{reason}; reporting settings collection error failed: {report_error}")
            }
        };
        collection = Err(match collection {
            Ok(()) => reason,
            Err(previous) => format!("{previous}; {reason}"),
        });
    }
    if let Err(error) = &collection {
        eprintln!("aimux Claude usage collection: {error}");
    }
    if let Some(command) = forwarded {
        return forward_statusline(&command, &input);
    }
    if let Err(error) = collection {
        println!("aimux usage error: {error}");
    }
    Ok(0)
}

fn forward_statusline(command: &str, input: &[u8]) -> Result<i32, String> {
    let mut child = Command::new("/bin/sh")
        .args(["-c", command])
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("cannot start original Claude statusline: {error}"))?;
    let write_result = child
        .stdin
        .take()
        .ok_or("original Claude statusline stdin unavailable")?
        .write_all(input);
    let status = child
        .wait()
        .map_err(|error| format!("cannot wait for original Claude statusline: {error}"))?;
    if let Err(error) = write_result
        && error.kind() != std::io::ErrorKind::BrokenPipe
    {
        return Err(format!(
            "cannot forward original Claude statusline stdin: {error}"
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        Ok(status
            .code()
            .unwrap_or_else(|| 128 + status.signal().unwrap_or(1)))
    }
    #[cfg(not(unix))]
    Ok(status.code().unwrap_or(1))
}
