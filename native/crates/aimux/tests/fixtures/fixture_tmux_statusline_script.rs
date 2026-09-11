use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

const TMUX_STATUSLINE_SCRIPT: &str =
    include_str!("../../../../../testdata/contracts/v1/tmux/statusline-script.json");
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[test]
fn fixture_tmux_statusline_script_native_matches_shell_contract() {
    let contract: Value =
        serde_json::from_str(TMUX_STATUSLINE_SCRIPT).expect("valid statusline script fixture");
    let cases = contract["cases"].as_array().expect("statusline cases");
    assert_eq!(cases.len(), 10, "unexpected statusline script case count");

    let mut failures = Vec::new();
    for case in cases {
        let actual = run_case(case, StatuslineRunner::Native);
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
        "{} tmux-statusline-script parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

#[test]
fn fixture_tmux_statusline_script_shell_still_matches_contract() {
    let contract: Value =
        serde_json::from_str(TMUX_STATUSLINE_SCRIPT).expect("valid statusline script fixture");
    let cases = contract["cases"].as_array().expect("statusline cases");

    let mut failures = Vec::new();
    for case in cases {
        let actual = run_case(case, StatuslineRunner::Shell);
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
        "{} tmux-statusline shell fixture drift failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

#[derive(Clone, Copy)]
enum StatuslineRunner {
    Native,
    Shell,
}

fn run_case(case: &Value, runner: StatuslineRunner) -> Value {
    let state_dir = temp_root();
    write_input_files(&state_dir, &case["input"]["files"]);
    let args = case["input"]["args"]
        .as_array()
        .expect("args")
        .iter()
        .map(|arg| denormalize(arg.as_str().expect("arg"), &state_dir))
        .collect::<Vec<_>>();
    let output = match runner {
        StatuslineRunner::Native => Command::new(env!("CARGO_BIN_EXE_aimux"))
            .arg("__tmux-statusline-internal")
            .args(&args)
            .output()
            .expect("run native statusline"),
        StatuslineRunner::Shell => Command::new("sh")
            .arg(repo_root().join("scripts/tmux-statusline.sh"))
            .args(&args)
            .output()
            .expect("run shell statusline"),
    };
    let snapshot = json!({
        "status": output.status.code().unwrap_or(-1),
        "stdout": normalize_text(&String::from_utf8_lossy(&output.stdout)),
        "stderr": normalize_text(&String::from_utf8_lossy(&output.stderr)),
        "files": list_files(&state_dir),
    });
    let _ = fs::remove_dir_all(&state_dir);
    snapshot
}

fn write_input_files(state_dir: &Path, files: &Value) {
    let Some(files) = files.as_object() else {
        return;
    };
    for (name, content) in files {
        let path = state_dir.join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(
            path,
            denormalize(content.as_str().unwrap_or_default(), state_dir),
        )
        .expect("write input file");
    }
}

fn list_files(root: &Path) -> Value {
    let mut files = serde_json::Map::new();
    collect_files(root, root, &mut files);
    Value::Object(files)
}

fn collect_files(root: &Path, current: &Path, files: &mut serde_json::Map<String, Value>) {
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    let mut entries = entries.flatten().collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        if path.is_dir() {
            collect_files(root, &path, files);
        } else if path.is_file()
            && let Ok(relative) = path.strip_prefix(root)
            && let Ok(text) = fs::read_to_string(&path)
        {
            files.insert(
                relative.to_string_lossy().into_owned(),
                Value::String(normalize_text(&text)),
            );
        }
    }
}

fn normalize_text(text: &str) -> String {
    let mut normalized = String::new();
    for line in text.split_inclusive('\n') {
        normalized.push_str(&normalize_log_timestamp(line));
    }
    normalized
}

fn normalize_log_timestamp(line: &str) -> String {
    if line.len() >= 25
        && line.as_bytes().get(4) == Some(&b'-')
        && line.as_bytes().get(7) == Some(&b'-')
        && line.as_bytes().get(10) == Some(&b'T')
        && line.as_bytes().get(13) == Some(&b':')
        && line.as_bytes().get(16) == Some(&b':')
        && matches!(line.as_bytes().get(19), Some(b'+') | Some(b'-'))
        && line.as_bytes().get(24) == Some(&b' ')
    {
        format!("<timestamp> {}", &line[25..])
    } else {
        line.to_owned()
    }
}

fn denormalize(value: &str, state_dir: &Path) -> String {
    value.replace("<state>", &state_dir.to_string_lossy())
}

fn temp_root() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "aimux-statusline-script-fixture-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(&path).expect("create temp root");
    path
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repo root")
}
