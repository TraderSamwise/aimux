use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::notification_delivery_guard::current_process_external_notification_refusal_reason;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationPayload {
    pub title: String,
    pub message: String,
    pub sound: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deep_link_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopNotificationTransport {
    MacHelper,
    OsaScript,
    Disabled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationDeliveryResult {
    pub transport: DesktopNotificationTransport,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub helper_path: Option<String>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stdout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MacNotifierHelperCheck {
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotifierDoctorReport {
    pub platform: String,
    pub transport: DesktopNotificationTransport,
    pub helper_path: Option<String>,
    pub helper_candidates: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub helper_check: Option<MacNotifierHelperCheck>,
}

pub fn external_notifications_disabled() -> bool {
    matches!(
        std::env::var("AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS").as_deref(),
        Ok("1")
    ) || matches!(
        std::env::var("AIMUX_DISABLE_DESKTOP_NOTIFICATIONS").as_deref(),
        Ok("1")
    )
}

pub fn mac_notifier_candidates() -> Vec<String> {
    let override_path = std::env::var("AIMUX_NOTIFIER_HELPER")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let root = package_root();
    [
        override_path,
        Some(
            root.join("native/darwin/aimux-notifier.app/Contents/MacOS/aimux-notifier")
                .to_string_lossy()
                .into_owned(),
        ),
        Some(
            root.join(format!(
                "native/darwin-{}/aimux-notifier.app/Contents/MacOS/aimux-notifier",
                node_arch()
            ))
            .to_string_lossy()
            .into_owned(),
        ),
    ]
    .into_iter()
    .flatten()
    .filter(|candidate| is_mac_notifier_app_executable(candidate))
    .map(|candidate| {
        let path = PathBuf::from(candidate);
        path.canonicalize()
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned()
    })
    .collect()
}

pub fn find_mac_notifier_helper() -> Option<String> {
    mac_notifier_candidates()
        .into_iter()
        .find(|candidate| Path::new(candidate).exists())
}

pub fn send_desktop_notification_and_wait(
    payload: &DesktopNotificationPayload,
) -> DesktopNotificationDeliveryResult {
    if external_notifications_disabled() {
        return disabled_delivery("disabled");
    }
    if let Some(reason) = current_process_external_notification_refusal_reason() {
        return disabled_delivery(reason);
    }
    if std::env::consts::OS == "macos"
        && let Some(helper_path) = find_mac_notifier_helper()
    {
        return run_notification_command(
            DesktopNotificationTransport::MacHelper,
            Some(helper_path.clone()),
            &helper_path,
            &mac_helper_args(payload),
        );
    }
    disabled_delivery("macOS notification helper not found")
}

pub fn build_desktop_notifier_doctor_report() -> DesktopNotifierDoctorReport {
    let platform = std::env::consts::OS.to_owned();
    let helper_candidates = if platform == "macos" {
        mac_notifier_candidates()
    } else {
        Vec::new()
    };
    let helper_path = if platform == "macos" {
        find_mac_notifier_helper()
    } else {
        None
    };
    let helper_check = helper_path.as_deref().map(check_mac_notifier_helper);
    let transport = if external_notifications_disabled() {
        DesktopNotificationTransport::Disabled
    } else if platform == "macos" && helper_path.is_some() {
        DesktopNotificationTransport::MacHelper
    } else {
        DesktopNotificationTransport::Disabled
    };
    DesktopNotifierDoctorReport {
        platform,
        transport,
        helper_path,
        helper_candidates,
        helper_check,
    }
}

pub fn render_desktop_notifier_doctor_report(report: &DesktopNotifierDoctorReport) -> String {
    let mut lines = vec![
        "Desktop notifications".to_owned(),
        format!("Platform: {}", report.platform),
        format!("Transport: {}", transport_name(&report.transport)),
    ];
    if report.platform != "macos" {
        lines.push("macOS helper: not used on this platform".into());
        return lines.join("\n");
    }
    lines.push(format!(
        "Helper: {}",
        report.helper_path.as_deref().unwrap_or("not found")
    ));
    if let Some(check) = &report.helper_check {
        lines.push(format!(
            "Helper check: {}",
            if check.ok { "ok" } else { "failed" }
        ));
        if !check.stdout.is_empty() {
            lines.push(format!("Helper stdout: {}", check.stdout));
        }
        if !check.stderr.is_empty() {
            lines.push(format!("Helper stderr: {}", check.stderr));
        }
        if let Some(error) = &check.error {
            lines.push(format!("Helper error: {error}"));
        }
    }
    if report.helper_path.is_none() && !report.helper_candidates.is_empty() {
        lines.push("Checked:".into());
        lines.extend(
            report
                .helper_candidates
                .iter()
                .map(|candidate| format!("  {candidate}")),
        );
    }
    lines.join("\n")
}

pub fn render_notification_test_success(attempt: &DesktopNotificationDeliveryResult) -> String {
    let helper = attempt
        .helper_path
        .as_deref()
        .map(|path| format!(" ({path})"))
        .unwrap_or_default();
    format!(
        "Sent notification via {}{}.",
        transport_name(&attempt.transport),
        helper
    )
}

pub fn render_notification_test_failure(attempt: &DesktopNotificationDeliveryResult) -> String {
    let helper = attempt
        .helper_path
        .as_deref()
        .map(|path| format!(" ({path})"))
        .unwrap_or_default();
    let error = attempt
        .error
        .as_deref()
        .map(|error| format!(": {error}"))
        .unwrap_or_default();
    format!(
        "Failed to send notification via {}{}{error}.",
        transport_name(&attempt.transport),
        helper
    )
}

pub fn notification_test_json(attempt: &DesktopNotificationDeliveryResult) -> serde_json::Value {
    json!({ "ok": attempt.ok, "attempt": attempt })
}

fn check_mac_notifier_helper(helper_path: &str) -> MacNotifierHelperCheck {
    match Command::new(helper_path).arg("--check").output() {
        Ok(output) => MacNotifierHelperCheck {
            ok: output.status.success(),
            exit_code: output.status.code(),
            stdout: trim_output(output.stdout),
            stderr: trim_output(output.stderr),
            error: (!output.status.success())
                .then(|| format!("helper exited with {}", output.status)),
        },
        Err(error) => MacNotifierHelperCheck {
            ok: false,
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            error: Some(error.to_string()),
        },
    }
}

fn run_notification_command(
    transport: DesktopNotificationTransport,
    helper_path: Option<String>,
    program: &str,
    args: &[String],
) -> DesktopNotificationDeliveryResult {
    match Command::new(program).args(args).output() {
        Ok(output) => DesktopNotificationDeliveryResult {
            transport,
            helper_path,
            ok: output.status.success(),
            exit_code: output.status.code(),
            stdout: Some(trim_output(output.stdout)),
            stderr: Some(trim_output(output.stderr)),
            error: (!output.status.success())
                .then(|| format!("command exited with {}", output.status)),
        },
        Err(error) => DesktopNotificationDeliveryResult {
            transport,
            helper_path,
            ok: false,
            exit_code: None,
            stdout: Some(String::new()),
            stderr: Some(String::new()),
            error: Some(error.to_string()),
        },
    }
}

fn mac_helper_args(payload: &DesktopNotificationPayload) -> Vec<String> {
    let mut args = vec![
        "--title".to_owned(),
        payload.title.clone(),
        "--message".to_owned(),
        payload.message.clone(),
    ];
    if let Some(deep_link_url) = payload.deep_link_url.as_deref().map(str::trim)
        && !deep_link_url.is_empty()
    {
        args.push("--open-url".into());
        args.push(deep_link_url.to_owned());
    }
    if payload.sound {
        args.push("--sound".into());
    }
    args
}

fn is_mac_notifier_app_executable(candidate: &str) -> bool {
    candidate
        .replace('\\', "/")
        .ends_with("aimux-notifier.app/Contents/MacOS/aimux-notifier")
}

fn package_root() -> PathBuf {
    if let Some(root) = std::env::var_os("AIMUX_ROOT") {
        return PathBuf::from(root);
    }
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

fn transport_name(transport: &DesktopNotificationTransport) -> &'static str {
    match transport {
        DesktopNotificationTransport::MacHelper => "mac-helper",
        DesktopNotificationTransport::OsaScript => "osascript",
        DesktopNotificationTransport::Disabled => "disabled",
    }
}

fn disabled_delivery(reason: &str) -> DesktopNotificationDeliveryResult {
    DesktopNotificationDeliveryResult {
        transport: DesktopNotificationTransport::Disabled,
        helper_path: None,
        ok: false,
        exit_code: None,
        stdout: None,
        stderr: None,
        error: Some(reason.to_owned()),
    }
}

fn trim_output(bytes: Vec<u8>) -> String {
    String::from_utf8_lossy(&bytes).trim().to_owned()
}
