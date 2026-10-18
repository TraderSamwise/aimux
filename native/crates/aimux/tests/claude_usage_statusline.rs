use aimux::claude_usage_statusline::{collect_statusline, parse_statusline_payload};
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

fn fixture(label: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-claude-usage-{label}-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&path).unwrap();
    path
}

#[test]
fn capture_whitelists_runtime_quotas_without_prompts_or_credentials() {
    let body = parse_statusline_payload("claude-1", br#"{
        "session_id":"backend-secret", "transcript_path":"secret", "api_key":"secret",
        "rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1738425600,"secret":"hidden"},
          "seven_day":null,"additional_window":{"used_percentage":0},
          "spend_limit":{"used_usd":12.3,"limit_usd":100,"period":"monthly","secret":"hidden"}}
    }"#).unwrap();
    assert_eq!(
        body,
        json!({"sessionId":"claude-1","rateLimits":{
            "five_hour":{"used_percentage":23.5,"resets_at":1738425600},
            "seven_day":null, "additional_window":{"used_percentage":0},
            "spend_limit":{"used_usd":12.3,"limit_usd":100,"period":"monthly"}
        }})
    );
    assert!(!body.to_string().contains("secret"));
}

#[test]
fn missing_quotas_are_absent_and_malformed_quotas_are_errors() {
    assert_eq!(
        parse_statusline_payload("claude-1", br#"{}"#).unwrap()["rateLimits"],
        Value::Null
    );
    assert!(parse_statusline_payload("claude-1", br#"{"rate_limits":[]}"#).is_err());
    assert!(
        parse_statusline_payload(
            "claude-1",
            br#"{"rate_limits":{"five_hour":{"used_percentage":"unknown"}}}"#
        )
        .is_err()
    );
    assert!(parse_statusline_payload("claude-1", b"invalid").is_err());
    assert_eq!(
        parse_statusline_payload(
            "claude-1",
            br#"{"rate_limits":{"spend_limit":{"period":"quarterly"}}}"#
        )
        .unwrap()["rateLimits"]["spend_limit"]["period"],
        "quarterly"
    );
    assert!(
        parse_statusline_payload(
            "claude-1",
            br#"{"rate_limits":{"spend_limit":{"period":3}}}"#
        )
        .unwrap_err()
        .contains("period")
    );
    let huge = vec![b' '; 1024 * 1024 + 1];
    assert!(
        parse_statusline_payload("claude-1", &huge)
            .unwrap_err()
            .contains("exceeds 1 MiB")
    );
}

fn serve_once(
    endpoint: &std::path::Path,
    status: u16,
    body: Value,
) -> std::thread::JoinHandle<Value> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    std::fs::write(
        endpoint,
        format!("http://{}", listener.local_addr().unwrap()),
    )
    .unwrap();
    std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        let mut request = Vec::new();
        let mut chunk = [0u8; 4096];
        let (header_end, length) = loop {
            let read = stream.read(&mut chunk).unwrap();
            assert!(read > 0);
            request.extend_from_slice(&chunk[..read]);
            if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&request[..end]);
                let length = header
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")?
                            .trim()
                            .parse::<usize>()
                            .ok()
                    })
                    .unwrap();
                if request.len() >= end + 4 + length {
                    break (end, length);
                }
            }
        };
        let body = body.to_string();
        write!(
            stream,
            "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        serde_json::from_slice(&request[header_end + 4..header_end + 4 + length]).unwrap()
    })
}

#[test]
fn callback_preserves_server_failure_causes_and_reports_local_parse_errors_to_shared_state() {
    let dir = fixture("errors");
    let endpoint = dir.join("endpoint");
    let server = serve_once(
        &endpoint,
        500,
        json!({"ok":false,"error":"write usage quota source: permission denied"}),
    );
    let error = collect_statusline(&endpoint, "claude-1", b"{}").unwrap_err();
    assert!(error.contains("HTTP 500"));
    assert!(error.contains("write usage quota source: permission denied"));
    server.join().unwrap();

    let server = serve_once(&endpoint, 200, json!({"ok":true}));
    let error = collect_statusline(
        &endpoint,
        "claude-1",
        br#"{"rate_limits":[],"api_key":"secret"}"#,
    )
    .unwrap_err();
    assert!(error.contains("Claude rate_limits must be an object"));
    let body = server.join().unwrap();
    assert_eq!(body["sessionId"], "claude-1");
    assert!(
        body["collectorError"]
            .as_str()
            .unwrap()
            .contains("rate_limits")
    );
    assert!(!body.to_string().contains("secret"));
    assert!(body.get("rateLimits").is_none());
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn wrapper_failure_without_a_user_command_is_visible_in_claudes_stdout() {
    let dir = fixture("visible-error");
    let mut child = Command::new(env!("CARGO_BIN_EXE_aimux"))
        .args(["claude-usage-statusline", "--endpoint-file"])
        .arg(dir.join("missing-endpoint"))
        .args(["--session-id", "claude-1"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"{}").unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "Claude only displays successful statusline output"
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.contains("aimux usage error: cannot read Claude usage endpoint"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn callback_uses_the_current_user_command_instead_of_the_launch_time_snapshot() {
    let dir = fixture("live-command");
    let config = dir.join("config");
    std::fs::create_dir_all(&config).unwrap();
    let user = config.join("settings.json");
    std::fs::write(
        &user,
        json!({"statusLine":{"type":"command","command":"printf old"}}).to_string(),
    )
    .unwrap();
    aimux::tool_hooks::inject_claude_hook_args(
        vec!["--setting-sources=user".into()],
        &dir,
        "claude-1",
        None,
        &dir,
        Some(&config),
    )
    .unwrap();
    std::fs::write(
        &user,
        json!({"statusLine":{"type":"command","command":"cat; printf updated-error >&2; exit 9"}})
            .to_string(),
    )
    .unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_aimux"))
        .args(["claude-usage-statusline", "--endpoint-file"])
        .arg(dir.join("missing-endpoint"))
        .args([
            "--session-id",
            "claude-1",
            "--forward-command",
            "printf stale",
            "--settings-source",
        ])
        .arg(dir.join("claude-settings/claude-1.source.json"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let input = br#"{"model":{"display_name":"test"}}"#;
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(9));
    assert_eq!(output.stdout, input);
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("updated-error")
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn capture_posts_to_existing_project_service_and_reports_missing_endpoint() {
    let dir = fixture("transport");
    let endpoint = dir.join("metadata-api.txt");
    assert!(
        collect_statusline(&endpoint, "claude-1", b"{}")
            .unwrap_err()
            .contains("cannot read Claude usage endpoint")
    );
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    std::fs::write(
        &endpoint,
        format!("http://{}", listener.local_addr().unwrap()),
    )
    .unwrap();
    let handler = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        let mut request = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let size = stream.read(&mut chunk).unwrap();
            assert!(size > 0);
            request.extend_from_slice(&chunk[..size]);
            if let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&request[..header_end]);
                let length = header
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")?
                            .trim()
                            .parse::<usize>()
                            .ok()
                    })
                    .unwrap();
                if request.len() >= header_end + 4 + length {
                    break;
                }
            }
        }
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
            .unwrap();
        String::from_utf8(request).unwrap()
    });
    collect_statusline(
        &endpoint,
        "claude-1",
        br#"{"rate_limits":{"five_hour":{"used_percentage":35}},"api_key":"secret"}"#,
    )
    .unwrap();
    let request = handler.join().unwrap();
    assert!(request.starts_with("POST /usage/claude/statusline HTTP/1.1"));
    assert!(request.contains("\"sessionId\":\"claude-1\""));
    assert!(request.contains("\"used_percentage\":35"));
    assert!(!request.contains("secret"));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn wrapper_preserves_original_stdin_stdout_stderr_and_exit_when_collection_fails() {
    let dir = fixture("forward");
    let input =
        br#"{"model":{"display_name":"test"},"rate_limits":{"five_hour":{"used_percentage":9}}}"#;
    let mut child = Command::new(env!("CARGO_BIN_EXE_aimux"))
        .args(["claude-usage-statusline", "--endpoint-file"])
        .arg(dir.join("absent"))
        .args([
            "--session-id",
            "claude-1",
            "--forward-command",
            "cat; printf 'original-error' >&2; exit 7",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(7));
    assert_eq!(output.stdout, input);
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stderr.contains("aimux Claude usage collection: cannot read Claude usage endpoint"));
    assert!(stderr.contains("original-error"));
    let _ = std::fs::remove_dir_all(dir);
}

fn isolated_callback(dir: &std::path::Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_aimux"));
    command
        .env("AIMUX_HOME", dir.join("aimux-home"))
        .env("TMPDIR", dir)
        .args(["claude-usage-statusline", "--endpoint-file"])
        .arg(dir.join("endpoint"))
        .args(["--session-id", "claude-1"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

#[test]
fn oversized_input_is_forwarded_in_full_and_commands_may_ignore_stdin() {
    let dir = fixture("oversized-forward");
    let input = json!({"text":"測試🙂".repeat(150_000)})
        .to_string()
        .into_bytes();
    assert!(input.len() > 1024 * 1024);
    for (command, expected_output, expected_code) in [
        (
            "cat; printf original-error >&2; exit 7",
            input.as_slice(),
            7,
        ),
        ("printf ignored; exit 9", b"ignored".as_slice(), 9),
    ] {
        let mut child = isolated_callback(&dir)
            .args(["--forward-command", command])
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(&input).unwrap();
        let output = child.wait_with_output().unwrap();
        assert_eq!(output.status.code(), Some(expected_code));
        assert_eq!(output.stdout, expected_output);
        assert!(
            String::from_utf8(output.stderr)
                .unwrap()
                .contains("exceeds 1 MiB")
        );
        assert!(
            !std::fs::read_dir(&dir).unwrap().any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("aimux-claude-statusline-")),
            "forwarded stdin must have no remaining filesystem name"
        );
    }
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn oversized_input_without_a_user_command_reports_shared_and_visible_error() {
    let dir = fixture("oversized-no-forward");
    let server = serve_once(&dir.join("endpoint"), 200, json!({"ok":true}));
    let mut input = vec![b' '; 1024 * 1024 + 1];
    input[..2].copy_from_slice(b"{}");
    let mut child = isolated_callback(&dir).spawn().unwrap();
    child.stdin.take().unwrap().write_all(&input).unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert!(
        String::from_utf8(output.stdout)
            .unwrap()
            .contains("aimux usage error: Claude statusline stdin exceeds 1 MiB")
    );
    assert_eq!(
        server.join().unwrap()["collectorError"],
        "Claude statusline stdin exceeds 1 MiB"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(unix)]
#[test]
fn forwarded_shell_keeps_callback_identity_and_receives_cancellation_directly() {
    use std::io::BufRead;
    use std::os::unix::process::ExitStatusExt;

    let dir = fixture("forwarded-process-identity");
    let mut child = isolated_callback(&dir)
        .args([
            "--forward-command",
            "printf '%s\n' \"$$\"; exec /bin/sleep 30",
        ])
        .spawn()
        .unwrap();
    let callback_pid = child.id();
    child.stdin.take().unwrap().write_all(b"{}").unwrap();
    let mut line = String::new();
    std::io::BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .unwrap();
    let forwarded_pid = line.trim().parse::<u32>().unwrap();
    // Clean up both identities even under the old implementation, so the
    // regression assertion cannot leak the sleeper it is intended to detect.
    assert_eq!(
        unsafe { libc::kill(forwarded_pid as i32, libc::SIGTERM) },
        0
    );
    if forwarded_pid != callback_pid {
        unsafe {
            libc::kill(callback_pid as i32, libc::SIGTERM);
        }
    }
    let status = child.wait().unwrap();
    assert_eq!(
        forwarded_pid, callback_pid,
        "forwarding must replace the callback rather than orphan a child on cancellation"
    );
    assert_eq!(status.signal(), Some(libc::SIGTERM));
    let _ = std::fs::remove_dir_all(dir);
}
