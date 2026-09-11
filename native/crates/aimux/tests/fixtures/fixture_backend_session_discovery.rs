use aimux::backend_session_ids::{
    BackendSessionDiscoveryOptions, claude_transcript_path,
    discover_backend_session_id_with_options, discover_claude_backend_session_id,
    discover_codex_backend_session_id, relocate_claude_transcript,
};
use aimux::session_bootstrap::compose_tool_args;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const BACKEND_SESSION_DISCOVERY: &str =
    include_str!("../../../../../testdata/contracts/v1/backend-session-discovery/discovery.json");

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);

impl TestDir {
    fn new(case_id: &str) -> Self {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir()
            .join("rust-backend-session-discovery-fixtures")
            .join(format!("{}-{sequence}-{case_id}", std::process::id()));
        fs::create_dir_all(&path).expect("create fixture dir");
        Self(path)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn fixture_backend_session_discovery_cases_match_typescript_contract() {
    let contract: Value =
        serde_json::from_str(BACKEND_SESSION_DISCOVERY).expect("valid backend discovery fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("backend discovery cases");
    assert_eq!(cases.len(), 16, "unexpected backend discovery case count");

    for case in cases {
        run_case(case);
    }
}

fn run_case(case: &Value) {
    let id = case["id"].as_str().expect("case id");
    let api = case["api"].as_str().expect("case api");
    match api {
        "claudeTranscriptPath" => {
            assert_claude_transcript_path(id, &case["input"], &case["output"])
        }
        "discoverClaudeBackendSessionId" => {
            assert_discover_claude_backend_session_id(id, &case["input"], &case["output"])
        }
        "discoverBackendSessionId" => {
            assert_discover_backend_session_id(id, &case["input"], &case["output"])
        }
        "discoverCodexBackendSessionId" => {
            assert_discover_codex_backend_session_id(id, &case["input"], &case["output"])
        }
        "relocateClaudeTranscript" => {
            assert_relocate_claude_transcript(id, &case["input"], &case["output"])
        }
        "SessionBootstrapService.composeToolArgs" => {
            assert_compose_tool_args(id, &case["input"], &case["output"])
        }
        other => panic!("{id}: unhandled backend discovery api {other}"),
    }
}

fn assert_claude_transcript_path(id: &str, input: &Value, expected: &Value) {
    let actual = claude_transcript_path(
        input["cwd"].as_str().expect("cwd"),
        input["backendSessionId"].as_str().expect("backend id"),
        Some(Path::new(
            input["projectsDir"].as_str().expect("projects dir"),
        )),
    );
    assert_eq!(
        Value::String(actual.to_string_lossy().into_owned()),
        *expected,
        "{id}"
    );
}

fn assert_discover_claude_backend_session_id(id: &str, input: &Value, expected: &Value) {
    let fixture = TestDir::new(id);
    let projects_dir = fixture.0.join("claude").join("projects");
    write_claude_project_shape(
        &projects_dir,
        input["projectsDirShape"]
            .as_array()
            .expect("claude projects shape"),
    );
    assert_eq!(
        option_string(discover_claude_backend_session_id(
            input["cwd"].as_str().expect("cwd"),
            Some(&projects_dir)
        )),
        *expected,
        "{id}"
    );
}

fn assert_discover_backend_session_id(id: &str, input: &Value, expected: &Value) {
    if id == "backend-session-discovery-006" {
        assert_eq!(
            json!({
                "missingCwd": option_string(discover_backend_session_id_with_options(
                    Some("claude"),
                    None,
                    &BackendSessionDiscoveryOptions::default(),
                )),
                "unknownTool": option_string(discover_backend_session_id_with_options(
                    Some("unknown"),
                    Some(input["calls"][1]["cwd"].as_str().expect("cwd")),
                    &BackendSessionDiscoveryOptions::default(),
                )),
            }),
            *expected,
            "{id}"
        );
        return;
    }

    let fixture = TestDir::new(id);
    let sessions_dir = fixture.0.join("codex").join("sessions");
    write_codex_session_shape(id, &sessions_dir, input, None);
    let options = BackendSessionDiscoveryOptions {
        codex_sessions_dir: Some(sessions_dir),
        ..BackendSessionDiscoveryOptions::default()
    };
    assert_eq!(
        option_string(discover_backend_session_id_with_options(
            input["toolConfigKey"].as_str(),
            Some(input["cwd"].as_str().expect("cwd")),
            &options,
        )),
        *expected,
        "{id}"
    );
}

fn assert_discover_codex_backend_session_id(id: &str, input: &Value, expected: &Value) {
    let fixture = TestDir::new(id);
    let sessions_dir = fixture.0.join("codex").join("sessions");
    let cwd = resolved_cwd(&fixture.0, input["cwd"].as_str().expect("cwd"));
    if id == "backend-session-discovery-013" {
        write_codex_session_shape(id, &sessions_dir, input, Some(&cwd));
        let source = input["source"].as_str().expect("source id").to_owned();
        let forked = input["forked"].as_str().expect("forked id").to_owned();
        let without_exclude = codex_discovery(&sessions_dir, &cwd, None, []);
        let excluding_source = codex_discovery(&sessions_dir, &cwd, None, [source.clone()]);
        let excluding_both = codex_discovery(&sessions_dir, &cwd, None, [source, forked]);
        assert_eq!(
            json!({
                "withoutExclude": option_string(without_exclude),
                "excludingSource": option_string(excluding_source),
                "excludingBoth": option_string(excluding_both),
            }),
            *expected,
            "{id}"
        );
        return;
    }

    write_codex_session_shape(id, &sessions_dir, input, Some(&cwd));
    let since_ms = input
        .get("options")
        .and_then(|options| options.get("sinceMs"))
        .and_then(Value::as_u64)
        .map(u128::from);
    assert_eq!(
        option_string(codex_discovery(&sessions_dir, &cwd, since_ms, [])),
        *expected,
        "{id}"
    );
}

fn assert_relocate_claude_transcript(id: &str, input: &Value, expected: &Value) {
    let fixture = TestDir::new(id);
    let projects_dir = fixture.0.join("claude").join("projects");
    if id == "backend-session-discovery-015" {
        let missing = &input["missingSource"];
        let same = &input["samePlace"];
        assert_eq!(
            json!({
                "missingSource": relocate_claude_transcript(
                    missing["sourceCwd"].as_str().expect("source cwd"),
                    missing["targetCwd"].as_str().expect("target cwd"),
                    missing["backendSessionId"].as_str().expect("backend id"),
                    Some(&projects_dir),
                ),
                "samePlace": relocate_claude_transcript(
                    same["sourceCwd"].as_str().expect("source cwd"),
                    same["targetCwd"].as_str().expect("target cwd"),
                    same["backendSessionId"].as_str().expect("backend id"),
                    Some(&projects_dir),
                ),
            }),
            *expected,
            "{id}"
        );
        return;
    }

    let source = input["sourceCwd"].as_str().expect("source cwd");
    let target = input["targetCwd"].as_str().expect("target cwd");
    let backend_id = input["backendSessionId"].as_str().expect("backend id");
    let source_path = claude_transcript_path(source, backend_id, Some(&projects_dir));
    fs::create_dir_all(source_path.parent().expect("source parent")).expect("mkdir source");
    fs::write(&source_path, "please write me a poem\n").expect("write source transcript");
    let target_path = claude_transcript_path(target, backend_id, Some(&projects_dir));
    assert_eq!(
        source_path.exists(),
        input["sourceExistsBefore"].as_bool().unwrap_or(false)
    );
    assert_eq!(
        target_path.exists(),
        input["targetExistsBefore"].as_bool().unwrap_or(false)
    );
    let relocated = relocate_claude_transcript(source, target, backend_id, Some(&projects_dir));
    assert_eq!(
        json!({
            "relocated": relocated,
            "sourceExistsAfter": source_path.exists(),
            "targetExistsAfter": target_path.exists(),
            "targetContentIncludesPoem": fs::read_to_string(target_path)
                .map(|text| text.contains("write me a poem"))
                .unwrap_or(false),
        }),
        *expected,
        "{id}"
    );
}

fn assert_compose_tool_args(id: &str, input: &Value, expected: &Value) {
    let base = string_array(&input["base"]);
    let action = string_array(&input["action"]);
    let original = string_array(&input["saved"]["original"]);
    let remembered = string_array(&input["saved"]["rememberedLaunch"]);
    let first_move = compose_tool_args(&base, &action, &original);
    let second_move = compose_tool_args(&base, &action, &original);
    let if_remembered_launch = compose_tool_args(&base, &action, &remembered);
    assert_eq!(
        json!({
            "firstMove": first_move,
            "secondMove": second_move,
            "secondMoveResumeCount": resume_count(&second_move),
            "ifRememberedLaunch": if_remembered_launch,
            "ifRememberedLaunchResumeCount": resume_count(&if_remembered_launch),
        }),
        *expected,
        "{id}"
    );
}

fn codex_discovery<I>(
    sessions_dir: &Path,
    cwd: &str,
    since_ms: Option<u128>,
    exclude: I,
) -> Option<String>
where
    I: IntoIterator<Item = String>,
{
    let options = BackendSessionDiscoveryOptions {
        codex_sessions_dir: Some(sessions_dir.to_path_buf()),
        codex_since_ms: since_ms,
        codex_exclude_backend_session_ids: exclude.into_iter().collect::<BTreeSet<_>>(),
        ..BackendSessionDiscoveryOptions::default()
    };
    discover_codex_backend_session_id(cwd, &options)
}

fn write_claude_project_shape(projects_dir: &Path, shape: &[Value]) {
    for entry in shape {
        let path = projects_dir.join(entry.as_str().expect("shape path"));
        fs::create_dir_all(path.parent().expect("shape parent")).expect("mkdir shape");
        fs::write(path, "{}\n").expect("write claude transcript");
    }
}

fn write_codex_session_shape(id: &str, sessions_dir: &Path, input: &Value, cwd: Option<&str>) {
    let default_shape = [Value::String(
        "2026/06/14/rollout-2026-06-14T00-00-00-0710a963-a473-430f-9f9a-e27dd4546328.jsonl"
            .to_owned(),
    )];
    let shape = input["sessionsDirShape"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&default_shape);
    for entry in shape {
        let relative = entry.as_str().expect("shape path");
        let path = sessions_dir.join(relative);
        fs::create_dir_all(path.parent().expect("shape parent")).expect("mkdir shape");
        let backend_id = backend_id_from_codex_path(relative);
        let transcript_cwd = match id {
            "backend-session-discovery-011" => "/Users/x/other".to_owned(),
            _ => cwd
                .map(str::to_owned)
                .unwrap_or_else(|| input["cwd"].as_str().expect("cwd").to_owned()),
        };
        let mut payload = json!({ "id": backend_id, "cwd": transcript_cwd });
        if id == "backend-session-discovery-008" {
            payload["base_instructions"] = json!({ "text": "x".repeat(80 * 1024) });
        }
        fs::write(
            &path,
            format!(
                "{}\n{}\n",
                json!({ "type": "session_meta", "payload": payload }),
                json!({ "type": "response", "payload": { "text": "not read by discovery" } })
            ),
        )
        .expect("write codex transcript");
        if id == "backend-session-discovery-010" {
            let seconds = if backend_id.ends_with("46328") {
                1000
            } else {
                2000
            };
            set_mtime_seconds(&path, seconds);
        }
    }
}

fn backend_id_from_codex_path(path: &str) -> String {
    let stem = path.strip_suffix(".jsonl").expect("jsonl path");
    stem[stem.len() - 36..].to_owned()
}

fn resolved_cwd(temp: &Path, cwd: &str) -> String {
    if cwd.contains("<temp>") {
        cwd.replace("<temp>", temp.to_string_lossy().as_ref())
    } else {
        cwd.to_owned()
    }
}

fn option_string(value: Option<String>) -> Value {
    value.map(Value::String).unwrap_or(Value::Null)
}

fn string_array(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("string array")
        .iter()
        .map(|entry| entry.as_str().expect("string").to_owned())
        .collect()
}

fn resume_count(args: &[String]) -> usize {
    args.iter().filter(|arg| arg.as_str() == "--resume").count()
}

#[cfg(unix)]
fn set_mtime_seconds(path: &Path, seconds: i64) {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let path = CString::new(path.as_os_str().as_bytes()).expect("cstring path");
    let times = [
        libc::timeval {
            tv_sec: seconds,
            tv_usec: 0,
        },
        libc::timeval {
            tv_sec: seconds,
            tv_usec: 0,
        },
    ];
    let result = unsafe { libc::utimes(path.as_ptr(), times.as_ptr()) };
    assert_eq!(result, 0, "utimes failed");
}

#[cfg(not(unix))]
fn set_mtime_seconds(_path: &Path, _seconds: i64) {}
