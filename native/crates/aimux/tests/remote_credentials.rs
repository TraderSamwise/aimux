use aimux::paths::PathResolver;
use aimux::remote_credentials::{
    AimuxCredentials, ClearCredentialsResult, clear_credentials_at, load_credentials,
    load_credentials_at, save_credentials_at, set_remote_enabled_at,
};
use std::fs::{self, remove_dir_all};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn credentials_round_trip_to_auth_json_with_required_fields() {
    let fixture = TestDir::new("round-trip");
    let auth_path = fixture.path().join("auth.json");
    let credentials = credentials();

    save_credentials_at(&auth_path, &credentials).expect("save credentials");

    assert_eq!(load_credentials_at(&auth_path), Some(credentials));
    let metadata = fs::metadata(&auth_path).expect("metadata");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(metadata.permissions().mode() & 0o777, 0o600);
    }
}

#[test]
fn invalid_or_missing_credentials_load_as_none_like_typescript() {
    let fixture = TestDir::new("invalid");
    let auth_path = fixture.path().join("auth.json");

    assert_eq!(load_credentials_at(&auth_path), None);
    fs::write(&auth_path, "{}").expect("write invalid");
    assert_eq!(load_credentials_at(&auth_path), None);
    fs::write(
        &auth_path,
        r#"{"version":1,"relayUrl":"","token":"token","userId":"user","createdAt":"now","remoteEnabled":true}"#,
    )
    .expect("write missing relay");
    assert_eq!(load_credentials_at(&auth_path), None);
}

#[test]
fn remote_enabled_toggle_preserves_credentials_and_clear_reports_state() {
    let fixture = TestDir::new("toggle");
    let auth_path = fixture.path().join("auth.json");
    save_credentials_at(&auth_path, &credentials()).expect("save credentials");

    let updated = set_remote_enabled_at(&auth_path, false)
        .expect("toggle")
        .expect("credentials");

    assert!(!updated.remote_enabled);
    assert!(
        !load_credentials_at(&auth_path)
            .expect("stored credentials")
            .remote_enabled
    );
    assert_eq!(
        clear_credentials_at(&auth_path),
        ClearCredentialsResult::Cleared
    );
    assert_eq!(
        clear_credentials_at(&auth_path),
        ClearCredentialsResult::None
    );
}

#[test]
fn resolver_uses_global_aimux_auth_path() {
    let fixture = TestDir::new("resolver");
    let resolver = PathResolver::new(
        fixture.path(),
        fixture.path(),
        Some(fixture.path().join(".aimux").to_string_lossy().into_owned()),
    );
    save_credentials_at(resolver.auth_path(), &credentials()).expect("save credentials");

    assert_eq!(
        load_credentials(&resolver).expect("credentials").user_id,
        "user-1"
    );
}

#[derive(Debug)]
struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "aimux-rust-remote-credentials-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = remove_dir_all(&path);
        fs::create_dir_all(&path).expect("test dir");
        Self { path }
    }

    fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = remove_dir_all(&self.path);
    }
}

fn credentials() -> AimuxCredentials {
    AimuxCredentials {
        version: 1,
        relay_url: "wss://relay.example".into(),
        token: "token-1".into(),
        user_id: "user-1".into(),
        created_at: "2026-09-05T00:00:00.000Z".into(),
        remote_enabled: true,
    }
}
