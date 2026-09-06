use aimux::core_cli::CoreCommandRequestOptions;
use aimux::core_cli_executor::run_core_cli;
use aimux::core_cli_routing::core_command_args;
use aimux::core_command_client::request_core_command;
use aimux::core_command_contract::CORE_COMMAND_NAMES;
use aimux::daemon::runtime::run_daemon_internal;
use aimux::daemon_state::get_daemon_base_url;
use aimux::launcher_env::{CliEntry, cli_entry_for};
use aimux::local_ui_server::{
    DEFAULT_LOCAL_UI_HOST, DEFAULT_LOCAL_UI_PORT, LocalUiConfig, LocalUiServerOptions,
    open_url_in_browser, resolve_default_local_ui_root, start_local_ui_server,
};
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
    }?;
    Ok(ExitCode::SUCCESS)
}

fn is_native_main_command(args: &[String]) -> bool {
    match args {
        [command, ..] if command == "build-info" => true,
        [command, subcommand, ..] if command == "daemon" && subcommand == "run" => true,
        [command, subcommand, ..] if command == "contracts" && subcommand == "list" => true,
        [command, subcommand, ..] if command == "rewrite" && subcommand == "status" => true,
        [command, ..] if command == "ui" => true,
        [command, ..] if command == "__project-service-internal" => true,
        _ => false,
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
