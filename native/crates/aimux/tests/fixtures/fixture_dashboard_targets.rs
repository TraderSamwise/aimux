use serde::Deserialize;
use serde_json::{Value, json};

use aimux::dashboard_targets::{
    DashboardResolveOptions, DashboardTargetContext, resolve_dashboard_target_with_context,
    run_dashboard_targets_contract_case,
};
use aimux::tmux::{
    TMUX_DASHBOARD_READY_OPTION, TmuxCommandSpec, TmuxExecOptions, TmuxRuntimeManager,
};
use std::cell::RefCell;
use std::rc::Rc;

const TARGETS: &str = include_str!("../../../../../testdata/contracts/v1/dashboard/targets.json");

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Contract {
    source: String,
    case_count: usize,
    cases: Vec<Case>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    source: String,
    api: String,
    input: Value,
    output: Value,
}

#[test]
fn fixture_dashboard_targets_contract_is_captured() {
    let contract: Contract =
        serde_json::from_str(TARGETS).expect("dashboard targets fixture parses");
    assert_eq!(contract.source, "src/dashboard/targets.test.ts");
    assert_eq!(contract.case_count, 4);
    assert_eq!(contract.cases.len(), contract.case_count);

    for case in contract.cases {
        assert!(!case.id.is_empty());
        assert_eq!(case.source, contract.source);
        assert!(matches!(
            case.api.as_str(),
            "findLiveDashboardTarget" | "resolveDashboardTarget"
        ));
        assert!(!case.input.is_null());
        assert!(case.output.get("calls").and_then(Value::as_array).is_some());
        let actual =
            normalize_dashboard_stamps(run_dashboard_targets_contract_case(&case.id, &case.input));
        let expected = normalize_dashboard_stamps(case.output);
        assert_eq!(actual, expected, "{} ({})", case.id, case.api);
    }
}

#[test]
fn restart_resolution_reuses_usable_dashboard_without_replacement() {
    let actual = run_dashboard_targets_contract_case(
        "dashboard-targets-003",
        &json!({
            "api": "resolveDashboardTargetForRestart",
            "projectRoot": "/Users/sam/cs/glyde-frontend"
        }),
    );
    let calls = actual
        .get("calls")
        .and_then(Value::as_array)
        .expect("restart dashboard calls");
    let methods = calls
        .iter()
        .filter_map(|call| call.get("method").and_then(Value::as_str))
        .collect::<Vec<_>>();

    assert_eq!(actual["result"]["dashboardTarget"]["windowId"], json!("@1"));
    assert!(methods.contains(&"setSessionOption"));
    assert!(!methods.contains(&"ensureProjectSession"));
    assert!(!methods.contains(&"ensureDashboardWindow"));
    assert!(!methods.contains(&"replaceWindowWhenReady"));
}

#[test]
fn production_dashboard_target_resolution_uses_dashboard_command_for_new_session() {
    let calls = Rc::new(RefCell::new(Vec::<Vec<String>>::new()));
    let created = Rc::new(RefCell::new(false));
    let calls_for_exec = calls.clone();
    let created_for_exec = created.clone();
    let mut tmux = TmuxRuntimeManager::with_exec(
        move |args: &[String], _options: Option<&TmuxExecOptions>| {
            calls_for_exec.borrow_mut().push(args.to_vec());
            match args.first().map(String::as_str) {
                Some("has-session") => {
                    if *created_for_exec.borrow() {
                        Ok(String::new())
                    } else {
                        Err("no such session".to_owned())
                    }
                }
                Some("new-session") => {
                    *created_for_exec.borrow_mut() = true;
                    Ok(String::new())
                }
                Some("list-sessions") => Ok(String::new()),
                Some("list-windows") => {
                    if *created_for_exec.borrow() {
                        Ok("@1\t0\tdashboard\t1\t0\t0\n@2\t1\taimux-reload\t0\t0\t0".to_owned())
                    } else {
                        Ok(String::new())
                    }
                }
                Some("show-window-options")
                    if args.last().map(String::as_str) == Some(TMUX_DASHBOARD_READY_OPTION) =>
                {
                    Ok("dashboard-stamp".to_owned())
                }
                Some("display-message")
                    if args.last().map(String::as_str) == Some("#{pane_dead}") =>
                {
                    Ok("0".to_owned())
                }
                Some("display-message")
                    if args.last().map(String::as_str) == Some("#{window_active}") =>
                {
                    Ok("1".to_owned())
                }
                Some("new-window") => Ok("@2\t1\taimux-reload".to_owned()),
                _ => Ok(String::new()),
            }
        },
    );
    let context = DashboardTargetContext {
        dashboard_build_stamp: "dashboard-stamp".to_owned(),
        dashboard_command: TmuxCommandSpec {
            cwd: "/repo/mobile".to_owned(),
            command: "bash".to_owned(),
            args: vec!["-lc".to_owned(), "echo custom-dashboard".to_owned()],
        },
        runtime_owner_id: "owner".to_owned(),
    };

    resolve_dashboard_target_with_context(
        "/repo/mobile",
        &mut tmux,
        DashboardResolveOptions {
            force_reload: false,
            open_in_host_session: true,
        },
        &context,
    )
    .expect("dashboard target");

    let calls = calls.borrow();
    let new_session = calls
        .iter()
        .find(|args| args.first().map(String::as_str) == Some("new-session"))
        .expect("new-session call");
    assert_eq!(
        new_session,
        &vec![
            "new-session".to_owned(),
            "-d".to_owned(),
            "-s".to_owned(),
            "aimux-mobile-078d0ecd20ec".to_owned(),
            "-c".to_owned(),
            "/repo/mobile".to_owned(),
            "-n".to_owned(),
            "dashboard".to_owned(),
            "bash".to_owned(),
            "-lc".to_owned(),
            "echo custom-dashboard".to_owned(),
        ]
    );
}

fn normalize_dashboard_stamps(value: Value) -> Value {
    let mut stamps = Vec::<String>::new();
    normalize_dashboard_stamps_inner(value, &mut stamps)
}

fn normalize_dashboard_stamps_inner(value: Value, stamps: &mut Vec<String>) -> Value {
    match value {
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(|value| normalize_dashboard_stamps_inner(value, stamps))
                .collect(),
        ),
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, normalize_dashboard_stamps_inner(value, stamps)))
                .collect(),
        ),
        Value::String(text) => {
            let text =
                normalize_dashboard_launcher_command(&normalize_dashboard_launcher_path(&text));
            if !is_dashboard_stamp(&text) {
                return Value::String(text);
            }
            let index = stamps
                .iter()
                .position(|existing| existing == &text)
                .unwrap_or_else(|| {
                    stamps.push(text);
                    stamps.len() - 1
                });
            json!(format!("<stamp:{}>", index + 1))
        }
        value => value,
    }
}

fn normalize_dashboard_launcher_path(value: &str) -> String {
    const MARKER: &str = "/dist/launcher-bin.js";
    let mut rest = value;
    let mut normalized = String::new();
    while let Some(marker_start) = rest.find(MARKER) {
        let prefix = &rest[..marker_start];
        let path_start = prefix.rfind('\'').map_or(0, |index| index + 1);
        normalized.push_str(&prefix[..path_start]);
        normalized.push_str("<repo>/dist/launcher-bin.js");
        rest = &rest[marker_start + MARKER.len()..];
    }
    normalized.push_str(rest);
    normalized
}

fn normalize_dashboard_launcher_command(value: &str) -> String {
    value.replace("env -u 'AIMUX_ROOT' -u 'AIMUX_NATIVE_BIN' ", "env ")
}

fn is_dashboard_stamp(value: &str) -> bool {
    let Some((left, right)) = value.split_once('-') else {
        return false;
    };
    left.len() == 16
        && right.len() == 16
        && left.bytes().all(|byte| byte.is_ascii_hexdigit())
        && right.bytes().all(|byte| byte.is_ascii_hexdigit())
}
