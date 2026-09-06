use aimux::config::load_config_for_project;
use aimux::core_cli::CoreCommandRequestOptions;
use aimux::core_cli_executor::run_core_cli;
use aimux::core_cli_routing::core_command_args;
use aimux::core_command_client::request_core_command;
use aimux::core_command_contract::CORE_COMMAND_NAMES;
use aimux::daemon::runtime::run_daemon_internal;
use aimux::daemon_state::get_daemon_base_url;
use aimux::dashboard_internal::{NativeDashboardOptions, run_native_dashboard_internal};
use aimux::launcher_env::{CliEntry, cli_entry_for};
use aimux::local_ui_server::{
    DEFAULT_LOCAL_UI_HOST, DEFAULT_LOCAL_UI_PORT, LocalUiConfig, LocalUiServerOptions,
    open_url_in_browser, resolve_default_local_ui_root, start_local_ui_server,
};
use aimux::paths::PathResolver;
use aimux::project_service::process::{
    ProjectServiceInternalOptions, run_project_service_internal,
};
use aimux::tmux_expose::{parse_expose_args, run_tmux_expose};
use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process::Command as ProcessCommand;
use std::process::ExitCode;

#[derive(Debug, Parser)]
#[command(name = "aimux")]
#[command(about = "Native Aimux CLI")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
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
        #[arg(long, default_value_t = 120)]
        cols: usize,
        #[arg(long, default_value_t = 40)]
        rows: usize,
        #[arg(long)]
        once: bool,
    },
}

#[derive(Debug, Subcommand)]
enum ContractsCommand {
    List {
        #[arg(long)]
        json: bool,
    },
}

#[derive(Debug, Subcommand)]
enum DaemonCommand {
    Run,
}

#[derive(Debug, Subcommand)]
enum RewriteCommand {
    Status {
        #[arg(long)]
        json: bool,
    },
}

fn main() -> Result<ExitCode> {
    let raw_args = std::env::args().skip(1).collect::<Vec<_>>();
    let stripped_args = core_command_args(&raw_args);
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
            if let Some(args) = native_tool_launch_args(&stripped_args) {
                return run_core_command_and_print(&args);
            }
            if !is_native_main_command(&stripped_args) {
                return run_node_fallback(&raw_args);
            }
        }
    }
    let cli = Cli::parse_from(std::iter::once("aimux".to_owned()).chain(stripped_args));
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
            run_native_dashboard_internal(NativeDashboardOptions {
                project_root: project_root.unwrap_or(std::env::current_dir()?),
                desktop_state_file,
                cols,
                rows,
                once,
            })?;
            Ok(())
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
        [command, ..] if command == "__dashboard-internal-native" => true,
        _ => false,
    }
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

    let dashboard_args = vec!["dashboard-reload".to_owned(), "--open".to_owned()];
    run_core_command_and_print(&dashboard_args)
}

fn run_core_command_and_print(args: &[String]) -> Result<ExitCode> {
    let execution = run_core_cli(args);
    for line in execution.stdout {
        println!("{line}");
    }
    for line in execution.stderr {
        eprintln!("{line}");
    }
    Ok(ExitCode::from(execution.code as u8))
}

fn native_tool_launch_args(args: &[String]) -> Option<Vec<String>> {
    let (tool, extra_args) = args.split_first()?;
    if tool.starts_with('-') || is_reserved_main_word(tool) {
        return None;
    }
    let project_root = current_project_root().ok()?;
    let config = load_config_for_project(project_root);
    let tool_config = config.get("tools")?.as_object()?.get(tool)?;
    if tool_config
        .get("enabled")
        .and_then(serde_json::Value::as_bool)
        == Some(false)
    {
        return None;
    }
    let mut spawn_args = vec!["spawn".to_owned(), "--tool".to_owned(), tool.clone()];
    if !extra_args.is_empty() {
        spawn_args.push("--".to_owned());
        spawn_args.extend(extra_args.iter().cloned());
    }
    Some(spawn_args)
}

fn current_project_root() -> Result<PathBuf> {
    let cwd = std::env::current_dir()?;
    let mut resolver = PathResolver::from_env();
    Ok(resolver.resolve_repo_root(cwd))
}

fn is_reserved_main_word(word: &str) -> bool {
    matches!(
        word,
        "build-info"
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
            | "init"
            | "input"
            | "kill"
            | "list-notifications"
            | "login"
            | "logout"
            | "loop"
            | "message"
            | "migrate"
            | "notifications"
            | "notify"
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
            | "spawn"
            | "stop"
            | "task"
            | "thread"
            | "threads"
            | "ui"
            | "whoami"
            | "worktree"
            | "__dashboard-internal-native"
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

fn run_node_fallback(args: &[String]) -> Result<ExitCode> {
    let Some(root) = std::env::var_os("AIMUX_ROOT") else {
        let cli = Cli::parse_from(std::iter::once("aimux".to_owned()).chain(args.iter().cloned()));
        drop(cli);
        return Ok(ExitCode::SUCCESS);
    };
    let script = PathBuf::from(root).join("dist/launcher-bin.js");
    if !script.is_file() {
        let cli = Cli::parse_from(std::iter::once("aimux".to_owned()).chain(args.iter().cloned()));
        drop(cli);
        return Ok(ExitCode::SUCCESS);
    }
    let node = std::env::var_os("AIMUX_NODE_BIN").unwrap_or_else(|| "node".into());
    exec_or_wait_node(node, script, args)
}

#[cfg(unix)]
fn exec_or_wait_node(
    node: std::ffi::OsString,
    script: PathBuf,
    args: &[String],
) -> Result<ExitCode> {
    use std::os::unix::process::CommandExt;
    Err(ProcessCommand::new(node).arg(script).args(args).exec())
        .context("exec node launcher fallback")
}

#[cfg(not(unix))]
fn exec_or_wait_node(
    node: std::ffi::OsString,
    script: PathBuf,
    args: &[String],
) -> Result<ExitCode> {
    let status = ProcessCommand::new(node)
        .arg(script)
        .args(args)
        .status()
        .context("run node launcher fallback")?;
    Ok(ExitCode::from(status.code().unwrap_or(1) as u8))
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
