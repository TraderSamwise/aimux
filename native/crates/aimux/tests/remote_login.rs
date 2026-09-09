use aimux::remote_credentials::load_credentials_at;
use aimux::remote_login::{LoginAction, build_auth_url, handle_login_callback};
use std::fs::{self, remove_dir_all};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[test]
fn auth_url_matches_cli_auth_callback_contract() {
    assert_eq!(
        build_auth_url(
            "https://aimux.app/",
            "http://127.0.0.1:1234/callback",
            "abc 123",
            LoginAction::SecurityUnlock,
        ),
        "https://aimux.app/cli-auth?callback=http%3A%2F%2F127.0.0.1%3A1234%2Fcallback&state=abc%20123&action=security-unlock"
    );
}

#[test]
fn callback_saves_credentials_after_state_token_and_user_validation() {
    let fixture = TestDir::new("success");
    let auth_path = fixture.path().join("auth.json");

    let response = handle_login_callback(
        "/callback?state=state-1&token=token-1&userId=user-1",
        "state-1",
        "wss://relay.example/",
        &auth_path,
        "2026-09-05T00:00:00.000Z",
    );

    assert_eq!(response.status, 200);
    assert_eq!(response.user_id.as_deref(), Some("user-1"));
    let credentials = load_credentials_at(&auth_path).expect("credentials");
    assert_eq!(credentials.relay_url, "wss://relay.example");
    assert_eq!(credentials.token, "token-1");
    assert!(credentials.remote_enabled);
}

#[test]
fn callback_rejects_wrong_state_error_and_missing_token() {
    let fixture = TestDir::new("failure");
    let auth_path = fixture.path().join("auth.json");

    assert_eq!(
        handle_login_callback(
            "/callback?state=wrong&token=token-1&userId=user-1",
            "state-1",
            "wss://relay.example",
            &auth_path,
            "now",
        )
        .status,
        403
    );
    assert_eq!(
        handle_login_callback(
            "/callback?state=state-1&error=denied",
            "state-1",
            "wss://relay.example",
            &auth_path,
            "now",
        )
        .error
        .as_deref(),
        Some("denied")
    );
    assert_eq!(
        handle_login_callback(
            "/callback?state=state-1&token=token-1",
            "state-1",
            "wss://relay.example",
            &auth_path,
            "now",
        )
        .error
        .as_deref(),
        Some("Callback missing token or userId")
    );
    assert_eq!(load_credentials_at(&auth_path), None);
}

#[derive(Debug)]
struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "aimux-rust-remote-login-{label}-{}-{}",
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
