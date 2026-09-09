use aimux::project_service::runtime_exchange::{
    empty_runtime_exchange, read_runtime_exchange, runtime_exchange_path, write_runtime_exchange,
};
use aimux::runtime_migration::{
    RuntimeMigrationDiagnosticSeverity, RuntimeMigrationSourceKind, RuntimeMigrationStatus,
    build_runtime_migration_report, import_runtime_migration, rollback_runtime_migration,
};
use serde_json::json;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

static ENV_LOCK: Mutex<()> = Mutex::new(());

struct Fixture {
    root: PathBuf,
    repo: PathBuf,
    previous_home: Option<String>,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-rust-runtime-migration-{label}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        let repo = root.join("repo");
        let home = root.join("home");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(&home).unwrap();
        let previous_home = std::env::var("AIMUX_HOME").ok();
        unsafe {
            std::env::set_var("AIMUX_HOME", &home);
        }
        Self {
            root,
            repo,
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

impl Drop for Fixture {
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

const NOW: &str = "2026-05-26T00:00:00.000Z";

#[test]
fn reports_corrupt_legacy_files_and_blocks_import() {
    let _lock = ENV_LOCK.lock().unwrap();
    let fixture = Fixture::new("corrupt");
    fs::create_dir_all(fixture.repo.join(".aimux/threads")).unwrap();
    fs::write(fixture.repo.join(".aimux/threads/thread-1.json"), "{bad").unwrap();

    let report = build_runtime_migration_report(&fixture.repo, Some(NOW));

    assert_eq!(report.status, RuntimeMigrationStatus::Blocked);
    assert!(report.diagnostics.iter().any(|diagnostic| {
        diagnostic.severity == RuntimeMigrationDiagnosticSeverity::Error
            && diagnostic.kind == RuntimeMigrationSourceKind::LegacyThread
    }));
    assert!(
        import_runtime_migration(&fixture.repo, Some(NOW))
            .unwrap_err()
            .to_string()
            .contains("blocked")
    );
}

#[test]
fn imports_legacy_exchange_refs_and_writes_rollback_manifest() {
    let _lock = ENV_LOCK.lock().unwrap();
    let fixture = Fixture::new("import");
    let project_state_dir = fixture.project_state_dir();
    let exchange_path = runtime_exchange_path(&project_state_dir);
    let mut original_exchange = empty_runtime_exchange();
    original_exchange["generatedAt"] = json!("original");
    write_runtime_exchange(&exchange_path, &original_exchange).unwrap();
    fs::create_dir_all(fixture.repo.join(".aimux/threads")).unwrap();
    fs::create_dir_all(fixture.repo.join(".aimux/tasks")).unwrap();
    fs::create_dir_all(project_state_dir.join("history")).unwrap();
    fs::write(
        fixture.repo.join(".aimux/threads/thread-1.json"),
        json!({
            "id": "thread-1",
            "title": "Task",
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
    .unwrap();
    fs::write(
        fixture.repo.join(".aimux/tasks/task-1.json"),
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
    .unwrap();
    fs::write(project_state_dir.join("history/codex-1.jsonl"), "{}\n").unwrap();

    let result = import_runtime_migration(&fixture.repo, Some(NOW)).unwrap();
    let manifest_path =
        project_state_dir.join("migration-backups/2026-05-26T00-00-00-000Z/manifest.json");

    assert_eq!(result.exchange["threads"][0]["id"], "thread-1");
    assert_eq!(result.exchange["tasks"][0]["id"], "task-1");
    assert!(fixture.repo.join(".aimux/history/codex-1.jsonl").exists());
    assert!(manifest_path.exists());
    assert!(
        fs::read_to_string(&result.manifest.backups[0].backup)
            .unwrap()
            .contains("original")
    );
    fs::write(
        fixture.repo.join(".aimux/history/post-import.jsonl"),
        "{}\n",
    )
    .unwrap();

    rollback_runtime_migration(&manifest_path).unwrap();

    assert!(!fixture.repo.join(".aimux/history/codex-1.jsonl").exists());
    assert!(
        fixture
            .repo
            .join(".aimux/history/post-import.jsonl")
            .exists()
    );
    assert_eq!(
        read_runtime_exchange(&exchange_path)["generatedAt"],
        "original"
    );
}

#[test]
fn rollback_removes_imported_runtime_exchange_when_no_backup_existed() {
    let _lock = ENV_LOCK.lock().unwrap();
    let fixture = Fixture::new("rollback-no-backup");
    let project_state_dir = fixture.project_state_dir();
    let exchange_path = runtime_exchange_path(&project_state_dir);
    fs::create_dir_all(fixture.repo.join(".aimux/threads")).unwrap();
    fs::write(
        fixture.repo.join(".aimux/threads/thread-1.json"),
        json!({
            "id": "thread-1",
            "title": "Task",
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
    .unwrap();

    import_runtime_migration(&fixture.repo, Some(NOW)).unwrap();
    let manifest_path =
        project_state_dir.join("migration-backups/2026-05-26T00-00-00-000Z/manifest.json");

    assert!(exchange_path.exists());
    rollback_runtime_migration(manifest_path).unwrap();
    assert!(!exchange_path.exists());
}

#[test]
fn blocks_import_when_authoritative_runtime_exchange_already_has_records() {
    let _lock = ENV_LOCK.lock().unwrap();
    let fixture = Fixture::new("blocked-authoritative");
    let project_state_dir = fixture.project_state_dir();
    fs::create_dir_all(fixture.repo.join(".aimux/threads")).unwrap();
    fs::write(
        fixture.repo.join(".aimux/threads/thread-1.json"),
        json!({
            "id": "thread-1",
            "title": "Legacy task",
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
    .unwrap();
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
    write_runtime_exchange(runtime_exchange_path(&project_state_dir), &exchange).unwrap();

    let report = build_runtime_migration_report(&fixture.repo, Some(NOW));

    assert_eq!(report.status, RuntimeMigrationStatus::Blocked);
    assert!(report.diagnostics.iter().any(|diagnostic| {
        diagnostic.severity == RuntimeMigrationDiagnosticSeverity::Error
            && diagnostic.kind == RuntimeMigrationSourceKind::RuntimeExchange
    }));
    assert!(
        import_runtime_migration(&fixture.repo, Some(NOW))
            .unwrap_err()
            .to_string()
            .contains("blocked")
    );
}

#[test]
fn does_not_copy_legacy_global_agent_dirs_during_report() {
    let _lock = ENV_LOCK.lock().unwrap();
    let fixture = Fixture::new("readonly-report");
    let project_state_dir = fixture.project_state_dir();
    fs::create_dir_all(project_state_dir.join("history")).unwrap();
    fs::write(project_state_dir.join("history/codex-1.jsonl"), "{}\n").unwrap();

    let report = build_runtime_migration_report(&fixture.repo, Some(NOW));

    assert_eq!(report.status, RuntimeMigrationStatus::NeedsImport);
    assert!(!fixture.repo.join(".aimux/history/codex-1.jsonl").exists());
}
