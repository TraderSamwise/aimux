use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};

pub fn run_desktop_notifier_contract_case(input: &Value) -> Value {
    let mut calls = Calls::default();
    let api = input.get("api").and_then(Value::as_str).unwrap_or_default();
    let deps = ContractDeps::from_input(input.get("deps"));

    let result = match api {
        "macNotifierCandidates" => json!(mac_notifier_candidates(&deps)),
        "findMacNotifierHelper" => match find_mac_notifier_helper(&deps, &mut calls) {
            Some(path) => json!(path),
            None => Value::Null,
        },
        "sendDesktopNotification" => {
            send_desktop_notification(input.get("payload"), &deps, &mut calls)
        }
        "sendDesktopNotificationAndWait" => {
            send_desktop_notification_and_wait(input.get("payload"), &deps, &mut calls)
        }
        "buildDesktopNotifierDoctorReport" => {
            build_desktop_notifier_doctor_report(&deps, &mut calls)
        }
        "renderDesktopNotifierDoctorReport" => {
            json!(render_desktop_notifier_doctor_report(
                input.get("report").unwrap_or(&Value::Null)
            ))
        }
        _ => panic!("unknown desktop notifier contract api: {api}"),
    };

    json!({
        "result": result,
        "calls": calls.to_json(),
    })
}

#[derive(Debug, Default)]
struct Calls {
    exists: Vec<String>,
    exec_file: Vec<Value>,
    node_notify: Vec<Value>,
}

impl Calls {
    fn to_json(&self) -> Value {
        json!({
            "exists": self.exists,
            "execFile": self.exec_file,
            "nodeNotify": self.node_notify,
        })
    }
}

#[derive(Debug, Clone)]
struct ContractDeps {
    platform: String,
    arch: String,
    env: Map<String, Value>,
    module_dir: String,
    existing_paths: Vec<String>,
    exec_result: Option<Value>,
}

impl ContractDeps {
    fn from_input(value: Option<&Value>) -> Self {
        let deps = value.and_then(Value::as_object);
        Self {
            platform: deps
                .and_then(|deps| deps.get("platform"))
                .and_then(Value::as_str)
                .unwrap_or(current_node_platform())
                .to_owned(),
            arch: deps
                .and_then(|deps| deps.get("arch"))
                .and_then(Value::as_str)
                .unwrap_or(current_node_arch())
                .to_owned(),
            env: deps
                .and_then(|deps| deps.get("env"))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
            module_dir: deps
                .and_then(|deps| deps.get("moduleDir"))
                .and_then(Value::as_str)
                .unwrap_or("/tmp/aimux/dist")
                .to_owned(),
            existing_paths: deps
                .and_then(|deps| deps.get("existingPaths"))
                .and_then(Value::as_array)
                .map(|paths| {
                    paths
                        .iter()
                        .filter_map(Value::as_str)
                        .map(ToOwned::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            exec_result: deps.and_then(|deps| deps.get("execResult")).cloned(),
        }
    }
}

fn current_node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    }
}

fn current_node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

fn mac_notifier_candidates(deps: &ContractDeps) -> Vec<String> {
    let override_path = env_string(&deps.env, "AIMUX_NOTIFIER_HELPER")
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    [
        override_path,
        Some(format!(
            "{}/native/darwin/aimux-notifier.app/Contents/MacOS/aimux-notifier",
            package_root(&deps.module_dir)
        )),
        Some(format!(
            "{}/native/darwin-{}/aimux-notifier.app/Contents/MacOS/aimux-notifier",
            package_root(&deps.module_dir),
            deps.arch
        )),
    ]
    .into_iter()
    .flatten()
    .map(resolve_path)
    .filter(|candidate| is_mac_notifier_app_executable(candidate))
    .collect()
}

fn find_mac_notifier_helper(deps: &ContractDeps, calls: &mut Calls) -> Option<String> {
    for candidate in mac_notifier_candidates(deps) {
        calls.exists.push(candidate.clone());
        if deps.existing_paths.contains(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn send_desktop_notification(
    payload: Option<&Value>,
    deps: &ContractDeps,
    calls: &mut Calls,
) -> Value {
    if external_notifications_disabled(&deps.env) {
        return json!({ "transport": "disabled" });
    }
    if deps.platform != "darwin" {
        send_via_node_notifier(payload, calls);
        return json!({ "transport": "node-notifier" });
    }
    if let Some(helper_path) = find_mac_notifier_helper(deps, calls) {
        calls.exec_file.push(json!({
            "file": helper_path,
            "args": mac_helper_args(payload),
            "options": null,
        }));
        return json!({ "transport": "mac-helper", "helperPath": calls.exec_file.last().unwrap()["file"] });
    }
    send_via_node_notifier(payload, calls);
    json!({ "transport": "node-notifier" })
}

fn send_desktop_notification_and_wait(
    payload: Option<&Value>,
    deps: &ContractDeps,
    calls: &mut Calls,
) -> Value {
    if external_notifications_disabled(&deps.env) {
        return json!({ "transport": "disabled", "ok": false, "error": "disabled" });
    }
    if deps.platform != "darwin" {
        send_via_node_notifier(payload, calls);
        return json!({ "transport": "node-notifier", "ok": true });
    }
    if let Some(helper_path) = find_mac_notifier_helper(deps, calls) {
        calls.exec_file.push(json!({
            "file": helper_path,
            "args": mac_helper_args(payload),
            "options": { "timeout": 10000 },
        }));
        return mac_helper_result(
            "mac-helper",
            deps.exec_result.as_ref(),
            calls.exec_file.last().unwrap()["file"].clone(),
        );
    }
    send_via_node_notifier(payload, calls);
    json!({ "transport": "node-notifier", "ok": true })
}

fn build_desktop_notifier_doctor_report(deps: &ContractDeps, calls: &mut Calls) -> Value {
    let helper_candidates = if deps.platform == "darwin" {
        mac_notifier_candidates(deps)
    } else {
        Vec::new()
    };
    let helper_path = if deps.platform == "darwin" {
        find_mac_notifier_helper(deps, calls)
    } else {
        None
    };
    let helper_check = helper_path.as_ref().map(|path| {
        calls.exec_file.push(json!({
            "file": path,
            "args": ["--check"],
            "options": { "timeout": 10000 },
        }));
        mac_helper_check(deps.exec_result.as_ref())
    });
    json!({
        "platform": deps.platform,
        "transport": if helper_path.is_some() { "mac-helper" } else { "node-notifier" },
        "helperPath": helper_path,
        "helperCandidates": helper_candidates,
        "helperCheck": helper_check,
    })
}

fn render_desktop_notifier_doctor_report(report: &Value) -> String {
    let platform = report
        .get("platform")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let transport = report
        .get("transport")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut lines = vec![
        "Desktop notifications".to_owned(),
        format!("Platform: {platform}"),
        format!("Transport: {transport}"),
    ];
    if platform != "darwin" {
        lines.push("macOS helper: not used on this platform".to_owned());
        return lines.join("\n");
    }
    lines.push(format!(
        "Helper: {}",
        report
            .get("helperPath")
            .and_then(Value::as_str)
            .unwrap_or("not found")
    ));
    if let Some(check) = report.get("helperCheck").and_then(Value::as_object) {
        let ok = check.get("ok").and_then(Value::as_bool).unwrap_or(false);
        lines.push(format!(
            "Helper check: {}",
            if ok { "ok" } else { "failed" }
        ));
        push_prefixed(&mut lines, "Helper stdout", check.get("stdout"));
        push_prefixed(&mut lines, "Helper stderr", check.get("stderr"));
        push_prefixed(&mut lines, "Helper error", check.get("error"));
    }
    if report.get("helperPath").is_none_or(Value::is_null)
        && let Some(candidates) = report.get("helperCandidates").and_then(Value::as_array)
        && !candidates.is_empty()
    {
        lines.push("Checked:".to_owned());
        for candidate in candidates {
            if let Some(candidate) = candidate.as_str() {
                lines.push(format!("  {candidate}"));
            }
        }
    }
    lines.join("\n")
}

fn push_prefixed(lines: &mut Vec<String>, label: &str, value: Option<&Value>) {
    if let Some(text) = value.and_then(Value::as_str)
        && !text.is_empty()
    {
        lines.push(format!("{label}: {text}"));
    }
}

fn send_via_node_notifier(payload: Option<&Value>, calls: &mut Calls) {
    let mut call = Map::new();
    call.insert("title".to_owned(), json!(payload_string(payload, "title")));
    call.insert(
        "message".to_owned(),
        json!(payload_string(payload, "message")),
    );
    call.insert(
        "sound".to_owned(),
        json!(
            payload
                .and_then(|payload| payload.get("sound"))
                .and_then(Value::as_bool)
                .unwrap_or(true)
        ),
    );
    if let Some(deep_link_url) = payload
        .and_then(|payload| payload.get("deepLinkUrl"))
        .and_then(Value::as_str)
    {
        call.insert("deepLinkUrl".to_owned(), json!(deep_link_url));
    }
    calls.node_notify.push(Value::Object(call));
}

fn mac_helper_args(payload: Option<&Value>) -> Vec<String> {
    let mut args = vec![
        "--title".to_owned(),
        payload_string(payload, "title"),
        "--message".to_owned(),
        payload_string(payload, "message"),
    ];
    if let Some(deep_link_url) = payload
        .and_then(|payload| payload.get("deepLinkUrl"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        args.push("--open-url".to_owned());
        args.push(deep_link_url.to_owned());
    }
    if payload
        .and_then(|payload| payload.get("sound"))
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        args.push("--sound".to_owned());
    }
    args
}

fn mac_helper_result(transport: &str, exec_result: Option<&Value>, helper_path: Value) -> Value {
    let error = exec_result.and_then(|result| result.get("error"));
    let mut result = Map::new();
    result.insert("transport".to_owned(), json!(transport));
    result.insert("helperPath".to_owned(), helper_path);
    result.insert("ok".to_owned(), json!(error.is_none()));
    result.insert(
        "exitCode".to_owned(),
        error
            .and_then(|error| error.get("code"))
            .cloned()
            .unwrap_or_else(|| json!(0)),
    );
    result.insert(
        "stdout".to_owned(),
        json!(trim_exec_string(exec_result, "stdout")),
    );
    result.insert(
        "stderr".to_owned(),
        json!(trim_exec_string(exec_result, "stderr")),
    );
    if let Some(message) = error
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
    {
        result.insert("error".to_owned(), json!(message));
    }
    Value::Object(result)
}

fn mac_helper_check(exec_result: Option<&Value>) -> Value {
    let error = exec_result.and_then(|result| result.get("error"));
    let mut result = Map::new();
    result.insert("ok".to_owned(), json!(error.is_none()));
    result.insert(
        "exitCode".to_owned(),
        error
            .and_then(|error| error.get("code"))
            .cloned()
            .unwrap_or_else(|| json!(0)),
    );
    result.insert(
        "stdout".to_owned(),
        json!(trim_exec_string(exec_result, "stdout")),
    );
    result.insert(
        "stderr".to_owned(),
        json!(trim_exec_string(exec_result, "stderr")),
    );
    if let Some(message) = error
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)
    {
        result.insert("error".to_owned(), json!(message));
    }
    Value::Object(result)
}

fn trim_exec_string(exec_result: Option<&Value>, key: &str) -> String {
    exec_result
        .and_then(|result| result.get(key))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_owned()
}

fn payload_string(payload: Option<&Value>, key: &str) -> String {
    payload
        .and_then(|payload| payload.get(key))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn external_notifications_disabled(env: &Map<String, Value>) -> bool {
    matches!(
        env_string(env, "AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS").as_deref(),
        Some("1")
    ) || matches!(
        env_string(env, "AIMUX_DISABLE_DESKTOP_NOTIFICATIONS").as_deref(),
        Some("1")
    )
}

fn env_string(env: &Map<String, Value>, key: &str) -> Option<String> {
    env.get(key).and_then(Value::as_str).map(ToOwned::to_owned)
}

fn package_root(module_dir: &str) -> String {
    Path::new(module_dir)
        .parent()
        .unwrap_or_else(|| Path::new(module_dir))
        .to_string_lossy()
        .into_owned()
}

fn resolve_path(path: String) -> String {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        path.to_string_lossy().into_owned()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
            .to_string_lossy()
            .into_owned()
    }
}

fn is_mac_notifier_app_executable(candidate: &str) -> bool {
    candidate
        .replace('\\', "/")
        .ends_with("aimux-notifier.app/Contents/MacOS/aimux-notifier")
}
