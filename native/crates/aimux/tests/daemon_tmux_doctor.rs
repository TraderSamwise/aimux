use aimux::daemon::tmux_doctor::{
    TmuxDoctorCommandRunner, TmuxDoctorInput, TmuxRepairInput, build_tmux_doctor_report,
    render_tmux_doctor_report, render_tmux_repair_result, repair_tmux_runtime,
};
use aimux::tmux::{
    AIMUX_MODIFIED_ENTER_COMMAND, AIMUX_STALE_MODIFIED_ENTER_COMMAND,
    AIMUX_TMUX_RUNTIME_CONTRACT_VERSION, MOSH_CLIPBOARD_WARNING_MESSAGE,
    TMUX_DASHBOARD_BUILD_OPTION, TMUX_DASHBOARD_OWNER_OPTION, TMUX_DASHBOARD_READY_OPTION,
    TMUX_RUNTIME_CONTRACT_OPTION, TMUX_RUNTIME_REBUILD_REQUIRED_OPTION, TmuxCommandSpec,
    project_session,
};
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

type FakeCommandKey = (String, Vec<String>);
type FakeCommandResponses = VecDeque<Result<String, String>>;

#[derive(Debug, Default)]
struct FakeRunner {
    responses: HashMap<FakeCommandKey, FakeCommandResponses>,
    calls: Vec<(String, Vec<String>)>,
    sourced_files: Vec<String>,
    pass_mutations: bool,
}

impl FakeRunner {
    fn respond(&mut self, program: &str, args: &[&str], output: &str) {
        self.responses.insert(
            (
                program.to_owned(),
                args.iter().map(|arg| (*arg).to_owned()).collect(),
            ),
            VecDeque::from([Ok(output.to_owned())]),
        );
    }

    fn respond_sequence(&mut self, program: &str, args: &[&str], outputs: &[&str]) {
        self.responses.insert(
            (
                program.to_owned(),
                args.iter().map(|arg| (*arg).to_owned()).collect(),
            ),
            outputs
                .iter()
                .map(|output| Ok((*output).to_owned()))
                .collect(),
        );
    }

    fn fail(&mut self, program: &str, args: &[&str], error: &str) {
        self.responses.insert(
            (
                program.to_owned(),
                args.iter().map(|arg| (*arg).to_owned()).collect(),
            ),
            VecDeque::from([Err(error.to_owned())]),
        );
    }
}

impl TmuxDoctorCommandRunner for FakeRunner {
    fn run(&mut self, program: &str, args: &[String]) -> Result<String, String> {
        let key = (program.to_owned(), args.to_vec());
        self.calls.push(key.clone());
        if program == "tmux"
            && args.first().map(String::as_str) == Some("source-file")
            && let Some(path) = args.get(1)
            && let Ok(contents) = fs::read_to_string(path)
        {
            self.sourced_files.push(contents);
        }
        if self.pass_mutations && is_mutating_tmux_command(program, args) {
            return Ok(String::new());
        }
        self.responses
            .get_mut(&key)
            .and_then(|responses| {
                if responses.len() > 1 {
                    responses.pop_front()
                } else {
                    responses.front().cloned()
                }
            })
            .unwrap_or_else(|| Err(format!("unhandled command: {program} {}", args.join(" "))))
    }
}

fn is_mutating_tmux_command(program: &str, args: &[String]) -> bool {
    program == "tmux"
        && args.first().is_some_and(|verb| {
            matches!(
                verb.as_str(),
                "bind-key"
                    | "new-session"
                    | "new-window"
                    | "refresh-client"
                    | "rename-session"
                    | "respawn-window"
                    | "set-hook"
                    | "set-option"
                    | "set-window-option"
                    | "source-file"
                    | "switch-client"
                    | "unbind-key"
            )
        })
}

#[test]
fn builds_native_compatibility_report_for_active_managed_session() {
    let fixture = Fixture::new("active");
    let project_root = fixture.root.join("repo");
    fs::create_dir_all(&project_root).expect("project root");
    let session_name = "aimux-mobile-abc";
    let current_client = "aimux-mobile-abc-client-deadbeef";
    let canonical_project_root = fs::canonicalize(&project_root).expect("canonical project root");
    let project_id = project_session(&canonical_project_root, "aimux").project_id;
    let project_state_dir = fixture.aimux_home.join("projects").join(project_id);
    let statusline_dir = project_state_dir.join("tmux-statusline");
    fs::create_dir_all(&statusline_dir).expect("statusline dir");
    fs::create_dir_all(fixture.script.parent().expect("script parent")).expect("scripts dir");
    fs::write(project_state_dir.join("statusline.json"), "{}\n").expect("statusline json");
    fs::write(statusline_dir.join("bottom-dashboard.txt"), "bottom\n").expect("bottom dashboard");
    fs::write(
        statusline_dir.join(format!("bottom-dashboard-{current_client}.txt")),
        "client\n",
    )
    .expect("client dashboard");
    fs::write(&fixture.script, "#!/bin/sh\n").expect("statusline script");

    let mut runner = FakeRunner::default();
    runner.respond("tmux", &["-V"], "tmux 3.5a\n");
    runner.respond(
        "tmux",
        &["display-message", "-p", "#{client_session}"],
        current_client,
    );
    runner.respond("tmux", &["display-message", "-p", "#{window_id}"], "@3");
    runner.respond(
        "tmux",
        &["display-message", "-p", "#{window_name}"],
        "codex",
    );
    runner.respond("tmux", &["has-session", "-t", session_name], "");
    for (key, value) in [
        ("prefix", "C-a"),
        ("prefix2", "C-b"),
        ("mouse", "on"),
        ("window-size", "latest"),
        ("history-limit", "20000"),
        ("extended-keys", "always"),
        ("extended-keys-format", "csi-u"),
    ] {
        runner.respond(
            "tmux",
            &["show-options", "-v", "-t", session_name, key],
            value,
        );
    }
    runner.respond(
        "tmux",
        &[
            "show-options",
            "-v",
            "-t",
            session_name,
            "terminal-features",
        ],
        "xterm*:clipboard:ccolour:cstyle:focus:title\nxterm*:RGB\nxterm*:extkeys\nxterm*:hyperlinks",
    );
    runner.respond(
        "tmux",
        &["show-options", "-v", "-t", session_name, "status-format[0]"],
        "#(top)",
    );
    runner.respond(
        "tmux",
        &["show-options", "-v", "-t", session_name, "status-format[1]"],
        "#(bottom)",
    );
    runner.respond(
        "tmux",
        &[
            "list-windows",
            "-t",
            session_name,
            "-F",
            "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}\t#{@aimux-meta}",
        ],
        &format!(
            "@0\t0\tdashboard\t0\t0\t0\t\n@3\t3\tcodex\t1\t0\t0\t{}",
            json!({
                "sessionId": "codex-abc123",
                "command": "codex",
                "args": ["--full-auto"],
                "toolConfigKey": "codex",
                "worktreePath": "/repo/mobile"
            })
        ),
    );
    for (key, value) in [
        ("@aimux-tool", "codex"),
        ("allow-passthrough", "on"),
        ("aggressive-resize", "on"),
    ] {
        runner.respond(
            "tmux",
            &["show-window-options", "-v", "-t", "@3", key],
            value,
        );
    }
    let script = fixture.script.to_string_lossy().into_owned();
    let state_dir = project_state_dir.to_string_lossy().into_owned();
    runner.respond(
        "sh",
        &[
            &script,
            "--line",
            "bottom",
            "--project-state-dir",
            &state_dir,
            "--current-session",
            current_client,
            "--current-window",
            "codex",
            "--current-window-id",
            "@3",
        ],
        "bottom preview\n",
    );

    let report = build_tmux_doctor_report(
        &mut runner,
        &TmuxDoctorInput {
            project_root,
            aimux_home: fixture.aimux_home.clone(),
            statusline_script_path: fixture.script.clone(),
            session_prefix: "aimux".into(),
            session_name: Some(session_name.into()),
            window_id: None,
            term: Some("xterm-ghostty".into()),
            term_program: Some("ghostty".into()),
            tmux_env: Some("/tmp/tmux-1000/default,123,0".into()),
        },
    );
    let value = serde_json::to_value(&report).expect("report json");

    assert_eq!(
        value["managedSession"]["terminalFeatures"]["xterm*:ccolour"]["ok"],
        true
    );
    assert_eq!(
        value["managedSession"]["terminalFeatures"]["xterm*:cstyle"]["ok"],
        true
    );
    assert_eq!(
        value["managedWindows"],
        json!([{
            "windowId": "@3",
            "windowIndex": 3,
            "windowName": "codex",
            "tool": "codex",
            "allowPassthrough": "on",
            "aggressiveResize": "on"
        }])
    );
    assert_eq!(value["statusline"]["helperPreview"], "bottom preview");
    assert_eq!(value["statusline"]["bottomDashboardClientExists"], true);
    let text = render_tmux_doctor_report(&report);
    assert!(text.contains("managed session exists: yes"));
    assert!(text.contains("xterm*:ccolour: present [ok]"));
    assert!(text.contains("allow-passthrough: on (expected on) [ok]"));
    assert!(text.contains("status-format[1]: #(bottom)"));
    fixture.cleanup();
}

#[test]
fn canonicalizes_default_session_and_reports_unavailable_tmux_without_fallback() {
    let fixture = Fixture::new("unavailable");
    let real_root = fixture.root.join("repo");
    let alias_root = fixture.root.join("repo-link");
    fs::create_dir_all(&real_root).expect("real root");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&real_root, &alias_root).expect("project symlink");
    #[cfg(not(unix))]
    let alias_root = real_root.clone();
    let expected_session = project_session(
        fs::canonicalize(&alias_root).expect("canonical project"),
        "aimux",
    )
    .session_name;
    let mut runner = FakeRunner::default();
    runner.fail("tmux", &["-V"], "tmux not found");

    let report = build_tmux_doctor_report(
        &mut runner,
        &TmuxDoctorInput {
            project_root: alias_root,
            aimux_home: fixture.aimux_home.clone(),
            statusline_script_path: fixture.script.clone(),
            session_prefix: "aimux".into(),
            session_name: None,
            window_id: Some("@9".into()),
            term: None,
            term_program: None,
            tmux_env: None,
        },
    );
    let value: Value = serde_json::to_value(&report).expect("report json");

    assert_eq!(value["tmux"]["available"], false);
    assert_eq!(value["tmux"]["currentWindowId"], Value::Null);
    assert_eq!(value["managedSession"]["sessionName"], expected_session);
    assert_eq!(value["managedSession"]["exists"], false);
    assert_eq!(value["activeWindow"], Value::Null);
    assert_eq!(
        value["statusline"]["helperError"],
        format!("missing script: {}", fixture.script.to_string_lossy())
    );
    assert_eq!(runner.calls.len(), 1);
    let text = render_tmux_doctor_report(&report);
    assert!(text.contains("tmux available: no"));
    assert!(text.contains("active window: (none)"));
    fixture.cleanup();
}

#[test]
fn repair_creates_dashboard_window_when_host_session_exists_without_dashboard() {
    let fixture = Fixture::new("missing-dashboard-window");
    let project_root = fixture.root.join("repo");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(fixture.script.parent().expect("script parent")).expect("script dir");
    fs::write(&fixture.script, "#!/bin/sh\n").expect("statusline script");
    let control_script = fixture.root.join("scripts/tmux-control.sh");
    fs::write(&control_script, "#!/bin/sh\n").expect("control script");
    let canonical_project_root = fs::canonicalize(&project_root).expect("canonical project root");
    let host_session = project_session(&canonical_project_root, "aimux").session_name;

    let mut runner = FakeRunner {
        pass_mutations: true,
        ..FakeRunner::default()
    };
    runner.respond("tmux", &["-V"], "tmux 3.5a\n");
    runner.respond(
        "tmux",
        &["list-sessions", "-F", "#{session_name}"],
        &format!("{host_session}\n"),
    );
    runner.respond("tmux", &["has-session", "-t", &host_session], "");
    runner.respond(
        "tmux",
        &[
            "show-options",
            "-v",
            "-t",
            &host_session,
            "@aimux-runtime-contract",
        ],
        AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
    );
    runner.respond(
        "tmux",
        &[
            "show-options",
            "-v",
            "-t",
            &host_session,
            "terminal-features",
        ],
        "",
    );
    runner.respond_sequence(
        "tmux",
        &[
            "list-windows",
            "-t",
            &host_session,
            "-F",
            "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}",
        ],
        &[
            "@3\t3\tclaude\t1\t0\t0\n",
            "@0\t0\tdashboard\t1\t0\t0\n@3\t3\tclaude\t0\t0\t0\n",
        ],
    );
    runner.respond(
        "tmux",
        &[
            "list-windows",
            "-t",
            &host_session,
            "-F",
            "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}\t#{@aimux-meta}",
        ],
        "",
    );

    let result = repair_tmux_runtime(
        &mut runner,
        &TmuxRepairInput {
            project_root,
            aimux_home: fixture.aimux_home.clone(),
            session_prefix: "aimux".into(),
            dashboard_command: Some(TmuxCommandSpec {
                cwd: canonical_project_root.to_string_lossy().into_owned(),
                command: "aimux".into(),
                args: vec!["__dashboard-internal-native".into()],
            }),
            dashboard_build_stamp: Some("dashboard-ready".into()),
            dashboard_ready_timeout_ms: 50,
            statusline_script_path: fixture.script.clone(),
            tmux_control_script_path: control_script,
            tmux_env: None,
            open: false,
        },
    )
    .expect("repair result");

    assert_eq!(result.session_name, host_session);
    assert_eq!(result.dashboard_session_name, result.session_name);
    assert_eq!(result.dashboard_window_id, "@0");
    assert!(runner.calls.iter().any(|(_, args)| args
        == &[
            "new-window".to_owned(),
            "-d".to_owned(),
            "-t".to_owned(),
            result.session_name.clone(),
            "-c".to_owned(),
            canonical_project_root.to_string_lossy().into_owned(),
            "-n".to_owned(),
            "dashboard".to_owned(),
            "aimux".to_owned(),
            "__dashboard-internal-native".to_owned(),
        ]));
    assert!(render_tmux_repair_result(&result).contains("dashboard target:"));
    fixture.cleanup();
}

#[test]
fn repair_reclaims_stale_tail_dashboard_placeholder_and_waits_for_ready() {
    let fixture = Fixture::new("stale-dashboard-placeholder");
    let project_root = fixture.root.join("repo");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(fixture.script.parent().expect("script parent")).expect("script dir");
    fs::write(&fixture.script, "#!/bin/sh\n").expect("statusline script");
    let control_script = fixture.root.join("scripts/tmux-control.sh");
    fs::write(&control_script, "#!/bin/sh\n").expect("control script");
    let canonical_project_root = fs::canonicalize(&project_root).expect("canonical project root");
    let host_session = project_session(&canonical_project_root, "aimux").session_name;

    let mut runner = FakeRunner {
        pass_mutations: true,
        ..FakeRunner::default()
    };
    runner.respond("tmux", &["-V"], "tmux 3.5a\n");
    runner.respond(
        "tmux",
        &["list-sessions", "-F", "#{session_name}"],
        &format!("{host_session}\n"),
    );
    runner.respond("tmux", &["has-session", "-t", &host_session], "");
    runner.respond(
        "tmux",
        &[
            "show-options",
            "-v",
            "-t",
            &host_session,
            "@aimux-runtime-contract",
        ],
        AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
    );
    runner.respond(
        "tmux",
        &[
            "show-options",
            "-v",
            "-t",
            &host_session,
            "terminal-features",
        ],
        "",
    );
    runner.respond(
        "tmux",
        &[
            "list-windows",
            "-t",
            &host_session,
            "-F",
            "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}",
        ],
        "@22\t0\tdashboard\t1\t0\t0\n@7\t7\tcodex\t0\t0\t0\n",
    );
    runner.respond(
        "tmux",
        &[
            "display-message",
            "-p",
            "-t",
            "@22",
            "#{pane_current_command}",
        ],
        "tail\n",
    );
    runner.respond(
        "tmux",
        &[
            "show-window-options",
            "-v",
            "-t",
            "@22",
            TMUX_DASHBOARD_BUILD_OPTION,
        ],
        "",
    );
    runner.respond(
        "tmux",
        &[
            "show-window-options",
            "-v",
            "-t",
            "@22",
            TMUX_DASHBOARD_OWNER_OPTION,
        ],
        "",
    );
    runner.respond(
        "tmux",
        &[
            "show-window-options",
            "-v",
            "-t",
            "@22",
            TMUX_DASHBOARD_READY_OPTION,
        ],
        "dashboard-ready\n",
    );
    runner.respond(
        "tmux",
        &[
            "list-windows",
            "-t",
            &host_session,
            "-F",
            "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}\t#{@aimux-meta}",
        ],
        &format!(
            "@7\t7\tcodex\t0\t0\t0\t{}",
            json!({
                "sessionId": "codex-1",
                "command": "codex",
                "args": [],
                "toolConfigKey": "codex"
            })
        ),
    );

    let result = repair_tmux_runtime(
        &mut runner,
        &TmuxRepairInput {
            project_root,
            aimux_home: fixture.aimux_home.clone(),
            session_prefix: "aimux".into(),
            dashboard_command: Some(TmuxCommandSpec {
                cwd: canonical_project_root.to_string_lossy().into_owned(),
                command: "aimux".into(),
                args: vec!["--tmux-dashboard-internal".into()],
            }),
            dashboard_build_stamp: Some("dashboard-ready".into()),
            dashboard_ready_timeout_ms: 50,
            statusline_script_path: fixture.script.clone(),
            tmux_control_script_path: control_script,
            tmux_env: None,
            open: false,
        },
    )
    .expect("repair result");

    assert_eq!(result.dashboard_window_id, "@22");
    assert!(runner.calls.iter().any(|(_, args)| args
        == &[
            "respawn-window".to_owned(),
            "-k".to_owned(),
            "-t".to_owned(),
            "@22".to_owned(),
            "-c".to_owned(),
            canonical_project_root.to_string_lossy().into_owned(),
            "aimux".to_owned(),
            "--tmux-dashboard-internal".to_owned(),
        ]));
    assert!(runner.calls.iter().any(|(_, args)| args
        == &[
            "show-window-options".to_owned(),
            "-v".to_owned(),
            "-t".to_owned(),
            "@22".to_owned(),
            TMUX_DASHBOARD_READY_OPTION.to_owned(),
        ]));
    assert!(!runner.calls.iter().any(|(_, args)| {
        args.first().map(String::as_str) == Some("kill-window")
            && args.iter().any(|arg| arg == "@7")
    }));
    fixture.cleanup();
}

#[test]
fn repair_reports_stale_tail_dashboard_placeholder_that_never_becomes_ready() {
    let fixture = Fixture::new("stale-dashboard-placeholder-timeout");
    let project_root = fixture.root.join("repo");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(fixture.script.parent().expect("script parent")).expect("script dir");
    fs::write(&fixture.script, "#!/bin/sh\n").expect("statusline script");
    let control_script = fixture.root.join("scripts/tmux-control.sh");
    fs::write(&control_script, "#!/bin/sh\n").expect("control script");
    let canonical_project_root = fs::canonicalize(&project_root).expect("canonical project root");
    let host_session = project_session(&canonical_project_root, "aimux").session_name;

    let mut runner = FakeRunner {
        pass_mutations: true,
        ..FakeRunner::default()
    };
    runner.respond("tmux", &["-V"], "tmux 3.5a\n");
    runner.respond(
        "tmux",
        &["list-sessions", "-F", "#{session_name}"],
        &format!("{host_session}\n"),
    );
    runner.respond("tmux", &["has-session", "-t", &host_session], "");
    runner.respond(
        "tmux",
        &[
            "show-options",
            "-v",
            "-t",
            &host_session,
            "@aimux-runtime-contract",
        ],
        AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
    );
    runner.respond(
        "tmux",
        &[
            "show-options",
            "-v",
            "-t",
            &host_session,
            "terminal-features",
        ],
        "",
    );
    runner.respond(
        "tmux",
        &[
            "list-windows",
            "-t",
            &host_session,
            "-F",
            "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}",
        ],
        "@22\t0\tdashboard\t1\t0\t0\n",
    );
    runner.respond(
        "tmux",
        &[
            "display-message",
            "-p",
            "-t",
            "@22",
            "#{pane_current_command}",
        ],
        "tail\n",
    );
    runner.respond(
        "tmux",
        &[
            "show-window-options",
            "-v",
            "-t",
            "@22",
            TMUX_DASHBOARD_BUILD_OPTION,
        ],
        "",
    );
    runner.respond(
        "tmux",
        &[
            "show-window-options",
            "-v",
            "-t",
            "@22",
            TMUX_DASHBOARD_OWNER_OPTION,
        ],
        "",
    );
    runner.respond(
        "tmux",
        &[
            "show-window-options",
            "-v",
            "-t",
            "@22",
            TMUX_DASHBOARD_READY_OPTION,
        ],
        "",
    );

    let error = repair_tmux_runtime(
        &mut runner,
        &TmuxRepairInput {
            project_root,
            aimux_home: fixture.aimux_home.clone(),
            session_prefix: "aimux".into(),
            dashboard_command: Some(TmuxCommandSpec {
                cwd: canonical_project_root.to_string_lossy().into_owned(),
                command: "aimux".into(),
                args: vec!["--tmux-dashboard-internal".into()],
            }),
            dashboard_build_stamp: Some("dashboard-ready".into()),
            dashboard_ready_timeout_ms: 0,
            statusline_script_path: fixture.script.clone(),
            tmux_control_script_path: control_script,
            tmux_env: None,
            open: false,
        },
    )
    .expect_err("repair must not report success before the replacement dashboard is ready");

    assert!(error.contains("Timed out waiting 0ms for repaired dashboard window @22"));
    assert!(error.contains(TMUX_DASHBOARD_READY_OPTION));
    assert!(!error.contains("exited before setting readiness"));
    fixture.cleanup();
}

#[test]
fn repair_reports_replacement_dashboard_child_crash_instead_of_readiness_timeout() {
    let fixture = Fixture::new("stale-dashboard-placeholder-crash");
    let project_root = fixture.root.join("repo");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(fixture.script.parent().expect("script parent")).expect("script dir");
    fs::write(&fixture.script, "#!/bin/sh\n").expect("statusline script");
    let control_script = fixture.root.join("scripts/tmux-control.sh");
    fs::write(&control_script, "#!/bin/sh\n").expect("control script");
    let canonical_project_root = fs::canonicalize(&project_root).expect("canonical project root");
    let host_session = project_session(&canonical_project_root, "aimux").session_name;

    let mut runner = FakeRunner {
        pass_mutations: true,
        ..FakeRunner::default()
    };
    runner.respond("tmux", &["-V"], "tmux 3.5a\n");
    runner.respond(
        "tmux",
        &["list-sessions", "-F", "#{session_name}"],
        &format!("{host_session}\n"),
    );
    runner.respond("tmux", &["has-session", "-t", &host_session], "");
    runner.respond(
        "tmux",
        &[
            "show-options",
            "-v",
            "-t",
            &host_session,
            "@aimux-runtime-contract",
        ],
        AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
    );
    runner.respond(
        "tmux",
        &[
            "show-options",
            "-v",
            "-t",
            &host_session,
            "terminal-features",
        ],
        "",
    );
    runner.respond(
        "tmux",
        &[
            "list-windows",
            "-t",
            &host_session,
            "-F",
            "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}",
        ],
        "@22\t0\tdashboard\t1\t0\t0\n",
    );
    runner.respond(
        "tmux",
        &[
            "display-message",
            "-p",
            "-t",
            "@22",
            "#{pane_current_command}",
        ],
        "tail\n",
    );
    runner.respond(
        "tmux",
        &[
            "show-window-options",
            "-v",
            "-t",
            "@22",
            TMUX_DASHBOARD_BUILD_OPTION,
        ],
        "",
    );
    runner.respond(
        "tmux",
        &[
            "show-window-options",
            "-v",
            "-t",
            "@22",
            TMUX_DASHBOARD_OWNER_OPTION,
        ],
        "",
    );
    runner.respond(
        "tmux",
        &[
            "show-window-options",
            "-v",
            "-t",
            "@22",
            TMUX_DASHBOARD_READY_OPTION,
        ],
        "",
    );
    runner.respond(
        "tmux",
        &["display-message", "-p", "-t", "@22", "#{pane_dead}"],
        "1\n",
    );
    runner.respond(
        "tmux",
        &["capture-pane", "-p", "-J", "-t", "@22", "-S", "-80"],
        "Error: request project desktop-state\n\nCaused by:\n    invalid type: string, expected struct DashboardOperationFailure\n",
    );

    let error = repair_tmux_runtime(
        &mut runner,
        &TmuxRepairInput {
            project_root,
            aimux_home: fixture.aimux_home.clone(),
            session_prefix: "aimux".into(),
            dashboard_command: Some(TmuxCommandSpec {
                cwd: canonical_project_root.to_string_lossy().into_owned(),
                command: "aimux".into(),
                args: vec!["--tmux-dashboard-internal".into()],
            }),
            dashboard_build_stamp: Some("dashboard-ready".into()),
            dashboard_ready_timeout_ms: 50,
            statusline_script_path: fixture.script.clone(),
            tmux_control_script_path: control_script,
            tmux_env: None,
            open: false,
        },
    )
    .expect_err("repair must report the child crash, not a readiness timeout");

    assert!(error.contains("Repaired dashboard window @22 exited before setting readiness"));
    assert!(error.contains(TMUX_DASHBOARD_READY_OPTION));
    assert!(error.contains("invalid type: string"));
    assert!(error.contains("DashboardOperationFailure"));
    assert!(!error.contains("Timed out waiting"));
    fixture.cleanup();
}

#[test]
fn repairs_managed_sessions_dashboard_and_agent_window_policy() {
    let fixture = Fixture::new("repair");
    let real_root = fixture.root.join("repo");
    let alias_root = fixture.root.join("repo-link");
    fs::create_dir_all(&real_root).expect("real root");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&real_root, &alias_root).expect("project symlink");
    #[cfg(not(unix))]
    let alias_root = real_root.clone();
    fs::create_dir_all(fixture.script.parent().expect("script parent")).expect("script dir");
    fs::write(&fixture.script, "#!/bin/sh\n").expect("statusline script");
    let control_script = fixture.root.join("scripts/tmux-control.sh");
    fs::write(&control_script, "#!/bin/sh\n").expect("control script");
    let canonical_project_root = fs::canonicalize(&alias_root).expect("canonical project root");
    let host_session = project_session(&canonical_project_root, "aimux").session_name;
    let client_session = format!("{host_session}-client-deadbeef");
    let alias_session = "aimux-alias-111";

    let mut runner = FakeRunner {
        pass_mutations: true,
        ..FakeRunner::default()
    };
    runner.respond("tmux", &["-V"], "tmux 3.5a\n");
    runner.respond(
        "tmux",
        &["list-sessions", "-F", "#{session_name}"],
        &format!("{host_session}\n{client_session}\n{alias_session}\n"),
    );
    for session_name in [&host_session, &client_session, alias_session] {
        runner.respond("tmux", &["has-session", "-t", session_name], "");
        runner.respond(
            "tmux",
            &[
                "show-options",
                "-v",
                "-t",
                session_name,
                "terminal-features",
            ],
            "",
        );
    }
    runner.respond(
        "tmux",
        &[
            "show-options",
            "-v",
            "-t",
            &host_session,
            "@aimux-runtime-contract",
        ],
        "",
    );
    runner.respond(
        "tmux",
        &[
            "show-options",
            "-v",
            "-t",
            alias_session,
            "@aimux-project-root",
        ],
        &alias_root.to_string_lossy(),
    );
    runner.respond(
        "tmux",
        &[
            "list-windows",
            "-t",
            &host_session,
            "-F",
            "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}",
        ],
        "@0\t0\tdashboard\t1\t0\t0\n@3\t3\tcodex\t0\t0\t0\n",
    );
    runner.respond(
        "tmux",
        &[
            "list-windows",
            "-t",
            &host_session,
            "-F",
            "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}\t#{@aimux-meta}",
        ],
        &format!(
            "@3\t3\tcodex\t0\t0\t0\t{}",
            json!({
                "sessionId": "codex-1",
                "command": "codex",
                "args": [],
                "toolConfigKey": "codex"
            })
        ),
    );

    let result = repair_tmux_runtime(
        &mut runner,
        &TmuxRepairInput {
            project_root: alias_root,
            aimux_home: fixture.aimux_home.clone(),
            session_prefix: "aimux".into(),
            dashboard_command: Some(TmuxCommandSpec {
                cwd: canonical_project_root.to_string_lossy().into_owned(),
                command: "aimux".into(),
                args: vec!["--tmux-dashboard-internal".into()],
            }),
            dashboard_build_stamp: Some("dashboard-ready".into()),
            dashboard_ready_timeout_ms: 50,
            statusline_script_path: fixture.script.clone(),
            tmux_control_script_path: control_script,
            tmux_env: None,
            open: false,
        },
    )
    .expect("repair result");

    assert_eq!(result.session_name, host_session);
    assert_eq!(result.dashboard_session_name, result.session_name);
    assert_eq!(result.dashboard_window_id, "@0");
    assert_eq!(
        result.repaired_sessions,
        vec![
            result.session_name.clone(),
            client_session.clone(),
            alias_session.to_owned()
        ]
    );
    assert_eq!(result.repaired_windows, vec!["@3"]);
    assert!(runner.calls.iter().any(|(_, args)| args
        == &[
            "respawn-window".to_owned(),
            "-k".to_owned(),
            "-t".to_owned(),
            "@0".to_owned(),
            "-c".to_owned(),
            canonical_project_root.to_string_lossy().into_owned(),
            "aimux".to_owned(),
            "--tmux-dashboard-internal".to_owned(),
        ]));
    assert!(runner.calls.iter().any(|(_, args)| args
        == &[
            "set-option".to_owned(),
            "-t".to_owned(),
            result.session_name.clone(),
            "@aimux-project-root".to_owned(),
            canonical_project_root.to_string_lossy().into_owned(),
        ]));
    assert!(runner.calls.iter().any(|(_, args)| args
        == &[
            "set-option".to_owned(),
            "-t".to_owned(),
            result.session_name.clone(),
            TMUX_RUNTIME_CONTRACT_OPTION.to_owned(),
            AIMUX_TMUX_RUNTIME_CONTRACT_VERSION.to_owned(),
        ]));
    assert!(runner.calls.iter().any(|(_, args)| args
        == &[
            "set-option".to_owned(),
            "-t".to_owned(),
            result.session_name.clone(),
            TMUX_RUNTIME_REBUILD_REQUIRED_OPTION.to_owned(),
            "0".to_owned(),
        ]));
    assert!(!runner.calls.iter().any(|(_, args)| {
        args.first().map(String::as_str) == Some("kill-window")
            && args.iter().any(|arg| arg == "@3")
    }));
    let repaired_commands = runner
        .calls
        .iter()
        .flat_map(|(_, args)| args.iter())
        .cloned()
        .chain(runner.sourced_files.iter().cloned())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(repaired_commands.contains("__tmux-control-internal"));
    assert!(repaired_commands.contains("__tmux-statusline-internal"));
    assert!(repaired_commands.contains("__tmux-open-hyperlink-internal"));
    assert!(repaired_commands.contains("__tmux-client-is-mosh-internal"));
    assert!(repaired_commands.contains(MOSH_CLIPBOARD_WARNING_MESSAGE));
    assert!(repaired_commands.contains(AIMUX_MODIFIED_ENTER_COMMAND));
    assert!(!repaired_commands.contains(AIMUX_STALE_MODIFIED_ENTER_COMMAND));
    assert!(!repaired_commands.contains("tmux-control.sh"));
    assert!(!repaired_commands.contains("tmux-statusline.sh"));
    assert!(!repaired_commands.contains("tmux-open-hyperlink.sh"));
    assert!(runner.calls.iter().any(|(_, args)| args
        == &[
            "set-window-option".to_owned(),
            "-q".to_owned(),
            "-t".to_owned(),
            "@3".to_owned(),
            "allow-passthrough".to_owned(),
            "on".to_owned(),
        ]));
    let rendered = render_tmux_repair_result(&result);
    assert!(rendered.contains("Tmux Repair"));
    assert!(rendered.contains("repaired sessions: 3"));
    assert!(rendered.contains("dashboard target:"));
    fixture.cleanup();
}

#[test]
fn repair_preserves_user_modified_enter_bindings() {
    let fixture = Fixture::new("repair-user-enter");
    let project_root = fixture.root.join("repo");
    fs::create_dir_all(&project_root).expect("project root");
    fs::create_dir_all(fixture.script.parent().expect("script parent")).expect("script dir");
    fs::write(&fixture.script, "#!/bin/sh\n").expect("statusline script");
    let control_script = fixture.root.join("scripts/tmux-control.sh");
    fs::write(&control_script, "#!/bin/sh\n").expect("control script");
    let canonical_project_root = fs::canonicalize(&project_root).expect("canonical project root");
    let session_name = project_session(&canonical_project_root, "aimux").session_name;

    let mut runner = FakeRunner {
        pass_mutations: true,
        ..FakeRunner::default()
    };
    runner.respond("tmux", &["-V"], "tmux 3.5a\n");
    runner.respond(
        "tmux",
        &["list-sessions", "-F", "#{session_name}"],
        &session_name,
    );
    runner.respond("tmux", &["has-session", "-t", &session_name], "");
    runner.respond(
        "tmux",
        &[
            "show-options",
            "-v",
            "-t",
            &session_name,
            "terminal-features",
        ],
        "",
    );
    runner.respond(
        "tmux",
        &[
            "show-options",
            "-v",
            "-t",
            &session_name,
            "@aimux-runtime-contract",
        ],
        "",
    );
    runner.respond(
        "tmux",
        &[
            "list-windows",
            "-t",
            &session_name,
            "-F",
            "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}",
        ],
        "@0\t0\tdashboard\t1\t0\t0\n",
    );
    runner.respond(
        "tmux",
        &[
            "list-windows",
            "-t",
            &session_name,
            "-F",
            "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}\t#{@aimux-meta}",
        ],
        "",
    );
    runner.respond(
        "tmux",
        &["list-keys", "-T", "root", "C-j"],
        "bind-key -T root C-j send-keys C-j",
    );
    runner.respond(
        "tmux",
        &["list-keys", "-T", "root", "S-Enter"],
        "bind-key -T root S-Enter send-keys Escape",
    );

    repair_tmux_runtime(
        &mut runner,
        &TmuxRepairInput {
            project_root,
            aimux_home: fixture.aimux_home.clone(),
            session_prefix: "aimux".into(),
            dashboard_command: Some(TmuxCommandSpec {
                cwd: canonical_project_root.to_string_lossy().into_owned(),
                command: "aimux".into(),
                args: vec!["--tmux-dashboard-internal".into()],
            }),
            dashboard_build_stamp: Some("dashboard-ready".into()),
            dashboard_ready_timeout_ms: 50,
            statusline_script_path: fixture.script.clone(),
            tmux_control_script_path: control_script,
            tmux_env: None,
            open: false,
        },
    )
    .expect("repair result");

    assert!(!runner.calls.iter().any(|(_, args)| {
        args.first().map(String::as_str) == Some("unbind-key")
            && args.get(2).map(String::as_str) == Some("root")
            && matches!(args.get(3).map(String::as_str), Some("C-j" | "S-Enter"))
    }));
    assert!(!runner.calls.iter().any(|(_, args)| {
        args.first().map(String::as_str) == Some("bind-key")
            && args.get(2).map(String::as_str) == Some("root")
            && matches!(args.get(3).map(String::as_str), Some("C-j" | "S-Enter"))
    }));
    fixture.cleanup();
}

#[derive(Debug)]
struct Fixture {
    root: PathBuf,
    aimux_home: PathBuf,
    script: PathBuf,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "aimux-rust-tmux-doctor-{label}-{}-{}",
            std::process::id(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("fixture root");
        Self {
            aimux_home: root.join("home/.aimux"),
            script: root.join("scripts/tmux-statusline.sh"),
            root,
        }
    }

    fn cleanup(self) {
        let _ = fs::remove_dir_all(self.root);
    }
}
