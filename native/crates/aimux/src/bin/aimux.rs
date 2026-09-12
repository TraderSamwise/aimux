use aimux::async_subprocess::AsyncCommand;
use aimux::config::load_config_for_project;
use aimux::core_cli::CoreCommandRequestOptions;
use aimux::core_cli_executor::run_core_cli;
use aimux::core_cli_routing::core_command_args;
use aimux::core_command_client::request_core_command;
use aimux::core_command_contract::CORE_COMMAND_NAMES;
use aimux::daemon::runtime::run_daemon_internal;
use aimux::daemon_state::{get_daemon_base_url, get_daemon_port};
use aimux::dashboard_internal::{NativeDashboardOptions, run_native_dashboard_internal};
use aimux::dashboard_targets::{
    DashboardResolveOptions, find_live_dashboard_target, resolve_dashboard_target,
};
use aimux::debug_logging::{
    LogLevel, configure_daemon_logging, configure_process_logging, log_at,
    parse_logging_cli_options,
};
use aimux::hosted_cli::run_hosted_cli_command;
use aimux::launcher_env::{CliEntry, cli_entry_for, prepare_stable_process_env};
use aimux::local_ui_server::{
    DEFAULT_LOCAL_UI_HOST, DEFAULT_LOCAL_UI_PORT, LocalUiConfig, LocalUiServerOptions,
    open_url_in_browser, resolve_default_local_ui_root, start_local_ui_server,
};
use aimux::native_cli_dispatch::{
    is_known_aimux_command_word, native_root_tool_launch_args_for_config,
    normalize_root_dispatch_args,
};
use aimux::paths::PathResolver;
use aimux::process_inspector::is_process_descended_from_executable;
use aimux::project_service::process::{
    ProjectServiceInternalOptions, run_project_service_internal,
};
use aimux::project_service_manifest::get_project_service_manifest;
use aimux::release_version_contract::read_aimux_runtime_version;
use aimux::root_session_launch::{
    RootResumeRequest, parse_root_resume_args, resume_saved_sessions,
};
use aimux::tmux::{OpenTargetOptions, TmuxRuntimeManager, TmuxTarget, tmux_command_from_env};
use aimux::tmux_control::{parse_tmux_control_args, run_tmux_control};
use aimux::tmux_expose::{parse_expose_args, run_tmux_expose};
use aimux::tmux_open_hyperlink::run_tmux_open_hyperlink_from_env;
use aimux::tmux_statusline_script::{parse_tmux_statusline_args, run_tmux_statusline};
use anyhow::Result;
use clap::{Parser, Subcommand};
use serde_json::Value;
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
    #[command(name = "__project-service-manifest-internal", hide = true)]
    ProjectServiceManifestInternal {
        #[arg(long)]
        json: bool,
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
    #[command(name = "__tmux-client-is-mosh-internal", hide = true)]
    TmuxClientIsMoshInternal {
        #[arg(long)]
        pid: i32,
    },
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
    aimux::async_runtime::init_process_runtime()?;
    let raw_args = std::env::args().skip(1).collect::<Vec<_>>();
    let stripped_args = normalize_root_dispatch_args(&core_command_args(&raw_args));
    let logging_cli = parse_logging_cli_options(&raw_args);
    if is_root_version_request(&stripped_args) {
        println!("{}", aimux_package_version());
        return Ok(ExitCode::SUCCESS);
    }
    if is_root_help_request(&stripped_args) {
        print_root_help();
        return Ok(ExitCode::SUCCESS);
    }
    if let Some(help) = core_command_help(&stripped_args) {
        println!("{help}");
        return Ok(ExitCode::SUCCESS);
    }
    configure_process_logging(std::env::current_dir()?, "cli", logging_cli.clone());
    log_at(
        LogLevel::Info,
        "logging configured",
        "logging",
        Some(serde_json::json!({
            "processKind": "cli",
        })),
    );
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
            if stripped_args.first().map(String::as_str) == Some("hosted") {
                let execution = run_hosted_cli_command(&stripped_args);
                for line in execution.stdout {
                    println!("{line}");
                }
                for line in execution.stderr {
                    eprintln!("{line}");
                }
                return Ok(ExitCode::from(execution.code));
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
    if let Command::TmuxClientIsMoshInternal { pid } = cli.command.clone() {
        return Ok(
            if is_process_descended_from_executable(pid, "mosh-server") {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            },
        );
    }
    match cli.command {
        Command::BuildInfo { json } => print_value(aimux::build_info(), json),
        Command::Daemon {
            command: DaemonCommand::Run,
        } => {
            configure_daemon_logging(logging_cli.clone());
            log_at(LogLevel::Info, "logging configured", "logging", None);
            run_daemon_internal()?;
            Ok(())
        }
        Command::Contracts {
            command: ContractsCommand::List { json },
        } => {
            let repo_root = aimux::find_contract_repo_root(std::env::current_dir()?);
            print_value(aimux::contract_manifest_report(repo_root), json)
        }
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
            let logging_project_root = project_root
                .as_deref()
                .map(PathBuf::from)
                .unwrap_or(std::env::current_dir()?);
            configure_process_logging(
                &logging_project_root,
                "project-service",
                logging_cli.clone(),
            );
            log_at(LogLevel::Info, "logging configured", "logging", None);
            run_project_service_internal(ProjectServiceInternalOptions {
                project_id,
                project_root,
            })?;
            Ok(())
        }
        Command::ProjectServiceManifestInternal { json } => {
            print_value(get_project_service_manifest()?, json)
        }
        Command::DashboardInternalNative {
            project_root,
            desktop_state_file,
            cols,
            rows,
            once,
        } => {
            let logging_project_root = project_root
                .as_deref()
                .map(PathBuf::from)
                .unwrap_or(std::env::current_dir()?);
            configure_process_logging(&logging_project_root, "dashboard", logging_cli.clone());
            log_at(LogLevel::Info, "logging configured", "logging", None);
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
        Command::TmuxClientIsMoshInternal { .. } => {
            unreachable!("handled before native command match")
        }
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
        [command, ..] if command == "__project-service-manifest-internal" => true,
        [command, ..] if command == "__dashboard-internal-native" => true,
        [command, ..] if command == "__tmux-control-internal" => true,
        [command, ..] if command == "__tmux-statusline-internal" => true,
        [command, ..] if command == "__tmux-open-hyperlink-internal" => true,
        [command, ..] if command == "__tmux-client-is-mosh-internal" => true,
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
    read_aimux_runtime_version()
}

fn print_root_help() {
    println!(
        "Usage: aimux [options] [command] [tool] [args...]\n\nNative CLI agent multiplexer\n\nArguments:\n  tool                         Tool to run (e.g. claude, codex, aider)\n  args                         Arguments to pass to the tool\n\nOptions:\n  --resume                     Resume previous sessions using native tool resume\n  --restore                    Start fresh sessions with injected history context\n  --debug                      Enable debug logging for this process\n  -V, --version                output the version number\n  -h, --help                   display help for command\n\nCommands:\n  init                         Initialize .aimux directory\n  restart                      Restart the Aimux control plane\n  dashboard-reload             Reload or open the dashboard\n  stop [sessionId]             Stop an agent or the current project service\n  restart-runtime              Restart the tmux runtime service\n  host                         Advanced project-service inspection commands\n  ui                           Run the first-party local web UI\n  serve                        Ensure the daemon-backed project control service is running\n  daemon                       Advanced: manage the global aimux control-plane daemon\n  projects                     Inspect known aimux projects\n  compact                      Compact session history using LLM summarization\n  worktree                     Manage git worktrees\n  thread                       Inspect and manage orchestration threads\n  threads                      List orchestration threads\n  input                        Send input to a running agent\n  attachment                   Manage session attachments\n  ps                           List running agent sessions\n  list                         List agents grouped by worktree\n  id <sessionId>               Resolve an Aimux agent id to its canonical tool and native backend id\n  loop                         Manage agents in an overseer-managed loop\n  message                      Send directed orchestration messages\n  handoff                      Send an explicit orchestration handoff\n  task                         Create and manage orchestrated tasks\n  review                       Manage review workflow tasks\n  spawn                        Spawn a new agent\n  overseer                     Manage the project overseer\n  scribe                       Manage the project scribe\n  fork                         Fork an agent session\n  graveyard                    Manage killed agents\n  rename <sessionId>           Rename an agent session\n  kill <sessionId>             Kill an agent session\n  migrate <sessionId>          Move an agent to another worktree\n  doctor                       Inspect aimux runtime state\n  notifications                Manage desktop notification delivery\n  repair                       Repair the current project runtime in place\n  migration                    Audit and migrate runtime state\n  logs                         Inspect aimux logs\n  metadata                     Inspect and mutate session metadata\n  outline                      Inspect and update work outlines\n  team                         Manage agent team roles\n  remote                       Manage remote access\n  security                     Manage aimux security controls\n  hosted                       Manage hosted mode\n  debug-state                  Read a debug snapshot\n  notify                       Send a notification\n  list-notifications           List notifications\n  clear-notifications          Clear notifications\n  read-notifications           Mark notifications read\n"
    );
}

fn core_command_help(args: &[String]) -> Option<&'static str> {
    let help_requested = args
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h"));
    let command = args.first().map(String::as_str)?;
    let subcommand = args
        .iter()
        .skip(1)
        .find(|arg| !arg.starts_with('-'))
        .map(String::as_str);
    if matches!(command, "hosted")
        && matches!(subcommand, Some("token" | "audit"))
        && !help_requested
        && args.len() > 2
    {
        return None;
    }
    match (command, subcommand, help_requested) {
        ("host", None, _) => Some(HOST_HELP),
        ("host", Some("status"), true) => Some(HOST_STATUS_HELP),
        ("host", Some("agent-read"), true) => Some(HOST_AGENT_READ_HELP),
        ("host", Some("agent-stream"), true) => Some(HOST_AGENT_STREAM_HELP),
        ("host", Some("restart"), true) => Some(HOST_RESTART_HELP),
        ("host", Some("topology"), true) => Some(HOST_TOPOLOGY_HELP),
        ("host", Some("stop" | "kill"), true) => Some(HOST_STOP_HELP),
        ("overseer", None, _) => Some(OVERSEER_HELP),
        ("overseer", Some("start"), true) => Some(OVERSEER_START_HELP),
        ("overseer", Some("clear"), true) => Some(OVERSEER_CLEAR_HELP),
        ("overseer", Some("status"), true) => Some(OVERSEER_STATUS_HELP),
        ("scribe", None, _) => Some(SCRIBE_HELP),
        ("scribe", Some("start"), true) => Some(SCRIBE_START_HELP),
        ("scribe", Some("clear"), true) => Some(SCRIBE_CLEAR_HELP),
        ("scribe", Some("status"), true) => Some(SCRIBE_STATUS_HELP),
        ("loop", None, _) => Some(LOOP_HELP),
        ("loop", Some("add"), true) => Some(LOOP_ADD_HELP),
        ("loop", Some("remove"), true) => Some(LOOP_REMOVE_HELP),
        ("loop", Some("list"), true) => Some(LOOP_LIST_HELP),
        ("loop", Some("done"), true) => Some(LOOP_DONE_HELP),
        ("loop", Some("block"), true) => Some(LOOP_BLOCK_HELP),
        ("doctor", None, _) => Some(DOCTOR_HELP),
        ("doctor", Some("versions"), true) => Some(DOCTOR_VERSIONS_HELP),
        ("doctor", Some("lifecycle"), true) => Some(DOCTOR_LIFECYCLE_HELP),
        ("doctor", Some("exchange"), true) => Some(DOCTOR_EXCHANGE_HELP),
        ("doctor", Some("disk"), true) => Some(DOCTOR_DISK_HELP),
        ("doctor", Some("installs"), true) => Some(DOCTOR_INSTALLS_HELP),
        ("doctor", Some("notifications"), true) => Some(DOCTOR_NOTIFICATIONS_HELP),
        ("doctor", Some("tasks"), true) => Some(DOCTOR_TASKS_HELP),
        ("doctor", Some("stability"), true) => Some(DOCTOR_STABILITY_HELP),
        ("doctor", Some("tmux"), true) => Some(DOCTOR_TMUX_HELP),
        ("migration", None, _) => Some(MIGRATION_HELP),
        ("migration", Some("audit"), true) => Some(MIGRATION_AUDIT_HELP),
        ("migration", Some("import"), true) => Some(MIGRATION_IMPORT_HELP),
        ("migration", Some("rollback"), true) => Some(MIGRATION_ROLLBACK_HELP),
        ("repair", None, true) => Some(REPAIR_HELP),
        ("repair", Some("exchange"), true) => Some(REPAIR_EXCHANGE_HELP),
        ("logs", None, _) => Some(LOGS_HELP),
        ("logs", Some("path"), true) => Some(LOGS_PATH_HELP),
        ("logs", Some("tail"), true) => Some(LOGS_TAIL_HELP),
        ("logs", Some("clear"), true) => Some(LOGS_CLEAR_HELP),
        ("metadata", None, _) => Some(METADATA_HELP),
        ("metadata", Some("endpoint"), true) => Some(METADATA_ENDPOINT_HELP),
        ("metadata", Some("event"), true) => Some(METADATA_EVENT_HELP),
        ("metadata", Some("mark-seen"), true) => Some(METADATA_MARK_SEEN_HELP),
        ("metadata", Some("set-activity"), true) => Some(METADATA_SET_ACTIVITY_HELP),
        ("metadata", Some("set-attention"), true) => Some(METADATA_SET_ATTENTION_HELP),
        ("metadata", Some("set-status"), true) => Some(METADATA_SET_STATUS_HELP),
        ("metadata", Some("set-progress"), true) => Some(METADATA_SET_PROGRESS_HELP),
        ("metadata", Some("set-context"), true) => Some(METADATA_SET_CONTEXT_HELP),
        ("metadata", Some("set-services"), true) => Some(METADATA_SET_SERVICES_HELP),
        ("metadata", Some("log"), true) => Some(METADATA_LOG_HELP),
        ("metadata", Some("clear-log"), true) => Some(METADATA_CLEAR_LOG_HELP),
        ("outline", None, _) => Some(OUTLINE_HELP),
        ("outline", Some("list"), true) => Some(OUTLINE_LIST_HELP),
        ("outline", Some("show"), true) => Some(OUTLINE_SHOW_HELP),
        ("outline", Some("update"), true) => Some(OUTLINE_UPDATE_HELP),
        ("team", None, _) => Some(TEAM_HELP),
        ("team", Some("show"), true) => Some(TEAM_SHOW_HELP),
        ("team", Some("add"), true) => Some(TEAM_ADD_HELP),
        ("team", Some("remove"), true) => Some(TEAM_REMOVE_HELP),
        ("team", Some("default"), true) => Some(TEAM_DEFAULT_HELP),
        ("team", Some("init"), true) => Some(TEAM_INIT_HELP),
        ("notifications", None, _) => Some(NOTIFICATIONS_HELP),
        ("notifications", Some("test"), true) => Some(NOTIFICATIONS_TEST_HELP),
        ("restart", None, true) => Some(RESTART_HELP),
        ("daemon", None, _) => Some(DAEMON_HELP),
        ("projects", None, true) => Some(PROJECTS_HELP),
        ("compact", None, true) => Some(COMPACT_HELP),
        ("worktree", None, true) => Some(WORKTREE_HELP),
        ("thread", None, _) => Some(THREAD_HELP),
        ("threads", None, true) => Some(THREADS_HELP),
        ("input", None, true) => Some(INPUT_HELP),
        ("attachment", None, _) => Some(ATTACHMENT_HELP),
        ("ps", None, true) => Some(PS_HELP),
        ("list", None, true) => Some(LIST_HELP),
        ("message", None, _) => Some(MESSAGE_HELP),
        ("handoff", None, _) => Some(HANDOFF_HELP),
        ("task", None, _) => Some(TASK_HELP),
        ("review", None, _) => Some(REVIEW_HELP),
        ("graveyard", None, true) => Some(GRAVEYARD_HELP),
        ("debug-state", None, true) => Some(DEBUG_STATE_HELP),
        ("worktree", Some("create" | "add"), true) => Some(WORKTREE_CREATE_HELP),
        ("worktree", Some("remove"), true) => Some(WORKTREE_REMOVE_HELP),
        ("worktree", Some("graveyard"), true) => Some(WORKTREE_GRAVEYARD_HELP),
        ("worktree", Some("resurrect"), true) => Some(WORKTREE_RESURRECT_HELP),
        ("worktree", Some("cleanup-caches"), true) => Some(WORKTREE_CLEANUP_HELP),
        ("graveyard", Some("send"), true) => Some(GRAVEYARD_SEND_HELP),
        ("graveyard", Some("resurrect"), true) => Some(GRAVEYARD_RESURRECT_HELP),
        ("graveyard", Some("cleanup"), true) => Some(GRAVEYARD_CLEANUP_HELP),
        ("fork", _, true) => Some(FORK_HELP),
        ("spawn", _, true) => Some(SPAWN_HELP),
        ("kill", _, true) => Some(KILL_HELP),
        ("migrate", _, true) => Some(MIGRATE_HELP),
        ("dashboard-reload", _, true) => Some(DASHBOARD_RELOAD_HELP),
        ("restart-runtime", _, true) => Some(RESTART_RUNTIME_HELP),
        ("serve", _, true) => Some(SERVE_HELP),
        ("id", _, true) => Some(ID_HELP),
        ("rename", _, true) => Some(RENAME_HELP),
        ("stop", _, true) => Some(STOP_HELP),
        ("projects", Some("remove" | "unregister"), true) => Some(PROJECTS_REMOVE_HELP),
        ("notify", _, true) => Some(NOTIFY_HELP),
        ("list-notifications", _, true) => Some(LIST_NOTIFICATIONS_HELP),
        ("clear-notifications", _, true) => Some(CLEAR_NOTIFICATIONS_HELP),
        ("read-notifications", _, true) => Some(READ_NOTIFICATIONS_HELP),
        ("remote", None, _) => Some(REMOTE_HELP),
        ("remote", Some("status"), true) => Some(REMOTE_STATUS_HELP),
        ("remote", Some("enable"), true) => Some(REMOTE_ENABLE_HELP),
        ("remote", Some("disable"), true) => Some(REMOTE_DISABLE_HELP),
        ("whoami", _, true) => Some(WHOAMI_HELP),
        ("login", _, true) => Some(LOGIN_HELP),
        ("logout", _, true) => Some(LOGOUT_HELP),
        ("security", None, _) => Some(SECURITY_HELP),
        ("security", Some("unlock"), true) => Some(SECURITY_UNLOCK_HELP),
        ("security", Some("devices"), true) => Some(SECURITY_DEVICES_HELP),
        ("security", Some("device"), true) => Some(SECURITY_DEVICE_HELP),
        ("security", Some("approve"), true) => Some(SECURITY_APPROVE_HELP),
        ("security", Some("block" | "revoke"), true) => Some(SECURITY_BLOCK_HELP),
        ("security", Some("unblock"), true) => Some(SECURITY_UNBLOCK_HELP),
        ("hosted", None, _) => Some(HOSTED_HELP),
        ("hosted", Some("status"), true) => Some(HOSTED_STATUS_HELP),
        ("hosted", Some("grant"), true) => Some(HOSTED_GRANT_HELP),
        ("hosted", Some("ungrant"), true) => Some(HOSTED_UNGRANT_HELP),
        ("hosted", Some("lockdown"), true) => Some(HOSTED_LOCKDOWN_HELP),
        ("hosted", Some("token"), _) => Some(HOSTED_TOKEN_HELP),
        ("hosted", Some("audit"), _) => Some(HOSTED_AUDIT_HELP),
        _ if help_requested => known_subcommand_group_help(command, subcommand),
        _ => None,
    }
}

fn known_subcommand_group_help(command: &str, subcommand: Option<&str>) -> Option<&'static str> {
    let subcommand = subcommand?;
    match (command, subcommand) {
        (
            "daemon",
            "ensure" | "status" | "projects" | "project-ensure" | "restart" | "stop" | "kill",
        ) => Some(DAEMON_HELP),
        ("projects", "list") => Some(PROJECTS_HELP),
        ("worktree", "list") => Some(WORKTREE_HELP),
        ("thread", "list" | "show" | "open" | "send" | "mark-seen" | "status") => Some(THREAD_HELP),
        ("attachment", "publish") => Some(ATTACHMENT_HELP),
        ("message", "send") => Some(MESSAGE_HELP),
        ("handoff", "send" | "accept" | "complete") => Some(HANDOFF_HELP),
        (
            "task",
            "list" | "show" | "assign" | "accept" | "block" | "cancel" | "complete" | "reopen",
        ) => Some(TASK_HELP),
        ("review", "list" | "approve" | "request-changes") => Some(REVIEW_HELP),
        ("graveyard", "list") => Some(GRAVEYARD_HELP),
        _ => None,
    }
}

const HOST_HELP: &str = "Usage: aimux host [options] [command]\n\nAdvanced project-service inspection commands\n\nCommands:\n  status                      Print project-service status\n  agent-read <sessionId>      Read an agent pane snapshot\n  agent-stream <sessionId>    Stream an agent pane snapshot\n  restart                     Restart the current project service\n  topology                    Print topology debug information\n  stop                        Stop the current project service\n  kill                        Kill the current project service";
const HOST_STATUS_HELP: &str = "Usage: aimux host status [options]\n\nPrint project-service status\n\nOptions:\n  --json                      Emit JSON";
const HOST_AGENT_READ_HELP: &str = "Usage: aimux host agent-read <sessionId> [options]\n\nRead an agent pane snapshot\n\nOptions:\n  --project <path>            Project path\n  --lines <count>             Number of trailing lines\n  --start-line <line>         Starting line\n  --json                      Emit JSON";
const HOST_AGENT_STREAM_HELP: &str = "Usage: aimux host agent-stream <sessionId> [options]\n\nStream an agent pane snapshot\n\nOptions:\n  --project <path>            Project path\n  --lines <count>             Number of trailing lines\n  --start-line <line>         Starting line\n  --interval-ms <ms>          Poll interval";
const HOST_RESTART_HELP: &str = "Usage: aimux host restart [options]\n\nRestart the current project service\n\nOptions:\n  --serve                     Ensure the service is running after restart\n  --open                      Open the dashboard after restart\n  --json                      Emit JSON";
const HOST_TOPOLOGY_HELP: &str = "Usage: aimux host topology [options]\n\nPrint topology debug information\n\nOptions:\n  --project <path>            Project path\n  --raw                       Print raw topology\n  --json                      Emit JSON";
const HOST_STOP_HELP: &str = "Usage: aimux host <stop|kill> [options]\n\nStop the current project service\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const OVERSEER_HELP: &str = "Usage: aimux overseer [options] [command]\n\nManage the project overseer (top-down orchestrator)\n\nCommands:\n  start                       Spawn an overseer agent\n  clear <sessionId>           Demote a session from overseer\n  status                      Print overseer status";
const OVERSEER_START_HELP: &str = "Usage: aimux overseer start [options]\n\nSpawn an overseer agent that monitors and directs the project's agents\n\nOptions:\n  --tool <toolKey>            Configured tool key\n  --project <path>            Project path\n  --worktree <path>           Target worktree path\n  --no-open                   Do not switch into the overseer window\n  --json                      Emit JSON";
const OVERSEER_CLEAR_HELP: &str = "Usage: aimux overseer clear <sessionId> [options]\n\nDemote a session from overseer\n\nOptions:\n  --project <path>            Project path";
const OVERSEER_STATUS_HELP: &str = "Usage: aimux overseer status [options]\n\nPrint overseer status\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const SCRIBE_HELP: &str = "Usage: aimux scribe [options] [command]\n\nManage the project scribe\n\nCommands:\n  start                       Spawn a scribe agent\n  clear <sessionId>           Demote a session from scribe\n  status                      Print scribe status";
const SCRIBE_START_HELP: &str = "Usage: aimux scribe start [options]\n\nSpawn a scribe agent that maintains project scribe notes\n\nOptions:\n  --tool <toolKey>            Configured tool key\n  --project <path>            Project path\n  --worktree <path>           Target worktree path\n  --no-open                   Do not switch into the scribe window\n  --json                      Emit JSON";
const SCRIBE_CLEAR_HELP: &str = "Usage: aimux scribe clear <sessionId> [options]\n\nDemote a session from scribe\n\nOptions:\n  --project <path>            Project path";
const SCRIBE_STATUS_HELP: &str = "Usage: aimux scribe status [options]\n\nPrint scribe status\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const LOOP_HELP: &str = "Usage: aimux loop [options] [command]\n\nManage agents in an overseer-managed loop\n\nCommands:\n  add <sessionId>             Mark an agent as in a managed loop\n  remove <sessionId>          Remove an agent from the managed loop\n  list                        List agents in the managed loop\n  done                        Report the loop goal complete\n  block                       Report the loop blocked";
const LOOP_ADD_HELP: &str = "Usage: aimux loop add <sessionId> [options]\n\nMark an agent as in a managed loop\n\nOptions:\n  --goal <goal>               What the agent should keep working toward";
const LOOP_REMOVE_HELP: &str =
    "Usage: aimux loop remove <sessionId>\n\nRemove an agent from the managed loop";
const LOOP_LIST_HELP: &str = "Usage: aimux loop list [options]\n\nList agents in the managed loop\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const LOOP_DONE_HELP: &str = "Usage: aimux loop done [options]\n\nReport the loop goal complete\n\nOptions:\n  --session <id>              Session id\n  --reason <text>             What was completed";
const LOOP_BLOCK_HELP: &str = "Usage: aimux loop block [options]\n\nReport the loop blocked\n\nOptions:\n  --session <id>              Session id\n  --reason <text>             Why you are blocked";
const DOCTOR_HELP: &str = "Usage: aimux doctor [options] [command]\n\nInspect aimux runtime state\n\nCommands:\n  versions                    Inspect version coherence\n  lifecycle                   Inspect lifecycle queue diagnostics\n  exchange                    Inspect runtime exchange\n  disk                        Inspect worktree cache disk usage\n  installs                    Report superseded installs\n  notifications               Inspect desktop notification delivery\n  tasks                       Inspect async runtime task registry\n  stability                   Inspect runtime-health history verdict\n  tmux                        Inspect managed tmux runtime state";
const DOCTOR_VERSIONS_HELP: &str = "Usage: aimux doctor versions [options]\n\nInspect local daemon, project service, and dashboard version coherence\n\nOptions:\n  --json                      Emit JSON";
const DOCTOR_LIFECYCLE_HELP: &str = "Usage: aimux doctor lifecycle [options]\n\nInspect project-service lifecycle queue diagnostics\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const DOCTOR_EXCHANGE_HELP: &str = "Usage: aimux doctor exchange [options]\n\nInspect runtime exchange size, counts, and retention telemetry\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const DOCTOR_DISK_HELP: &str = "Usage: aimux doctor disk [options]\n\nInspect Aimux-managed worktree cache disk usage\n\nOptions:\n  --project <path>            Project path\n  --include-active            Measure cache directories in active worktrees\n  --json                      Emit JSON";
const DOCTOR_INSTALLS_HELP: &str = "Usage: aimux doctor installs [options]\n\nReport superseded installs under the aimux install root; removes nothing without --fix\n\nOptions:\n  --fix                       Remove the reported installs instead of only listing them\n  --retention-days <days>     Keep installs newer than this many days\n  --keep-recent <count>       Always keep this many newest installs\n  --json                      Emit JSON";
const DOCTOR_NOTIFICATIONS_HELP: &str = "Usage: aimux doctor notifications [options]\n\nInspect desktop notification delivery\n\nOptions:\n  --json                      Emit JSON";
const DOCTOR_STABILITY_HELP: &str = "Usage: aimux doctor stability [options]\n\nInspect runtime-health history and report whether async runtime stability can be proven\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const DOCTOR_TASKS_HELP: &str = "Usage: aimux doctor tasks [options]\n\nInspect async runtime task registry and project scheduler tasks\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const DOCTOR_TMUX_HELP: &str = "Usage: aimux doctor tmux [options]\n\nInspect managed tmux runtime state\n\nOptions:\n  --project-root <path>       Project root\n  --session <name>            Managed tmux session name override\n  --window-id <id>            Specific tmux window id to inspect\n  --json                      Emit JSON";
const MIGRATION_HELP: &str = "Usage: aimux migration [options] [command]\n\nExplicit runtime-core migration audit, import, and rollback tooling\n\nCommands:\n  audit                       Inspect legacy runtime artifacts without mutating project state\n  import                      Import legacy exchange artifacts into runtime-exchange.yaml\n  rollback <manifest>         Restore files recorded by a runtime migration manifest";
const MIGRATION_AUDIT_HELP: &str = "Usage: aimux migration audit [options]\n\nInspect legacy runtime artifacts without mutating project state\n\nOptions:\n  --project <path>            Project path";
const MIGRATION_IMPORT_HELP: &str = "Usage: aimux migration import [options]\n\nImport legacy exchange artifacts into runtime-exchange.yaml with a rollback manifest\n\nOptions:\n  --project <path>            Project path";
const MIGRATION_ROLLBACK_HELP: &str = "Usage: aimux migration rollback <manifest>\n\nRestore files recorded by a runtime migration manifest";
const REPAIR_HELP: &str = "Usage: aimux repair [options] [command]\n\nRepair the current project runtime in place\n\nOptions:\n  --project-root <path>       Project root\n  --open                      Open the repaired dashboard after fixing runtime state\n  --json                      Emit JSON\n\nCommands:\n  exchange                    Compact runtime-exchange.yaml using project-service retention rules";
const REPAIR_EXCHANGE_HELP: &str = "Usage: aimux repair exchange [options]\n\nCompact runtime-exchange.yaml using project-service retention rules\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const LOGS_HELP: &str = "Usage: aimux logs [options] [command]\n\nInspect persistent aimux logs\n\nCommands:\n  path                        Print the active log file path\n  tail                        Print recent log lines\n  clear                       Clear the active log file";
const LOGS_PATH_HELP: &str = "Usage: aimux logs path [options]\n\nPrint the active log file path\n\nOptions:\n  --daemon                    Show the global daemon log path\n  --project <path>            Project path";
const LOGS_TAIL_HELP: &str = "Usage: aimux logs tail [options]\n\nPrint recent log lines\n\nOptions:\n  --daemon                    Tail the global daemon log\n  --project <path>            Project path\n  -n, --lines <number>        Number of lines to print";
const LOGS_CLEAR_HELP: &str = "Usage: aimux logs clear [options]\n\nClear the active log file\n\nOptions:\n  --daemon                    Clear the global daemon log\n  --project <path>            Project path";
const METADATA_HELP: &str = "Usage: aimux metadata [options] [command]\n\nPush metadata into aimux tmux status integration\n\nCommands:\n  endpoint                    Print the local metadata API endpoint\n  event <session> <kind>      Emit a normalized agent event\n  mark-seen <session>         Mark a session's unseen activity as seen\n  set-activity <session>      Set derived activity state for a session\n  set-attention <session>     Set derived attention state for a session\n  set-status <session> <text> Set a session status pill\n  set-progress <session>      Set per-session progress\n  set-context <session>       Set rich session context metadata\n  set-services <session>      Set detected session services/ports\n  log <session> <message>     Append a session log line\n  clear-log <session>         Clear session logs";
const METADATA_ENDPOINT_HELP: &str =
    "Usage: aimux metadata endpoint\n\nPrint the local metadata API endpoint";
const METADATA_EVENT_HELP: &str = "Usage: aimux metadata event <session> <kind> [options]\n\nEmit a normalized agent event\n\nOptions:\n  --message <message>         Event message\n  --source <source>           Event source\n  --tone <tone>               Event tone\n  --thread-id <threadId>      Thread identifier\n  --thread-name <threadName>  Thread name";
const METADATA_MARK_SEEN_HELP: &str =
    "Usage: aimux metadata mark-seen <session>\n\nMark a session's unseen activity as seen";
const METADATA_SET_ACTIVITY_HELP: &str = "Usage: aimux metadata set-activity <session> <activity>\n\nSet derived activity state for a session";
const METADATA_SET_ATTENTION_HELP: &str = "Usage: aimux metadata set-attention <session> <attention>\n\nSet derived attention state for a session";
const METADATA_SET_STATUS_HELP: &str = "Usage: aimux metadata set-status <session> <text> [options]\n\nSet a session status pill\n\nOptions:\n  --tone <tone>               Status tone";
const METADATA_SET_PROGRESS_HELP: &str = "Usage: aimux metadata set-progress <session> <current> <total> [options]\n\nSet per-session progress\n\nOptions:\n  --label <label>             Progress label";
const METADATA_SET_CONTEXT_HELP: &str = "Usage: aimux metadata set-context <session> [options]\n\nSet rich session context metadata\n\nOptions:\n  --cwd <cwd>                 Working directory\n  --worktree-path <path>      Worktree path\n  --worktree-name <name>      Worktree name\n  --branch <branch>           Git branch\n  --pr-number <number>        PR number\n  --pr-title <title>          PR title\n  --pr-url <url>              PR URL";
const METADATA_SET_SERVICES_HELP: &str = "Usage: aimux metadata set-services <session> [options]\n\nSet detected session services/ports\n\nOptions:\n  --url <url...>              One or more service URLs\n  --label <label>             Shared label for the services";
const METADATA_LOG_HELP: &str = "Usage: aimux metadata log <session> <message> [options]\n\nAppend a session log line\n\nOptions:\n  --source <source>           Log source\n  --tone <tone>               Log tone";
const METADATA_CLEAR_LOG_HELP: &str =
    "Usage: aimux metadata clear-log <session>\n\nClear session logs";
const RESTART_HELP: &str = "Usage: aimux restart [options]\n\nRestart the Aimux control plane\n\nOptions:\n  --project <path>            Restart one project instead of every known project\n  --all                       Restart every known project even when run inside a checkout\n  --force                     Restart even when exact-resume sessions have not recorded a backend id\n  --json                      Emit JSON";
const DAEMON_HELP: &str = "Usage: aimux daemon [options] [command]\n\nAdvanced: manage the global aimux control-plane daemon\n\nCommands:\n  ensure                      Ensure the daemon is running\n  status                      Print daemon status\n  projects                    List known projects\n  project-ensure              Ensure one project service is running\n  restart                     Restart the daemon\n  stop                        Stop the daemon\n  kill                        Kill the daemon";
const PROJECTS_HELP: &str = "Usage: aimux projects [options] [command]\n\nInspect known aimux projects\n\nCommands:\n  list                        List known projects\n  remove <path>               Remove a registered project\n  unregister <path>           Alias for remove";
const COMPACT_HELP: &str =
    "Usage: aimux compact\n\nCompact session history using LLM summarization";
const WORKTREE_HELP: &str = "Usage: aimux worktree [options] [command]\n\nManage git worktrees\n\nCommands:\n  list                        List git worktrees\n  create <name>               Create a git worktree\n  remove <path>               Remove a git worktree\n  graveyard <path>            Move a worktree to the graveyard\n  resurrect <path>            Restore a graveyarded worktree\n  cleanup-caches              Remove generated worktree cache directories";
const THREAD_HELP: &str = "Usage: aimux thread [options] [command]\n\nInspect and manage orchestration threads\n\nCommands:\n  list                        List orchestration threads\n  show <threadId>             Show one thread\n  open <threadId>             Open or create a thread\n  send <threadId> <body>      Send a thread message (--body is also accepted)\n  mark-seen <threadId>        Mark a thread seen\n  status <threadId>           Change a thread status";
const THREADS_HELP: &str = "Usage: aimux threads [options]\n\nList orchestration threads\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const INPUT_HELP: &str = "Usage: aimux input <sessionId> <text...> [options]\n\nSend input to a running agent\n\nOptions:\n  --project <path>            Project path\n  --force                     Send even when the target is not waiting";
const ATTACHMENT_HELP: &str = "Usage: aimux attachment [options] [command]\n\nManage session attachments\n\nCommands:\n  publish <path>              Publish a local file as a session attachment";
const PS_HELP: &str = "Usage: aimux ps [options]\n\nList running agent sessions\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const LIST_HELP: &str = "Usage: aimux list [options]\n\nList agents grouped by worktree\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const MESSAGE_HELP: &str = "Usage: aimux message [options] [command]\n\nSend directed orchestration messages\n\nCommands:\n  send <message>              Send a message to an agent";
const HANDOFF_HELP: &str = "Usage: aimux handoff [options] [command]\n\nSend explicit orchestration handoffs\n\nCommands:\n  send <context>              Send a handoff to an agent\n  accept <threadId>           Accept a handoff\n  complete <threadId>         Complete a handoff";
const TASK_HELP: &str = "Usage: aimux task [options] [command]\n\nCreate and manage orchestrated tasks\n\nCommands:\n  list                        List tasks\n  show <taskId>               Show one task\n  assign <description>        Assign a task\n  accept <taskId>             Accept a task\n  block <taskId>              Mark a task blocked\n  cancel <taskId>             Cancel a task\n  complete <taskId>           Complete a task\n  reopen <taskId>             Reopen a task";
const REVIEW_HELP: &str = "Usage: aimux review [options] [command]\n\nManage review workflow tasks\n\nCommands:\n  list                        List review tasks\n  approve <taskId>            Approve a review\n  request-changes <taskId>    Request changes on a review";
const GRAVEYARD_HELP: &str = "Usage: aimux graveyard [options] [command]\n\nManage killed agents\n\nCommands:\n  list                        List graveyard entries\n  send <id>                   Send an agent to the graveyard\n  resurrect <id>              Resurrect an agent\n  cleanup                     Remove expired graveyard entries";
const DEBUG_STATE_HELP: &str = "Usage: aimux debug-state <sessionId>\n\nRead a debug snapshot";
const OUTLINE_HELP: &str = "Usage: aimux outline [options] [command]\n\nManage project scribe notes\n\nCommands:\n  list                        List scribe notes\n  show <entryId>              Show one scribe note\n  update                      Create or update a scribe note";
const OUTLINE_LIST_HELP: &str = "Usage: aimux outline list [options]\n\nList scribe notes\n\nOptions:\n  --project <path>            Project path\n  --session <sessionId>       Filter by Aimux session id\n  --worktree <path>           Filter by worktree path\n  --status <status>           Filter by status: active, done, superseded, stale\n  --search <query>            Search title, summary, topic key, worktree, and sessions\n  --limit <count>             Maximum entries to print\n  --json                      Emit JSON";
const OUTLINE_SHOW_HELP: &str = "Usage: aimux outline show <entryId> [options]\n\nShow one scribe note\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const OUTLINE_UPDATE_HELP: &str = "Usage: aimux outline update [options]\n\nCreate or update a scribe note\n\nOptions:\n  --title <title>             Entry title\n  --summary <summary>         Short entry summary\n  --project <path>            Project path\n  --topic-key <key>           Stable topic key for dedupe\n  --session <sessionId>       Aimux session id\n  --worktree <path>           Worktree path\n  --status <status>           Entry status: active, done, superseded, stale\n  --source <source>           Update source: agent, scribe, system, human\n  --json                      Emit JSON";
const TEAM_HELP: &str = "Usage: aimux team [options] [command]\n\nManage agent team roles\n\nCommands:\n  show                        Show current team config\n  add <role>                  Add or update a role\n  remove <role>               Remove a role\n  default <role>              Set the default role for new agents\n  init                        Initialize project with default team structure";
const TEAM_SHOW_HELP: &str = "Usage: aimux team show [options]\n\nShow current team config\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const TEAM_ADD_HELP: &str = "Usage: aimux team add <role> [options]\n\nAdd or update a role\n\nOptions:\n  -d, --description <desc>    Role description\n  --reviewed-by <role>        Role that reviews this role's work\n  --can-edit                  Whether this role can edit code directly\n  --project <path>            Project path\n  --json                      Emit JSON";
const TEAM_REMOVE_HELP: &str = "Usage: aimux team remove <role> [options]\n\nRemove a role\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const TEAM_DEFAULT_HELP: &str = "Usage: aimux team default <role> [options]\n\nSet the default role for new agents\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const TEAM_INIT_HELP: &str = "Usage: aimux team init [options]\n\nInitialize project with default team structure\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const NOTIFICATIONS_HELP: &str = "Usage: aimux notifications [options] [command]\n\nManage desktop notification delivery\n\nCommands:\n  test                        Send a desktop notification test";
const NOTIFICATIONS_TEST_HELP: &str = "Usage: aimux notifications test [options]\n\nSend a desktop notification test\n\nOptions:\n  --title <title>             Notification title\n  --body <body>               Notification body\n  --open-url <url>            Aimux URL to open when the notification is clicked\n  --json                      Emit JSON";
const WORKTREE_CREATE_HELP: &str = "Usage: aimux worktree create <name> [options]\n\nCreate a git worktree\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const WORKTREE_REMOVE_HELP: &str = "Usage: aimux worktree remove <path> [options]\n\nRemove a git worktree\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const WORKTREE_GRAVEYARD_HELP: &str = "Usage: aimux worktree graveyard <path> [options]\n\nMove a worktree to the graveyard without deleting the checkout\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const WORKTREE_RESURRECT_HELP: &str = "Usage: aimux worktree resurrect <path> [options]\n\nRestore a graveyarded worktree to the active worktree list\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const WORKTREE_CLEANUP_HELP: &str = "Usage: aimux worktree cleanup-caches [options]\n\nRemove generated cache directories from Aimux-managed worktrees\n\nOptions:\n  --project <path>            Project path\n  --yes                       Delete instead of dry run\n  --include-active            Include active worktrees\n  --json                      Emit JSON";
const GRAVEYARD_SEND_HELP: &str = "Usage: aimux graveyard send <id> [options]\n\nSend an agent to the graveyard\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const GRAVEYARD_RESURRECT_HELP: &str = "Usage: aimux graveyard resurrect <id> [options]\n\nResurrect an agent from the graveyard\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const GRAVEYARD_CLEANUP_HELP: &str = "Usage: aimux graveyard cleanup [options]\n\nRemove expired graveyard agents and worktrees\n\nOptions:\n  --project <path>            Project path\n  --dry-run                   Show what would be removed\n  --json                      Emit JSON";
const FORK_HELP: &str = "Usage: aimux fork <sourceSessionId> --tool <toolKey> [options]\n\nFork an existing agent into a new agent with handed-off context\n\nOptions:\n  --tool <toolKey>            Configured target tool key\n  --project <path>            Project path\n  --instruction <text>        Extra instruction\n  --worktree <path>           Target worktree path\n  --no-open                   Do not switch into the forked agent window\n  --json                      Emit JSON";
const SPAWN_HELP: &str = "Usage: aimux spawn --tool <toolKey> [options]\n\nSpawn a new agent\n\nOptions:\n  --tool <toolKey>            Configured tool key\n  --project <path>            Project path\n  --worktree <path>           Target worktree path\n  --no-open                   Do not switch into the agent window\n  --json                      Emit JSON";
const KILL_HELP: &str = "Usage: aimux kill <sessionId> [options]\n\nSend an agent to the graveyard\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const MIGRATE_HELP: &str = "Usage: aimux migrate <sessionId> --worktree <path> [options]\n\nMigrate a running agent into another worktree\n\nOptions:\n  --worktree <path>           Target worktree path\n  --project <path>            Project path\n  --json                      Emit JSON";
const DASHBOARD_RELOAD_HELP: &str = "Usage: aimux dashboard-reload [options]\n\nRecreate and optionally reopen the dashboard window only\n\nOptions:\n  --open                      Open the dashboard after reloading\n  --client-tty <tty>          tmux client tty to switch after reloading\n  --current-client-session <name> Current client session to reopen";
const RESTART_RUNTIME_HELP: &str = "Usage: aimux restart-runtime [options]\n\nHard restart the current project runtime and rebuild its managed tmux topology\n\nOptions:\n  --project-root <path>       Project root\n  --open                      Open the dashboard after restarting the runtime\n  --client-tty <tty>          tmux client tty to switch after reopening\n  --json                      Emit JSON";
const SERVE_HELP: &str =
    "Usage: aimux serve\n\nAdvanced: ensure the daemon-backed project control service is running";
const ID_HELP: &str = "Usage: aimux id <sessionId> [options]\n\nResolve an Aimux agent id to its canonical tool and native backend id\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const RENAME_HELP: &str = "Usage: aimux rename <sessionId> [options]\n\nRename an agent label in running or offline state\n\nOptions:\n  --label <label>             New agent label\n  --project <path>            Project path\n  --json                      Emit JSON";
const STOP_HELP: &str = "Usage: aimux stop [sessionId] [options]\n\nStop the current project runtime, or stop a specific running agent by session ID\n\nOptions:\n  --project <path>            Project path\n  --json                      Emit JSON";
const PROJECTS_REMOVE_HELP: &str = "Usage: aimux projects <remove|unregister> <path> [options]\n\nStop, remove managed tmux sessions for, and unregister a project\n\nOptions:\n  --force                     Remove even when live agents or unverifiable tmux sessions are present\n  --json                      Emit JSON";
const NOTIFY_HELP: &str = "Usage: aimux notify [options]\n\nSend a project notification\n\nOptions:\n  --title <title>             Notification title\n  --subtitle <subtitle>       Notification subtitle\n  --body <body>               Notification body\n  --session <sessionId>       Related session id\n  --kind <kind>               Notification kind\n  --project <path>            Project root\n  --json                      Emit JSON output";
const LIST_NOTIFICATIONS_HELP: &str = "Usage: aimux list-notifications [options]\n\nList project notifications\n\nOptions:\n  --unread                    Show only unread notifications\n  --session <sessionId>       Filter by session id\n  --project <path>            Project root\n  --json                      Emit JSON output";
const CLEAR_NOTIFICATIONS_HELP: &str = "Usage: aimux clear-notifications [options]\n\nClear project notifications\n\nOptions:\n  --id <notificationId>       Clear one notification\n  --ids <notificationIds>     Comma-separated notification ids\n  --session <sessionId>       Clear only notifications for a session\n  --project <path>            Project root\n  --json                      Emit JSON output";
const READ_NOTIFICATIONS_HELP: &str = "Usage: aimux read-notifications [options]\n\nMark project notifications as read\n\nOptions:\n  --id <notificationId>       Mark one notification as read\n  --ids <notificationIds>     Comma-separated notification ids\n  --session <sessionId>       Mark only notifications for a session as read\n  --project <path>            Project root\n  --json                      Emit JSON output";
const REMOTE_HELP: &str = "Usage: aimux remote [options] [command]\n\nManage remote access\n\nCommands:\n  status                      Show remote access status\n  enable                      Enable remote access\n  disable                     Disable remote access";
const REMOTE_STATUS_HELP: &str = "Usage: aimux remote status [options]\n\nShow remote access status\n\nOptions:\n  --json                      Emit JSON";
const REMOTE_ENABLE_HELP: &str = "Usage: aimux remote enable\n\nEnable remote access";
const REMOTE_DISABLE_HELP: &str = "Usage: aimux remote disable\n\nDisable remote access";
const WHOAMI_HELP: &str = "Usage: aimux whoami [options]\n\nShow current remote access identity\n\nOptions:\n  --json                      Emit JSON";
const LOGIN_HELP: &str = "Usage: aimux login\n\nAuthenticate remote access";
const LOGOUT_HELP: &str = "Usage: aimux logout\n\nClear remote access credentials";
const SECURITY_HELP: &str = "Usage: aimux security [options] [command]\n\nManage aimux security controls\n\nCommands:\n  devices                     List remote client devices\n  device                      Approve a live remote client device\n  approve <deviceId>          Approve a remote client device\n  block <deviceId>            Block a remote client device\n  unblock <deviceId>          Unblock a remote client device\n  unlock                      Unlock security credentials";
const SECURITY_DEVICES_HELP: &str = "Usage: aimux security devices [options]\n\nList remote client devices\n\nOptions:\n  --json                      Emit JSON";
const SECURITY_DEVICE_HELP: &str = "Usage: aimux security device [options] [command]\n\nApprove a live remote client device\n\nCommands:\n  approve [deviceId]          Approve the most recent live remote client waiting for access";
const SECURITY_APPROVE_HELP: &str = "Usage: aimux security approve <deviceId> [options]\n\nApprove a remote client device\n\nOptions:\n  --code <code>               Approval code shown on the waiting device\n  --json                      Emit JSON";
const SECURITY_BLOCK_HELP: &str = "Usage: aimux security block <deviceId> [options]\n\nBlock a remote client device\n\nOptions:\n  --json                      Emit JSON";
const SECURITY_UNBLOCK_HELP: &str = "Usage: aimux security unblock <deviceId> [options]\n\nUnblock a remote client device without approving it\n\nOptions:\n  --json                      Emit JSON";
const SECURITY_UNLOCK_HELP: &str = "Usage: aimux security unlock\n\nUnlock security credentials";
const HOSTED_HELP: &str = "Usage: aimux hosted [options] [command]\n\nManage hosted mode: principals, grants, audit, lockdown\n\nCommands:\n  status                      Show hosted mode configuration and principals\n  token                       Manage hosted bearer tokens\n  grant <principalId>         Allow a principal to converse with one session\n  ungrant <principalId>       Remove a principal's access to one session\n  lockdown <state>            Close or reopen the hosted listener\n  audit                       Inspect the hosted audit log";
const HOSTED_STATUS_HELP: &str = "Usage: aimux hosted status [options]\n\nShow hosted mode configuration and principals\n\nOptions:\n  --json                      Emit JSON";
const HOSTED_TOKEN_HELP: &str = "Usage: aimux hosted token [options] [command]\n\nManage hosted bearer tokens\n\nCommands:\n  create                      Create a principal and print its token once\n  list                        List principals\n  revoke <principalId>        Revoke a principal's token";
const HOSTED_GRANT_HELP: &str = "Usage: aimux hosted grant <principalId> [options]\n\nAllow a principal to converse with one session\n\nOptions:\n  --project <root>            Project root the session belongs to\n  --session <id>              Session id";
const HOSTED_UNGRANT_HELP: &str = "Usage: aimux hosted ungrant <principalId> [options]\n\nRemove a principal's access to one session\n\nOptions:\n  --project <root>            Project root the session belongs to\n  --session <id>              Session id";
const HOSTED_LOCKDOWN_HELP: &str = "Usage: aimux hosted lockdown <state>\n\nClose or reopen the hosted listener (\"on\" or \"off\")";
const HOSTED_AUDIT_HELP: &str = "Usage: aimux hosted audit [options] [command]\n\nInspect the hosted audit log\n\nCommands:\n  tail                        Show the most recent audit records";

fn run_root_dashboard_command() -> Result<ExitCode> {
    validate_daemon_port()?;
    let project_root = current_project_root()?;
    let project_root_text = project_root.to_string_lossy().into_owned();
    let mut tmux = TmuxRuntimeManager::new();
    if !tmux.is_available() {
        anyhow::bail!("aimux: tmux is not installed or not available in PATH");
    }

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

    if let Some(live) =
        find_live_dashboard_target(&project_root_text, &mut tmux).map_err(anyhow::Error::msg)?
    {
        open_dashboard_target_from_foreground(&mut tmux, &live.dashboard_target, true)?;
        return Ok(ExitCode::SUCCESS);
    }

    let open_in_host_session = should_open_dashboard_in_host_session(&mut tmux, &project_root_text);
    let resolved = resolve_dashboard_target(
        &project_root_text,
        &mut tmux,
        DashboardResolveOptions {
            force_reload: false,
            open_in_host_session,
        },
    )
    .map_err(anyhow::Error::msg)?;
    open_dashboard_target_from_foreground(&mut tmux, &resolved.dashboard_target, false)?;
    Ok(ExitCode::SUCCESS)
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
    validate_daemon_port()?;
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
    validate_daemon_port()?;
    if args.first().map(String::as_str) != Some("spawn") {
        return run_core_command_and_print(args);
    }
    let execution = run_core_cli(args);
    if execution.code != 0 {
        print_execution(execution);
        return Ok(ExitCode::from(1));
    }
    let payload = parse_single_json_stdout(&execution.stdout)?;
    if let Some(warning) = payload
        .get("warning")
        .and_then(Value::as_str)
        .filter(|warning| !warning.trim().is_empty())
    {
        eprintln!("warning: {warning}");
    }
    open_payload_target_from_foreground(&payload)?;
    Ok(ExitCode::SUCCESS)
}

fn validate_daemon_port() -> Result<()> {
    get_daemon_port().map(|_| ()).map_err(anyhow::Error::msg)
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
    open_dashboard_target_from_foreground(&mut tmux, &target, false)
}

fn open_dashboard_target_from_foreground(
    tmux: &mut TmuxRuntimeManager,
    target: &TmuxTarget,
    already_resolved: bool,
) -> Result<()> {
    // Only ever consider THIS process's own terminal. Borrowing another attached
    // client's tty made `aimux` switch that client's view and exit, so a second
    // terminal could never attach while any client was attached anywhere.
    let foreground_tty = foreground_tty();
    let inside_by_client = foreground_tty
        .as_deref()
        .is_some_and(|tty| tmux.find_client_by_tty(tty).is_some());
    let inside_by_socket = tmux_env_socket_path().is_some_and(|env_socket| {
        tmux.display_message("#{socket_path}", Some(&target.window_id))
            .as_deref()
            == Some(env_socket.as_str())
    });
    // Node gated this on isInsideTmux() alone: switch-client is only correct when
    // the caller is itself a tmux client. Outside tmux we must attach.
    let inside_tmux = tmux.is_inside_tmux() && (inside_by_client || inside_by_socket);
    let client_tty = if inside_tmux { foreground_tty } else { None };
    tmux.open_target(
        target,
        OpenTargetOptions {
            inside_tmux,
            client_tty,
            already_resolved,
            ..OpenTargetOptions::default()
        },
    )
    .map_err(anyhow::Error::msg)?;
    Ok(())
}

fn should_open_dashboard_in_host_session(
    tmux: &mut TmuxRuntimeManager,
    project_root: &str,
) -> bool {
    let Some(env_socket) = tmux_env_socket_path() else {
        return false;
    };
    let session = tmux.get_project_session(project_root);
    tmux.display_message("#{socket_path}", Some(&session.session_name))
        .as_deref()
        != Some(env_socket.as_str())
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
    AsyncCommand::new("tty")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .filter(|tty| !tty.is_empty() && tty != "not a tty")
}

fn tmux_env_socket_path() -> Option<String> {
    std::env::var("TMUX")
        .ok()
        .and_then(|value| value.split(',').next().map(str::to_owned))
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn tmux_display_message(format: &str) -> Option<String> {
    let mut command = tmux_command_from_env();
    command.args(["display-message", "-p"]);
    if let Some(pane_id) = std::env::var("TMUX_PANE")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        command.args(["-t", pane_id.as_str()]);
    }
    command
        .arg(format)
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
    let project_root = resolver.resolve_repo_root(cwd);
    Ok(project_root)
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
    if let Some((message, help)) = invalid_known_command_help(args) {
        eprintln!("{message}");
        if let Some(help) = help {
            eprintln!();
            eprintln!("{help}");
        }
        return Some(ExitCode::from(2));
    }
    eprintln!(
        "error: unsupported or invalid aimux command: {}",
        args.join(" ")
    );
    Some(ExitCode::from(2))
}

fn invalid_known_command_help(args: &[String]) -> Option<(&'static str, Option<&'static str>)> {
    match args {
        [command] if command == "task" => {
            Some(("error: aimux task requires a subcommand", Some(TASK_HELP)))
        }
        [command] if command == "projects" => Some((
            "error: aimux projects requires a subcommand",
            Some(PROJECTS_HELP),
        )),
        [command, subcommand, rest @ ..]
            if command == "projects"
                && matches!(subcommand.as_str(), "remove" | "unregister")
                && rest
                    .iter()
                    .any(|arg| arg == "--project" || arg.starts_with("--project=")) =>
        {
            Some((
                "error: aimux projects remove requires <path> as a positional argument; --project is not accepted here",
                Some(PROJECTS_REMOVE_HELP),
            ))
        }
        [command, subcommand, ..]
            if command == "projects" && matches!(subcommand.as_str(), "remove" | "unregister") =>
        {
            Some((
                "error: aimux projects remove requires <path>",
                Some(PROJECTS_REMOVE_HELP),
            ))
        }
        [command, ..] if command == "metadata" => Some((
            "error: invalid aimux metadata arguments",
            Some(METADATA_HELP),
        )),
        [command, ..] if command == "logs" => {
            Some(("error: invalid aimux logs arguments", Some(LOGS_HELP)))
        }
        [command, ..] if command == "team" => {
            Some(("error: invalid aimux team arguments", Some(TEAM_HELP)))
        }
        [command, ..] if command == "outline" => {
            Some(("error: invalid aimux outline arguments", Some(OUTLINE_HELP)))
        }
        [command, ..] if command == "attachment" => Some((
            "error: invalid aimux attachment arguments",
            Some(ATTACHMENT_HELP),
        )),
        _ => None,
    }
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
