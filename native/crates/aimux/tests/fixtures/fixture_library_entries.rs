use aimux::project_service::library::{is_stub_plan, load_library_entries};
use aimux::project_service::router::ProjectServiceRequestContext;
use serde_json::{Value, json};
use std::fs::{create_dir_all, remove_dir_all, write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const LIBRARY_ENTRIES: &str =
    include_str!("../../../../../testdata/contracts/v1/library/entries.json");
static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn fixture_library_entries_match_typescript() {
    let contract: Value =
        serde_json::from_str(LIBRARY_ENTRIES).expect("valid library/entries fixture");
    let cases = contract["cases"].as_array().expect("library entries cases");
    assert_eq!(cases.len(), 8, "unexpected library entries case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = match case["api"].as_str().unwrap_or_default() {
            "isStubPlan" => json!(is_stub_plan(
                case["input"]["content"].as_str().unwrap_or_default()
            )),
            "loadLibraryEntries" => library_entries_actual(case),
            api => json!({ "error": format!("unknown library api: {api}") }),
        };
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
        "{} library/entries parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn library_entries_actual(case: &Value) -> Value {
    let fixture = LibraryFixture::new(case["id"].as_str().unwrap_or("library"));
    for file in case["input"]["files"].as_array().into_iter().flatten() {
        let path = fixture
            .project
            .join(file["path"].as_str().expect("file path"));
        let content = expand_content(file["content"].as_str().unwrap_or_default());
        create_dir_all(path.parent().expect("file parent")).expect("file dir");
        write(&path, content).expect("write library file");
        if let Some(mtime) = file["mtime"].as_str() {
            set_mtime(&path, mtime);
        }
    }
    let mut context = ProjectServiceRequestContext::new(&fixture.project);
    if let Some(labels) = case["input"]["labels"].as_object() {
        for (session_id, label) in labels {
            if let Some(label) = label.as_str() {
                context = context.with_session_label(session_id, label);
            }
        }
    }
    let entries = load_library_entries(&context, 4000);
    let actual = Value::Array(
        entries
            .into_iter()
            .map(|mut entry| {
                if let Some(path) = entry.get("path").and_then(Value::as_str) {
                    entry["path"] = Value::String(fixture.normalize_path(path));
                }
                entry
            })
            .collect(),
    );
    fixture.cleanup();
    actual
}

fn expand_content(content: &str) -> String {
    match content {
        "<REAL_PLAN_CRLF>" => real_plan().replace('\n', "\r\n"),
        "<STUB_CRLF>" => stub_plan().replace('\n', "\r\n"),
        "<REAL_PLAN_BAD_DATE>" => real_plan().replace("2026-06-17T05:00:00.000Z", "not-a-date"),
        value => value.to_owned(),
    }
}

fn stub_plan() -> &'static str {
    "---\nsessionId: claude-1\ntool: claude\nworktree: main\nupdatedAt: 2026-06-17T00:00:00.000Z\n---\n\n# Goal\n\nTBD\n\n# Current Status\n\nTBD\n\n# Steps\n\n- [ ] TBD\n\n# Notes\n\n- None yet.\n"
}

fn real_plan() -> &'static str {
    "---\nsessionId: claude-2\ntool: claude\nworktree: main\nupdatedAt: 2026-06-17T05:00:00.000Z\n---\n\n# Goal\n\nShip the library screen\n\n# Steps\n\n- [x] write loader\n"
}

fn set_mtime(path: &Path, iso: &str) {
    let millis = parse_iso_millis(iso).expect("mtime iso");
    let seconds = (millis / 1000) as libc::time_t;
    let micros = ((millis % 1000) * 1000) as libc::suseconds_t;
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

fn parse_iso_millis(value: &str) -> Option<u128> {
    let (date, time) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year = date_parts.next()?.parse::<i64>().ok()?;
    let month = date_parts.next()?.parse::<i64>().ok()?;
    let day = date_parts.next()?.parse::<i64>().ok()?;
    let time = time.strip_suffix('Z')?;
    let (hms, millis) = time.split_once('.').unwrap_or((time, "0"));
    let mut time_parts = hms.split(':');
    let hour = time_parts.next()?.parse::<i64>().ok()?;
    let minute = time_parts.next()?.parse::<i64>().ok()?;
    let second = time_parts.next()?.parse::<i64>().ok()?;
    let millis = millis.parse::<u128>().ok()?;
    let days = days_from_civil(year, month, day)?;
    Some(
        (((days as u128 * 24 + hour as u128) * 60 + minute as u128) * 60 + second as u128) * 1000
            + millis,
    )
}

fn days_from_civil(year: i64, month: i64, day: i64) -> Option<i64> {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    (days >= 0).then_some(days)
}

struct LibraryFixture {
    root: PathBuf,
    project: PathBuf,
}

impl LibraryFixture {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-rust-library-fixture-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = remove_dir_all(&root);
        let project = root.join("project");
        create_dir_all(project.join(".aimux/plans")).expect("plans dir");
        Self { root, project }
    }

    fn normalize_path(&self, path: &str) -> String {
        let project = self.project.to_string_lossy().into_owned();
        if path == project {
            return "<repoRoot>".into();
        }
        if let Some(suffix) = path.strip_prefix(&(project + "/")) {
            return format!("<repoRoot>/{suffix}");
        }
        path.to_owned()
    }

    fn cleanup(self) {
        let _ = remove_dir_all(self.root);
    }
}
