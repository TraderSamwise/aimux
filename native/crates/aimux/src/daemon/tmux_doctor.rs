use crate::cli_launcher::{AimuxCliLaunchOptions, get_aimux_dashboard_launch_command};
use crate::config::load_config_for_project;
use crate::daemon_state::DEFAULT_DAEMON_PORT;
use crate::paths::PathResolver;
use crate::shell_hooks::shell_quote;
use crate::tmux::{
    AIMUX_TMUX_RUNTIME_CONTRACT_VERSION, MANAGED_TMUX_AGENT_WINDOW_OPTIONS,
    MANAGED_TMUX_SESSION_OPTIONS, MANAGED_TMUX_TERMINAL_FEATURES, TMUX_RUNTIME_CONTRACT_OPTION,
    TMUX_RUNTIME_OWNER_OPTION, TmuxCommandSpec, WINDOW_LIST_FORMAT, append_session_option_argv,
    build_default_root_mouse_bindings_install_config_for_command, is_dashboard_window_name,
    is_tmux_client_session_for_host, legacy_project_session_name, new_dashboard_window_argv,
    new_session_argv, project_session, refresh_status_argv, rename_session_argv,
    respawn_window_argv, set_session_option_argv, set_window_option_argv, switch_client_argv,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const MANAGED_WINDOWS_FORMAT: &str = "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}\t#{@aimux-meta}";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmuxDoctorInput {
    pub project_root: PathBuf,
    pub aimux_home: PathBuf,
    pub statusline_script_path: PathBuf,
    pub session_prefix: String,
    pub session_name: Option<String>,
    pub window_id: Option<String>,
    pub term: Option<String>,
    pub term_program: Option<String>,
    pub tmux_env: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TmuxRepairInput {
    pub project_root: PathBuf,
    pub aimux_home: PathBuf,
    pub session_prefix: String,
    pub dashboard_command: Option<TmuxCommandSpec>,
    pub statusline_script_path: PathBuf,
    pub tmux_control_script_path: PathBuf,
    pub tmux_env: Option<String>,
    pub open: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxRepairResult {
    pub project_root: String,
    pub session_name: String,
    pub repaired_sessions: Vec<String>,
    pub repaired_windows: Vec<String>,
    pub dashboard_window_id: String,
    pub dashboard_session_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxDoctorReport {
    pub env: TmuxDoctorEnvironment,
    pub tmux: TmuxDoctorTmux,
    pub managed_session: TmuxDoctorManagedSession,
    pub active_window: Option<TmuxDoctorActiveWindow>,
    pub managed_windows: Vec<TmuxDoctorManagedWindow>,
    pub statusline: TmuxDoctorStatusline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxDoctorEnvironment {
    pub term: Option<String>,
    pub term_program: Option<String>,
    pub inside_tmux: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxDoctorTmux {
    pub available: bool,
    pub version: Option<String>,
    pub current_client_session: Option<String>,
    pub current_window_id: Option<String>,
    pub current_window_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxDoctorManagedSession {
    pub session_name: String,
    pub exists: bool,
    pub options: TmuxDoctorSessionChecks,
    pub terminal_features: TmuxDoctorTerminalFeatureChecks,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TmuxDoctorCheck {
    pub expected: String,
    pub observed: Option<String>,
    pub ok: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TmuxDoctorSessionChecks {
    pub prefix: TmuxDoctorCheck,
    pub prefix2: TmuxDoctorCheck,
    pub mouse: TmuxDoctorCheck,
    #[serde(rename = "window-size")]
    pub window_size: TmuxDoctorCheck,
    #[serde(rename = "history-limit")]
    pub history_limit: TmuxDoctorCheck,
    #[serde(rename = "extended-keys")]
    pub extended_keys: TmuxDoctorCheck,
    #[serde(rename = "extended-keys-format")]
    pub extended_keys_format: TmuxDoctorCheck,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TmuxDoctorTerminalFeatureChecks {
    #[serde(rename = "xterm*:ccolour")]
    pub ccolour: TmuxDoctorCheck,
    #[serde(rename = "xterm*:cstyle")]
    pub cstyle: TmuxDoctorCheck,
    #[serde(rename = "xterm*:RGB")]
    pub rgb: TmuxDoctorCheck,
    #[serde(rename = "xterm*:extkeys")]
    pub extkeys: TmuxDoctorCheck,
    #[serde(rename = "xterm*:hyperlinks")]
    pub hyperlinks: TmuxDoctorCheck,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxDoctorActiveWindow {
    pub window_id: String,
    pub window_name: Option<String>,
    pub tool: Option<String>,
    pub options: TmuxDoctorWindowChecks,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TmuxDoctorWindowChecks {
    #[serde(rename = "allow-passthrough")]
    pub allow_passthrough: TmuxDoctorCheck,
    #[serde(rename = "aggressive-resize")]
    pub aggressive_resize: TmuxDoctorCheck,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxDoctorManagedWindow {
    pub window_id: String,
    pub window_index: i64,
    pub window_name: String,
    pub tool: String,
    pub allow_passthrough: Option<String>,
    pub aggressive_resize: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxDoctorStatusline {
    pub script_path: String,
    pub script_exists: bool,
    pub project_state_dir: String,
    pub statusline_json_exists: bool,
    pub tmux_statusline_dir_exists: bool,
    pub bottom_dashboard_exists: bool,
    pub bottom_dashboard_client_exists: bool,
    pub session_format: Option<String>,
    pub window_format: Option<String>,
    pub helper_preview: Option<String>,
    pub helper_error: Option<String>,
}

pub trait TmuxDoctorCommandRunner {
    fn run(&mut self, program: &str, args: &[String]) -> Result<String, String>;
}

#[derive(Debug, Default)]
pub struct SystemTmuxDoctorCommandRunner;

impl TmuxDoctorCommandRunner for SystemTmuxDoctorCommandRunner {
    fn run(&mut self, program: &str, args: &[String]) -> Result<String, String> {
        let output = Command::new(program)
            .args(args)
            .output()
            .map_err(|error| error.to_string())?;
        if output.status.success() {
            return String::from_utf8(output.stdout).map_err(|error| error.to_string());
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        if stderr.is_empty() {
            Err(format!("Command failed: {program} {}", args.join(" ")))
        } else {
            Err(format!(
                "Command failed: {program} {}\n{stderr}",
                args.join(" ")
            ))
        }
    }
}

pub fn system_tmux_doctor_report(
    resolver: &mut PathResolver,
    project_root: &str,
    session_name: Option<&str>,
    window_id: Option<&str>,
) -> Result<(Value, String), String> {
    let session_prefix = load_config_for_project(project_root)
        .pointer("/runtime/tmux/sessionPrefix")
        .and_then(Value::as_str)
        .filter(|prefix| !prefix.trim().is_empty())
        .unwrap_or("aimux")
        .to_owned();
    let input = TmuxDoctorInput {
        project_root: PathBuf::from(project_root),
        aimux_home: resolver.global_aimux_dir(),
        statusline_script_path: resolve_statusline_script_path(),
        session_prefix,
        session_name: session_name.map(str::to_owned),
        window_id: window_id.map(str::to_owned),
        term: nonempty_env("TERM"),
        term_program: nonempty_env("TERM_PROGRAM"),
        tmux_env: nonempty_env("TMUX"),
    };
    let mut runner = SystemTmuxDoctorCommandRunner;
    let report = build_tmux_doctor_report(&mut runner, &input);
    let text = render_tmux_doctor_report(&report);
    let report = serde_json::to_value(report).map_err(|error| error.to_string())?;
    Ok((report, text))
}

pub fn system_tmux_repair_result(
    resolver: &mut PathResolver,
    project_root: &str,
    open: bool,
) -> Result<(Value, String), String> {
    let session_prefix = load_config_for_project(project_root)
        .pointer("/runtime/tmux/sessionPrefix")
        .and_then(Value::as_str)
        .filter(|prefix| !prefix.trim().is_empty())
        .unwrap_or("aimux")
        .to_owned();
    let mut launch_options = AimuxCliLaunchOptions::default();
    launch_options
        .env
        .insert("AIMUX_DASHBOARD_IMPLEMENTATION".into(), "native".into());
    let dashboard_launch = get_aimux_dashboard_launch_command(launch_options);
    let input = TmuxRepairInput {
        project_root: PathBuf::from(project_root),
        aimux_home: resolver.global_aimux_dir(),
        session_prefix,
        dashboard_command: Some(TmuxCommandSpec {
            cwd: project_root.to_owned(),
            command: dashboard_launch.command,
            args: dashboard_launch.args,
        }),
        statusline_script_path: resolve_statusline_script_path(),
        tmux_control_script_path: resolve_tmux_control_script_path(),
        tmux_env: nonempty_env("TMUX"),
        open,
    };
    let mut runner = SystemTmuxDoctorCommandRunner;
    let result = repair_tmux_runtime(&mut runner, &input)?;
    let text = render_tmux_repair_result(&result);
    let result = serde_json::to_value(result).map_err(|error| error.to_string())?;
    Ok((result, text))
}

pub fn repair_tmux_runtime(
    runner: &mut impl TmuxDoctorCommandRunner,
    input: &TmuxRepairInput,
) -> Result<TmuxRepairResult, String> {
    run_command(runner, "tmux", &["-V"])
        .map_err(|_| "tmux is not installed or not available in PATH".to_owned())?;
    let canonical_project_root =
        fs::canonicalize(&input.project_root).unwrap_or_else(|_| input.project_root.clone());
    let project_root_text = path_text(&canonical_project_root);
    let dashboard_command = input.dashboard_command.clone().map(|mut command| {
        command.cwd = project_root_text.clone();
        command
    });
    let host_session = project_session(&canonical_project_root, &input.session_prefix);
    let mut known_sessions = list_session_names(runner);
    repair_legacy_project_session_names(
        runner,
        &project_root_text,
        &input.session_prefix,
        &host_session.session_name,
        &mut known_sessions,
    )?;

    let existed = has_session(runner, &host_session.session_name);
    let current_contract = existed
        .then(|| {
            session_option(
                runner,
                &host_session.session_name,
                TMUX_RUNTIME_CONTRACT_OPTION,
            )
        })
        .flatten();
    if !existed {
        let argv = new_session_argv(
            &host_session.session_name,
            &project_root_text,
            dashboard_command.as_ref(),
        );
        run_tmux_owned(runner, &argv)?;
    }
    configure_managed_session(
        runner,
        input,
        &host_session.session_name,
        &project_root_text,
    )?;
    if !existed || current_contract.is_none() {
        set_session_option(
            runner,
            &host_session.session_name,
            TMUX_RUNTIME_CONTRACT_OPTION,
            AIMUX_TMUX_RUNTIME_CONTRACT_VERSION,
        )?;
    }
    if !known_sessions.contains(&host_session.session_name) {
        known_sessions.push(host_session.session_name.clone());
    }

    let current_client_session = if input
        .tmux_env
        .as_ref()
        .is_some_and(|value| !value.is_empty())
    {
        tmux_value(runner, &["display-message", "-p", "#{client_session}"])
    } else {
        None
    };
    let managed_sessions = managed_sessions_for_project(
        runner,
        input,
        &project_root_text,
        &host_session.session_name,
        &known_sessions,
        current_client_session.as_deref(),
    );
    for session_name in &managed_sessions {
        configure_managed_session(runner, input, session_name, &project_root_text)?;
    }

    let dashboard_target = ensure_dashboard_target(
        runner,
        &host_session.session_name,
        &project_root_text,
        dashboard_command.as_ref(),
    )?;
    let mut configured_sessions = managed_sessions.clone();
    if !configured_sessions.contains(&dashboard_target.session_name) {
        configured_sessions.push(dashboard_target.session_name.clone());
    }
    for session_name in &configured_sessions {
        configure_managed_session(runner, input, session_name, &project_root_text)?;
    }

    let mut repaired_windows = BTreeSet::new();
    for session_name in &configured_sessions {
        for window in managed_window_reports(runner, session_name) {
            apply_managed_agent_window_policy(runner, &window.window_id, &window.tool)?;
            repaired_windows.insert(window.window_id);
        }
    }

    if input.open {
        if input.tmux_env.as_ref().is_none_or(|value| value.is_empty()) {
            return Err("open requires an attached tmux client".to_owned());
        }
        let argv = switch_client_argv(
            &dashboard_target.session_name,
            dashboard_target.window_index,
            None,
        );
        run_tmux_owned(runner, &argv)?;
    }
    let _ = run_tmux_owned(runner, &refresh_status_argv());

    Ok(TmuxRepairResult {
        project_root: project_root_text,
        session_name: host_session.session_name,
        repaired_sessions: configured_sessions
            .into_iter()
            .filter(|session_name| has_session(runner, session_name))
            .collect(),
        repaired_windows: repaired_windows.into_iter().collect(),
        dashboard_window_id: dashboard_target.window_id,
        dashboard_session_name: dashboard_target.session_name,
    })
}

pub fn render_tmux_repair_result(result: &TmuxRepairResult) -> String {
    let mut lines = vec![
        "Tmux Repair".to_owned(),
        format!("  project root: {}", result.project_root),
        format!("  host session: {}", result.session_name),
        format!("  repaired sessions: {}", result.repaired_sessions.len()),
    ];
    for session_name in &result.repaired_sessions {
        lines.push(format!("    {session_name}"));
    }
    lines.push(format!(
        "  repaired windows: {}",
        result.repaired_windows.len()
    ));
    for window_id in &result.repaired_windows {
        lines.push(format!("    {window_id}"));
    }
    lines.push(format!(
        "  dashboard target: {}:{}",
        result.dashboard_session_name, result.dashboard_window_id
    ));
    lines.join("\n")
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TmuxRepairTarget {
    session_name: String,
    window_id: String,
    window_index: i64,
    window_name: String,
    pane_dead: Option<bool>,
}

fn list_session_names(runner: &mut impl TmuxDoctorCommandRunner) -> Vec<String> {
    tmux_value(runner, &["list-sessions", "-F", "#{session_name}"])
        .map(|raw| {
            raw.lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

fn repair_legacy_project_session_names(
    runner: &mut impl TmuxDoctorCommandRunner,
    project_root: &str,
    session_prefix: &str,
    host_session_name: &str,
    known_sessions: &mut [String],
) -> Result<(), String> {
    let legacy_name = legacy_project_session_name(project_root, session_prefix);
    if legacy_name == host_session_name {
        return Ok(());
    }
    rename_known_session(runner, known_sessions, &legacy_name, host_session_name)?;
    let client_renames = known_sessions
        .iter()
        .filter_map(|session_name| {
            let suffix = session_name.strip_prefix(&legacy_name)?;
            is_tmux_client_session_for_host(session_name, &legacy_name)
                .then(|| (session_name.clone(), format!("{host_session_name}{suffix}")))
        })
        .collect::<Vec<_>>();
    for (from, to) in client_renames {
        rename_known_session(runner, known_sessions, &from, &to)?;
    }
    Ok(())
}

fn rename_known_session(
    runner: &mut impl TmuxDoctorCommandRunner,
    known_sessions: &mut [String],
    from: &str,
    to: &str,
) -> Result<(), String> {
    if !known_sessions.iter().any(|session| session == from)
        || known_sessions.iter().any(|session| session == to)
    {
        return Ok(());
    }
    run_tmux_owned(runner, &rename_session_argv(from, to))?;
    for session in known_sessions.iter_mut() {
        if session == from {
            *session = to.to_owned();
            return Ok(());
        }
    }
    Ok(())
}

fn managed_sessions_for_project(
    runner: &mut impl TmuxDoctorCommandRunner,
    input: &TmuxRepairInput,
    canonical_project_root: &str,
    host_session_name: &str,
    session_names: &[String],
    current_client_session: Option<&str>,
) -> Vec<String> {
    let mut sessions = vec![host_session_name.to_owned()];
    for session_name in session_names {
        if session_name == host_session_name
            || is_tmux_client_session_for_host(session_name, host_session_name)
        {
            push_unique(&mut sessions, session_name.clone());
            continue;
        }
        if !is_managed_session(session_name, &input.session_prefix) {
            continue;
        }
        let Some(project_root) = session_option(runner, session_name, "@aimux-project-root") else {
            continue;
        };
        if canonical_path_text(&project_root) == canonical_project_root {
            push_unique(&mut sessions, session_name.clone());
        }
    }
    if let Some(session_name) = current_client_session
        && (session_name == host_session_name
            || is_tmux_client_session_for_host(session_name, host_session_name))
    {
        push_unique(&mut sessions, session_name.to_owned());
    }
    sessions
}

fn configure_managed_session(
    runner: &mut impl TmuxDoctorCommandRunner,
    input: &TmuxRepairInput,
    session_name: &str,
    project_root: &str,
) -> Result<(), String> {
    let project_id = project_session(project_root, &input.session_prefix).project_id;
    let project_state_dir = input.aimux_home.join("projects").join(project_id);
    let project_state_dir_text = path_text(&project_state_dir);
    let runtime_owner = runtime_owner_id(&input.aimux_home);
    for (key, value) in [
        ("@aimux-project-root", project_root),
        ("@aimux-project-state-dir", &project_state_dir_text),
        (TMUX_RUNTIME_OWNER_OPTION, &runtime_owner),
        ("prefix", MANAGED_TMUX_SESSION_OPTIONS.prefix),
        ("prefix2", MANAGED_TMUX_SESSION_OPTIONS.prefix2),
        ("mouse", MANAGED_TMUX_SESSION_OPTIONS.mouse),
        ("window-size", MANAGED_TMUX_SESSION_OPTIONS.window_size),
        ("history-limit", MANAGED_TMUX_SESSION_OPTIONS.history_limit),
        ("set-clipboard", "external"),
        ("copy-command", "pbcopy"),
        ("repeat-time", "300"),
        ("focus-events", MANAGED_TMUX_SESSION_OPTIONS.focus_events),
        ("bell-action", "none"),
    ] {
        set_session_option(runner, session_name, key, value)?;
    }
    run_tmux_owned(
        runner,
        &[
            "set-hook".to_owned(),
            "-t".to_owned(),
            session_name.to_owned(),
            "pane-focus-in".to_owned(),
            format!(
                "run-shell -b {}",
                shell_quote(&control_command(input, "active", ""))
            ),
        ],
    )?;
    run_tmux_owned(
        runner,
        &[
            "set-window-option".to_owned(),
            "-t".to_owned(),
            session_name.to_owned(),
            "monitor-bell".to_owned(),
            "off".to_owned(),
        ],
    )?;
    run_tmux_owned(
        runner,
        &[
            "set-window-option".to_owned(),
            "-t".to_owned(),
            session_name.to_owned(),
            "aggressive-resize".to_owned(),
            MANAGED_TMUX_AGENT_WINDOW_OPTIONS
                .aggressive_resize
                .to_owned(),
        ],
    )?;
    set_option_if_supported(
        runner,
        &set_session_option_argv(
            session_name,
            "extended-keys",
            MANAGED_TMUX_SESSION_OPTIONS.extended_keys,
        ),
    )?;
    set_option_if_supported(
        runner,
        &set_session_option_argv(
            session_name,
            "extended-keys-format",
            MANAGED_TMUX_SESSION_OPTIONS.extended_keys_format,
        ),
    )?;
    for feature in MANAGED_TMUX_TERMINAL_FEATURES {
        ensure_terminal_feature(runner, session_name, feature)?;
    }
    configure_managed_key_bindings(runner, input, session_name, &project_state_dir_text)?;
    configure_statusline(runner, input, session_name, &project_state_dir_text)
}

fn configure_managed_key_bindings(
    runner: &mut impl TmuxDoctorCommandRunner,
    input: &TmuxRepairInput,
    session_name: &str,
    project_state_dir: &str,
) -> Result<(), String> {
    for key in [
        "C-j",
        "S-Enter",
        "MouseDown1Pane",
        "MouseDrag1Pane",
        "WheelUpPane",
        "WheelDownPane",
    ] {
        let _ = run_tmux_owned(
            runner,
            &["unbind-key".into(), "-T".into(), "root".into(), key.into()],
        );
    }
    source_default_mouse_bindings(runner, project_state_dir)?;
    bind_root_modified_enter(runner, "C-j", "send-keys C-j")?;
    bind_root_modified_enter(runner, "S-Enter", "send-keys S-Enter")?;
    for key in ["s", "n", "p", "d", "u", "e", "g", "m", "O", "K"] {
        let _ = run_tmux_owned(
            runner,
            &[
                "unbind-key".into(),
                "-T".into(),
                "prefix".into(),
                key.into(),
            ],
        );
    }
    for digit in ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] {
        let _ = run_tmux_owned(
            runner,
            &[
                "unbind-key".into(),
                "-T".into(),
                "prefix".into(),
                digit.into(),
            ],
        );
    }
    let _ = run_tmux_owned(
        runner,
        &[
            "unbind-key".into(),
            "-T".into(),
            "prefix".into(),
            "Any".into(),
        ],
    );
    for argv in prefix_binding_commands(input, session_name) {
        run_tmux_owned(runner, &argv)?;
    }
    Ok(())
}

fn configure_statusline(
    runner: &mut impl TmuxDoctorCommandRunner,
    input: &TmuxRepairInput,
    session_name: &str,
    project_state_dir: &str,
) -> Result<(), String> {
    for (key, value) in [
        ("status", "2"),
        ("status-interval", "0"),
        ("status-style", "bg=colour236,fg=colour252"),
        ("message-style", "bg=colour24,fg=colour255,bold"),
        ("message-command-style", "bg=colour24,fg=colour255"),
        ("window-status-separator", " "),
        ("window-status-format", ""),
        ("window-status-current-format", ""),
        ("status-left", ""),
        ("status-right", ""),
    ] {
        set_session_option(runner, session_name, key, value)?;
    }
    let top = statusline_command(input, "top", project_state_dir);
    let bottom = statusline_command(input, "bottom", project_state_dir);
    set_session_option(
        runner,
        session_name,
        "status-format[0]",
        &format!(
            "#[bg=colour236,fg=colour255,bold] #({top})#[default]#{{?pane_in_mode, #[fg=colour214,bold]scroll#[default],}}"
        ),
    )?;
    set_session_option(
        runner,
        session_name,
        "status-format[1]",
        &format!("#[bg=colour236,fg=colour252] #({bottom}) #[default]"),
    )
}

fn ensure_terminal_feature(
    runner: &mut impl TmuxDoctorCommandRunner,
    session_name: &str,
    feature: &str,
) -> Result<(), String> {
    let current = session_option(runner, session_name, "terminal-features");
    let present = current
        .as_deref()
        .map(|value| value.lines().map(str::trim).any(|entry| entry == feature))
        .unwrap_or(false);
    if present {
        return Ok(());
    }
    run_tmux_owned(
        runner,
        &append_session_option_argv(session_name, "terminal-features", &format!(",{feature}")),
    )
}

fn set_option_if_supported(
    runner: &mut impl TmuxDoctorCommandRunner,
    argv: &[String],
) -> Result<(), String> {
    match run_tmux_owned(runner, argv) {
        Ok(()) => Ok(()),
        Err(error) if error.to_lowercase().contains("invalid option") => Ok(()),
        Err(error) if error.to_lowercase().contains("unknown option") => Ok(()),
        Err(error) => Err(error),
    }
}

fn source_default_mouse_bindings(
    runner: &mut impl TmuxDoctorCommandRunner,
    project_state_dir: &str,
) -> Result<(), String> {
    let dir = std::env::temp_dir().join(format!(
        "aimux-tmux-{}-{}",
        std::process::id(),
        time::OffsetDateTime::now_utc().unix_timestamp_nanos()
    ));
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let file = dir.join("mouse-bindings.conf");
    fs::write(
        &file,
        build_default_root_mouse_bindings_install_config_for_command(
            project_state_dir,
            &native_tmux_open_hyperlink_command(),
        ),
    )
    .map_err(|error| error.to_string())?;
    let result = run_tmux_owned(runner, &["source-file".to_owned(), path_text(&file)]);
    let _ = fs::remove_dir_all(dir);
    result
}

fn bind_root_modified_enter(
    runner: &mut impl TmuxDoctorCommandRunner,
    key: &str,
    fallback: &str,
) -> Result<(), String> {
    run_tmux_owned(
        runner,
        &[
            "bind-key".into(),
            "-T".into(),
            "root".into(),
            key.into(),
            "if-shell".into(),
            "-F".into(),
            "#{m/r:^(claude|codex)$,#{@aimux-tool}}".into(),
            "send-keys -H 1b5b32373b3575".into(),
            fallback.into(),
        ],
    )
}

fn prefix_binding_commands(input: &TmuxRepairInput, session_name: &str) -> Vec<Vec<String>> {
    let mut commands = vec![
        vec![
            "bind-key".into(),
            "-T".into(),
            "prefix".into(),
            "C-a".into(),
            "send-prefix".into(),
        ],
        vec![
            "bind-key".into(),
            "-T".into(),
            "prefix".into(),
            "0".into(),
            "run-shell".into(),
            "-b".into(),
            "true".into(),
        ],
    ];
    for digit in ["1", "2", "3", "4", "5", "6", "7", "8", "9"] {
        commands.push(vec![
            "bind-key".into(),
            "-T".into(),
            "prefix".into(),
            digit.into(),
            "run-shell".into(),
            "-b".into(),
            control_command(input, "window", &format!("--index {digit}")),
        ]);
    }
    for (key, action) in [("n", "next"), ("p", "prev")] {
        commands.push(vec![
            "bind-key".into(),
            "-r".into(),
            "-T".into(),
            "prefix".into(),
            key.into(),
            "run-shell".into(),
            "-b".into(),
            control_command(input, action, ""),
        ]);
    }
    for (key, action, args) in [
        ("s", "menu", ""),
        ("u", "attention", ""),
        ("g", "expose", &control_plane_args()),
        ("m", "meta", &control_plane_args()),
        ("e", "team", ""),
        ("O", "overseer", ""),
        ("d", "dashboard", ""),
        ("i", "coordination", ""),
    ] {
        commands.push(vec![
            "bind-key".into(),
            "-T".into(),
            "prefix".into(),
            key.into(),
            "run-shell".into(),
            "-b".into(),
            control_command(input, action, args),
        ]);
    }
    for key in ["K", "L"] {
        commands.push(vec![
            "bind-key".into(),
            "-T".into(),
            "prefix".into(),
            key.into(),
            "clear-history".into(),
            "\\;".into(),
            "send-keys".into(),
            "C-l".into(),
        ]);
    }
    commands.push(vec![
        "bind-key".into(),
        "-T".into(),
        "prefix".into(),
        "q".into(),
        "if-shell".into(),
        "-F".into(),
        "#{@aimux-project-root}".into(),
        "switch-client -T root".into(),
        "display-panes".into(),
    ]);
    commands.push(vec![
        "bind-key".into(),
        "-T".into(),
        "prefix".into(),
        "Any".into(),
        "switch-client".into(),
        "-T".into(),
        "root".into(),
    ]);
    commands.push(set_session_option_argv(
        session_name,
        "renumber-windows",
        "off",
    ));
    commands
}

fn control_command(_input: &TmuxRepairInput, action: &str, args: &str) -> String {
    let control_script = native_tmux_control_command();
    let control_context_args = [
        "--project-root #{q:@aimux-project-root}",
        "--current-session #{q:session_name}",
        "--current-window #{q:window_name}",
        "--current-window-id #{q:window_id}",
        "--current-path #{q:pane_current_path}",
        "--pane-id #{q:pane_id}",
    ]
    .join(" ");
    let args = args.trim();
    if args.is_empty() {
        format!("{control_script} {action} {control_context_args} >/dev/null 2>&1")
    } else {
        format!("{control_script} {action} {args} {control_context_args} >/dev/null 2>&1")
    }
}

fn control_plane_args() -> String {
    [
        std::env::var("AIMUX_HOME")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("--aimux-home {}", shell_quote(&value))),
        std::env::var("AIMUX_DAEMON_HOST")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("--daemon-host {}", shell_quote(&value))),
        std::env::var("AIMUX_DAEMON_PORT")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!("--daemon-port {}", shell_quote(&value))),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ")
}

fn statusline_command(_input: &TmuxRepairInput, line: &str, project_state_dir: &str) -> String {
    format!(
        "{} --line {line} --project-state-dir {} --current-session '#{{session_name}}' --current-window '#{{window_name}}' --current-window-id '#{{window_id}}'",
        native_tmux_statusline_command(),
        shell_quote(project_state_dir)
    )
}

fn ensure_dashboard_target(
    runner: &mut impl TmuxDoctorCommandRunner,
    session_name: &str,
    project_root: &str,
    dashboard_command: Option<&TmuxCommandSpec>,
) -> Result<TmuxRepairTarget, String> {
    if let Some(target) = find_dashboard_target(runner, session_name) {
        if let Some(command) = dashboard_command {
            run_tmux_owned(runner, &respawn_window_argv(&target.window_id, command))?;
        }
        return Ok(target);
    }
    run_tmux_owned(
        runner,
        &new_dashboard_window_argv(session_name, project_root, "dashboard", dashboard_command),
    )?;
    find_dashboard_target(runner, session_name)
        .ok_or_else(|| "dashboard window not found after repair".to_owned())
}

fn find_dashboard_target(
    runner: &mut impl TmuxDoctorCommandRunner,
    session_name: &str,
) -> Option<TmuxRepairTarget> {
    list_window_targets(runner, session_name)
        .into_iter()
        .find(|target| {
            is_dashboard_window_name(&target.window_name) && target.pane_dead != Some(true)
        })
}

fn list_window_targets(
    runner: &mut impl TmuxDoctorCommandRunner,
    session_name: &str,
) -> Vec<TmuxRepairTarget> {
    let Some(raw) = tmux_value(
        runner,
        &["list-windows", "-t", session_name, "-F", WINDOW_LIST_FORMAT],
    ) else {
        return Vec::new();
    };
    raw.lines()
        .filter_map(|line| {
            let mut fields = line.splitn(6, '\t');
            Some(TmuxRepairTarget {
                session_name: session_name.to_owned(),
                window_id: fields.next()?.to_owned(),
                window_index: fields.next()?.parse().ok()?,
                window_name: fields.next()?.to_owned(),
                pane_dead: fields.nth(2).map(|value| value == "1"),
            })
        })
        .collect()
}

fn apply_managed_agent_window_policy(
    runner: &mut impl TmuxDoctorCommandRunner,
    window_id: &str,
    tool_key: &str,
) -> Result<(), String> {
    for (key, value) in [
        ("@aimux-tool", tool_key),
        (
            "allow-passthrough",
            MANAGED_TMUX_AGENT_WINDOW_OPTIONS.allow_passthrough,
        ),
        (
            "aggressive-resize",
            MANAGED_TMUX_AGENT_WINDOW_OPTIONS.aggressive_resize,
        ),
    ] {
        run_tmux_owned(runner, &set_window_option_argv(window_id, key, value))?;
    }
    Ok(())
}

fn set_session_option(
    runner: &mut impl TmuxDoctorCommandRunner,
    session_name: &str,
    key: &str,
    value: &str,
) -> Result<(), String> {
    run_tmux_owned(runner, &set_session_option_argv(session_name, key, value))
}

fn has_session(runner: &mut impl TmuxDoctorCommandRunner, session_name: &str) -> bool {
    run_command(runner, "tmux", &["has-session", "-t", session_name]).is_ok()
}

fn run_tmux_owned(
    runner: &mut impl TmuxDoctorCommandRunner,
    args: &[String],
) -> Result<(), String> {
    run_command_owned(runner, "tmux", args).map(|_| ())
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.contains(&value) {
        values.push(value);
    }
}

fn canonical_path_text(path: &str) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .into_owned()
}

fn runtime_owner_id(aimux_home: &Path) -> String {
    let port = std::env::var("AIMUX_DAEMON_PORT")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_DAEMON_PORT.to_string());
    serde_json::json!({
        "home": path_text(aimux_home),
        "port": port,
    })
    .to_string()
}

pub fn build_tmux_doctor_report(
    runner: &mut impl TmuxDoctorCommandRunner,
    input: &TmuxDoctorInput,
) -> TmuxDoctorReport {
    let canonical_project_root =
        fs::canonicalize(&input.project_root).unwrap_or_else(|_| input.project_root.clone());
    let availability = run_command(runner, "tmux", &["-V"]);
    let available = availability.is_ok();
    let version = availability.ok();
    let inside_tmux = input
        .tmux_env
        .as_ref()
        .is_some_and(|value| !value.is_empty());
    let current_client_session = if available && inside_tmux {
        tmux_value(runner, &["display-message", "-p", "#{client_session}"])
    } else {
        None
    };
    let default_session =
        project_session(&canonical_project_root, &input.session_prefix).session_name;
    let resolved_session_name = input.session_name.clone().unwrap_or_else(|| {
        current_client_session
            .as_ref()
            .filter(|session| inside_tmux && is_managed_session(session, &input.session_prefix))
            .cloned()
            .unwrap_or(default_session)
    });
    let current_window_id = if available {
        input.window_id.clone().or_else(|| {
            if inside_tmux {
                tmux_value(runner, &["display-message", "-p", "#{window_id}"])
            } else {
                None
            }
        })
    } else {
        None
    };
    let current_window_name = if available && inside_tmux {
        tmux_value(runner, &["display-message", "-p", "#{window_name}"])
    } else {
        None
    };
    let session_exists = available
        && run_command(
            runner,
            "tmux",
            &["has-session", "-t", &resolved_session_name],
        )
        .is_ok();

    let session_options = session_checks(runner, &resolved_session_name, session_exists);
    let feature_text = session_exists
        .then(|| session_option(runner, &resolved_session_name, "terminal-features"))
        .flatten();
    let terminal_features = terminal_feature_checks(feature_text.as_deref());
    let active_window = current_window_id
        .as_ref()
        .filter(|window_id| !window_id.is_empty())
        .map(|window_id| active_window_report(runner, window_id, current_window_name.clone()));
    let managed_windows = if session_exists {
        managed_window_reports(runner, &resolved_session_name)
    } else {
        Vec::new()
    };

    let project_id = project_session(&canonical_project_root, &input.session_prefix).project_id;
    let project_state_dir = input.aimux_home.join("projects").join(project_id);
    let tmux_statusline_dir = project_state_dir.join("tmux-statusline");
    let bottom_dashboard_client_path = current_client_session
        .as_ref()
        .map(|session| tmux_statusline_dir.join(format!("bottom-dashboard-{session}.txt")));
    let (helper_preview, helper_error) = preview_statusline_helper(
        runner,
        &input.statusline_script_path,
        &project_state_dir,
        current_client_session.as_deref(),
        current_window_name.as_deref(),
        current_window_id.as_deref(),
    );
    let session_format = session_exists
        .then(|| session_option(runner, &resolved_session_name, "status-format[0]"))
        .flatten();
    let window_format = session_exists
        .then(|| session_option(runner, &resolved_session_name, "status-format[1]"))
        .flatten();

    TmuxDoctorReport {
        env: TmuxDoctorEnvironment {
            term: input.term.clone().filter(|value| !value.is_empty()),
            term_program: input.term_program.clone().filter(|value| !value.is_empty()),
            inside_tmux,
        },
        tmux: TmuxDoctorTmux {
            available,
            version,
            current_client_session,
            current_window_id,
            current_window_name,
        },
        managed_session: TmuxDoctorManagedSession {
            session_name: resolved_session_name,
            exists: session_exists,
            options: session_options,
            terminal_features,
        },
        active_window,
        managed_windows,
        statusline: TmuxDoctorStatusline {
            script_path: path_text(&input.statusline_script_path),
            script_exists: input.statusline_script_path.is_file(),
            project_state_dir: path_text(&project_state_dir),
            statusline_json_exists: project_state_dir.join("statusline.json").exists(),
            tmux_statusline_dir_exists: tmux_statusline_dir.exists(),
            bottom_dashboard_exists: tmux_statusline_dir.join("bottom-dashboard.txt").exists(),
            bottom_dashboard_client_exists: bottom_dashboard_client_path
                .is_some_and(|path| path.exists()),
            session_format,
            window_format,
            helper_preview,
            helper_error,
        },
    }
}

pub fn render_tmux_doctor_report(report: &TmuxDoctorReport) -> String {
    let mut lines = vec![
        "Tmux Doctor".to_owned(),
        format!("  TERM: {}", optional(&report.env.term, "(unset)")),
        format!(
            "  TERM_PROGRAM: {}",
            optional(&report.env.term_program, "(unset)")
        ),
        format!("  inside tmux: {}", yes_no(report.env.inside_tmux)),
        format!("  tmux available: {}", yes_no(report.tmux.available)),
        format!(
            "  tmux version: {}",
            optional(&report.tmux.version, "(unavailable)")
        ),
        format!(
            "  current client session: {}",
            optional(&report.tmux.current_client_session, "(none)")
        ),
        format!("  managed session: {}", report.managed_session.session_name),
        format!(
            "  managed session exists: {}",
            yes_no(report.managed_session.exists)
        ),
        "  managed session options:".to_owned(),
    ];
    let options = &report.managed_session.options;
    for (key, check) in [
        ("prefix", &options.prefix),
        ("prefix2", &options.prefix2),
        ("mouse", &options.mouse),
        ("window-size", &options.window_size),
        ("history-limit", &options.history_limit),
        ("extended-keys", &options.extended_keys),
        ("extended-keys-format", &options.extended_keys_format),
    ] {
        lines.push(render_check(key, check));
    }
    lines.push("  managed terminal features:".to_owned());
    let features = &report.managed_session.terminal_features;
    for (feature, check) in [
        (MANAGED_TMUX_TERMINAL_FEATURES[0], &features.ccolour),
        (MANAGED_TMUX_TERMINAL_FEATURES[1], &features.cstyle),
        (MANAGED_TMUX_TERMINAL_FEATURES[2], &features.rgb),
        (MANAGED_TMUX_TERMINAL_FEATURES[3], &features.extkeys),
        (MANAGED_TMUX_TERMINAL_FEATURES[4], &features.hyperlinks),
    ] {
        lines.push(format!(
            "    {feature}: {} [{}]",
            if check.ok { "present" } else { "missing" },
            if check.ok { "ok" } else { "mismatch" }
        ));
    }

    if let Some(window) = &report.active_window {
        lines.push(format!(
            "  active window: {} ({})",
            window.window_id,
            optional(&window.window_name, "unknown")
        ));
        lines.push(format!(
            "    @aimux-tool: {}",
            optional(&window.tool, "(unset)")
        ));
        lines.push(render_check(
            "allow-passthrough",
            &window.options.allow_passthrough,
        ));
        lines.push(render_check(
            "aggressive-resize",
            &window.options.aggressive_resize,
        ));
    } else {
        lines.push("  active window: (none)".to_owned());
    }

    if !report.managed_windows.is_empty() {
        lines.push("  managed windows:".to_owned());
        for window in &report.managed_windows {
            lines.push(format!(
                "    {} {} tool={} allow-passthrough={} aggressive-resize={}",
                window.window_id,
                window.window_name,
                window.tool,
                optional(&window.allow_passthrough, "(unset)"),
                optional(&window.aggressive_resize, "(unset)")
            ));
        }
    }

    let statusline = &report.statusline;
    lines.extend([
        "  statusline:".to_owned(),
        format!("    script: {}", statusline.script_path),
        format!("    script exists: {}", yes_no(statusline.script_exists)),
        format!("    project state dir: {}", statusline.project_state_dir),
        format!(
            "    statusline.json: {}",
            yes_no(statusline.statusline_json_exists)
        ),
        format!(
            "    tmux-statusline dir: {}",
            yes_no(statusline.tmux_statusline_dir_exists)
        ),
        format!(
            "    bottom-dashboard.txt: {}",
            yes_no(statusline.bottom_dashboard_exists)
        ),
        format!(
            "    bottom-dashboard-<client>.txt: {}",
            yes_no(statusline.bottom_dashboard_client_exists)
        ),
        format!(
            "    status-format[0]: {}",
            optional(&statusline.session_format, "(missing)")
        ),
        format!(
            "    status-format[1]: {}",
            optional(&statusline.window_format, "(missing)")
        ),
        format!(
            "    helper preview: {}",
            optional(&statusline.helper_preview, "(empty)")
        ),
        format!(
            "    helper error: {}",
            optional(&statusline.helper_error, "(none)")
        ),
    ]);
    lines.join("\n")
}

fn session_checks(
    runner: &mut impl TmuxDoctorCommandRunner,
    session_name: &str,
    session_exists: bool,
) -> TmuxDoctorSessionChecks {
    TmuxDoctorSessionChecks {
        prefix: build_check(
            MANAGED_TMUX_SESSION_OPTIONS.prefix,
            observed_session_option(runner, session_name, "prefix", session_exists),
        ),
        prefix2: build_check(
            MANAGED_TMUX_SESSION_OPTIONS.prefix2,
            observed_session_option(runner, session_name, "prefix2", session_exists),
        ),
        mouse: build_check(
            MANAGED_TMUX_SESSION_OPTIONS.mouse,
            observed_session_option(runner, session_name, "mouse", session_exists),
        ),
        window_size: build_check(
            MANAGED_TMUX_SESSION_OPTIONS.window_size,
            observed_session_option(runner, session_name, "window-size", session_exists),
        ),
        history_limit: build_check(
            MANAGED_TMUX_SESSION_OPTIONS.history_limit,
            observed_session_option(runner, session_name, "history-limit", session_exists),
        ),
        extended_keys: build_check(
            MANAGED_TMUX_SESSION_OPTIONS.extended_keys,
            observed_session_option(runner, session_name, "extended-keys", session_exists),
        ),
        extended_keys_format: build_check(
            MANAGED_TMUX_SESSION_OPTIONS.extended_keys_format,
            observed_session_option(runner, session_name, "extended-keys-format", session_exists),
        ),
    }
}

fn observed_session_option(
    runner: &mut impl TmuxDoctorCommandRunner,
    session_name: &str,
    key: &str,
    session_exists: bool,
) -> Option<String> {
    session_exists
        .then(|| session_option(runner, session_name, key))
        .flatten()
}

fn terminal_feature_checks(feature_text: Option<&str>) -> TmuxDoctorTerminalFeatureChecks {
    let entries = feature_text
        .into_iter()
        .flat_map(str::lines)
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>();
    let check = |feature| {
        let present = terminal_feature_present(&entries, feature);
        TmuxDoctorCheck {
            expected: "present".to_owned(),
            observed: present.then(|| "present".to_owned()),
            ok: present,
        }
    };
    TmuxDoctorTerminalFeatureChecks {
        ccolour: check(MANAGED_TMUX_TERMINAL_FEATURES[0]),
        cstyle: check(MANAGED_TMUX_TERMINAL_FEATURES[1]),
        rgb: check(MANAGED_TMUX_TERMINAL_FEATURES[2]),
        extkeys: check(MANAGED_TMUX_TERMINAL_FEATURES[3]),
        hyperlinks: check(MANAGED_TMUX_TERMINAL_FEATURES[4]),
    }
}

fn terminal_feature_present(entries: &[&str], feature: &str) -> bool {
    if entries.contains(&feature) {
        return true;
    }
    let Some((selector, capability)) = feature.split_once(':') else {
        return false;
    };
    entries.iter().any(|entry| {
        let mut parts = entry.split(':');
        parts.next() == Some(selector)
            && parts.any(|entry_capability| entry_capability == capability)
    })
}

fn active_window_report(
    runner: &mut impl TmuxDoctorCommandRunner,
    window_id: &str,
    window_name: Option<String>,
) -> TmuxDoctorActiveWindow {
    TmuxDoctorActiveWindow {
        window_id: window_id.to_owned(),
        window_name,
        tool: window_option(runner, window_id, "@aimux-tool"),
        options: TmuxDoctorWindowChecks {
            allow_passthrough: build_check(
                MANAGED_TMUX_AGENT_WINDOW_OPTIONS.allow_passthrough,
                window_option(runner, window_id, "allow-passthrough"),
            ),
            aggressive_resize: build_check(
                MANAGED_TMUX_AGENT_WINDOW_OPTIONS.aggressive_resize,
                window_option(runner, window_id, "aggressive-resize"),
            ),
        },
    }
}

fn managed_window_reports(
    runner: &mut impl TmuxDoctorCommandRunner,
    session_name: &str,
) -> Vec<TmuxDoctorManagedWindow> {
    let Some(raw) = tmux_value(
        runner,
        &[
            "list-windows",
            "-t",
            session_name,
            "-F",
            MANAGED_WINDOWS_FORMAT,
        ],
    ) else {
        return Vec::new();
    };
    raw.lines()
        .filter_map(|line| {
            let mut fields = line.splitn(7, '\t');
            let window_id = fields.next()?.to_owned();
            let window_index = fields.next()?.parse().ok()?;
            let window_name = fields.next()?.to_owned();
            fields.next()?;
            fields.next()?;
            fields.next()?;
            let metadata: Value = serde_json::from_str(fields.next()?).ok()?;
            let tool = metadata.get("toolConfigKey")?.as_str()?.to_owned();
            Some(TmuxDoctorManagedWindow {
                allow_passthrough: window_option(runner, &window_id, "allow-passthrough"),
                aggressive_resize: window_option(runner, &window_id, "aggressive-resize"),
                window_id,
                window_index,
                window_name,
                tool,
            })
        })
        .collect()
}

fn preview_statusline_helper(
    runner: &mut impl TmuxDoctorCommandRunner,
    script_path: &Path,
    project_state_dir: &Path,
    current_session: Option<&str>,
    current_window: Option<&str>,
    current_window_id: Option<&str>,
) -> (Option<String>, Option<String>) {
    if !script_path.is_file() {
        return (
            None,
            Some(format!("missing script: {}", script_path.to_string_lossy())),
        );
    }
    let args = vec![
        path_text(script_path),
        "--line".to_owned(),
        "bottom".to_owned(),
        "--project-state-dir".to_owned(),
        path_text(project_state_dir),
        "--current-session".to_owned(),
        current_session.unwrap_or("").to_owned(),
        "--current-window".to_owned(),
        current_window.unwrap_or("").to_owned(),
        "--current-window-id".to_owned(),
        current_window_id.unwrap_or("").to_owned(),
    ];
    match run_command_owned(runner, "sh", &args) {
        Ok(output) => (nonempty(output), None),
        Err(error) => (None, Some(error)),
    }
}

fn build_check(expected: &str, observed: Option<String>) -> TmuxDoctorCheck {
    TmuxDoctorCheck {
        ok: observed.as_deref() == Some(expected),
        expected: expected.to_owned(),
        observed,
    }
}

fn session_option(
    runner: &mut impl TmuxDoctorCommandRunner,
    session_name: &str,
    key: &str,
) -> Option<String> {
    tmux_value(runner, &["show-options", "-v", "-t", session_name, key])
}

fn window_option(
    runner: &mut impl TmuxDoctorCommandRunner,
    window_id: &str,
    key: &str,
) -> Option<String> {
    tmux_value(runner, &["show-window-options", "-v", "-t", window_id, key])
}

fn tmux_value(runner: &mut impl TmuxDoctorCommandRunner, args: &[&str]) -> Option<String> {
    run_command(runner, "tmux", args).ok().and_then(nonempty)
}

fn run_command(
    runner: &mut impl TmuxDoctorCommandRunner,
    program: &str,
    args: &[&str],
) -> Result<String, String> {
    let args = args.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
    run_command_owned(runner, program, &args)
}

fn run_command_owned(
    runner: &mut impl TmuxDoctorCommandRunner,
    program: &str,
    args: &[String],
) -> Result<String, String> {
    runner
        .run(program, args)
        .map(|output| output.trim().to_owned())
}

fn nonempty(value: String) -> Option<String> {
    (!value.is_empty()).then_some(value)
}

fn nonempty_env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

fn resolve_statusline_script_path() -> PathBuf {
    let candidate = std::env::var_os("AIMUX_ROOT")
        .filter(|root| !root.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))
        .join("scripts/tmux-statusline.sh");
    fs::canonicalize(&candidate).unwrap_or(candidate)
}

fn resolve_tmux_control_script_path() -> PathBuf {
    resolve_repo_script_path("scripts/tmux-control.sh")
}

fn resolve_repo_script_path(relative: &str) -> PathBuf {
    let candidate = std::env::var_os("AIMUX_ROOT")
        .filter(|root| !root.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))
        .join(relative);
    fs::canonicalize(&candidate).unwrap_or(candidate)
}

fn native_tmux_control_command() -> String {
    native_aimux_internal_command("__tmux-control-internal")
}

fn native_tmux_statusline_command() -> String {
    native_aimux_internal_command("__tmux-statusline-internal")
}

fn native_tmux_open_hyperlink_command() -> String {
    native_aimux_internal_command("__tmux-open-hyperlink-internal")
}

fn native_aimux_internal_command(command: &str) -> String {
    std::env::current_exe()
        .ok()
        .map(|path| format!("{} {command}", shell_quote(&path_text(&path))))
        .unwrap_or_else(|| format!("aimux {command}"))
}

fn is_managed_session(session_name: &str, prefix: &str) -> bool {
    session_name.starts_with(&format!("{prefix}-"))
}

fn render_check(key: &str, check: &TmuxDoctorCheck) -> String {
    format!(
        "    {key}: {} (expected {}) [{}]",
        optional(&check.observed, "(missing)"),
        check.expected,
        if check.ok { "ok" } else { "mismatch" }
    )
}

fn optional<'a>(value: &'a Option<String>, fallback: &'a str) -> &'a str {
    value.as_deref().unwrap_or(fallback)
}

fn yes_no(value: bool) -> &'static str {
    if value { "yes" } else { "no" }
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
