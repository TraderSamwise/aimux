use aimux::daemon_state::{
    AimuxDaemonInfo, DaemonState, DaemonStateProjectRootStatus, MetadataApiEndpoint, MetadataState,
    clear_daemon_info_if_owned, get_daemon_base_url, get_daemon_host_from, get_daemon_port_from,
    load_daemon_info_with, load_daemon_info_with_probe, load_daemon_state, load_daemon_state_with,
    load_daemon_state_with_status, load_metadata_endpoint, load_metadata_endpoint_by_project_id,
    load_metadata_state, metadata_endpoint_path, metadata_endpoint_path_by_project_id,
    metadata_endpoint_text_path, metadata_state_path, remove_metadata_endpoint,
    resolve_project_service_endpoint, save_daemon_info, save_daemon_state, save_metadata_endpoint,
    save_metadata_state,
};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir()
            .join("rust-daemon-state-tests")
            .join(format!("{}-{sequence}", std::process::id()));
        fs::create_dir_all(&path).expect("create test directory");
        Self(path)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn daemon_env_contract_accepts_only_loopback_and_integer_ports() {
    assert_eq!(get_daemon_host_from(None), Ok("127.0.0.1".into()));
    assert_eq!(
        get_daemon_host_from(Some(" localhost ")),
        Ok("localhost".into())
    );
    assert!(
        get_daemon_host_from(Some("0.0.0.0"))
            .expect_err("reject non-loopback")
            .contains("must be loopback")
    );
    assert_eq!(get_daemon_port_from(None), Ok(43190));
    assert_eq!(get_daemon_port_from(Some(" 44191 ")), Ok(44191));
    assert!(get_daemon_port_from(Some("1.5")).is_err());
    assert!(get_daemon_port_from(Some("65536")).is_err());
    assert_eq!(get_daemon_port_from(Some("0x10")), Ok(16));
    assert_eq!(get_daemon_port_from(Some("0b10")), Ok(2));
    assert_eq!(get_daemon_port_from(Some("0o10")), Ok(8));
    assert_eq!(get_daemon_port_from(Some("1e2")), Ok(100));
    assert!(get_daemon_port_from(Some("-0x10")).is_err());
    assert_eq!(
        get_daemon_base_url(Some(44191)).unwrap(),
        "http://127.0.0.1:44191"
    );
}

#[test]
fn daemon_info_load_checks_liveness_and_save_is_pretty_json() {
    let test_dir = TestDir::new();
    let path = test_dir.0.join("daemon/daemon.json");
    let info = AimuxDaemonInfo {
        pid: 123,
        port: 43190,
        started_at: "then".into(),
        updated_at: "now".into(),
    };
    save_daemon_info(&path, &info).expect("save info");

    let saved = fs::read_to_string(&path).expect("read info");
    assert!(saved.contains("\"startedAt\": \"then\""));
    assert!(saved.ends_with('\n'));
    assert_eq!(load_daemon_info_with(&path, |pid| pid == 123), Some(info));
    assert_eq!(load_daemon_info_with(&path, |_| false), None);
}

#[test]
fn daemon_info_load_preserves_registration_when_pid_probe_fails() {
    let test_dir = TestDir::new();
    let path = test_dir.0.join("daemon/daemon.json");
    let info = AimuxDaemonInfo {
        pid: 123,
        port: 43190,
        started_at: "then".into(),
        updated_at: "now".into(),
    };
    save_daemon_info(&path, &info).expect("save info");

    assert_eq!(
        load_daemon_info_with_probe(&path, |_| Err("ps unavailable".to_owned())),
        Some(info)
    );
}

#[test]
fn daemon_info_clear_only_truncates_when_pid_matches_owner() {
    let test_dir = TestDir::new();
    let path = test_dir.0.join("daemon/daemon.json");
    let info = AimuxDaemonInfo {
        pid: 123,
        port: 43190,
        started_at: "then".into(),
        updated_at: "now".into(),
    };
    save_daemon_info(&path, &info).expect("save info");

    assert!(
        !clear_daemon_info_if_owned(&path, 456).expect("skip different owner"),
        "different daemon pid must not clear daemon info"
    );
    assert_eq!(load_daemon_info_with(&path, |pid| pid == 123), Some(info));

    assert!(
        clear_daemon_info_if_owned(&path, 123).expect("clear owner"),
        "matching daemon pid should clear daemon info"
    );
    assert_eq!(
        fs::read(&path).expect("read cleared info"),
        Vec::<u8>::new()
    );
}

#[test]
fn daemon_state_filters_project_records_like_typescript() {
    let test_dir = TestDir::new();
    let path = test_dir.0.join("daemon/state.json");
    let state = json!({
        "version": 1,
        "updatedAt": "2026-08-25T00:00:00.000Z",
        "projects": {
            "git": {
                "projectId": "git",
                "projectRoot": "/repo/git",
                "pid": 123,
                "startedAt": "then",
                "updatedAt": "now"
            },
            "missingRoot": {
                "projectId": "missingRoot",
                "pid": 456
            },
            "nonGit": {
                "projectId": "nonGit",
                "projectRoot": "/repo/non-git",
                "pid": 789
            }
        }
    });
    fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
    fs::write(&path, serde_json::to_vec(&state).expect("serialize")).expect("write state");

    let loaded = load_daemon_state_with(&path, |root| root == Path::new("/repo/git"));
    assert_eq!(loaded.version, 1);
    assert_eq!(loaded.updated_at, Some(json!("2026-08-25T00:00:00.000Z")));
    assert_eq!(loaded.projects.keys().collect::<Vec<_>>(), ["git"]);

    fs::write(&path, json!({ "version": 1, "projects": {} }).to_string())
        .expect("write state without updatedAt");
    assert_eq!(load_daemon_state_with(&path, |_| true).updated_at, None);

    save_daemon_state(&path, &DaemonState::empty()).expect("save empty state");
    assert!(
        fs::read_to_string(&path)
            .expect("read state")
            .ends_with('\n')
    );
}

#[test]
fn daemon_state_load_drops_existing_non_checkout_roots() {
    let test_dir = TestDir::new();
    let path = test_dir.0.join("daemon/state.json");
    let repo = test_dir.0.join("repo");
    let non_checkout = test_dir.0.join("not-a-repo");
    fs::create_dir_all(repo.join(".git")).expect("create repo marker");
    fs::create_dir_all(&non_checkout).expect("create non-checkout");
    let state = json!({
        "version": 1,
        "updatedAt": "2026-09-10T00:00:00.000Z",
        "projects": {
            "repo": {
                "projectId": "repo",
                "projectRoot": repo,
                "pid": 123,
                "startedAt": "then",
                "updatedAt": "now"
            },
            "home": {
                "projectId": "home",
                "projectRoot": non_checkout,
                "pid": 456,
                "startedAt": "then",
                "updatedAt": "now"
            }
        }
    });
    fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
    fs::write(&path, serde_json::to_vec(&state).expect("serialize")).expect("write state");

    let loaded = load_daemon_state(&path);

    assert_eq!(loaded.projects.keys().collect::<Vec<_>>(), ["repo"]);
}

#[test]
fn daemon_state_load_retains_unreachable_roots_as_transient() {
    let test_dir = TestDir::new();
    let path = test_dir.0.join("daemon/state.json");
    let state = json!({
        "version": 1,
        "projects": {
            "unmounted": {
                "projectId": "unmounted",
                "projectRoot": "/Volumes/work/project",
                "pid": 789,
                "startedAt": "then",
                "updatedAt": "now"
            },
            "plain": {
                "projectId": "plain",
                "projectRoot": "/Users/sam",
                "pid": 456,
                "startedAt": "then",
                "updatedAt": "now"
            }
        }
    });
    fs::create_dir_all(path.parent().expect("parent")).expect("create parent");
    fs::write(&path, serde_json::to_vec(&state).expect("serialize")).expect("write state");

    let loaded = load_daemon_state_with_status(&path, |root| {
        if root == Path::new("/Volumes/work/project") {
            DaemonStateProjectRootStatus::Unreachable
        } else {
            DaemonStateProjectRootStatus::NotCheckout
        }
    });

    assert_eq!(loaded.projects.keys().collect::<Vec<_>>(), ["unmounted"]);
}

#[test]
fn metadata_endpoint_paths_save_resolve_and_remove_like_metadata_store() {
    let test_dir = TestDir::new();
    let project_state_dir = test_dir.0.join("projects/project-a");
    let endpoint = MetadataApiEndpoint {
        host: "127.0.0.1".into(),
        port: 44555,
        pid: 987,
        updated_at: "now".into(),
    };
    save_metadata_endpoint(&project_state_dir, &endpoint).expect("save endpoint");

    assert_eq!(
        metadata_endpoint_path(&project_state_dir),
        project_state_dir.join("metadata-api.json")
    );
    assert_eq!(
        metadata_endpoint_text_path(&project_state_dir),
        project_state_dir.join("metadata-api.txt")
    );
    assert_eq!(load_metadata_endpoint(&project_state_dir), Some(endpoint));
    assert_eq!(
        resolve_project_service_endpoint(load_metadata_endpoint(&project_state_dir).as_ref())
            .expect("endpoint")
            .port,
        44555
    );
    assert_eq!(
        fs::read_to_string(metadata_endpoint_text_path(&project_state_dir)).expect("read text"),
        "http://127.0.0.1:44555\n"
    );
    assert_eq!(
        load_metadata_endpoint_by_project_id(&test_dir.0, "project-a")
            .expect("endpoint by project id")
            .pid,
        987
    );
    fs::write(project_state_dir.join("host.json"), "{}").expect("write legacy endpoint");

    remove_metadata_endpoint(&project_state_dir);
    assert!(!metadata_endpoint_path(&project_state_dir).exists());
    assert!(!metadata_endpoint_text_path(&project_state_dir).exists());
    assert!(!project_state_dir.join("host.json").exists());
}

#[test]
fn metadata_state_round_trips_sessions_and_project_id_endpoint_path() {
    let test_dir = TestDir::new();
    let project_state_dir = test_dir.0.join("projects/project-b");
    let state = MetadataState {
        version: 1,
        sessions: [(
            "codex-1".to_owned(),
            json!({ "updatedAt": "now", "derived": { "activity": "idle" } }),
        )]
        .into_iter()
        .collect(),
    };
    save_metadata_state(&project_state_dir, &state).expect("save metadata");
    assert_eq!(load_metadata_state(&project_state_dir), state);
    assert_eq!(
        metadata_state_path(&project_state_dir),
        project_state_dir.join("metadata.json")
    );
    assert_eq!(
        metadata_endpoint_path_by_project_id(&test_dir.0, "project-b"),
        test_dir
            .0
            .join("projects")
            .join("project-b")
            .join("metadata-api.json")
    );
}

#[test]
fn metadata_state_quarantines_corrupt_json_scrubs_projection_fields_and_drops_expired_segments() {
    let test_dir = TestDir::new();
    let project_state_dir = test_dir.0.join("projects/project-c");
    fs::create_dir_all(&project_state_dir).expect("create project state");
    let path = metadata_state_path(&project_state_dir);
    fs::write(&path, "{ nope").expect("write corrupt metadata");

    assert_eq!(
        load_metadata_state(&project_state_dir),
        MetadataState::empty()
    );
    assert!(!path.exists());
    assert!(
        fs::read_dir(&project_state_dir)
            .expect("read project state")
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("metadata.json.corrupt-"))
    );

    let state = json!({
        "version": 1,
        "sessions": {
            "codex-1": {
                "updatedAt": "now",
                "backendSessionId": "owned-by-runtime",
                "label": "owned-by-runtime",
                "statusline": {
                    "top": [
                        { "id": "expired", "text": "old", "expiresAt": "1970-01-01T00:00:00.000Z" },
                        { "id": "bad-date", "text": "keep", "expiresAt": "not a date" },
                        "keep malformed"
                    ],
                    "bottom": [
                        { "id": "open", "text": "keep" }
                    ]
                }
            }
        }
    });
    fs::write(&path, state.to_string()).expect("write metadata");

    let loaded = load_metadata_state(&project_state_dir);
    let session = loaded.sessions["codex-1"]
        .as_object()
        .expect("session object");
    assert!(!session.contains_key("backendSessionId"));
    assert!(!session.contains_key("label"));
    let top = session["statusline"]["top"].as_array().expect("top array");
    assert_eq!(top.len(), 2);
    assert_eq!(top[0]["id"], "bad-date");

    save_metadata_state(&project_state_dir, &loaded).expect("save scrubbed metadata");
    let saved: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("read saved metadata"))
            .expect("saved JSON");
    assert!(
        saved["sessions"]["codex-1"]
            .get("backendSessionId")
            .is_none()
    );
    assert!(saved["sessions"]["codex-1"].get("label").is_none());
}
