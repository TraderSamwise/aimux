use aimux::project_service::work_outline::{
    WORK_OUTLINE_MAX_ENTRIES, WORK_OUTLINE_MAX_SESSION_IDS, WORK_OUTLINE_SESSION_ID_MAX_CHARS,
    WORK_OUTLINE_SUMMARY_MAX_CHARS, WORK_OUTLINE_TITLE_MAX_CHARS, WorkOutlineQuery,
    WorkOutlineStatus, get_work_outline_entry, list_work_outline_entries, read_work_outline_state,
    update_work_outline_entry, work_outline_path,
};
use serde_json::{Value, json};
use std::fs::{create_dir_all, read_dir, remove_dir_all, write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const WORK_OUTLINE: &str =
    include_str!("../../../../../testdata/contracts/v1/work-outline/outline.json");

struct TestProject {
    root: PathBuf,
    state_dir: PathBuf,
}

impl TestProject {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-work-outline-fixture-{label}-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = remove_dir_all(&root);
        create_dir_all(root.join(".git")).expect("create git dir");
        let state_dir = root.join("state");
        create_dir_all(&state_dir).expect("create state dir");
        Self { root, state_dir }
    }
}

impl Drop for TestProject {
    fn drop(&mut self) {
        let _ = remove_dir_all(&self.root);
    }
}

#[test]
fn fixture_work_outline_matches_typescript() {
    let contract: Value = serde_json::from_str(WORK_OUTLINE).expect("valid fixture");
    let cases = contract["cases"].as_array().expect("work outline cases");
    assert_eq!(cases.len(), 5, "unexpected work-outline case count");
    let mut failures = Vec::new();
    for case in cases {
        let scenario = case["input"]["scenario"].as_str().unwrap_or("case");
        let project = TestProject::new(scenario);
        let actual = normalize_output(run_case(&project, scenario));
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
        "{} work-outline parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(project: &TestProject, scenario: &str) -> Value {
    match scenario {
        "upsert-merge" => {
            let first = entry_value(
                update_work_outline_entry(
                    &project.state_dir,
                    &json!({
                        "topicKey": "Release Train",
                        "title": "Release train",
                        "summary": "Prepare the release.",
                        "sessionId": "codex-a",
                        "worktreePath": "/repo/main",
                        "evidence": { "source": "tail", "startLine": 5, "endLine": 9 },
                    }),
                    Some("2026-08-30T00:00:00.000Z"),
                )
                .expect("first outline entry"),
            );
            let second = entry_value(
                update_work_outline_entry(
                    &project.state_dir,
                    &json!({
                        "topicKey": "release train",
                        "title": "Release train",
                        "summary": "Release is ready to cut.",
                        "sessionIds": ["claude-b", "codex-a"],
                        "worktreePath": "/repo/main",
                    }),
                    Some("2026-08-30T00:01:00.000Z"),
                )
                .expect("second outline entry"),
            );
            json!({ "first": first, "second": second, "state": state_value(project) })
        }
        "filters" => {
            let alpha = entry_value(
                update_work_outline_entry(
                    &project.state_dir,
                    &json!({
                        "topicKey": "alpha",
                        "title": "Alpha cleanup",
                        "summary": "Remove stale paths.",
                        "sessionId": "codex-a",
                        "status": "done",
                        "worktreePath": "/repo/alpha",
                    }),
                    Some("2026-08-30T00:00:00.000Z"),
                )
                .expect("alpha outline entry"),
            );
            let beta = entry_value(
                update_work_outline_entry(
                    &project.state_dir,
                    &json!({
                        "topicKey": "beta",
                        "title": "Beta scheduler",
                        "summary": "Scan changed agents.",
                        "sessionId": "claude-b",
                        "status": "active",
                        "worktreePath": "/repo/beta",
                    }),
                    Some("2026-08-30T00:01:00.000Z"),
                )
                .expect("beta outline entry"),
            );
            json!({
                "alpha": alpha,
                "beta": beta,
                "done": entries_value(list_work_outline_entries(
                    &project.state_dir,
                    WorkOutlineQuery { status: Some(WorkOutlineStatus::Done), ..WorkOutlineQuery::default() },
                )),
                "session": entries_value(list_work_outline_entries(
                    &project.state_dir,
                    WorkOutlineQuery { session_id: Some("codex-a".into()), ..WorkOutlineQuery::default() },
                )),
                "worktree": entries_value(list_work_outline_entries(
                    &project.state_dir,
                    WorkOutlineQuery { worktree_path: Some("/repo/alpha".into()), ..WorkOutlineQuery::default() },
                )),
                "search": entries_value(list_work_outline_entries(
                    &project.state_dir,
                    WorkOutlineQuery { q: Some("stale".into()), ..WorkOutlineQuery::default() },
                )),
            })
        }
        "bounds-text" => {
            let title = "t".repeat(WORK_OUTLINE_TITLE_MAX_CHARS + 20);
            let summary = "s".repeat(WORK_OUTLINE_SUMMARY_MAX_CHARS + 20);
            for index in 0..(WORK_OUTLINE_MAX_ENTRIES + 5) {
                let now = format!("2026-08-30T00:{:02}:{:02}.000Z", index / 60, index % 60);
                update_work_outline_entry(
                    &project.state_dir,
                    &json!({
                        "topicKey": format!("topic-{index}"),
                        "title": title,
                        "summary": summary,
                    }),
                    Some(&now),
                )
                .expect("bounded outline entry");
            }
            json!({
                "summary": state_summary(project),
                "missing": get_work_outline_entry(&project.state_dir, "outline-missing").map(entry_value),
            })
        }
        "bounds-session-ids" => {
            let long_id = format!(
                "codex-{}",
                "x".repeat(WORK_OUTLINE_SESSION_ID_MAX_CHARS + 20)
            );
            let many_ids = (0..(WORK_OUTLINE_MAX_SESSION_IDS + 20))
                .map(|index| Value::String(format!("codex-{index}")))
                .collect::<Vec<_>>();
            let first = entry_value(
                update_work_outline_entry(
                    &project.state_dir,
                    &json!({
                        "topicKey": "session bound",
                        "title": "Session bound",
                        "summary": "Keep persisted session id arrays bounded.",
                        "sessionIds": std::iter::once(Value::String(long_id)).chain(many_ids).collect::<Vec<_>>(),
                    }),
                    Some("2026-08-30T00:00:00.000Z"),
                )
                .expect("first session outline entry"),
            );
            let second_ids = (0..20)
                .map(|index| Value::String(format!("claude-{index}")))
                .collect::<Vec<_>>();
            let second = entry_value(
                update_work_outline_entry(
                    &project.state_dir,
                    &json!({
                        "topicKey": "session bound",
                        "title": "Session bound",
                        "summary": "Keep persisted session id arrays bounded after updates.",
                        "sessionIds": second_ids,
                    }),
                    Some("2026-08-30T00:01:00.000Z"),
                )
                .expect("second session outline entry"),
            );
            json!({ "first": first, "second": second, "state": state_value(project) })
        }
        "corrupt-json" => {
            let path = work_outline_path(&project.state_dir);
            write(&path, "{not json").expect("write corrupt outline");
            let state = read_work_outline_state(&project.state_dir);
            let mut files = read_dir(&project.state_dir)
                .expect("state dir")
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .filter(|file| file.starts_with("work-outline.json"))
                .collect::<Vec<_>>();
            files.sort();
            json!({
                "state": state,
                "exists": path.exists(),
                "files": files,
            })
        }
        scenario => json!({ "error": format!("unknown scenario: {scenario}") }),
    }
}

fn entry_value(entry: aimux::project_service::work_outline::WorkOutlineEntry) -> Value {
    serde_json::to_value(entry).expect("serialize work outline entry")
}

fn entries_value(entries: Vec<aimux::project_service::work_outline::WorkOutlineEntry>) -> Value {
    Value::Array(entries.into_iter().map(entry_value).collect())
}

fn state_value(project: &TestProject) -> Value {
    serde_json::to_value(read_work_outline_state(&project.state_dir))
        .expect("serialize outline state")
}

fn state_summary(project: &TestProject) -> Value {
    let state = read_work_outline_state(&project.state_dir);
    json!({
        "count": state.entries.len(),
        "first": state.entries.first().cloned().map(entry_value),
        "last": state.entries.last().cloned().map(entry_value),
    })
}

fn normalize_output(value: Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.into_iter().map(normalize_output).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, normalize_output(value)))
                .collect(),
        ),
        Value::String(text) => Value::String(normalize_corrupt_filename(&text)),
        value => value,
    }
}

fn normalize_corrupt_filename(text: &str) -> String {
    const PREFIX: &str = "work-outline.json.corrupt-";
    let Some(index) = text.find(PREFIX) else {
        return text.to_owned();
    };
    let suffix_start = index + PREFIX.len();
    let suffix_len = text[suffix_start..]
        .bytes()
        .take_while(u8::is_ascii_digit)
        .count();
    if suffix_len == 0 {
        return text.to_owned();
    }
    format!(
        "{}{PREFIX}<ts>{}",
        &text[..index],
        &text[suffix_start + suffix_len..]
    )
}
