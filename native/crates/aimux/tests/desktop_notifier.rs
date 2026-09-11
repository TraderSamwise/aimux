use aimux::desktop_notifier::{
    DesktopNotificationPayload, DesktopNotificationTransport, build_desktop_notifier_doctor_report,
    external_notifications_disabled, find_mac_notifier_helper, mac_notifier_candidates,
    render_desktop_notifier_doctor_report, send_desktop_notification_and_wait,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

static ENV_LOCK: Mutex<()> = Mutex::new(());

struct EnvGuard {
    root: PathBuf,
    notifier_helper: Option<String>,
    disable_external: Option<String>,
    disable_desktop: Option<String>,
    aimux_root: Option<String>,
}

impl EnvGuard {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-rust-desktop-notifier-{label}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let guard = Self {
            root,
            notifier_helper: std::env::var("AIMUX_NOTIFIER_HELPER").ok(),
            disable_external: std::env::var("AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS").ok(),
            disable_desktop: std::env::var("AIMUX_DISABLE_DESKTOP_NOTIFICATIONS").ok(),
            aimux_root: std::env::var("AIMUX_ROOT").ok(),
        };
        unsafe {
            std::env::remove_var("AIMUX_NOTIFIER_HELPER");
            std::env::remove_var("AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS");
            std::env::remove_var("AIMUX_DISABLE_DESKTOP_NOTIFICATIONS");
            std::env::set_var("AIMUX_ROOT", &guard.root);
        }
        guard
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        restore("AIMUX_NOTIFIER_HELPER", &self.notifier_helper);
        restore(
            "AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS",
            &self.disable_external,
        );
        restore("AIMUX_DISABLE_DESKTOP_NOTIFICATIONS", &self.disable_desktop);
        restore("AIMUX_ROOT", &self.aimux_root);
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn resolves_app_bundled_mac_helper_override() {
    let _lock = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let guard = EnvGuard::new("override");
    let helper = fake_helper(
        &guard
            .root
            .join("aimux-notifier.app/Contents/MacOS/aimux-notifier"),
        0,
        "ready\n",
        "",
    );
    unsafe {
        std::env::set_var("AIMUX_NOTIFIER_HELPER", &helper);
    }

    assert_eq!(find_mac_notifier_helper(), Some(path_string(&helper)));
}

#[test]
fn ignores_raw_helper_override_without_app_bundle_identity() {
    let _lock = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let guard = EnvGuard::new("raw-helper");
    let helper = fake_helper(&guard.root.join("aimux-notifier"), 0, "ready\n", "");
    unsafe {
        std::env::set_var("AIMUX_NOTIFIER_HELPER", &helper);
    }

    assert_eq!(find_mac_notifier_helper(), None);
}

#[test]
fn derives_bundled_helper_candidates_from_aimux_root() {
    let _lock = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let guard = EnvGuard::new("candidates");

    let candidates = mac_notifier_candidates();

    assert_eq!(
        candidates[0],
        path_string(
            &guard
                .root
                .join("native/darwin/aimux-notifier.app/Contents/MacOS/aimux-notifier")
        )
    );
}

#[test]
fn macos_missing_helper_fails_closed_instead_of_osascript() {
    let _lock = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let _guard = EnvGuard::new("missing-helper");

    let report = build_desktop_notifier_doctor_report();

    if report.platform == "macos" {
        assert_eq!(report.transport, DesktopNotificationTransport::Disabled);
        assert_eq!(report.helper_path, None);
        assert!(!render_desktop_notifier_doctor_report(&report).contains("osascript"));
    } else {
        assert_eq!(
            report.transport,
            DesktopNotificationTransport::PlatformUnsupported
        );
        assert_eq!(report.helper_path, None);
        assert_eq!(report.helper_check, None);
        let rendered = render_desktop_notifier_doctor_report(&report);
        assert!(rendered.contains("desktop notifications are macOS-only"));
        assert!(rendered.contains("mobile push notifications"));
    }
}

#[test]
fn reports_disabled_and_does_not_spawn_transport() {
    let _lock = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let _guard = EnvGuard::new("disabled");
    unsafe {
        std::env::set_var("AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS", "1");
    }

    let result = send_desktop_notification_and_wait(&DesktopNotificationPayload {
        title: "aimux".into(),
        message: "agent waiting".into(),
        sound: true,
        deep_link_url: None,
    });

    assert!(external_notifications_disabled());
    assert_eq!(result.transport, DesktopNotificationTransport::Disabled);
    assert!(!result.ok);
    assert_eq!(result.error.as_deref(), Some("disabled"));
}

#[test]
fn refuses_cargo_test_harness_before_mac_helper_delivery() {
    let _lock = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let guard = EnvGuard::new("send-helper");
    let expected_args = "--title aimux --message agent waiting --open-url aimux:///agent/codex-1/chat?notificationId=notice+1 --sound";
    let helper = arg_checking_helper(
        &guard
            .root
            .join("aimux-notifier.app/Contents/MacOS/aimux-notifier"),
        expected_args,
        "delivered\n",
    );
    unsafe {
        std::env::set_var("AIMUX_NOTIFIER_HELPER", &helper);
    }

    let result = send_desktop_notification_and_wait(&DesktopNotificationPayload {
        title: "aimux".into(),
        message: "agent waiting".into(),
        sound: true,
        deep_link_url: Some(" aimux:///agent/codex-1/chat?notificationId=notice+1 ".into()),
    });

    assert_eq!(result.transport, DesktopNotificationTransport::Disabled);
    assert!(!result.ok);
    assert_eq!(result.error.as_deref(), Some("cargo test harness"));
}

#[test]
fn builds_doctor_report_with_helper_check_output() {
    let _lock = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let guard = EnvGuard::new("doctor");
    let helper = fake_helper(
        &guard
            .root
            .join("aimux-notifier.app/Contents/MacOS/aimux-notifier"),
        0,
        "Aimux notifier ready (app.aimux.notifier)\n",
        "",
    );
    unsafe {
        std::env::set_var("AIMUX_NOTIFIER_HELPER", &helper);
    }

    let report = build_desktop_notifier_doctor_report();

    if report.platform == "macos" {
        assert_eq!(report.transport, DesktopNotificationTransport::MacHelper);
        assert_eq!(
            report.helper_path.as_deref(),
            Some(path_string(&helper).as_str())
        );
        assert!(report.helper_check.as_ref().is_some_and(|check| check.ok));
        assert!(render_desktop_notifier_doctor_report(&report).contains("Helper check: ok"));
    } else {
        assert_eq!(
            report.transport,
            DesktopNotificationTransport::PlatformUnsupported
        );
        assert_eq!(report.helper_path, None);
        assert_eq!(report.helper_check, None);
        let rendered = render_desktop_notifier_doctor_report(&report);
        assert!(rendered.contains("desktop notifications are macOS-only"));
        assert!(rendered.contains("mobile push notifications"));
    }
}

fn restore(key: &str, value: &Option<String>) {
    unsafe {
        if let Some(value) = value {
            std::env::set_var(key, value);
        } else {
            std::env::remove_var(key);
        }
    }
}

#[cfg(unix)]
fn fake_helper(path: &PathBuf, exit_code: i32, stdout: &str, stderr: &str) -> PathBuf {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        path,
        format!(
            "#!/bin/sh\nprintf '%b' {:?}\nprintf '%b' {:?} >&2\nexit {exit_code}\n",
            stdout, stderr
        ),
    )
    .unwrap();
    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).unwrap();
    path.to_path_buf()
}

#[cfg(unix)]
fn arg_checking_helper(path: &PathBuf, expected_args: &str, stdout: &str) -> PathBuf {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(
        path,
        format!(
            "#!/bin/sh\nexpected={:?}\nif [ \"$*\" != \"$expected\" ]; then printf '%s\\n' \"$*\" >&2; exit 42; fi\nprintf '%b' {:?}\n",
            expected_args, stdout
        ),
    )
    .unwrap();
    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).unwrap();
    path.to_path_buf()
}

#[cfg(not(unix))]
fn fake_helper(path: &PathBuf, _exit_code: i32, _stdout: &str, _stderr: &str) -> PathBuf {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, "").unwrap();
    path.to_path_buf()
}

#[cfg(not(unix))]
fn arg_checking_helper(path: &PathBuf, _expected_args: &str, _stdout: &str) -> PathBuf {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, "").unwrap();
    path.to_path_buf()
}

fn path_string(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}
