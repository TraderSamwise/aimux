use aimux::recording_cleanup::{
    DEFAULT_RECORDING_RETENTION_DAYS, MIN_RECORDING_RETENTION_DAYS, RunRecordingCleanupInput,
    normalize_recordings_config, plan_recording_cleanup, run_recording_cleanup,
};
use serde_json::{Number, Value, json};
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const RECORDING_CLEANUP: &str =
    include_str!("../../../../../testdata/contracts/v1/recordings/cleanup.json");
const RECORDING_CONFIG: &str =
    include_str!("../../../../../testdata/contracts/v1/recordings/config.json");
const DAY: f64 = 86_400_000.0;

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn fixture_recording_cleanup_matches_typescript() {
    let contract: Value =
        serde_json::from_str(RECORDING_CLEANUP).expect("valid recordings/cleanup fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("recording cleanup cases");
    assert_eq!(cases.len(), 13, "unexpected recording cleanup case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = recording_cleanup_actual(case);
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
        "{} recordings/cleanup parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

#[test]
fn fixture_recording_config_matches_typescript() {
    let contract: Value =
        serde_json::from_str(RECORDING_CONFIG).expect("valid recordings/config fixture");
    assert_eq!(
        contract["constants"],
        json!({
            "DEFAULT_RECORDINGS_CONFIG": { "cleanupEnabled": true, "retentionDays": DEFAULT_RECORDING_RETENTION_DAYS },
            "MIN_RECORDING_RETENTION_DAYS": MIN_RECORDING_RETENTION_DAYS,
        })
    );
    let cases = contract["cases"]
        .as_array()
        .expect("recording config cases");
    assert_eq!(cases.len(), 8, "unexpected recording config case count");
    let mut failures = Vec::new();
    for case in cases {
        let raw = case["input"].get("raw");
        let actual = normalize_recordings_config(raw);
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
        "{} recordings/config parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn recording_cleanup_actual(case: &Value) -> Value {
    if case["input"]["api"] == "DEFAULT_RECORDING_RETENTION_DAYS" {
        return json!(DEFAULT_RECORDING_RETENTION_DAYS);
    }
    let fixture = RecordingFixture::new(case["id"].as_str().unwrap_or("recordings"));
    seed_recordings(&fixture, &case["input"]);
    let extra_dirs = case["input"]["extraDirs"]
        .as_array()
        .map(|dirs| {
            dirs.iter()
                .map(|dir| fixture.extra_dir(dir["token"].as_str().unwrap_or_default()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let projects_root = if case["input"]["missingProjectsRoot"].as_bool() == Some(true) {
        fixture.projects_root.join("missing")
    } else {
        fixture.projects_root.clone()
    };
    let plan = plan_recording_cleanup(
        &projects_root,
        &extra_dirs,
        None,
        case["input"]["now"].as_f64().unwrap_or(0.0),
    );
    let actual = if case["input"]["api"] == "runRecordingCleanup" {
        let run = &case["input"]["run"];
        let fail_names = run["failNames"]
            .as_array()
            .map(|names| {
                names
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut removed = Vec::new();
        let result = run_recording_cleanup(
            &plan,
            RunRecordingCleanupInput {
                dry_run: run.get("dryRun").and_then(Value::as_bool),
                limit: run
                    .get("limit")
                    .and_then(Value::as_u64)
                    .map(|value| value as usize),
            },
            |path| {
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                if fail_names.iter().any(|fail| fail == name) {
                    return Err("permission denied".into());
                }
                removed.push(path.to_string_lossy().into_owned());
                Ok(())
            },
        );
        normalize_run(
            &fixture,
            &serde_json::to_value(result).expect("result json"),
            &removed,
        )
    } else {
        normalize_plan(&fixture, &serde_json::to_value(plan).expect("plan json"))
    };
    fixture.cleanup();
    actual
}

fn seed_recordings(fixture: &RecordingFixture, input: &Value) {
    for recording in input["projects"].as_array().into_iter().flatten() {
        let project = recording["project"].as_str().expect("project");
        let name = recording["name"].as_str().expect("recording name");
        let age_days = recording["ageDays"].as_f64().expect("age days");
        let bytes = recording["bytes"].as_u64().unwrap_or(512);
        let path = fixture
            .projects_root
            .join(project)
            .join("recordings")
            .join(name);
        create_file(
            &path,
            bytes,
            input["now"].as_f64().unwrap_or(0.0) - age_days * DAY,
        );
    }
    if let Some(state) = input["state"].as_object() {
        for (project, value) in state {
            let path = fixture.projects_root.join(project).join("state.json");
            create_dir_all(path.parent().expect("state parent")).expect("state dir");
            write(path, serde_json::to_vec(value).expect("state json")).expect("write state");
        }
    }
    for extra in input["extraDirs"].as_array().into_iter().flatten() {
        let dir = fixture.extra_dir(extra["token"].as_str().unwrap_or_default());
        let path = dir.join(extra["name"].as_str().expect("extra name"));
        let age_days = extra["ageDays"].as_f64().expect("extra age");
        create_file(
            &path,
            extra["bytes"].as_u64().unwrap_or(512),
            input["now"].as_f64().unwrap_or(0.0) - age_days * DAY,
        );
    }
}

fn create_file(path: &Path, bytes: u64, mtime_ms: f64) {
    create_dir_all(path.parent().expect("recording parent")).expect("recording dir");
    write(path, vec![b'x'; bytes as usize]).expect("write recording");
    set_mtime(path, mtime_ms);
}

fn set_mtime(path: &Path, mtime_ms: f64) {
    let seconds = (mtime_ms / 1000.0).floor() as libc::time_t;
    let micros = ((mtime_ms - seconds as f64 * 1000.0) * 1000.0).round() as libc::suseconds_t;
    let times = [
        libc::timeval {
            tv_sec: seconds,
            tv_usec: micros,
        },
        libc::timeval {
            tv_sec: seconds,
            tv_usec: micros,
        },
    ];
    let path = std::ffi::CString::new(path.to_string_lossy().as_bytes()).expect("cstring path");
    let rc = unsafe { libc::utimes(path.as_ptr(), times.as_ptr()) };
    assert_eq!(rc, 0, "utimes failed");
}

fn normalize_run(fixture: &RecordingFixture, result: &Value, removed: &[String]) -> Value {
    json!({
        "dryRun": result["dryRun"],
        "plan": normalize_plan(fixture, &result["plan"]),
        "removed": result["removed"],
        "failed": result["failed"],
        "reclaimedBytes": result["reclaimedBytes"],
        "removedPaths": removed.iter().map(|path| fixture.normalize_path(path)).collect::<Vec<_>>(),
    })
}

fn normalize_plan(fixture: &RecordingFixture, plan: &Value) -> Value {
    json!({
        "retentionDays": plan["retentionDays"],
        "remove": plan["remove"].as_array().into_iter().flatten().map(|entry| {
            let path = entry["path"].as_str().unwrap_or_default();
            json!({
                "path": fixture.normalize_path(path),
                "name": Path::new(path).file_name().and_then(|name| name.to_str()).unwrap_or_default(),
                "ageDays": js_number(round6(entry["ageDays"].as_f64().unwrap_or(0.0))),
                "sizeBytes": entry["sizeBytes"],
            })
        }).collect::<Vec<_>>(),
        "keptCount": plan["keptCount"],
        "reclaimableBytes": plan["reclaimableBytes"],
    })
}

fn round6(value: f64) -> f64 {
    (value * 1_000_000.0).round() / 1_000_000.0
}

fn js_number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 {
        Value::Number(Number::from(value as i64))
    } else {
        Number::from_f64(value)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

struct RecordingFixture {
    root: PathBuf,
    projects_root: PathBuf,
}

impl RecordingFixture {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-rust-recordings-fixture-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = remove_dir_all(&root);
        let projects_root = root.join("projects");
        create_dir_all(&projects_root).expect("projects root");
        Self {
            root,
            projects_root,
        }
    }

    fn extra_dir(&self, token: &str) -> PathBuf {
        match token {
            "<extra:local>" => self
                .projects_root
                .join("worktree")
                .join(".aimux")
                .join("recordings"),
            _ => self.projects_root.join("extra"),
        }
    }

    fn normalize_path(&self, path: &str) -> String {
        let local = self
            .extra_dir("<extra:local>")
            .to_string_lossy()
            .into_owned();
        if path == local {
            return "<extra:local>".into();
        }
        if let Some(suffix) = path.strip_prefix(&(local.clone() + "/")) {
            return format!("<extra:local>/{suffix}");
        }
        let projects = self.projects_root.to_string_lossy().into_owned();
        if path == projects {
            return "<projectsRoot>".into();
        }
        if let Some(suffix) = path.strip_prefix(&(projects + "/")) {
            return format!("<projectsRoot>/{suffix}");
        }
        path.to_owned()
    }

    fn cleanup(self) {
        let _ = remove_dir_all(self.root);
    }
}
