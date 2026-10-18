use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom, Write};
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
    let stdin = std::io::stdin();
    let mut stdin = stdin.lock();
    (&mut stdin)
        .take(MAX_STATUSLINE_BYTES + 1)
        .read_to_end(&mut input)
        .map_err(|error| format!("cannot read Claude statusline stdin: {error}"))?;
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
    // Only collection is bounded. Keep the complete original stream outside memory
    // when a user command needs it, including bytes beyond the collection limit.
    let forwarded_input = if forwarded.is_some() {
        Some(spool_statusline_input(&input, &mut stdin)?)
    } else {
        None
    };
    drop(stdin);
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
        return forward_statusline(
            &command,
            forwarded_input.ok_or("original Claude statusline input unavailable")?,
        );
    }
    if let Err(error) = collection {
        println!("aimux usage error: {error}");
    }
    Ok(0)
}

fn spool_statusline_input(
    prefix: &[u8],
    remaining: &mut impl Read,
) -> Result<std::fs::File, String> {
    use std::fs::OpenOptions;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("cannot name original Claude statusline stdin file: {error}"))?
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "aimux-claude-statusline-{}-{timestamp}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|error| format!("cannot create original Claude statusline stdin file: {error}"))?;
    // Remove the name before putting any potentially private statusline data in it.
    // The open descriptor owns its lifetime, including when the callback is killed.
    std::fs::remove_file(&path)
        .map_err(|error| format!("cannot unlink original Claude statusline stdin file: {error}"))?;
    file.write_all(prefix)
        .map_err(|error| format!("cannot spool original Claude statusline stdin: {error}"))?;
    std::io::copy(remaining, &mut file)
        .map_err(|error| format!("cannot spool original Claude statusline stdin: {error}"))?;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("cannot rewind original Claude statusline stdin: {error}"))?;
    Ok(file)
}

fn forward_statusline(command: &str, input: std::fs::File) -> Result<i32, String> {
    let mut command_process = Command::new("/bin/sh");
    command_process
        .args(["-c", command])
        .stdin(Stdio::from(input))
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Replace the callback so cancellation and signal status reach the same
        // process Claude started, without leaving a forwarding child behind.
        Err(format!(
            "cannot start original Claude statusline: {}",
            command_process.exec()
        ))
    }
    #[cfg(not(unix))]
    {
        let status = command_process
            .status()
            .map_err(|error| format!("cannot run original Claude statusline: {error}"))?;
        Ok(status.code().unwrap_or(1))
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    #[test]
    fn forwarded_stdin_is_private_unlinked_and_complete_and_read_failures_propagate() {
        let mut remaining = &b"remaining\0unicode: \xe6\xb8\xac"[..];
        let mut file = spool_statusline_input(b"prefix", &mut remaining).unwrap();
        let metadata = file.metadata().unwrap();
        assert_eq!(metadata.nlink(), 0);
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"prefixremaining\0unicode: \xe6\xb8\xac");

        struct FailedRead;
        impl Read for FailedRead {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("original stdin read failed"))
            }
        }
        assert!(
            spool_statusline_input(b"prefix", &mut FailedRead)
                .unwrap_err()
                .contains("original stdin read failed")
        );
    }
}
