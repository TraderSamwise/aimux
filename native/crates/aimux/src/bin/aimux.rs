use aimux::config::load_config_for_project;
use aimux::core_cli::CoreCommandRequestOptions;
use aimux::core_cli_executor::run_core_cli;
use aimux::core_cli_routing::core_command_args;
use aimux::core_command_client::request_core_command;
use aimux::core_command_contract::CORE_COMMAND_NAMES;
use aimux::daemon::runtime::run_daemon_internal;
use aimux::daemon_state::get_daemon_base_url;
use aimux::dashboard_internal::{NativeDashboardOptions, run_native_dashboard_internal};
use aimux::launcher_env::{CliEntry, cli_entry_for, prepare_stable_process_env};
use aimux::local_ui_server::{
    DEFAULT_LOCAL_UI_HOST, DEFAULT_LOCAL_UI_PORT, LocalUiConfig, LocalUiServerOptions,
    open_url_in_browser, resolve_default_local_ui_root, start_local_ui_server,
};
use aimux::native_cli_dispatch::{
    native_root_tool_launch_args_for_config, normalize_root_dispatch_args,
};
use aimux::paths::PathResolver;
use aimux::project_service::process::{
    ProjectServiceInternalOptions, run_project_service_internal,
};
use aimux::root_session_launch::{
    RootResumeRequest, parse_root_resume_args, resume_saved_sessions,
};
use aimux::tmux::{OpenTargetOptions, TmuxRuntimeManager, TmuxTarget};
use aimux::tmux_control::{parse_tmux_control_args, run_tmux_control};
use aimux::tmux_expose::{parse_expose_args, run_tmux_expose};
use aimux::tmux_open_hyperlink::run_tmux_open_hyperlink_from_env;
use aimux::tmux_statusline_script::{parse_tmux_statusline_args, run_tmux_statusline};
use anyhow::Result;
use clap::{Parser, Subcommand};
use serde_json::Value;
use std::fs;
use std::io::IsTerminal;
use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Debug, Parser)]
#[command(name = "aimux")]
#[command(about = "Native Aimux CLI")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Clone, Subcommand)]
enum Command {
    BuildInfo {
        #[arg(long)]
        json: bool,
    },
    Daemon {
        #[command(subcommand)]
        command: DaemonCommand,
    },
    Contracts {
        #[command(subcommand)]
        command: ContractsCommand,
    },
    Rewrite {
        #[command(subcommand)]
        command: RewriteCommand,
    },
    Ui {
        #[arg(long, default_value = DEFAULT_LOCAL_UI_HOST)]
        host: String,
        #[arg(long, default_value_t = DEFAULT_LOCAL_UI_PORT)]
        port: u16,
        #[arg(long = "daemon-url")]
        daemon_url: Option<String>,
        #[arg(long = "no-daemon")]
        no_daemon: bool,
        #[arg(long)]
        open: bool,
    },
    #[command(name = "__project-service-internal", hide = true)]
    ProjectServiceInternal {
        #[arg(long = "project-id")]
        project_id: Option<String>,
        #[arg(long = "project-root")]
        project_root: Option<PathBuf>,
    },
    #[command(name = "__dashboard-internal-native", hide = true)]
    DashboardInternalNative {
        #[arg(long = "project-root")]
        project_root: Option<PathBuf>,
        #[arg(long = "desktop-state-file")]
        desktop_state_file: Option<PathBuf>,
        #[arg(long)]
        cols: Option<usize>,
        #[arg(long)]
        rows: Option<usize>,
        #[arg(long)]
        once: bool,
    },
    #[command(name = "__tmux-control-internal", hide = true)]
    TmuxControlInternal {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    #[command(name = "__tmux-statusline-internal", hide = true)]
    TmuxStatuslineInternal {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    #[command(name = "__tmux-open-hyperlink-internal", hide = true)]
    TmuxOpenHyperlinkInternal,
}

#[derive(Debug, Clone, Subcommand)]
enum ContractsCommand {
    List {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Clone, Subcommand)]
enum DaemonCommand {
    Run,
}

#[derive(Debug, Clone, Subcommand)]
enum RewriteCommand {
    Status {
        #[arg(long)]
        json: bool,
    },
}

fn main() -> Result<ExitCode> {
    prepare_stable_process_env();
    let raw_args = std::env::args().skip(1).collect::<Vec<_>>();
    let stripped_args = normalize_root_dispatch_args(&core_command_args(&raw_args));
    if is_root_version_request(&stripped_args) {
        println!("{}", aimux_package_version());
        return Ok(ExitCode::SUCCESS);
    }
    if is_root_help_request(&stripped_args) {
        print_root_help();
        return Ok(ExitCode::SUCCESS);
    }
    let process_argv = std::iter::once("node".to_owned())
        .chain(std::iter::once("aimux".to_owned()))
        .chain(raw_args.clone())
        .collect::<Vec<_>>();
    match cli_entry_for(&process_argv) {
        CliEntry::Core => {
            let execution = run_core_cli(&raw_args);
            for line in execution.stdout {
                println!("{line}");
            }
            for line in execution.stderr {
                eprintln!("{line}");
            }
            return Ok(ExitCode::from(execution.code as u8));
        }
        CliEntry::Expose => {
            let options = match parse_expose_args(&raw_args) {
                Ok(options) => options,
                Err(error) => {
                    eprintln!("Error: {error}");
                    return Ok(ExitCode::from(1));
                }
            };
            return Ok(ExitCode::from(run_tmux_expose(options) as u8));
        }
        CliEntry::Main => {
            if stripped_args.is_empty() {
                return run_root_dashboard_command();
            }
            if let Some(request) = parse_root_resume_args(&stripped_args) {
                return run_root_resume_command(request);
            }
            if let Some(args) = native_tool_launch_args(&stripped_args) {
                return run_root_tool_launch_command(&args);
            }
            if is_native_foreground_core_command(&stripped_args) {
                return run_core_command_and_print(&stripped_args);
            }
            if let Some(code) = handle_known_native_command_fallback(&stripped_args) {
                return Ok(code);
            }
        }
    }
    let cli = Cli::parse_from(std::iter::once("aimux".to_owned()).chain(stripped_args));
    if let Command::TmuxControlInternal { args } = cli.command.clone() {
        return match parse_tmux_control_args(&args) {
            Ok(options) => Ok(ExitCode::from(run_tmux_control(options) as u8)),
            Err(error) => {
                eprintln!("Error: {error}");
                Ok(ExitCode::from(1))
            }
        };
    }
    if let Command::TmuxStatuslineInternal { args } = cli.command.clone() {
        let options = parse_tmux_statusline_args(&args);
        let mut stdout = std::io::stdout();
        return Ok(ExitCode::from(
            run_tmux_statusline(options, &mut stdout) as u8
        ));
    }
    if let Command::TmuxOpenHyperlinkInternal = cli.command.clone() {
        return Ok(ExitCode::from(run_tmux_open_hyperlink_from_env() as u8));
    }
    match cli.command {
        Command::BuildInfo { json } => print_value(aimux::build_info(), json),
        Command::Daemon {
            command: DaemonCommand::Run,
        } => {
            run_daemon_internal()?;
            Ok(())
        }
        Command::Contracts {
            command: ContractsCommand::List { json },
        } => print_value(aimux::contract_manifest(), json),
        Command::Rewrite {
            command: RewriteCommand::Status { json },
        } => print_value(aimux::rewrite_status(), json),
        Command::Ui {
            host,
            port,
            daemon_url,
            no_daemon,
            open,
        } => run_local_ui_command(host, port, daemon_url, no_daemon, open),
        Command::ProjectServiceInternal {
            project_id,
            project_root,
        } => {
            run_project_service_internal(ProjectServiceInternalOptions {
                project_id,
                project_root,
            })?;
            Ok(())
        }
        Command::DashboardInternalNative {
            project_root,
            desktop_state_file,
            cols,
            rows,
            once,
        } => {
            let (resolved_cols, resolved_rows) = resolve_dashboard_dimensions(cols, rows);
            run_native_dashboard_internal(NativeDashboardOptions {
                project_root: project_root.unwrap_or(std::env::current_dir()?),
                desktop_state_file,
                cols: resolved_cols,
                rows: resolved_rows,
                once,
            })?;
            Ok(())
        }
        Command::TmuxControlInternal { .. } => unreachable!("handled before native command match"),
        Command::TmuxStatuslineInternal { .. } => {
            unreachable!("handled before native command match")
        }
        Command::TmuxOpenHyperlinkInternal => unreachable!("handled before native command match"),
    }?;
    Ok(ExitCode::SUCCESS)
}

fn is_native_main_command(args: &[String]) -> bool {
    match args {
        [] => true,
        [command, ..] if command == "build-info" => true,
        [command, subcommand, ..] if command == "daemon" && subcommand == "run" => true,
        [command, subcommand, ..] if command == "contracts" && subcommand == "list" => true,
        [command, subcommand, ..] if command == "rewrite" && subcommand == "status" => true,
        [command, ..] if command == "ui" => true,
        [command, ..] if command == "__project-service-internal" => true,
        [command, ..] if command == "__dashboard-internal-native" => true,
        [command, ..] if command == "__tmux-control-internal" => true,
        [command, ..] if command == "__tmux-statusline-internal" => true,
        [command, ..] if command == "__tmux-open-hyperlink-internal" => true,
        _ => false,
    }
}

fn is_native_foreground_core_command(args: &[String]) -> bool {
    matches!(
        args.first().map(String::as_str),
        Some("dashboard-reload" | "restart-runtime")
    )
}

fn is_root_version_request(args: &[String]) -> bool {
    matches!(args, [flag] if flag == "--version" || flag == "-V")
}

fn is_root_help_request(args: &[String]) -> bool {
    matches!(args, [flag] if flag == "--help" || flag == "-h")
}

fn aimux_package_version() -> String {
    let root = std::env::var_os("AIMUX_ROOT")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::current_exe()
                .ok()
                .and_then(|path| path.parent().map(PathBuf::from))
        })
        .unwrap_or_else(|| PathBuf::from("."));
    let version_path = root.join("VERSION");
    if let Ok(version) = fs::read_to_string(&version_path) {
        let version = version.trim();
        if !version.is_empty() {
            return version.to_owned();
        }
    }
    let package_path = root.join("package.json");
    fs::read_to_string(package_path)
        .ok()
        .and_then(|body| serde_json::from_str::<serde_json::Value>(&body).ok())
        .and_then(|pkg| {
            pkg.get("version")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "0.0.0".into())
}

fn print_root_help() {
    println!(
        "Usage: aimux [options] [command] [tool] [args...]\n\nNative CLI agent multiplexer\n\nArguments:\n  tool                         Tool to run (e.g. claude, codex, aider)\n  args                         Arguments to pass to the tool\n\nOptions:\n  --resume                     Resume previous sessions using native tool resume\n  --restore                    Start fresh sessions with injected history context\n  --debug                      Enable debug logging for this process\n  -V, --version                output the version number\n  -h, --help                   display help for command\n\nCommands:\n  init                         Initialize .aimux directory\n  restart                      Restart the Aimux control plane\n  dashboard-reload             Reload or open the dashboard\n  stop [sessionId]             Stop an agent or the current project service\n  restart-runtime              Restart the tmux runtime service\n  host                         Advanced project-service inspection commands\n  daemon                       Advanced: manage the global aimux control-plane daemon\n  projects                     Inspect known aimux projects\n  compact                      Compact session history using LLM summarization\n  worktree                     Manage git worktrees\n  thread                       Inspect and manage orchestration threads\n  threads                      List orchestration threads\n  input                        Send input to a running agent\n  ps                           List running agent sessions\n  list                         List agents grouped by worktree\n  id <sessionId>               Resolve an Aimux agent id to its canonical tool and native backend id\n  loop                         Manage agents in an overseer-managed loop\n  message                      Send directed orchestration messages\n  handoff                      Send an explicit orchestration handoff\n  task                         Create and manage orchestrated tasks\n  review                       Manage review workflow tasks\n  overseer                     Manage the project overseer\n  scribe                       Manage the project scribe\n  fork                         Fork an agent session\n  graveyard                    Manage killed agents\n  rename <sessionId>           Rename an agent session\n  kill <sessionId>             Kill an agent session\n  migrate <sessionId>          Move an agent to another worktree\n  doctor                       Inspect aimux runtime state\n  notifications                Manage desktop notification delivery\n  repair                       Repair the current project runtime in place\n  migration                    Audit and migrate runtime state\n  notify                       Send a notification\n  list-notifications           List notifications\n  clear-notifications          Clear notifications\n  read-notifications           Mark notifications read\n"
    );
}

fn run_root_dashboard_command() -> Result<ExitCode> {
    let serve_args = vec!["serve".to_owned()];
    let serve = run_core_cli(&serve_args);
    if serve.code != 0 {
        for line in serve.stdout {
            println!("{line}");
        }
        for line in serve.stderr {
            eprintln!("{line}");
        }
        return Ok(ExitCode::from(serve.code as u8));
    }

    run_root_native_dashboard()
}

fn run_root_native_dashboard() -> Result<ExitCode> {
    let (cols, rows) = resolve_dashboard_dimensions(None, None);
    run_native_dashboard_internal(NativeDashboardOptions {
        project_root: current_project_root()?,
        desktop_state_file: None,
        cols,
        rows,
        once: false,
    })?;
    Ok(ExitCode::SUCCESS)
}

fn run_core_command_and_print(args: &[String]) -> Result<ExitCode> {
    let execution = run_core_cli(args);
    let code = execution.code;
    print_execution(execution);
    Ok(ExitCode::from(code as u8))
}

fn print_execution(execution: aimux::core_cli_executor::CoreCliExecution) {
    for line in execution.stdout {
        println!("{line}");
    }
    for line in execution.stderr {
        eprintln!("{line}");
    }
}

fn run_root_resume_command(request: RootResumeRequest) -> Result<ExitCode> {
    let serve_args = vec!["serve".to_owned()];
    let serve = run_core_cli(&serve_args);
    if serve.code != 0 {
        for line in serve.stdout {
            println!("{line}");
        }
        for line in serve.stderr {
            eprintln!("{line}");
        }
        return Ok(ExitCode::from(serve.code as u8));
    }
    let project_root = current_project_root()?;
    let result =
        resume_saved_sessions(&project_root, request.mode, request.tool_filter.as_deref())?;
    if result.resumed.is_empty() {
        eprintln!("No saved session state found (or state is stale). Starting fresh.");
    }
    for (session_id, error) in result.failed {
        eprintln!("Skipping saved session \"{session_id}\": {error}");
    }
    run_root_native_dashboard()
}

fn run_root_tool_launch_command(args: &[String]) -> Result<ExitCode> {
    if args.first().map(String::as_str) != Some("spawn") {
        return run_core_command_and_print(args);
    }
    let execution = run_core_cli(args);
    if execution.code != 0 {
        print_execution(execution);
        return Ok(ExitCode::from(1));
    }
    let payload = parse_single_json_stdout(&execution.stdout)?;
    open_payload_target_from_foreground(&payload)?;
    Ok(ExitCode::SUCCESS)
}

fn parse_single_json_stdout(stdout: &[String]) -> Result<Value> {
    let text = stdout.join("\n");
    serde_json::from_str(&text).map_err(anyhow::Error::from)
}

fn open_payload_target_from_foreground(payload: &Value) -> Result<()> {
    let target = tmux_target_from_value(&payload["dashboardTarget"])
        .or_else(|| tmux_target_from_value(&payload["tmuxTarget"]))
        .ok_or_else(|| anyhow::anyhow!("tmux target missing from native launch response"))?;
    let mut tmux = TmuxRuntimeManager::new();
    tmux.open_target(
        &target,
        OpenTargetOptions {
            inside_tmux: std::env::var_os("TMUX").is_some(),
            client_tty: foreground_tty(),
            ..OpenTargetOptions::default()
        },
    )
    .map_err(anyhow::Error::msg)?;
    Ok(())
}

fn tmux_target_from_value(value: &Value) -> Option<TmuxTarget> {
    Some(TmuxTarget {
        session_name: value.get("sessionName")?.as_str()?.to_owned(),
        window_id: value.get("windowId")?.as_str()?.to_owned(),
        window_index: value.get("windowIndex")?.as_i64()?,
        window_name: value.get("windowName")?.as_str()?.to_owned(),
        pane_dead: value.get("paneDead").and_then(Value::as_bool),
    })
}

fn foreground_tty() -> Option<String> {
    if std::env::var_os("TMUX").is_some()
        && let Some(client_tty) = tmux_display_message("#{client_tty}")
    {
        return Some(client_tty);
    }
    if !std::io::stdin().is_terminal() {
        return None;
    }
    std::process::Command::new("tty")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|tty| !tty.is_empty() && tty != "not a tty")
}

fn tmux_display_message(format: &str) -> Option<String> {
    std::process::Command::new("tmux")
        .args(["display-message", "-p", format])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn resolve_dashboard_dimensions(cols: Option<usize>, rows: Option<usize>) -> (usize, usize) {
    let detected = terminal_dimensions();
    (
        cols.or_else(|| detected.map(|(cols, _)| cols))
            .unwrap_or(120),
        rows.or_else(|| detected.map(|(_, rows)| rows))
            .unwrap_or(40),
    )
}

fn terminal_dimensions() -> Option<(usize, usize)> {
    terminal_dimensions_for_fd(std::io::stdout().as_raw_fd())
        .or_else(|| terminal_dimensions_for_fd(std::io::stdin().as_raw_fd()))
}

fn terminal_dimensions_for_fd(fd: i32) -> Option<(usize, usize)> {
    let mut size = std::mem::MaybeUninit::<libc::winsize>::zeroed();
    if unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, size.as_mut_ptr()) } != 0 {
        return None;
    }
    let size = unsafe { size.assume_init() };
    let cols = usize::from(size.ws_col);
    let rows = usize::from(size.ws_row);
    (cols > 0 && rows > 0).then_some((cols, rows))
}

fn native_tool_launch_args(args: &[String]) -> Option<Vec<String>> {
    let (tool, extra_args) = args.split_first()?;
    if tool.starts_with('-') || is_known_aimux_command_word(tool) {
        return None;
    }
    let project_root = current_project_root().ok()?;
    let config = load_config_for_project(project_root);
    let normalized = std::iter::once(tool.clone())
        .chain(extra_args.iter().cloned())
        .collect::<Vec<_>>();
    native_root_tool_launch_args_for_config(&normalized, &config)
}

fn current_project_root() -> Result<PathBuf> {
    let cwd = std::env::current_dir()?;
    let mut resolver = PathResolver::from_env();
    Ok(resolver.resolve_repo_root(cwd))
}

fn handle_known_native_command_fallback(args: &[String]) -> Option<ExitCode> {
    let command = args.first()?;
    if !is_known_aimux_command_word(command) || is_native_main_command(args) {
        return None;
    }
    if args
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h"))
    {
        print_root_help();
        return Some(ExitCode::SUCCESS);
    }
    eprintln!(
        "error: unsupported or invalid aimux command: {}",
        args.join(" ")
    );
    Some(ExitCode::from(2))
}

fn is_known_aimux_command_word(word: &str) -> bool {
    matches!(
        word,
        "attachment"
            | "build-info"
            | "clear-notifications"
            | "compact"
            | "contracts"
            | "daemon"
            | "dashboard-reload"
            | "debug-state"
            | "doctor"
            | "expose"
            | "fork"
            | "graveyard"
            | "handoff"
            | "host"
            | "hosted"
            | "id"
            | "init"
            | "input"
            | "kill"
            | "list"
            | "list-notifications"
            | "login"
            | "logout"
            | "logs"
            | "loop"
            | "message"
            | "metadata"
            | "migrate"
            | "migration"
            | "notifications"
            | "notify"
            | "outline"
            | "overseer"
            | "projects"
            | "ps"
            | "read-notifications"
            | "remote"
            | "rename"
            | "repair"
            | "restart"
            | "restart-runtime"
            | "review"
            | "rewrite"
            | "scribe"
            | "security"
            | "serve"
            | "service"
            | "spawn"
            | "stop"
            | "task"
            | "team"
            | "thread"
            | "threads"
            | "ui"
            | "whoami"
            | "worktree"
            | "__dashboard-internal-native"
            | "__tmux-control-internal"
            | "__tmux-statusline-internal"
            | "__tmux-open-hyperlink-internal"
            | "__project-service-internal"
    )
}

fn run_local_ui_command(
    host: String,
    port: u16,
    daemon_url: Option<String>,
    no_daemon: bool,
    open: bool,
) -> Result<()> {
    let daemon_url = match daemon_url
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        Some(value) => value,
        None if no_daemon => get_daemon_base_url(None).map_err(anyhow::Error::msg)?,
        None => {
            let response = request_core_command(
                CORE_COMMAND_NAMES.status,
                None,
                CoreCommandRequestOptions::default(),
            )
            .map_err(anyhow::Error::msg)?;
            let port = response
                .result
                .get("daemon")
                .and_then(|daemon| daemon.get("port"))
                .and_then(serde_json::Value::as_u64)
                .and_then(|port| u16::try_from(port).ok());
            get_daemon_base_url(port).map_err(anyhow::Error::msg)?
        }
    };
    let server = start_local_ui_server(LocalUiServerOptions {
        host,
        port,
        ui_root: resolve_default_local_ui_root(),
        config: LocalUiConfig {
            connection_mode: "local".into(),
            daemon_url: daemon_url.clone(),
        },
    })?;
    println!("aimux UI: {}", server.url);
    println!("Daemon: {daemon_url}");
    println!("Press Ctrl-C to stop.");
    if open {
        open_url_in_browser(&server.url)?;
    }
    loop {
        std::thread::park();
    }
}

fn print_value<T>(value: T, json: bool) -> Result<()>
where
    T: serde::Serialize + std::fmt::Debug,
{
    if json {
        println!("{}", serde_json::to_string_pretty(&value)?);
    } else {
        println!("{value:#?}");
    }
    Ok(())
}
