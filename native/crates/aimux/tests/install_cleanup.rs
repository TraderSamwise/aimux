use aimux::install_cleanup::{
    DEFAULT_INSTALL_KEEP_RECENT, DEFAULT_INSTALL_RETENTION_DAYS, InstallCleanupCandidate,
    InstallCleanupItemStatus, InstallKeepReason, InstallReferenceText, PlanInstallCleanupOptions,
    REMOVING_SUFFIX, RunInstallCleanupInput, is_install_cleanup_dry_run, plan_install_cleanup,
    render_install_cleanup_plan, render_install_cleanup_result, run_install_cleanup,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
use std::os::unix::{ffi::OsStrExt, fs::symlink};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);
const NOW_MS: u128 = 1_786_224_000_000;
const DAY_MS: u128 = 24 * 60 * 60 * 1000;

struct TestDir(PathBuf);

impl TestDir {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "aimux-install-cleanup-rust-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("create temp dir");
        Self(path)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn make_install(root: &Path, name: &str, age_days: u64) -> PathBuf {
    let path = root.join(name);
    fs::create_dir_all(path.join("dist")).expect("create dist");
    fs::create_dir_all(path.join("bin")).expect("create bin");
    fs::write(path.join("dist/launcher-bin.js"), "x".repeat(1024)).expect("write launcher");
    fs::write(path.join("bin/aimux"), "#!/bin/sh\n").expect("write aimux");
    set_age(&path, age_days);
    set_age(&path.join("dist"), age_days);
    set_age(&path.join("bin"), age_days);
    path
}

fn plan(
    root: &Path,
    shim: &Path,
    overrides: PlanInstallCleanupOptions,
) -> aimux::install_cleanup::InstallCleanupPlan {
    let PlanInstallCleanupOptions {
        root: override_root,
        keep_recent,
        retention_days,
        now_ms,
        stable_shim_path,
        list_reference_text,
        measure_size,
    } = overrides;
    plan_install_cleanup(PlanInstallCleanupOptions {
        root: override_root.or_else(|| Some(root.to_string_lossy().into_owned())),
        keep_recent: keep_recent.or(Some(0)),
        retention_days,
        now_ms: now_ms.or(Some(NOW_MS)),
        stable_shim_path: stable_shim_path.or_else(|| Some(shim.to_string_lossy().into_owned())),
        list_reference_text: list_reference_text.or_else(|| {
            Some(Box::new(|| InstallReferenceText {
                text: Vec::new(),
                complete: true,
            }))
        }),
        measure_size,
    })
}

#[test]
fn removes_only_old_unreferenced_complete_installs() {
    let dir = TestDir::new("old-unreferenced");
    let root = dir.0.join("native");
    fs::create_dir_all(&root).expect("create root");
    let shim = dir.0.join("aimux");
    make_install(&root, "old-a", 90);
    make_install(&root, "old-b", 45);
    make_install(&root, "fresh", 2);

    let result = plan(&root, &shim, PlanInstallCleanupOptions::default());

    let mut names = result
        .remove
        .iter()
        .map(|entry| entry.name.as_str())
        .collect::<Vec<_>>();
    names.sort();
    assert_eq!(names, vec!["old-a", "old-b"]);
    assert!(
        result
            .keep
            .contains(&aimux::install_cleanup::InstallCleanupKept {
                name: "fresh".into(),
                reason: InstallKeepReason::WithinRetention,
            })
    );
    assert!(result.reclaimable_bytes > 0);
}

#[cfg(unix)]
#[test]
fn keeps_current_referenced_recent_incomplete_and_unverified_installs() {
    let dir = TestDir::new("keep-reasons");
    let root = dir.0.join("native");
    fs::create_dir_all(&root).expect("create root");
    let shim = dir.0.join("aimux");
    let current = make_install(&root, "current", 400);
    make_install(&root, "busy", 300);
    make_install(&root, "newer", 200);
    let incomplete = make_install(&root, "mid-install", 400);
    fs::remove_file(incomplete.join("bin/aimux")).expect("remove aimux");
    set_age(&incomplete, 400);
    set_age(&incomplete.join("bin"), 400);
    symlink(current.join("dist/launcher-bin.js"), &shim).expect("link shim");

    let result = plan(
        &root,
        &shim,
        PlanInstallCleanupOptions {
            keep_recent: Some(1),
            list_reference_text: Some(Box::new({
                let root = root.clone();
                move || InstallReferenceText {
                    text: vec![format!(
                        "node {}/busy/dist/launcher-bin.js",
                        root.to_string_lossy()
                    )],
                    complete: true,
                }
            })),
            ..PlanInstallCleanupOptions::default()
        },
    );

    assert_eq!(result.current_install.as_deref(), Some("current"));
    assert!(
        result
            .keep
            .contains(&aimux::install_cleanup::InstallCleanupKept {
                name: "current".into(),
                reason: InstallKeepReason::CurrentInstall,
            })
    );
    assert!(
        result
            .keep
            .contains(&aimux::install_cleanup::InstallCleanupKept {
                name: "busy".into(),
                reason: InstallKeepReason::InUse,
            })
    );
    assert!(
        result
            .keep
            .contains(&aimux::install_cleanup::InstallCleanupKept {
                name: "newer".into(),
                reason: InstallKeepReason::Recent,
            })
    );
    assert!(
        result
            .keep
            .contains(&aimux::install_cleanup::InstallCleanupKept {
                name: "mid-install".into(),
                reason: InstallKeepReason::Incomplete,
            })
    );

    let unverified = plan(
        &root,
        &shim,
        PlanInstallCleanupOptions {
            list_reference_text: Some(Box::new(|| InstallReferenceText {
                text: Vec::new(),
                complete: false,
            })),
            ..PlanInstallCleanupOptions::default()
        },
    );
    assert!(unverified.remove.is_empty());
    assert!(
        unverified
            .keep
            .iter()
            .any(|entry| entry.reason == InstallKeepReason::ReferencesUnverified)
    );
}

#[test]
fn run_cleanup_defaults_to_dry_run_and_caps_real_sweeps() {
    let plan = aimux::install_cleanup::InstallCleanupPlan {
        root: "/root/native".into(),
        current_install: None,
        retention_days: 30,
        keep_recent: 0,
        references_complete: true,
        remove: vec![
            candidate("a", 300),
            candidate("b", 200),
            candidate("c", 100),
        ],
        keep: Vec::new(),
        reclaimable_bytes: 30,
    };

    let dry_run = run_install_cleanup(plan.clone(), RunInstallCleanupInput::default());
    assert!(dry_run.dry_run);
    assert!(
        dry_run
            .results
            .iter()
            .all(|entry| entry.status == InstallCleanupItemStatus::DryRun)
    );

    let real = run_install_cleanup(
        plan,
        RunInstallCleanupInput {
            dry_run: Some(false),
            limit: Some(2),
            remove_dir: Some(Box::new(|_| Ok(()))),
        },
    );
    assert_eq!(real.results.len(), 2);
    assert_eq!(real.results[0].status, InstallCleanupItemStatus::Removed);
    assert_eq!(real.reclaimed_bytes, 20);
}

#[test]
fn renderers_match_install_doctor_contract() {
    let plan = aimux::install_cleanup::InstallCleanupPlan {
        root: "/root/native".into(),
        current_install: Some("current".into()),
        retention_days: 30,
        keep_recent: 10,
        references_complete: true,
        remove: vec![InstallCleanupCandidate {
            name: "old".into(),
            path: "/root/native/old".into(),
            age_days: 70.4,
            size_bytes: 19_000_000,
        }],
        keep: vec![
            aimux::install_cleanup::InstallCleanupKept {
                name: "current".into(),
                reason: InstallKeepReason::CurrentInstall,
            },
            aimux::install_cleanup::InstallCleanupKept {
                name: "busy".into(),
                reason: InstallKeepReason::InUse,
            },
        ],
        reclaimable_bytes: 19_000_000,
    };

    let text = render_install_cleanup_plan(&plan);
    assert!(text.contains("root: /root/native"));
    assert!(text.contains("current: current"));
    assert!(text.contains("removable: 1 (19 MB)"));
    assert!(text.contains("old  70d  19 MB"));

    let result = render_install_cleanup_result(&aimux::install_cleanup::InstallCleanupRunResult {
        dry_run: true,
        plan,
        results: Vec::new(),
        reclaimed_bytes: 0,
    });
    assert!(result.contains("Dry run: nothing was removed"));
    assert!(result.contains("--fix"));
}

#[test]
fn debris_is_always_removable_and_defaults_are_conservative() {
    let dir = TestDir::new("debris");
    let root = dir.0.join("native");
    let shim = dir.0.join("aimux");
    fs::create_dir_all(root.join(format!("abandoned{REMOVING_SUFFIX}/dist")))
        .expect("create debris");

    let result = plan(&root, &shim, PlanInstallCleanupOptions::default());

    assert_eq!(result.remove[0].name, format!("abandoned{REMOVING_SUFFIX}"));
    assert_eq!(DEFAULT_INSTALL_RETENTION_DAYS, 30);
    assert_eq!(DEFAULT_INSTALL_KEEP_RECENT, 10);
    assert!(is_install_cleanup_dry_run(false));
    assert!(!is_install_cleanup_dry_run(true));
}

fn candidate(name: &str, age_days: u64) -> InstallCleanupCandidate {
    InstallCleanupCandidate {
        name: name.into(),
        path: format!("/root/native/{name}"),
        age_days: age_days as f64,
        size_bytes: 10,
    }
}

fn set_age(path: &Path, age_days: u64) {
    #[cfg(unix)]
    {
        let path = std::ffi::CString::new(path.as_os_str().as_bytes()).expect("path bytes");
        let seconds = ((NOW_MS - u128::from(age_days) * DAY_MS) / 1000) as i64;
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
        let rc = unsafe { libc::utimes(path.as_ptr(), times.as_ptr()) };
        if rc != 0 {
            panic!("set file time failed");
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (path, age_days);
    }
}
