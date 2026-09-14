use serde::Deserialize;
use serde_json::{Value, json};

use aimux::dashboard_targets::{
    DashboardResolveOptions, DashboardTargetContext, DashboardTargetTmux,
    resolve_dashboard_target_with_context, run_dashboard_targets_contract_case,
};
use aimux::tmux::{
    TMUX_DASHBOARD_READY_OPTION, TmuxCommandSpec, TmuxExecOptions, TmuxRuntimeManager,
    TmuxSessionRef, TmuxTarget, TmuxWindowInfo,
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
fn created_dashboard_exit_reports_child_cause_instead_of_timeout() {
    let mut tmux = CreatedDashboardTmux {
        window_alive: Ok(false),
        captured_output: "dashboard crashed: missing isolated runtime env".to_owned(),
    };
    let context = fake_context();

    let error = resolve_dashboard_target_with_context(
        "/repo/mobile",
        &mut tmux,
        DashboardResolveOptions {
            force_reload: false,
            open_in_host_session: true,
        },
        &context,
    )
    .expect_err("dead dashboard should report the child failure");

    assert!(
        error.contains("Dashboard window @7 exited before becoming ready"),
        "{error}"
    );
    assert!(
        error.contains("expected @aimux-dashboard-ready=dashboard-stamp"),
        "{error}"
    );
    assert!(
        error.contains("last observed @aimux-dashboard-ready=<missing>"),
        "{error}"
    );
    assert!(
        error.contains("dashboard crashed: missing isolated runtime env"),
        "{error}"
    );
    assert!(
        !error.contains("Timed out waiting"),
        "child failure was masked as timeout: {error}"
    );
}

#[test]
fn created_dashboard_liveness_error_is_reported_as_could_not_determine() {
    let mut tmux = CreatedDashboardTmux {
        window_alive: Err("tmux could not inspect dashboard pane state".to_owned()),
        ..CreatedDashboardTmux::default()
    };
    let context = fake_context();

    let error = resolve_dashboard_target_with_context(
        "/repo/mobile",
        &mut tmux,
        DashboardResolveOptions {
            force_reload: false,
            open_in_host_session: true,
        },
        &context,
    )
    .expect_err("tmux inspection failure should not become a timeout");

    assert_eq!(error, "tmux could not inspect dashboard pane state");
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

fn fake_context() -> DashboardTargetContext {
    DashboardTargetContext {
        dashboard_build_stamp: "dashboard-stamp".to_owned(),
        dashboard_command: TmuxCommandSpec {
            cwd: "/repo/mobile".to_owned(),
            command: "bash".to_owned(),
            args: vec![
                "-lc".to_owned(),
                "aimux __dashboard-internal-native".to_owned(),
            ],
        },
        runtime_owner_id: "owner".to_owned(),
    }
}

#[derive(Debug, Clone)]
struct CreatedDashboardTmux {
    window_alive: Result<bool, String>,
    captured_output: String,
}

impl Default for CreatedDashboardTmux {
    fn default() -> Self {
        Self {
            window_alive: Ok(true),
            captured_output: String::new(),
        }
    }
}

impl DashboardTargetTmux for CreatedDashboardTmux {
    fn get_project_session(&mut self, project_root: &str) -> TmuxSessionRef {
        TmuxSessionRef {
            project_root: project_root.to_owned(),
            project_id: "mobile".to_owned(),
            session_name: format!(
                "aimux-{}",
                project_root.rsplit('/').next().unwrap_or("repo")
            ),
        }
    }

    fn is_inside_tmux(&mut self) -> bool {
        false
    }

    fn get_open_session_name(&mut self, session_name: &str, _inside_tmux: bool) -> String {
        session_name.to_owned()
    }

    fn current_client_session(&mut self) -> Option<String> {
        None
    }

    fn list_session_names(&mut self) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }

    fn has_session(&mut self, _session_name: &str) -> bool {
        false
    }

    fn list_windows(&mut self, _session_name: &str) -> Result<Vec<TmuxWindowInfo>, String> {
        Ok(Vec::new())
    }

    fn get_window_option(&mut self, _target: &TmuxTarget, _key: &str) -> Option<String> {
        None
    }

    fn get_session_option(&mut self, _session_name: &str, _key: &str) -> Option<String> {
        None
    }

    fn display_message(&mut self, _format: &str, _target: &str) -> Option<String> {
        None
    }

    fn capture_target(&mut self, _target: &TmuxTarget, _start_line: i64) -> Option<String> {
        Some(self.captured_output.clone())
    }

    fn is_window_alive(&mut self, _target: &TmuxTarget) -> Result<bool, String> {
        self.window_alive.clone()
    }

    fn ensure_project_session(
        &mut self,
        _project_root: &str,
        _dashboard_command: &TmuxCommandSpec,
    ) -> Result<TmuxSessionRef, String> {
        Ok(TmuxSessionRef {
            project_root: "/repo/mobile".to_owned(),
            project_id: "mobile".to_owned(),
            session_name: "aimux-mobile".to_owned(),
        })
    }

    fn ensure_dashboard_window(
        &mut self,
        session_name: &str,
        _project_root: &str,
        _dashboard_command: &TmuxCommandSpec,
    ) -> Result<(TmuxTarget, bool), String> {
        Ok((
            TmuxTarget {
                session_name: session_name.to_owned(),
                window_id: "@7".to_owned(),
                window_index: 1,
                window_name: "dashboard".to_owned(),
                pane_dead: None,
            },
            true,
        ))
    }

    fn replace_window_when_ready(
        &mut self,
        _target: &TmuxTarget,
        _dashboard_command: &TmuxCommandSpec,
        _readiness_option: &str,
        _readiness_value: &str,
        _timeout_ms: u64,
    ) -> Result<TmuxTarget, String> {
        panic!("created dashboard path should wait on the new target, not replace it");
    }

    fn set_session_option(
        &mut self,
        _session_name: &str,
        _key: &str,
        _value: &str,
    ) -> Result<(), String> {
        Ok(())
    }

    fn set_window_option(
        &mut self,
        _target: &TmuxTarget,
        _key: &str,
        _value: &str,
    ) -> Result<(), String> {
        Ok(())
    }
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
