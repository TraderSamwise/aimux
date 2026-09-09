use aimux::project_service::runtime_exchange::{
    empty_runtime_exchange, read_runtime_exchange, runtime_exchange_path, write_runtime_exchange,
};
use aimux::runtime_migration::{
    build_runtime_migration_report, import_runtime_migration, rollback_runtime_migration,
};
use serde_json::{Value, json};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    Mutex,
    atomic::{AtomicU64, Ordering},
};

static ENV_LOCK: Mutex<()> = Mutex::new(());
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const NOW: &str = "2026-05-26T00:00:00.000Z";
const RUNTIME_MIGRATION: &str =
    include_str!("../../../../testdata/contracts/v1/runtime-migration/migration.json");

#[test]
fn fixture_runtime_migration_matches_typescript() {
    let contract: Value =
        serde_json::from_str(RUNTIME_MIGRATION).expect("valid runtime migration fixture");
    let cases = contract["cases"]
        .as_array()
        .expect("runtime migration cases");
    assert_eq!(cases.len(), 5, "unexpected runtime migration case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = run_runtime_migration_case(&case["input"]);
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
        "{} runtime-migration parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_runtime_migration_case(input: &Value) -> Value {
    let _lock = ENV_LOCK.lock().expect("env lock");
    let fixture = RuntimeMigrationFixture::new(input["scenario"].as_str().unwrap_or_default());
    let output = match input["scenario"].as_str().unwrap_or_default() {
        "global-history-report" => scenario_global_history_report(&fixture),
        "corrupt-legacy-thread" => scenario_corrupt_legacy_thread(&fixture),
        "import-and-rollback" => scenario_import_and_rollback(&fixture),
        "rollback-no-backup" => scenario_rollback_no_backup(&fixture),
        "blocked-existing-exchange" => scenario_blocked_existing_exchange(&fixture),
        scenario => json!({ "error": format!("unknown runtime migration scenario: {scenario}") }),
    };
    normalize_value(output, &fixture)
}

struct RuntimeMigrationFixture {
    root: PathBuf,
    repo: PathBuf,
    home: PathBuf,
    previous_home: Option<String>,
}

impl RuntimeMigrationFixture {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-runtime-migration-fixture-{label}-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        let repo = root.join("repo");
        let home = root.join("home");
        fs::create_dir_all(repo.join(".git")).expect("create repo");
        fs::create_dir_all(&home).expect("create home");
        let previous_home = std::env::var("AIMUX_HOME").ok();
        unsafe {
            std::env::set_var("AIMUX_HOME", &home);
        }
        Self {
            root,
            repo,
            home,
            previous_home,
        }
    }

    fn project_state_dir(&self) -> PathBuf {
        build_runtime_migration_report(&self.repo, Some(NOW))
            .project
            .project_state_dir
            .into()
    }
}

impl Drop for RuntimeMigrationFixture {
    fn drop(&mut self) {
        if let Some(previous_home) = &self.previous_home {
            unsafe {
                std::env::set_var("AIMUX_HOME", previous_home);
            }
        } else {
            unsafe {
                std::env::remove_var("AIMUX_HOME");
            }
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn scenario_global_history_report(fixture: &RuntimeMigrationFixture) -> Value {
    let project_state_dir = fixture.project_state_dir();
    fs::create_dir_all(project_state_dir.join("history")).expect("create history");
    fs::write(project_state_dir.join("history/codex-1.jsonl"), "{}\n").expect("write history");
    json!({
        "localHistoryExists": fixture.repo.join(".aimux/history/codex-1.jsonl").exists(),
        "report": build_runtime_migration_report(&fixture.repo, Some(NOW)),
    })
}

fn scenario_corrupt_legacy_thread(fixture: &RuntimeMigrationFixture) -> Value {
    fs::create_dir_all(fixture.repo.join(".aimux/threads")).expect("create threads");
    fs::write(fixture.repo.join(".aimux/threads/thread-1.json"), "{bad").expect("write bad");
    let report = build_runtime_migration_report(&fixture.repo, Some(NOW));
    let import_error = import_runtime_migration(&fixture.repo, Some(NOW))
        .err()
        .map(|error| error.to_string());
    json!({ "report": report, "importError": import_error })
}

fn scenario_import_and_rollback(fixture: &RuntimeMigrationFixture) -> Value {
    let project_state_dir = fixture.project_state_dir();
    let exchange_path = runtime_exchange_path(&project_state_dir);
    let mut original_exchange = empty_runtime_exchange();
    original_exchange["generatedAt"] = json!(NOW);
    write_runtime_exchange(&exchange_path, &original_exchange).expect("write exchange");
    fs::create_dir_all(fixture.repo.join(".aimux/threads")).expect("create threads");
    fs::create_dir_all(fixture.repo.join(".aimux/tasks")).expect("create tasks");
    fs::create_dir_all(project_state_dir.join("history")).expect("create history");
    write_thread(&fixture.repo, "thread-1", "Task");
    write_task(&fixture.repo);
    fs::write(project_state_dir.join("history/codex-1.jsonl"), "{}\n").expect("write history");

    let result = import_runtime_migration(&fixture.repo, Some(NOW)).expect("import");
    let manifest_path =
        project_state_dir.join("migration-backups/2026-05-26T00-00-00-000Z/manifest.json");
    let before_rollback = json!({
        "copiedHistoryExists": fixture.repo.join(".aimux/history/codex-1.jsonl").exists(),
        "manifestExists": manifest_path.exists(),
        "backupContainsOriginalGeneratedAt": fs::read_to_string(&result.manifest.backups[0].backup).expect("backup").contains(NOW),
    });
    fs::write(
        fixture.repo.join(".aimux/history/post-import.jsonl"),
        "{}\n",
    )
    .expect("write post import");
    let rollback = rollback_runtime_migration(&manifest_path).expect("rollback");
    json!({
        "import": import_result_value(&result),
        "beforeRollback": before_rollback,
        "rollback": rollback,
        "afterRollback": {
            "copiedHistoryExists": fixture.repo.join(".aimux/history/codex-1.jsonl").exists(),
            "postImportHistoryExists": fixture.repo.join(".aimux/history/post-import.jsonl").exists(),
            "runtimeExchangeGeneratedAt": read_runtime_exchange(&exchange_path)["generatedAt"],
        },
    })
}

fn scenario_rollback_no_backup(fixture: &RuntimeMigrationFixture) -> Value {
    let project_state_dir = fixture.project_state_dir();
    let exchange_path = runtime_exchange_path(&project_state_dir);
    fs::create_dir_all(fixture.repo.join(".aimux/threads")).expect("create threads");
    write_thread(&fixture.repo, "thread-1", "Task");
    let result = import_runtime_migration(&fixture.repo, Some(NOW)).expect("import");
    let manifest_path =
        project_state_dir.join("migration-backups/2026-05-26T00-00-00-000Z/manifest.json");
    let exchange_exists_before_rollback = exchange_path.exists();
    let rollback = rollback_runtime_migration(manifest_path).expect("rollback");
    json!({
        "import": import_result_value(&result),
        "exchangeExistsBeforeRollback": exchange_exists_before_rollback,
        "rollback": rollback,
        "exchangeExistsAfterRollback": exchange_path.exists(),
    })
}

fn scenario_blocked_existing_exchange(fixture: &RuntimeMigrationFixture) -> Value {
    let project_state_dir = fixture.project_state_dir();
    fs::create_dir_all(fixture.repo.join(".aimux/threads")).expect("create threads");
    write_thread(&fixture.repo, "thread-1", "Legacy task");
    let mut exchange = empty_runtime_exchange();
    exchange["generatedAt"] = json!(NOW);
    exchange["threads"] = json!([
        {
            "id": "thread-existing",
            "title": "Existing",
            "kind": "conversation",
            "status": "open",
            "createdAt": NOW,
            "updatedAt": NOW,
            "createdBy": "user",
            "participants": ["user"]
        }
    ]);
    write_runtime_exchange(runtime_exchange_path(&project_state_dir), &exchange)
        .expect("write exchange");
    let report = build_runtime_migration_report(&fixture.repo, Some(NOW));
    let import_error = import_runtime_migration(&fixture.repo, Some(NOW))
        .err()
        .map(|error| error.to_string());
    json!({ "report": report, "importError": import_error })
}

fn write_thread(repo: &Path, id: &str, title: &str) {
    fs::write(
        repo.join(format!(".aimux/threads/{id}.json")),
        json!({
            "id": id,
            "title": title,
            "kind": "task",
            "status": "waiting",
            "createdAt": NOW,
            "updatedAt": NOW,
            "createdBy": "user",
            "participants": ["user", "codex-1"]
        })
        .to_string()
            + "\n",
    )
    .expect("write thread");
}

fn write_task(repo: &Path) {
    fs::write(
        repo.join(".aimux/tasks/task-1.json"),
        json!({
            "id": "task-1",
            "status": "pending",
            "assignedBy": "user",
            "threadId": "thread-1",
            "description": "Do task",
            "prompt": "Do task",
            "createdAt": NOW,
            "updatedAt": NOW
        })
        .to_string()
            + "\n",
    )
    .expect("write task");
}

fn import_result_value(result: &aimux::runtime_migration::RuntimeMigrationImportResult) -> Value {
    json!({
        "exchange": result.exchange,
        "manifest": result.manifest,
    })
}

fn normalize_value(value: Value, fixture: &RuntimeMigrationFixture) -> Value {
    let report = build_runtime_migration_report(&fixture.repo, Some(NOW));
    let project_id = report.project.project_id;
    normalize_value_with_paths(value, fixture, &project_id)
}

fn normalize_value_with_paths(
    value: Value,
    fixture: &RuntimeMigrationFixture,
    project_id: &str,
) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| normalize_value_with_paths(item, fixture, project_id))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, normalize_value_with_paths(value, fixture, project_id)))
                .collect(),
        ),
        Value::String(text) => Value::String(
            text.replace(&fixture.repo.to_string_lossy().to_string(), "<repo>")
                .replace(&fixture.home.to_string_lossy().to_string(), "<home>")
                .replace(project_id, "<project-id>"),
        ),
        value => value,
    }
}
