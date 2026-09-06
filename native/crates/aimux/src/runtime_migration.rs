use crate::atomic_write::{write_json_atomic, write_text_atomic};
use crate::paths::{PathResolver, ReadOnlyProjectPaths};
use crate::project_service::plans::plan_authority_dir_for_project_root;
use crate::project_service::runtime_exchange::{
    empty_runtime_exchange, normalize_runtime_exchange, read_runtime_exchange,
    write_runtime_exchange,
};
use crate::runtime_topology::read_runtime_topology;
use anyhow::{Result, bail};
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

mod types;

pub use types::{
    RuntimeMigrationAuthority, RuntimeMigrationCopiedDir, RuntimeMigrationCopiedFile,
    RuntimeMigrationDiagnostic, RuntimeMigrationDiagnosticSeverity, RuntimeMigrationFileBackup,
    RuntimeMigrationImportResult, RuntimeMigrationManifest, RuntimeMigrationProject,
    RuntimeMigrationReport, RuntimeMigrationSourceKind, RuntimeMigrationStatus,
    RuntimeMigrationWrite,
};

pub fn build_runtime_migration_report(
    cwd: impl AsRef<Path>,
    now: Option<&str>,
) -> RuntimeMigrationReport {
    let generated_at = now.map(str::to_owned).unwrap_or_else(now_iso);
    let mut resolver = PathResolver::from_env();
    let paths = resolver.read_only_project_paths_for(cwd);
    build_runtime_migration_report_for_paths(paths, generated_at)
}

pub fn import_runtime_migration(
    cwd: impl AsRef<Path>,
    now: Option<&str>,
) -> Result<RuntimeMigrationImportResult> {
    let generated_at = now.map(str::to_owned).unwrap_or_else(now_iso);
    ensure_project_paths(cwd.as_ref())?;
    let mut resolver = PathResolver::from_env();
    let paths = resolver.read_only_project_paths_for(cwd);
    let report = build_runtime_migration_report_for_paths(paths.clone(), generated_at.clone());
    let errors = report
        .diagnostics
        .iter()
        .filter(|diagnostic| diagnostic.severity == RuntimeMigrationDiagnosticSeverity::Error)
        .count();
    if errors > 0 {
        bail!("runtime migration blocked by {errors} diagnostic error(s)");
    }

    let exchange = build_exchange_from_legacy_files(&paths, &generated_at);
    let exchange = normalize_runtime_exchange(exchange).map_err(anyhow::Error::msg)?;
    let backup_dir = PathBuf::from(&report.project.project_state_dir)
        .join("migration-backups")
        .join(timestamp_for_path(&generated_at));
    let manifest_path = backup_dir.join("manifest.json");
    fs::create_dir_all(&backup_dir)?;
    let mut manifest = RuntimeMigrationManifest {
        version: 1,
        generated_at,
        report,
        backups: Vec::new(),
        copied_dirs: Vec::new(),
        copied_files: Vec::new(),
        wrote: Vec::new(),
    };

    let result = (|| -> Result<()> {
        let runtime_exchange_path = manifest.report.authority.runtime_exchange_path.clone();
        let project_state_dir = PathBuf::from(&manifest.report.project.project_state_dir);
        let local_aimux_dir = PathBuf::from(&manifest.report.project.local_aimux_dir);
        backup_file(
            &mut manifest,
            RuntimeMigrationSourceKind::RuntimeExchange,
            &PathBuf::from(&runtime_exchange_path),
            &backup_dir,
        )?;
        for (subdir, kind) in [
            ("context", RuntimeMigrationSourceKind::LegacyContext),
            ("history", RuntimeMigrationSourceKind::LegacyHistory),
            ("status", RuntimeMigrationSourceKind::LegacyStatus),
        ] {
            copy_legacy_dir(
                &mut manifest,
                kind,
                &project_state_dir.join(subdir),
                &local_aimux_dir.join(subdir),
            )?;
        }
        manifest.wrote.push(RuntimeMigrationWrite {
            kind: RuntimeMigrationSourceKind::RuntimeExchange,
            path: runtime_exchange_path.clone(),
        });
        write_json_atomic(&manifest_path, &manifest)?;
        write_runtime_exchange(runtime_exchange_path, &exchange)?;
        write_json_atomic(&manifest_path, &manifest)?;
        Ok(())
    })();

    if let Err(error) = result {
        let _ = rollback_manifest(&manifest);
        return Err(error);
    }

    Ok(RuntimeMigrationImportResult { exchange, manifest })
}

pub fn rollback_runtime_migration(
    manifest_path: impl AsRef<Path>,
) -> Result<RuntimeMigrationManifest> {
    let text = fs::read_to_string(manifest_path)?;
    let manifest = serde_json::from_str::<RuntimeMigrationManifest>(&text)?;
    rollback_manifest(&manifest)?;
    Ok(manifest)
}

pub fn render_runtime_migration_report(report: &RuntimeMigrationReport) -> Result<String> {
    Ok(serde_json::to_string_pretty(report)?)
}

pub fn render_runtime_migration_import_result(
    result: &RuntimeMigrationImportResult,
) -> Result<String> {
    let manifest_path = PathBuf::from(&result.manifest.report.project.project_state_dir)
        .join("migration-backups")
        .join(timestamp_for_path(&result.manifest.generated_at))
        .join("manifest.json");
    Ok(serde_json::to_string_pretty(&json!({
        "ok": true,
        "manifestPath": path_string(manifest_path),
        "copiedDirs": result.manifest.copied_dirs,
        "backups": result.manifest.backups,
        "counts": {
            "threads": array_len(&result.exchange, "threads"),
            "messages": array_len(&result.exchange, "messages"),
            "tasks": array_len(&result.exchange, "tasks"),
            "planRefs": array_len(&result.exchange, "planRefs"),
            "continuityRefs": array_len(&result.exchange, "continuityRefs"),
            "attachmentRefs": array_len(&result.exchange, "attachmentRefs"),
        },
    }))?)
}

pub fn render_runtime_migration_rollback_result(
    manifest: &RuntimeMigrationManifest,
) -> Result<String> {
    Ok(serde_json::to_string_pretty(&json!({
        "ok": true,
        "restored": manifest.backups,
        "removedCopiedDirs": manifest.copied_dirs,
    }))?)
}

fn build_runtime_migration_report_for_paths(
    paths: ReadOnlyProjectPaths,
    generated_at: String,
) -> RuntimeMigrationReport {
    let local_threads_dir = PathBuf::from(&paths.local_aimux_dir).join("threads");
    let local_tasks_dir = PathBuf::from(&paths.local_aimux_dir).join("tasks");
    let local_plans_dir = plan_authority_dir_for_project_root(&paths.repo_root);
    let local_history_dir = PathBuf::from(&paths.local_aimux_dir).join("history");
    let local_context_dir = PathBuf::from(&paths.local_aimux_dir).join("context");
    let local_status_dir = PathBuf::from(&paths.local_aimux_dir).join("status");
    let local_attachments_dir = PathBuf::from(&paths.local_aimux_dir).join("attachments");
    let project_state_dir = PathBuf::from(&paths.project_state_dir);
    let global_recordings_dir = project_state_dir.join("recordings");
    let global_history_dir = project_state_dir.join("history");
    let global_context_dir = project_state_dir.join("context");
    let global_status_dir = project_state_dir.join("status");

    let thread_files = list_files(&local_threads_dir, |name| name.ends_with(".json"));
    let message_logs = list_files(&local_threads_dir, |name| name.ends_with(".jsonl"));
    let task_files = list_files(&local_tasks_dir, |name| name.ends_with(".json"));
    let attachment_files = list_files(&local_attachments_dir, |name| name.ends_with(".json"));
    let mut legacy = empty_legacy_counts();
    set_count(
        &mut legacy,
        RuntimeMigrationSourceKind::LegacyThread,
        thread_files.len(),
    );
    set_count(
        &mut legacy,
        RuntimeMigrationSourceKind::LegacyMessageLog,
        message_logs.len(),
    );
    set_count(
        &mut legacy,
        RuntimeMigrationSourceKind::LegacyTask,
        task_files.len(),
    );
    set_count(
        &mut legacy,
        RuntimeMigrationSourceKind::LegacyPlan,
        list_files(&local_plans_dir, |name| name.ends_with(".md")).len(),
    );
    set_count(
        &mut legacy,
        RuntimeMigrationSourceKind::LegacyHistory,
        list_files(&local_history_dir, |name| name.ends_with(".jsonl")).len()
            + list_files(&global_history_dir, |name| name.ends_with(".jsonl")).len(),
    );
    set_count(
        &mut legacy,
        RuntimeMigrationSourceKind::LegacyContext,
        list_nested_files(&local_context_dir, context_file).len()
            + list_nested_files(&global_context_dir, context_file).len(),
    );
    set_count(
        &mut legacy,
        RuntimeMigrationSourceKind::LegacyStatus,
        list_files(&local_status_dir, |name| name.ends_with(".md")).len()
            + list_files(&global_status_dir, |name| name.ends_with(".md")).len(),
    );
    set_count(
        &mut legacy,
        RuntimeMigrationSourceKind::LegacyRecording,
        list_files(&global_recordings_dir, recording_file).len(),
    );
    set_count(
        &mut legacy,
        RuntimeMigrationSourceKind::LegacyAttachment,
        attachment_files.len(),
    );
    set_count(
        &mut legacy,
        RuntimeMigrationSourceKind::RuntimeTopology,
        usize::from(Path::new(&paths.runtime_topology_path).exists()),
    );
    set_count(
        &mut legacy,
        RuntimeMigrationSourceKind::RuntimeExchange,
        usize::from(Path::new(&paths.runtime_exchange_path).exists()),
    );
    set_count(
        &mut legacy,
        RuntimeMigrationSourceKind::SavedState,
        usize::from(Path::new(&paths.state_path).exists()),
    );
    set_count(
        &mut legacy,
        RuntimeMigrationSourceKind::Metadata,
        usize::from(Path::new(&paths.metadata_path).exists()),
    );

    let mut diagnostics = Vec::new();
    for path in &thread_files {
        push_json_diagnostic(
            &mut diagnostics,
            RuntimeMigrationSourceKind::LegacyThread,
            path,
        );
    }
    for path in &message_logs {
        push_jsonl_diagnostics(
            &mut diagnostics,
            RuntimeMigrationSourceKind::LegacyMessageLog,
            path,
        );
    }
    for path in &task_files {
        push_json_diagnostic(
            &mut diagnostics,
            RuntimeMigrationSourceKind::LegacyTask,
            path,
        );
    }
    for path in &attachment_files {
        push_json_diagnostic(
            &mut diagnostics,
            RuntimeMigrationSourceKind::LegacyAttachment,
            path,
        );
    }
    if Path::new(&paths.state_path).exists() {
        push_json_diagnostic(
            &mut diagnostics,
            RuntimeMigrationSourceKind::SavedState,
            &paths.state_path,
        );
    }
    if Path::new(&paths.metadata_path).exists() {
        push_json_diagnostic(
            &mut diagnostics,
            RuntimeMigrationSourceKind::Metadata,
            &paths.metadata_path,
        );
    }
    validate_runtime_yaml(&mut diagnostics, &paths);

    for (subdir, kind) in [
        ("context", RuntimeMigrationSourceKind::LegacyContext),
        ("history", RuntimeMigrationSourceKind::LegacyHistory),
        ("status", RuntimeMigrationSourceKind::LegacyStatus),
    ] {
        let source = project_state_dir.join(subdir);
        let target = PathBuf::from(&paths.local_aimux_dir).join(subdir);
        if source.exists() && has_entries(&source) && has_entries(&target) {
            diagnostics.push(RuntimeMigrationDiagnostic {
                severity: RuntimeMigrationDiagnosticSeverity::Warning,
                kind,
                path: path_string(source),
                message: format!(
                    "legacy global {subdir} exists but local .aimux/{subdir} is not empty; explicit import will leave it untouched"
                ),
            });
        }
    }

    let has_legacy = legacy
        .iter()
        .any(|(kind, count)| kind.starts_with("legacy-") && count.as_u64().unwrap_or(0) > 0);
    if !has_error(&diagnostics)
        && has_legacy
        && Path::new(&paths.runtime_exchange_path).exists()
        && runtime_exchange_has_records(&paths.runtime_exchange_path)
    {
        diagnostics.push(RuntimeMigrationDiagnostic {
            severity: RuntimeMigrationDiagnosticSeverity::Error,
            kind: RuntimeMigrationSourceKind::RuntimeExchange,
            path: paths.runtime_exchange_path.clone(),
            message: "runtime-exchange.yaml already contains authoritative records; migration import would overwrite them".into(),
        });
    }
    let status = if has_error(&diagnostics) {
        RuntimeMigrationStatus::Blocked
    } else if has_legacy {
        RuntimeMigrationStatus::NeedsImport
    } else {
        RuntimeMigrationStatus::Clean
    };
    RuntimeMigrationReport {
        version: 1,
        generated_at,
        status,
        project: RuntimeMigrationProject {
            repo_root: paths.repo_root,
            project_id: paths.project_id,
            project_state_dir: paths.project_state_dir,
            local_aimux_dir: paths.local_aimux_dir,
        },
        authority: RuntimeMigrationAuthority {
            runtime_topology_path: paths.runtime_topology_path,
            runtime_exchange_path: paths.runtime_exchange_path,
            note: "runtime-topology.yaml and runtime-exchange.yaml are authoritative; legacy files are imported only by this explicit command.".into(),
        },
        legacy,
        diagnostics,
    }
}

fn ensure_project_paths(cwd: &Path) -> Result<()> {
    let mut resolver = PathResolver::from_env();
    let paths = resolver.read_only_project_paths_for(cwd);
    let project_state_dir = PathBuf::from(&paths.project_state_dir);
    fs::create_dir_all(&project_state_dir)?;
    write_text_atomic(
        project_state_dir.join("project-root.txt"),
        format!("{}\n", paths.repo_root),
    )?;
    let local_dir = PathBuf::from(paths.local_aimux_dir);
    fs::create_dir_all(&local_dir)?;
    for subdir in ["plans", "context", "history", "status", "attachments"] {
        fs::create_dir_all(local_dir.join(subdir))?;
    }
    Ok(())
}

fn build_exchange_from_legacy_files(paths: &ReadOnlyProjectPaths, now: &str) -> Value {
    let local_aimux_dir = PathBuf::from(&paths.local_aimux_dir);
    let project_state_dir = PathBuf::from(&paths.project_state_dir);
    let threads = read_legacy_json_files(&local_aimux_dir.join("threads"));
    let thread_ids = threads
        .iter()
        .filter_map(|thread| string_field(thread, "id"))
        .collect::<Vec<_>>();
    let messages = read_legacy_messages(&local_aimux_dir.join("threads"), &thread_ids);
    let tasks = read_legacy_json_files(&local_aimux_dir.join("tasks"));
    let attachments = read_legacy_json_files(&local_aimux_dir.join("attachments"));
    let plan_paths = list_files(&local_aimux_dir.join("plans"), |name| name.ends_with(".md"));
    let history_paths = [
        list_files(&local_aimux_dir.join("history"), |name| {
            name.ends_with(".jsonl")
        }),
        list_files(&project_state_dir.join("history"), |name| {
            name.ends_with(".jsonl")
        }),
    ]
    .concat();
    let context_paths = [
        list_nested_files(&local_aimux_dir.join("context"), context_file),
        list_nested_files(&project_state_dir.join("context"), context_file),
    ]
    .concat();
    let recording_paths = list_files(&project_state_dir.join("recordings"), recording_file);
    let status_paths = [
        list_files(&local_aimux_dir.join("status"), |name| {
            name.ends_with(".md")
        }),
        list_files(&project_state_dir.join("status"), |name| {
            name.ends_with(".md")
        }),
    ]
    .concat();

    let mut exchange = empty_runtime_exchange();
    exchange["generatedAt"] = Value::String(now.to_owned());
    exchange["threads"] = Value::Array(threads.iter().map(to_exchange_thread).collect());
    exchange["messages"] = Value::Array(messages.iter().map(to_exchange_message).collect());
    exchange["tasks"] = Value::Array(tasks.iter().map(to_exchange_task).collect());
    exchange["handoffs"] = Value::Array(threads.iter().filter_map(build_handoff).collect());
    exchange["reviews"] = Value::Array(tasks.iter().filter_map(build_review).collect());
    exchange["waits"] = Value::Array(threads.iter().filter_map(build_thread_wait).collect());
    exchange["inbox"] = Value::Array(threads.iter().flat_map(build_inbox_entries).collect());
    exchange["planRefs"] = Value::Array(
        plan_paths
            .iter()
            .map(|path| plan_ref_from_path(path, now))
            .collect(),
    );
    exchange["continuityRefs"] = Value::Array(
        history_paths
            .iter()
            .chain(context_paths.iter())
            .chain(recording_paths.iter())
            .chain(status_paths.iter())
            .map(|path| continuity_ref_from_path(path, now))
            .collect(),
    );
    exchange["attachmentRefs"] = Value::Array(
        attachments
            .iter()
            .filter_map(attachment_ref_from_record)
            .collect(),
    );
    exchange
}

fn to_exchange_thread(thread: &Value) -> Value {
    copy_object_fields(
        thread,
        &[
            "id",
            "title",
            "kind",
            "status",
            "createdAt",
            "updatedAt",
            "createdBy",
            "participants",
            "owner",
            "waitingOn",
            "worktreePath",
            "taskId",
            "relatedPlanIds",
            "lastMessageId",
            "unreadBy",
            "tags",
        ],
    )
}

fn to_exchange_message(message: &Value) -> Value {
    copy_object_fields(
        message,
        &[
            "id",
            "threadId",
            "ts",
            "from",
            "to",
            "kind",
            "body",
            "taskId",
            "planId",
            "metadata",
            "deliveredTo",
            "deliveredAt",
        ],
    )
}

fn to_exchange_task(task: &Value) -> Value {
    let mut record = copy_object_fields(
        task,
        &[
            "id",
            "status",
            "assignedBy",
            "assignedTo",
            "assignee",
            "assigner",
            "threadId",
            "tool",
            "description",
            "prompt",
            "result",
            "error",
            "createdAt",
            "updatedAt",
            "notifiedAt",
            "type",
            "reviewFeedback",
            "diff",
            "iteration",
            "reviewOf",
        ],
    );
    if let Some(status) = normalize_review_status(task.get("reviewStatus")) {
        record["reviewStatus"] = Value::String(status.into());
    }
    record
}

fn build_handoff(thread: &Value) -> Option<Value> {
    if string_field(thread, "kind").as_deref() != Some("handoff") {
        return None;
    }
    let waiting_on = string_array_field(thread, "waitingOn");
    let recipients = if waiting_on.is_empty() {
        let created_by = string_field(thread, "createdBy").unwrap_or_default();
        unique(
            string_array_field(thread, "participants")
                .into_iter()
                .filter(|id| id != &created_by),
        )
    } else {
        unique(waiting_on)
    };
    if recipients.is_empty() {
        return None;
    }
    let status = match string_field(thread, "status").as_deref() {
        Some("done") => "completed",
        Some("abandoned") => "cancelled",
        _ => "waiting",
    };
    let mut record = Map::new();
    insert_string(
        &mut record,
        "id",
        format!("handoff:{}", string_field(thread, "id")?),
    );
    insert_from_field(&mut record, "threadId", thread, "id");
    insert_string(&mut record, "status", status);
    insert_from_field(&mut record, "from", thread, "createdBy");
    record.insert("to".into(), json!(recipients));
    if string_field(thread, "status").as_deref() == Some("open") {
        insert_from_field(&mut record, "acceptedBy", thread, "owner");
    }
    if string_field(thread, "status").as_deref() == Some("done") {
        insert_from_field(&mut record, "completedBy", thread, "owner");
    }
    insert_from_field(&mut record, "createdAt", thread, "createdAt");
    insert_from_field(&mut record, "updatedAt", thread, "updatedAt");
    Some(Value::Object(record))
}

fn build_review(task: &Value) -> Option<Value> {
    if string_field(task, "type").as_deref() != Some("review") {
        return None;
    }
    let task_id = string_field(task, "id")?;
    let mut record = Map::new();
    insert_string(&mut record, "id", format!("review:{task_id}"));
    insert_string(&mut record, "taskId", task_id);
    insert_from_field(&mut record, "reviewOf", task, "reviewOf");
    if let Some(reviewer) =
        string_field(task, "assignedTo").or_else(|| string_field(task, "assignee"))
    {
        insert_string(&mut record, "reviewer", reviewer);
    }
    insert_string(
        &mut record,
        "status",
        normalize_review_status(task.get("reviewStatus")).unwrap_or("pending"),
    );
    if let Some(feedback) =
        string_field(task, "reviewFeedback").or_else(|| string_field(task, "result"))
    {
        insert_string(&mut record, "feedback", feedback);
    }
    insert_from_field(&mut record, "createdAt", task, "createdAt");
    insert_from_field(&mut record, "updatedAt", task, "updatedAt");
    Some(Value::Object(record))
}

fn build_thread_wait(thread: &Value) -> Option<Value> {
    let waiting_on = unique(string_array_field(thread, "waitingOn"));
    if waiting_on.is_empty() {
        return None;
    }
    let thread_id = string_field(thread, "id")?;
    let satisfied = matches!(
        string_field(thread, "status").as_deref(),
        Some("done" | "abandoned")
    );
    let mut record = Map::new();
    insert_string(&mut record, "id", format!("wait:thread:{thread_id}"));
    insert_string(
        &mut record,
        "status",
        if satisfied { "satisfied" } else { "waiting" },
    );
    insert_string(&mut record, "subjectKind", "thread");
    insert_string(&mut record, "subjectId", thread_id);
    record.insert("waitingOn".into(), json!(waiting_on));
    insert_from_field(&mut record, "owner", thread, "owner");
    insert_from_field(&mut record, "createdAt", thread, "createdAt");
    insert_from_field(&mut record, "updatedAt", thread, "updatedAt");
    if satisfied {
        insert_from_field(&mut record, "resolvedAt", thread, "updatedAt");
    }
    Some(Value::Object(record))
}

fn build_inbox_entries(thread: &Value) -> Vec<Value> {
    let participants = unique(
        string_array_field(thread, "unreadBy")
            .into_iter()
            .chain(string_array_field(thread, "waitingOn")),
    );
    let Some(thread_id) = string_field(thread, "id") else {
        return Vec::new();
    };
    participants
        .into_iter()
        .map(|participant_id| {
            let waiting = string_array_field(thread, "waitingOn").contains(&participant_id);
            let unread = string_array_field(thread, "unreadBy").contains(&participant_id);
            let mut record = Map::new();
            insert_string(
                &mut record,
                "id",
                format!("inbox:{participant_id}:thread:{thread_id}"),
            );
            insert_string(&mut record, "participantId", participant_id);
            insert_string(&mut record, "subjectKind", "thread");
            insert_string(&mut record, "subjectId", thread_id.clone());
            insert_string(
                &mut record,
                "state",
                if string_field(thread, "status").as_deref() == Some("blocked") {
                    "blocked"
                } else if waiting {
                    "waiting"
                } else {
                    "unread"
                },
            );
            record.insert(
                "urgency".into(),
                json!((if waiting { 10 } else { 0 }) + (if unread { 3 } else { 0 })),
            );
            insert_from_field(&mut record, "updatedAt", thread, "updatedAt");
            Value::Object(record)
        })
        .collect()
}

fn plan_ref_from_path(path: &Path, now: &str) -> Value {
    let session_id = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .strip_suffix(".md")
        .unwrap_or_else(|| {
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("")
        });
    json!({
        "id": format!("plan:{session_id}"),
        "path": path_string(path),
        "ownerSessionId": session_id,
        "title": session_id,
        "createdAt": now,
        "updatedAt": now,
    })
}

fn continuity_ref_from_path(path: &Path, now: &str) -> Value {
    let normalized = path_string(path).replace('\\', "/");
    let kind = if normalized.contains("/recordings/") {
        "recording"
    } else if normalized.contains("/status/") {
        "status"
    } else if normalized.contains("/history/") {
        "history"
    } else {
        "context"
    };
    let file = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    let session_id = file
        .strip_suffix(".jsonl")
        .or_else(|| file.strip_suffix(".md"))
        .or_else(|| file.strip_suffix(".txt"))
        .unwrap_or(file);
    json!({
        "id": format!("{kind}:{session_id}:{file}"),
        "kind": kind,
        "path": path_string(path),
        "sessionId": session_id,
        "createdAt": now,
        "updatedAt": now,
    })
}

fn attachment_ref_from_record(record: &Value) -> Option<Value> {
    let id = string_field(record, "id")?;
    let content_path = string_field(record, "contentPath")?;
    let mut attachment = Map::new();
    insert_string(&mut attachment, "id", id.clone());
    insert_string(&mut attachment, "path", content_path);
    insert_string(
        &mut attachment,
        "contentUrl",
        format!("/attachments/{id}/content"),
    );
    insert_from_field(&mut attachment, "mediaType", record, "mimeType");
    insert_from_field(&mut attachment, "createdAt", record, "createdAt");
    insert_from_field(&mut attachment, "updatedAt", record, "createdAt");
    Some(Value::Object(attachment))
}

fn rollback_manifest(manifest: &RuntimeMigrationManifest) -> Result<()> {
    let backed_sources = manifest
        .backups
        .iter()
        .map(|backup| backup.source.clone())
        .collect::<BTreeSet<_>>();
    for copied in &manifest.copied_files {
        let target = Path::new(&copied.target);
        if target.exists() {
            fs::remove_file(target)?;
        }
    }
    for copied in &manifest.copied_dirs {
        let target = Path::new(&copied.target);
        if target.exists() && fs::read_dir(target)?.next().is_none() {
            fs::remove_dir_all(target)?;
        }
    }
    for wrote in &manifest.wrote {
        let path = Path::new(&wrote.path);
        if !backed_sources.contains(&wrote.path) && path.exists() {
            fs::remove_file(path)?;
        }
    }
    for backup in &manifest.backups {
        let source = Path::new(&backup.source);
        if let Some(parent) = source.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(&backup.backup, source)?;
    }
    Ok(())
}

fn backup_file(
    manifest: &mut RuntimeMigrationManifest,
    kind: RuntimeMigrationSourceKind,
    source: &Path,
    backup_dir: &Path,
) -> Result<()> {
    if !source.exists() {
        return Ok(());
    }
    let backup = backup_dir.join(source.file_name().unwrap_or_default());
    fs::copy(source, &backup)?;
    manifest.backups.push(RuntimeMigrationFileBackup {
        kind,
        source: path_string(source),
        backup: path_string(backup),
    });
    Ok(())
}

fn copy_legacy_dir(
    manifest: &mut RuntimeMigrationManifest,
    kind: RuntimeMigrationSourceKind,
    source: &Path,
    target: &Path,
) -> Result<()> {
    if !source.exists() || has_entries(target) {
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    copy_dir_recursive(source, target)?;
    manifest.copied_dirs.push(RuntimeMigrationCopiedDir {
        kind,
        source: path_string(source),
        target: path_string(target),
    });
    manifest
        .copied_files
        .extend(
            list_nested_files(source, |_| true)
                .into_iter()
                .map(|source_path| RuntimeMigrationCopiedFile {
                    kind,
                    target: path_string(
                        target.join(source_path.strip_prefix(source).unwrap_or(&source_path)),
                    ),
                    source: path_string(source_path),
                }),
        );
    Ok(())
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else {
            fs::copy(source_path, target_path)?;
        }
    }
    Ok(())
}

fn validate_runtime_yaml(
    diagnostics: &mut Vec<RuntimeMigrationDiagnostic>,
    paths: &ReadOnlyProjectPaths,
) {
    if Path::new(&paths.runtime_topology_path).exists()
        && let Err(error) = read_runtime_topology(&paths.runtime_topology_path)
    {
        diagnostics.push(RuntimeMigrationDiagnostic {
            severity: RuntimeMigrationDiagnosticSeverity::Error,
            kind: RuntimeMigrationSourceKind::RuntimeTopology,
            path: paths.runtime_topology_path.clone(),
            message: format!("invalid runtime topology: {error}"),
        });
    }
    if Path::new(&paths.runtime_exchange_path).exists() {
        match fs::read_to_string(&paths.runtime_exchange_path)
            .ok()
            .and_then(|text| serde_yaml::from_str::<Value>(&text).ok())
            .map(normalize_runtime_exchange)
        {
            Some(Ok(_)) => {}
            Some(Err(error)) => diagnostics.push(RuntimeMigrationDiagnostic {
                severity: RuntimeMigrationDiagnosticSeverity::Error,
                kind: RuntimeMigrationSourceKind::RuntimeExchange,
                path: paths.runtime_exchange_path.clone(),
                message: format!("invalid runtime exchange: {error}"),
            }),
            None => diagnostics.push(RuntimeMigrationDiagnostic {
                severity: RuntimeMigrationDiagnosticSeverity::Error,
                kind: RuntimeMigrationSourceKind::RuntimeExchange,
                path: paths.runtime_exchange_path.clone(),
                message: "invalid runtime exchange: failed to parse YAML".into(),
            }),
        }
    }
}

fn runtime_exchange_has_records(path: &str) -> bool {
    let exchange = read_runtime_exchange(path);
    [
        "threads",
        "messages",
        "tasks",
        "handoffs",
        "reviews",
        "waits",
        "inbox",
        "planRefs",
        "continuityRefs",
        "attachmentRefs",
    ]
    .iter()
    .any(|key| array_len(&exchange, key) > 0)
}

fn push_json_diagnostic(
    diagnostics: &mut Vec<RuntimeMigrationDiagnostic>,
    kind: RuntimeMigrationSourceKind,
    path: impl AsRef<Path>,
) {
    let path = path.as_ref();
    match fs::read_to_string(path)
        .map_err(|error| error.to_string())
        .and_then(|text| serde_json::from_str::<Value>(&text).map_err(|error| error.to_string()))
    {
        Ok(_) => {}
        Err(error) => diagnostics.push(RuntimeMigrationDiagnostic {
            severity: RuntimeMigrationDiagnosticSeverity::Error,
            kind,
            path: path_string(path),
            message: format!("invalid JSON: {error}"),
        }),
    }
}

fn push_jsonl_diagnostics(
    diagnostics: &mut Vec<RuntimeMigrationDiagnostic>,
    kind: RuntimeMigrationSourceKind,
    path: impl AsRef<Path>,
) {
    let path = path.as_ref();
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) => {
            diagnostics.push(RuntimeMigrationDiagnostic {
                severity: RuntimeMigrationDiagnosticSeverity::Error,
                kind,
                path: path_string(path),
                message: format!("unreadable JSONL: {error}"),
            });
            return;
        }
    };
    for (index, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        if let Err(error) = serde_json::from_str::<Value>(line) {
            diagnostics.push(RuntimeMigrationDiagnostic {
                severity: RuntimeMigrationDiagnosticSeverity::Error,
                kind,
                path: path_string(path),
                message: format!("invalid JSONL on line {}: {error}", index + 1),
            });
        }
    }
}

fn read_legacy_json_files(dir: &Path) -> Vec<Value> {
    list_files(dir, |name| name.ends_with(".json"))
        .into_iter()
        .filter_map(|path| fs::read_to_string(path).ok())
        .filter_map(|text| serde_json::from_str::<Value>(&text).ok())
        .collect()
}

fn read_legacy_messages(dir: &Path, thread_ids: &[String]) -> Vec<Value> {
    thread_ids
        .iter()
        .flat_map(|thread_id| {
            fs::read_to_string(dir.join(format!("{thread_id}.jsonl")))
                .ok()
                .into_iter()
                .flat_map(|text| {
                    text.lines()
                        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
                        .collect::<Vec<_>>()
                })
        })
        .collect()
}

fn empty_legacy_counts() -> Map<String, Value> {
    let mut counts = Map::new();
    for kind in [
        RuntimeMigrationSourceKind::LegacyContext,
        RuntimeMigrationSourceKind::LegacyHistory,
        RuntimeMigrationSourceKind::LegacyStatus,
        RuntimeMigrationSourceKind::LegacyThread,
        RuntimeMigrationSourceKind::LegacyMessageLog,
        RuntimeMigrationSourceKind::LegacyTask,
        RuntimeMigrationSourceKind::LegacyPlan,
        RuntimeMigrationSourceKind::LegacyRecording,
        RuntimeMigrationSourceKind::LegacyAttachment,
        RuntimeMigrationSourceKind::RuntimeTopology,
        RuntimeMigrationSourceKind::RuntimeExchange,
        RuntimeMigrationSourceKind::SavedState,
        RuntimeMigrationSourceKind::Metadata,
    ] {
        counts.insert(kind.as_key().into(), Value::from(0));
    }
    counts
}

fn set_count(counts: &mut Map<String, Value>, kind: RuntimeMigrationSourceKind, count: usize) {
    counts.insert(kind.as_key().into(), Value::from(count));
}

fn list_files(dir: &Path, predicate: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_str().is_some_and(&predicate))
        .map(|entry| entry.path())
        .collect()
}

fn list_nested_files(dir: &Path, predicate: fn(&str) -> bool) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut paths = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if entry.file_type().is_ok_and(|file_type| file_type.is_dir()) {
            paths.extend(list_nested_files(&path, predicate));
        } else if entry.file_name().to_str().is_some_and(predicate) {
            paths.push(path);
        }
    }
    paths
}

fn has_entries(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false)
}

fn has_error(diagnostics: &[RuntimeMigrationDiagnostic]) -> bool {
    diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == RuntimeMigrationDiagnosticSeverity::Error)
}

fn copy_object_fields(source: &Value, fields: &[&str]) -> Value {
    let mut record = Map::new();
    for field in fields {
        if let Some(value) = source.get(*field) {
            record.insert((*field).into(), value.clone());
        }
    }
    Value::Object(record)
}

fn normalize_review_status(status: Option<&Value>) -> Option<&'static str> {
    let normalized = status
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
        .replace(['-', ' '], "_");
    match normalized.as_str() {
        "approved" | "approve" => Some("approved"),
        "changes_requested" | "request_changes" => Some("changes_requested"),
        "pending" => Some("pending"),
        _ => None,
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn string_array_field(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

fn insert_string(record: &mut Map<String, Value>, key: &str, value: impl Into<String>) {
    record.insert(key.into(), Value::String(value.into()));
}

fn insert_from_field(record: &mut Map<String, Value>, key: &str, source: &Value, source_key: &str) {
    if let Some(value) = string_field(source, source_key) {
        insert_string(record, key, value);
    }
}

fn context_file(name: &str) -> bool {
    name.ends_with(".md") || name.ends_with(".jsonl")
}

fn recording_file(name: &str) -> bool {
    name.ends_with(".txt") || name.ends_with(".log")
}

fn array_len(value: &Value, key: &str) -> usize {
    value.get(key).and_then(Value::as_array).map_or(0, Vec::len)
}

fn timestamp_for_path(generated_at: &str) -> String {
    generated_at.replace([':', '.'], "-")
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

fn path_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().into_owned()
}
