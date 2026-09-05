use crate::config::load_config_for_project;
use crate::paths::PathResolver;
use crate::tmux::{
    MANAGED_TMUX_AGENT_WINDOW_OPTIONS, MANAGED_TMUX_SESSION_OPTIONS,
    MANAGED_TMUX_TERMINAL_FEATURES, project_session,
};
use serde::Serialize;
use serde_json::Value;
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
