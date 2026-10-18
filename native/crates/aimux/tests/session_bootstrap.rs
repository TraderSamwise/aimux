use aimux::session_bootstrap::{
    ForkArtifacts, ForkSourceSnapshot, LAUNCH_PREAMBLE_ARGV_BUDGET_BYTES,
    cap_launch_preamble_for_argv, read_fork_source_snapshot, seed_fork_artifacts,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

struct Project(PathBuf);

impl Project {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "aimux-fork-bootstrap-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        fs::create_dir_all(path.join(".git")).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn write(&self, relative: &str, text: &str) {
        let path = self.0.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn assert_no_target(&self) {
        for relative in [
            ".aimux/context/target",
            ".aimux/history/target.jsonl",
            ".aimux/status/target.md",
            ".aimux/plans/target.md",
        ] {
            assert!(
                fs::symlink_metadata(self.0.join(relative)).is_err(),
                "{relative}"
            );
        }
    }
}

impl Drop for Project {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn fork_snapshot_distinguishes_missing_context_from_read_and_parse_failures() {
    let project = Project::new();
    let missing = read_fork_source_snapshot(project.path(), "source").unwrap();
    assert!(missing.history_text.is_none());
    assert!(missing.live_text.is_none());
    assert!(missing.plan_text.is_none());
    assert!(missing.status_text.is_none());
    project.write(
        ".aimux/history/source.jsonl",
        "{\"type\":\"prompt\",\"content\":\"keep context\"}\n{\n",
    );
    let error = read_fork_source_snapshot(project.path(), "source").unwrap_err();
    assert!(error.contains("source.jsonl line 2"), "{error}");
    fs::remove_file(project.path().join(".aimux/history/source.jsonl")).unwrap();
    for relative in [
        ".aimux/history/source.jsonl",
        ".aimux/context/source/live.md",
        ".aimux/plans/source.md",
        ".aimux/status/source.md",
    ] {
        let path = project.path().join(relative);
        fs::create_dir_all(&path).unwrap();
        let error = read_fork_source_snapshot(project.path(), "source").unwrap_err();
        assert!(
            error.contains(relative.split('/').next_back().unwrap()),
            "{error}"
        );
        fs::remove_dir(path).unwrap();
    }
}

#[test]
fn fork_snapshot_and_seed_preserve_portable_context_and_leave_source_untouched() {
    let project = Project::new();
    let source_history = "{\"type\":\"prompt\",\"content\":\"repair selection\"}\n{\"type\":\"response\",\"content\":\"checked defaults\"}\n";
    project.write(".aimux/history/source.jsonl", source_history);
    project.write(".aimux/context/source/live.md", "source live context");
    project.write(".aimux/status/source.md", "source progress");
    project.write(".aimux/plans/source.md", "# Goal\n\nPreserve work\n");
    let snapshot = read_fork_source_snapshot(project.path(), "source").unwrap();
    assert!(
        snapshot
            .history_text
            .as_deref()
            .unwrap()
            .contains("User: repair selection")
    );
    let mut artifacts = seed_fork_artifacts(
        project.path(),
        "source",
        "target",
        "codex",
        Some("/worktree"),
        &snapshot,
    )
    .unwrap();
    let summary =
        fs::read_to_string(project.path().join(".aimux/context/target/summary.md")).unwrap();
    for expected in [
        "repair selection",
        "source live context",
        "source progress",
        "Preserve work",
    ] {
        assert!(summary.contains(expected), "{summary}");
    }
    assert!(
        !project
            .path()
            .join(".aimux/context/target/live.md")
            .exists()
    );
    assert_eq!(
        fs::read_to_string(project.path().join(".aimux/history/target.jsonl")).unwrap(),
        source_history
    );
    artifacts.rollback().unwrap();
    project.assert_no_target();
    assert_eq!(
        fs::read_to_string(project.path().join(".aimux/history/source.jsonl")).unwrap(),
        source_history
    );
    assert_eq!(
        fs::read_to_string(project.path().join(".aimux/context/source/live.md")).unwrap(),
        "source live context"
    );
    assert_eq!(
        fs::read_to_string(project.path().join(".aimux/status/source.md")).unwrap(),
        "source progress"
    );
    assert_eq!(
        fs::read_to_string(project.path().join(".aimux/plans/source.md")).unwrap(),
        "# Goal\n\nPreserve work\n"
    );
}

#[test]
fn fork_artifact_collision_preserves_existing_files_and_dangling_symlinks() {
    for relative in [
        ".aimux/context/target",
        ".aimux/history/target.jsonl",
        ".aimux/status/target.md",
        ".aimux/plans/target.md",
    ] {
        let project = Project::new();
        project.write(relative, "existing identity");
        let error = ForkArtifacts::prepare(project.path(), "target").unwrap_err();
        assert!(error.contains("already exists"), "{error}");
        assert_eq!(
            fs::read_to_string(project.path().join(relative)).unwrap(),
            "existing identity"
        );
    }
    #[cfg(unix)]
    {
        let project = Project::new();
        fs::create_dir_all(project.path().join(".aimux/history")).unwrap();
        let path = project.path().join(".aimux/history/target.jsonl");
        std::os::unix::fs::symlink(project.path().join("missing"), &path).unwrap();
        let error = ForkArtifacts::prepare(project.path(), "target").unwrap_err();
        assert!(error.contains("already exists"), "{error}");
        assert!(fs::symlink_metadata(path).unwrap().file_type().is_symlink());
    }
}

#[test]
fn fork_artifact_partial_seed_error_rolls_back_and_names_the_source_path() {
    let project = Project::new();
    project.write(
        ".aimux/history/source.jsonl",
        "{\"type\":\"prompt\",\"content\":\"history\"}\n",
    );
    fs::create_dir_all(project.path().join(".aimux/status/source.md")).unwrap();
    let error = seed_fork_artifacts(
        project.path(),
        "source",
        "target",
        "codex",
        None,
        &ForkSourceSnapshot::default(),
    )
    .unwrap_err();
    assert!(error.contains("source.md"), "{error}");
    project.assert_no_target();
    assert!(project.path().join(".aimux/history/source.jsonl").is_file());
    assert!(project.path().join(".aimux/status/source.md").is_dir());
}

#[test]
fn fork_native_artifacts_rollback_and_commit_include_launch_generated_files() {
    for commit in [false, true] {
        let project = Project::new();
        let mut artifacts = ForkArtifacts::prepare(project.path(), "target").unwrap();
        let settings = project.path().join("state/claude-settings/target.json");
        artifacts.reserve_file(&settings).unwrap();
        artifacts
            .write_default_plan("claude", Some("/worktree"))
            .unwrap();
        project.write(
            ".aimux/context/target/launch-preamble.md",
            "overflow prompt",
        );
        project.write(".aimux/context/target/live.md", "new child context");
        project.write("state/claude-settings/target.json", "{}");
        if commit {
            artifacts.commit();
            assert!(settings.is_file());
            assert!(project.path().join(".aimux/plans/target.md").is_file());
            assert!(
                project
                    .path()
                    .join(".aimux/context/target/launch-preamble.md")
                    .is_file()
            );
        } else {
            artifacts.rollback().unwrap();
            project.assert_no_target();
            assert!(!settings.exists());
        }
    }
}

#[test]
fn fork_artifact_reservation_errors_do_not_delete_another_reservations_files() {
    let project = Project::new();
    let mut first = ForkArtifacts::prepare(project.path(), "target").unwrap();
    first.write_default_plan("claude", None).unwrap();
    let first_plan = fs::read_to_string(project.path().join(".aimux/plans/target.md")).unwrap();
    assert!(
        ForkArtifacts::prepare(project.path(), "target")
            .unwrap_err()
            .contains("already exists")
    );
    assert_eq!(
        fs::read_to_string(project.path().join(".aimux/plans/target.md")).unwrap(),
        first_plan
    );
    first.rollback().unwrap();
}

#[test]
fn fork_artifact_rollback_errors_are_visible_and_do_not_prevent_other_cleanup() {
    let project = Project::new();
    let mut artifacts = ForkArtifacts::prepare(project.path(), "target").unwrap();
    let settings = project.path().join("state/claude-settings/target.json");
    artifacts.reserve_file(&settings).unwrap();
    fs::remove_file(&settings).unwrap();
    fs::create_dir_all(&settings).unwrap();
    let error = artifacts.rollback().unwrap_err();
    assert!(error.contains("target.json"), "{error}");
    project.assert_no_target();
    fs::remove_dir(settings).unwrap();
    artifacts.rollback().unwrap();
}

#[test]
fn fork_artifact_ids_and_inspection_failures_refuse_before_mutation() {
    let project = Project::new();
    for invalid in ["../escape", "", "nested/id", "has.dot"] {
        assert!(
            ForkArtifacts::prepare(project.path(), invalid)
                .unwrap_err()
                .contains("invalid fork sessionId")
        );
        assert!(
            read_fork_source_snapshot(project.path(), invalid)
                .unwrap_err()
                .contains("invalid fork sessionId")
        );
    }
    project.write(".aimux/history", "not a directory");
    let error = ForkArtifacts::prepare(project.path(), "target").unwrap_err();
    assert!(error.contains("inspect fork artifact"), "{error}");
    assert_eq!(
        fs::read_to_string(project.path().join(".aimux/history")).unwrap(),
        "not a directory"
    );
    assert!(!project.path().join(".aimux/context/target").exists());
}

#[test]
fn fork_seed_race_preserves_foreign_files_created_after_prepare() {
    for relative in [
        ".aimux/history/target.jsonl",
        ".aimux/status/target.md",
        ".aimux/plans/target.md",
    ] {
        let project = Project::new();
        project.write(".aimux/history/source.jsonl", "{\"content\":\"source\"}\n");
        project.write(".aimux/status/source.md", "source status");
        let mut artifacts = ForkArtifacts::prepare(project.path(), "target").unwrap();
        project.write(relative, "foreign bytes written after prepare");
        let error = artifacts
            .seed("source", "codex", None, &ForkSourceSnapshot::default())
            .unwrap_err();
        assert!(error.contains("create fork artifact"), "{error}");
        artifacts.rollback().unwrap();
        assert_eq!(
            fs::read_to_string(project.path().join(relative)).unwrap(),
            "foreign bytes written after prepare"
        );
        assert!(!project.path().join(".aimux/context/target").exists());
        for candidate in [
            ".aimux/history/target.jsonl",
            ".aimux/status/target.md",
            ".aimux/plans/target.md",
        ] {
            if candidate != relative {
                assert!(!project.path().join(candidate).exists(), "{candidate}");
            }
        }
    }
}

#[test]
fn fork_reservation_race_preserves_foreign_settings_and_plan_bytes() {
    for reserve_settings in [false, true] {
        let project = Project::new();
        let mut artifacts = ForkArtifacts::prepare(project.path(), "target").unwrap();
        let relative = if reserve_settings {
            "state/claude-settings/target.json"
        } else {
            ".aimux/plans/target.md"
        };
        project.write(relative, "foreign bytes written after prepare");
        let error = if reserve_settings {
            artifacts.reserve_file(project.path().join(relative))
        } else {
            artifacts.write_default_plan("claude", None)
        }
        .unwrap_err();
        assert!(error.contains("create fork artifact"), "{error}");
        artifacts.rollback().unwrap();
        assert_eq!(
            fs::read_to_string(project.path().join(relative)).unwrap(),
            "foreign bytes written after prepare"
        );
        assert!(!project.path().join(".aimux/context/target").exists());
    }
}

#[test]
fn launch_preamble_short_text_needs_no_writable_overflow_directory() {
    let project = Project::new();
    project.write("blocked-root", "not a directory");
    for text in ["", "short context", "界🙂"] {
        assert_eq!(
            cap_launch_preamble_for_argv(&project.path().join("blocked-root"), "target", text)
                .unwrap(),
            text,
        );
    }
    assert_eq!(
        fs::read_to_string(project.path().join("blocked-root")).unwrap(),
        "not a directory"
    );
}

#[test]
fn launch_preamble_overflow_preserves_full_text_and_reports_directory_or_write_errors() {
    let project = Project::new();
    let text = format!(
        "{}\nlast carried context",
        "界🙂".repeat(LAUNCH_PREAMBLE_ARGV_BUDGET_BYTES)
    );
    let capped = cap_launch_preamble_for_argv(project.path(), "target", &text).unwrap();
    let overflow = project
        .path()
        .join(".aimux/context/target/launch-preamble.md");
    assert!(capped.len() <= LAUNCH_PREAMBLE_ARGV_BUDGET_BYTES);
    assert!(capped.contains(overflow.to_str().unwrap()), "{capped}");
    assert_eq!(fs::read_to_string(&overflow).unwrap(), format!("{text}\n"));
    fs::remove_file(&overflow).unwrap();
    fs::create_dir(&overflow).unwrap();
    let error = cap_launch_preamble_for_argv(project.path(), "target", &text).unwrap_err();
    assert!(error.contains("write launch preamble"), "{error}");
    assert!(error.contains(overflow.to_str().unwrap()), "{error}");
    assert!(overflow.is_dir());
    fs::remove_dir(&overflow).unwrap();
    fs::remove_dir(overflow.parent().unwrap()).unwrap();
    project.write(".aimux/context/target", "existing obstruction");
    let error = cap_launch_preamble_for_argv(project.path(), "target", &text).unwrap_err();
    assert!(
        error.contains("ensure launch preamble directory"),
        "{error}"
    );
    assert!(
        error.contains(overflow.parent().unwrap().to_str().unwrap()),
        "{error}"
    );
    assert_eq!(
        fs::read_to_string(overflow.parent().unwrap()).unwrap(),
        "existing obstruction"
    );
}

#[test]
fn fork_runtime_files_are_owned_before_child_writes_and_removed_on_rollback() {
    let project = Project::new();
    let mut artifacts = ForkArtifacts::prepare(project.path(), "target").unwrap();
    artifacts.write_default_plan("claude", None).unwrap();
    artifacts.reserve_runtime_files().unwrap();
    for relative in [".aimux/history/target.jsonl", ".aimux/status/target.md"] {
        assert_eq!(
            fs::read_to_string(project.path().join(relative)).unwrap(),
            ""
        );
    }
    project.write("child-history.tmp", "child history written atomically");
    fs::rename(
        project.path().join("child-history.tmp"),
        project.path().join(".aimux/history/target.jsonl"),
    )
    .unwrap();
    project.write(".aimux/status/target.md", "child progress");
    artifacts.reserve_runtime_files().unwrap();
    assert_eq!(
        fs::read_to_string(project.path().join(".aimux/history/target.jsonl")).unwrap(),
        "child history written atomically"
    );
    assert_eq!(
        fs::read_to_string(project.path().join(".aimux/status/target.md")).unwrap(),
        "child progress"
    );
    artifacts.rollback().unwrap();
    project.assert_no_target();
}

#[test]
fn fork_runtime_reservation_preserves_seeded_history_and_status() {
    let project = Project::new();
    project.write(
        ".aimux/history/source.jsonl",
        "{\"content\":\"source history\"}\n",
    );
    project.write(".aimux/status/source.md", "source progress");
    let snapshot = read_fork_source_snapshot(project.path(), "source").unwrap();
    let mut artifacts =
        seed_fork_artifacts(project.path(), "source", "target", "codex", None, &snapshot).unwrap();
    artifacts.reserve_runtime_files().unwrap();
    assert_eq!(
        fs::read_to_string(project.path().join(".aimux/history/target.jsonl")).unwrap(),
        "{\"content\":\"source history\"}\n"
    );
    assert_eq!(
        fs::read_to_string(project.path().join(".aimux/status/target.md")).unwrap(),
        "source progress"
    );
    artifacts.rollback().unwrap();
    project.assert_no_target();
    assert_eq!(
        fs::read_to_string(project.path().join(".aimux/status/source.md")).unwrap(),
        "source progress"
    );
}

#[test]
fn fork_runtime_reservation_race_refuses_and_preserves_foreign_bytes() {
    for relative in [".aimux/history/target.jsonl", ".aimux/status/target.md"] {
        let project = Project::new();
        let mut artifacts = ForkArtifacts::prepare(project.path(), "target").unwrap();
        artifacts.write_default_plan("claude", None).unwrap();
        project.write(relative, "foreign writer won the reservation");
        let error = artifacts.reserve_runtime_files().unwrap_err();
        assert!(error.contains("create fork artifact"), "{error}");
        artifacts.rollback().unwrap();
        assert_eq!(
            fs::read_to_string(project.path().join(relative)).unwrap(),
            "foreign writer won the reservation"
        );
        assert!(!project.path().join(".aimux/context/target").exists());
        assert!(!project.path().join(".aimux/plans/target.md").exists());
        let other = if relative.ends_with(".jsonl") {
            ".aimux/status/target.md"
        } else {
            ".aimux/history/target.jsonl"
        };
        assert!(!project.path().join(other).exists());
    }
}
