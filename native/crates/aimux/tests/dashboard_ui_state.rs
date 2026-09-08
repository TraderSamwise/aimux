use aimux::dashboard_controller::DashboardScreen;
use aimux::dashboard_ui_state::{DashboardUiStatePersistence, dashboard_client_key};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

#[test]
fn sanitizes_client_session_like_typescript_control_path() {
    assert_eq!(
        dashboard_client_key("aimux/proj:client 1234"),
        "aimux_proj_client_1234"
    );
    assert_eq!(
        dashboard_client_key("aimux-proj-client-1234abcd"),
        "aimux-proj-client-1234abcd"
    );
}

#[test]
fn reads_existing_screen_and_preserves_other_client_fields() {
    let root = temp_dir("dashboard-ui-state");
    fs::create_dir_all(&root).expect("create temp dir");
    let path = root.join("dashboard-ui-client-aimux-proj-client-1234abcd.json");
    fs::write(
        &path,
        r#"{"screen":"library","level":"sessions","selectedEntryId":"codex-1"}"#,
    )
    .expect("seed state");

    let mut state = DashboardUiStatePersistence::new(&root, "aimux-proj-client-1234abcd")
        .expect("create ui state");
    assert_eq!(state.load_screen(), Some(DashboardScreen::Library));
    let changed = state
        .persist_screen(DashboardScreen::Topology)
        .expect("persist screen");
    assert!(changed);

    let saved: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("read state")).expect("json");
    assert_eq!(saved["screen"], "topology");
    assert_eq!(saved["level"], "sessions");
    assert_eq!(saved["selectedEntryId"], "codex-1");
    fs::remove_dir_all(root).ok();
}

#[test]
fn persists_preview_source_with_render_state() {
    let root = temp_dir("dashboard-ui-state-preview-source");
    fs::create_dir_all(&root).expect("create temp dir");
    let path = root.join("dashboard-ui-client-client.json");
    fs::write(
        &path,
        r#"{"screen":"dashboard","previewSource":"scribe","selectedEntryId":"codex-1"}"#,
    )
    .expect("seed state");

    let mut state = DashboardUiStatePersistence::new(&root, "client").expect("create ui state");
    assert_eq!(state.load_preview_source(), Some("scribe"));
    let changed = state
        .persist_render_state(DashboardScreen::Dashboard, "output")
        .expect("persist render state");
    assert!(changed);

    let saved: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&path).expect("read state")).expect("json");
    assert_eq!(saved["screen"], "dashboard");
    assert_eq!(saved["previewSource"], "output");
    assert_eq!(saved["selectedEntryId"], "codex-1");
    fs::remove_dir_all(root).ok();
}

#[test]
fn skips_write_when_screen_is_unchanged() {
    let root = temp_dir("dashboard-ui-state-unchanged");
    fs::create_dir_all(&root).expect("create temp dir");
    let path = root.join("dashboard-ui-client-client.json");
    fs::write(&path, r#"{"screen":"topology","level":"sessions"}"#).expect("seed state");

    let mut state = DashboardUiStatePersistence::new(&root, "client").expect("create ui state");
    assert!(
        !state
            .persist_screen(DashboardScreen::Topology)
            .expect("persist screen")
    );
    assert_eq!(
        fs::read_to_string(&path).expect("read state"),
        r#"{"screen":"topology","level":"sessions"}"#
    );
    assert_eq!(state.client_session(), "client");
    fs::remove_dir_all(root).ok();
}

#[test]
fn ignores_invalid_persisted_screen() {
    let root = temp_dir("dashboard-ui-state-invalid");
    fs::create_dir_all(&root).expect("create temp dir");
    fs::write(
        root.join("dashboard-ui-client-client.json"),
        r#"{"screen":"missing"}"#,
    )
    .expect("seed state");

    let state = DashboardUiStatePersistence::new(&root, "client").expect("create ui state");
    assert_eq!(state.load_screen(), None);
    fs::remove_dir_all(root).ok();
}

fn temp_dir(prefix: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()))
}
