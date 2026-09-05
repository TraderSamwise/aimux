use aimux::daemon::tmux_doctor::{
    TmuxDoctorCommandRunner, TmuxDoctorInput, TmuxRepairInput, build_tmux_doctor_report,
    render_tmux_doctor_report, render_tmux_repair_result, repair_tmux_runtime,
};
use aimux::tmux::{TmuxCommandSpec, project_session};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Default)]
struct FakeRunner {
    responses: HashMap<(String, Vec<String>), Result<String, String>>,
    calls: Vec<(String, Vec<String>)>,
    pass_mutations: bool,
}

impl FakeRunner {
    fn respond(&mut self, program: &str, args: &[&str], output: &str) {
        self.responses.insert(
            (
                program.to_owned(),
                args.iter().map(|arg| (*arg).to_owned()).collect(),
            ),
            Ok(output.to_owned()),
        );
    }

    fn fail(&mut self, program: &str, args: &[&str], error: &str) {
        self.responses.insert(
            (
                program.to_owned(),
                args.iter().map(|arg| (*arg).to_owned()).collect(),
            ),
            Err(error.to_owned()),
        );
    }
}

impl TmuxDoctorCommandRunner for FakeRunner {
    fn run(&mut self, program: &str, args: &[String]) -> Result<String, String> {
        let key = (program.to_owned(), args.to_vec());
        self.calls.push(key.clone());
        if self.pass_mutations && is_mutating_tmux_command(program, args) {
            return Ok(String::new());
        }
        self.responses
            .get(&key)
            .cloned()
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
