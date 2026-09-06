use aimux::install_cleanup::{
    DEFAULT_INSTALL_KEEP_RECENT, DEFAULT_INSTALL_RETENTION_DAYS, InstallCleanupCandidate,
    InstallReferenceText, PlanInstallCleanupOptions, REMOVING_SUFFIX, RunInstallCleanupInput,
    plan_install_cleanup, run_install_cleanup,
};
use serde_json::{Value, json};
use std::fs::{self, create_dir_all};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
use std::os::unix::{ffi::OsStrExt, fs::symlink};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static ENV_LOCK: Mutex<()> = Mutex::new(());
const NOW_MS: u128 = 1_786_224_000_000;
const DAY_MS: u128 = 24 * 60 * 60 * 1000;
const INSTALL_CLEANUP: &str =
    include_str!("../../../../testdata/contracts/v1/install-cleanup/cleanup.json");

struct TestRoot {
    base: PathBuf,
    root: PathBuf,
    shim: PathBuf,
}

impl TestRoot {
    fn new(label: &str) -> Self {
        let base = std::env::temp_dir().join(format!(
            "aimux-install-cleanup-fixture-{label}-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("native");
        create_dir_all(&root).expect("create install root");
        Self {
            shim: base.join("aimux"),
            base,
            root,
        }
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

#[test]
fn fixture_install_cleanup_matches_typescript() {
    let contract: Value = serde_json::from_str(INSTALL_CLEANUP).expect("valid cleanup fixture");
    let cases = contract["cases"].as_array().expect("install cleanup cases");
    assert_eq!(cases.len(), 22, "unexpected install-cleanup case count");
    let mut failures = Vec::new();
    for case in cases {
        let actual = run_case(&case["input"]);
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
        "{} install-cleanup parity failures:\n{}",
        failures.len(),
        serde_json::to_string_pretty(&failures).expect("serialize failures")
    );
}

fn run_case(input: &Value) -> Value {
    let scenario = input["scenario"].as_str().unwrap_or_default();
    let dirs = TestRoot::new(scenario);
    normalize_value(
        match scenario {
            "old-unreferenced" => {
                make_install(&dirs.root, "old-a", 90);
                make_install(&dirs.root, "old-b", 45);
                make_install(&dirs.root, "fresh", 2);
                to_json(plan(&dirs, PlanInstallCleanupOptions::default()))
            }
            "current-install" => scenario_current_install(&dirs),
            "live-reference" => {
                make_install(&dirs.root, "busy", 200);
                let root = path_string(&dirs.root);
                to_json(plan(
                    &dirs,
                    PlanInstallCleanupOptions {
                        list_reference_text: Some(Box::new(move || InstallReferenceText {
                            text: vec![format!(
                                "node {root}/busy/dist/launcher-bin.js --tmux-dashboard-internal"
                            )],
                            complete: true,
                        })),
                        ..PlanInstallCleanupOptions::default()
                    },
                ))
            }
            "tmux-binding-reference" => {
                make_install(&dirs.root, "bound", 300);
                make_install(&dirs.root, "unbound", 300);
                let root = path_string(&dirs.root);
                to_json(plan(
                    &dirs,
                    PlanInstallCleanupOptions {
                        list_reference_text: Some(Box::new(move || InstallReferenceText {
                            text: vec![format!(
                                "bind-key -T root MouseDown1Pane run-shell '{root}/bound/scripts/x.sh'"
                            )],
                            complete: true,
                        })),
                        ..PlanInstallCleanupOptions::default()
                    },
                ))
            }
            "keep-newest" => {
                make_install(&dirs.root, "older", 300);
                make_install(&dirs.root, "newer", 200);
                to_json(plan(
                    &dirs,
                    PlanInstallCleanupOptions {
                        keep_recent: Some(1),
                        ..PlanInstallCleanupOptions::default()
                    },
                ))
            }
            "missing-root" => to_json(plan_install_cleanup(PlanInstallCleanupOptions {
                root: Some(path_string(dirs.root.join("does-not-exist"))),
                now_ms: Some(NOW_MS),
                stable_shim_path: Some(path_string(&dirs.shim)),
                keep_recent: Some(0),
                list_reference_text: Some(Box::new(empty_references)),
                ..PlanInstallCleanupOptions::default()
            })),
            "dry-run" => {
                make_install(&dirs.root, "old", 90);
                let removed = Vec::<String>::new();
                let result = run_install_cleanup(
                    plan(&dirs, PlanInstallCleanupOptions::default()),
                    RunInstallCleanupInput {
                        dry_run: Some(true),
                        remove_dir: Some(Box::new(|_| Ok(()))),
                        ..RunInstallCleanupInput::default()
                    },
                );
                json!({ "result": result, "removed": removed })
            }
            "remove-planned" => {
                make_install(&dirs.root, "old", 90);
                let result = run_install_cleanup(
                    plan(&dirs, PlanInstallCleanupOptions::default()),
                    RunInstallCleanupInput {
                        dry_run: Some(false),
                        remove_dir: Some(Box::new(|_| Ok(()))),
                        ..RunInstallCleanupInput::default()
                    },
                );
                json!({ "result": result, "removed": [path_string(dirs.root.join("old"))] })
            }
            "escape-candidate" => {
                let mut target = plan(&dirs, PlanInstallCleanupOptions::default());
                target.remove.push(InstallCleanupCandidate {
                    name: "escape".into(),
                    path: "/etc/passwd".into(),
                    age_days: 999.0,
                    size_bytes: 0,
                });
                let result = run_install_cleanup(
                    target,
                    RunInstallCleanupInput {
                        dry_run: Some(false),
                        remove_dir: Some(Box::new(|_| Ok(()))),
                        ..RunInstallCleanupInput::default()
                    },
                );
                json!({ "result": result, "removed": [] })
            }
            "failed-removal" => {
                make_install(&dirs.root, "bad", 90);
                make_install(&dirs.root, "good", 91);
                to_json(run_install_cleanup(
                    plan(&dirs, PlanInstallCleanupOptions::default()),
                    RunInstallCleanupInput {
                        dry_run: Some(false),
                        remove_dir: Some(Box::new(|path| {
                            if path.ends_with("bad") {
                                Err("permission denied".into())
                            } else {
                                Ok(())
                            }
                        })),
                        ..RunInstallCleanupInput::default()
                    },
                ))
            }
            "newest-content-age" => {
                let path = make_install(&dirs.root, "freshly-installed", 400);
                set_age(&path.join("dist"), 1);
                to_json(plan(&dirs, PlanInstallCleanupOptions::default()))
            }
            "incomplete-references" => {
                make_install(&dirs.root, "old-a", 400);
                make_install(&dirs.root, "old-b", 400);
                to_json(plan(
                    &dirs,
                    PlanInstallCleanupOptions {
                        list_reference_text: Some(Box::new(|| InstallReferenceText {
                            text: Vec::new(),
                            complete: false,
                        })),
                        ..PlanInstallCleanupOptions::default()
                    },
                ))
            }
            "canonical-reference" => {
                make_install(&dirs.root, "busy", 400);
                let canonical_root = fs::canonicalize(&dirs.root)
                    .unwrap_or_else(|_| dirs.root.clone())
                    .to_string_lossy()
                    .into_owned();
                to_json(plan(
                    &dirs,
                    PlanInstallCleanupOptions {
                        list_reference_text: Some(Box::new(move || InstallReferenceText {
                            text: vec![format!("node {canonical_root}/busy/dist/launcher-bin.js")],
                            complete: true,
                        })),
                        ..PlanInstallCleanupOptions::default()
                    },
                ))
            }
            "trailing-slash-root" => {
                make_install(&dirs.root, "busy", 400);
                let root = path_string(&dirs.root);
                to_json(plan_install_cleanup(PlanInstallCleanupOptions {
                    root: Some(format!("{root}/")),
                    now_ms: Some(NOW_MS),
                    stable_shim_path: Some(path_string(&dirs.shim)),
                    keep_recent: Some(0),
                    list_reference_text: Some(Box::new(move || InstallReferenceText {
                        text: vec![format!("node {root}/busy/dist/launcher-bin.js")],
                        complete: true,
                    })),
                    ..PlanInstallCleanupOptions::default()
                }))
            }
            "env-root" => scenario_env_root(&dirs),
            "default-dry-run" => {
                make_install(&dirs.root, "old", 90);
                let result = run_install_cleanup(
                    plan(&dirs, PlanInstallCleanupOptions::default()),
                    RunInstallCleanupInput {
                        remove_dir: Some(Box::new(|_| Ok(()))),
                        ..RunInstallCleanupInput::default()
                    },
                );
                json!({ "result": result, "removed": [] })
            }
            "half-written-install" => {
                let path = make_install(&dirs.root, "mid-install", 400);
                fs::remove_file(path.join("bin/aimux")).expect("remove aimux");
                to_json(plan(&dirs, PlanInstallCleanupOptions::default()))
            }
            "oldest-first" => {
                make_install(&dirs.root, "middle", 100);
                make_install(&dirs.root, "oldest", 300);
                make_install(&dirs.root, "newest", 40);
                to_json(plan(&dirs, PlanInstallCleanupOptions::default()))
            }
            "limit-removals" => {
                make_install(&dirs.root, "a", 300);
                make_install(&dirs.root, "b", 200);
                make_install(&dirs.root, "c", 100);
                let result = run_install_cleanup(
                    plan(&dirs, PlanInstallCleanupOptions::default()),
                    RunInstallCleanupInput {
                        dry_run: Some(false),
                        limit: Some(2),
                        remove_dir: Some(Box::new(|_| Ok(()))),
                    },
                );
                json!({
                    "result": result,
                    "removed": [path_string(dirs.root.join("a")), path_string(dirs.root.join("b"))]
                })
            }
            "debris" => {
                create_dir_all(dirs.root.join(format!("abandoned{REMOVING_SUFFIX}/dist")))
                    .expect("create debris");
                to_json(plan(&dirs, PlanInstallCleanupOptions::default()))
            }
            "rename-before-delete" => {
                let path = make_install(&dirs.root, "doomed", 90);
                let result = run_install_cleanup(
                    plan(&dirs, PlanInstallCleanupOptions::default()),
                    RunInstallCleanupInput {
                        dry_run: Some(false),
                        ..RunInstallCleanupInput::default()
                    },
                );
                json!({
                    "result": result,
                    "exists": path.exists(),
                    "removingExists": PathBuf::from(format!("{}{}", path.to_string_lossy(), REMOVING_SUFFIX)).exists()
                })
            }
            "defaults" => json!({
                "defaultRetentionDays": DEFAULT_INSTALL_RETENTION_DAYS,
                "defaultKeepRecent": DEFAULT_INSTALL_KEEP_RECENT,
            }),
            other => json!({ "error": format!("unknown scenario: {other}") }),
        },
        &dirs.base,
    )
}

fn scenario_current_install(dirs: &TestRoot) -> Value {
    let current = make_install(&dirs.root, "current", 400);
    #[cfg(unix)]
    {
        symlink(current.join("dist/launcher-bin.js"), &dirs.shim).expect("link shim");
    }
    to_json(plan(dirs, PlanInstallCleanupOptions::default()))
}

fn scenario_env_root(dirs: &TestRoot) -> Value {
    make_install(&dirs.root, "old", 400);
    let _guard = ENV_LOCK.lock().expect("env lock");
    let previous = std::env::var_os("AIMUX_INSTALL_ROOT");
    unsafe {
        std::env::set_var("AIMUX_INSTALL_ROOT", &dirs.root);
    }
    let result = plan_install_cleanup(PlanInstallCleanupOptions {
        now_ms: Some(NOW_MS),
        stable_shim_path: Some(path_string(&dirs.shim)),
        list_reference_text: Some(Box::new(empty_references)),
        keep_recent: Some(0),
        ..PlanInstallCleanupOptions::default()
    });
    unsafe {
        match previous {
            Some(value) => std::env::set_var("AIMUX_INSTALL_ROOT", value),
            None => std::env::remove_var("AIMUX_INSTALL_ROOT"),
        }
    }
    to_json(result)
}

fn plan(
    dirs: &TestRoot,
    overrides: PlanInstallCleanupOptions,
) -> aimux::install_cleanup::InstallCleanupPlan {
    let PlanInstallCleanupOptions {
        root,
        keep_recent,
        retention_days,
        now_ms,
        stable_shim_path,
        list_reference_text,
        measure_size,
    } = overrides;
    plan_install_cleanup(PlanInstallCleanupOptions {
        root: root.or_else(|| Some(path_string(&dirs.root))),
        keep_recent: keep_recent.or(Some(0)),
        retention_days,
        now_ms: now_ms.or(Some(NOW_MS)),
        stable_shim_path: stable_shim_path.or_else(|| Some(path_string(&dirs.shim))),
        list_reference_text: list_reference_text.or_else(|| Some(Box::new(empty_references))),
        measure_size,
    })
}

fn empty_references() -> InstallReferenceText {
    InstallReferenceText {
        text: Vec::new(),
        complete: true,
    }
}

fn make_install(root: &Path, name: &str, age_days: u64) -> PathBuf {
    let path = root.join(name);
    create_dir_all(path.join("dist")).expect("create dist");
    create_dir_all(path.join("bin")).expect("create bin");
    fs::write(path.join("dist/launcher-bin.js"), "x".repeat(1024)).expect("write launcher");
    fs::write(path.join("bin/aimux"), "#!/bin/sh\n").expect("write aimux");
    set_age(&path, age_days);
    set_age(&path.join("dist"), age_days);
    set_age(&path.join("bin"), age_days);
    path
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
        assert_eq!(rc, 0, "set file time failed");
    }
    #[cfg(not(unix))]
    {
        let _ = (path, age_days);
    }
}

fn to_json(value: impl serde::Serialize) -> Value {
    serde_json::to_value(value).expect("serialize value")
}

fn path_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().into_owned()
}

fn normalize_value(value: Value, base: &Path) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|item| normalize_value(item, base))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(key, value)| (key, normalize_value(value, base)))
                .collect(),
        ),
        Value::String(text) => {
            let base_text = base.to_string_lossy().to_string();
            let canonical = fs::canonicalize(base)
                .ok()
                .map(|path| path.to_string_lossy().to_string());
            let mut normalized = text.replace(&base_text, "<root>");
            if let Some(canonical) = canonical {
                normalized = normalized.replace(&canonical, "<root>");
            }
            Value::String(normalized)
        }
        value => value,
    }
}
