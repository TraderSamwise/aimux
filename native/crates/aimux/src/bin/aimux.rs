use aimux::core_cli_executor::run_core_cli;
use aimux::core_cli_routing::core_command_args;
use aimux::launcher_env::{CliEntry, cli_entry_for};
use anyhow::Result;
use clap::{Parser, Subcommand};
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
    Contracts {
        #[command(subcommand)]
        command: ContractsCommand,
    },
    Rewrite {
        #[command(subcommand)]
        command: RewriteCommand,
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
enum RewriteCommand {
    Status {
        #[arg(long)]
        json: bool,
    },
}

fn main() -> Result<ExitCode> {
    let raw_args = std::env::args().skip(1).collect::<Vec<_>>();
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
            eprintln!("Error: expose is not yet ported to native CLI");
            return Ok(ExitCode::from(1));
        }
        CliEntry::Main => {
            let core_args = core_command_args(&raw_args);
            if core_args != raw_args {
                eprintln!("Error: global logging flags are not yet ported to native CLI");
                return Ok(ExitCode::from(1));
            }
        }
    }
    let cli = Cli::parse();
    match cli.command {
        Command::BuildInfo { json } => print_value(aimux::build_info(), json),
        Command::Contracts {
            command: ContractsCommand::List { json },
        } => print_value(aimux::contract_manifest(), json),
        Command::Rewrite {
            command: RewriteCommand::Status { json },
        } => print_value(aimux::rewrite_status(), json),
    }?;
    Ok(ExitCode::SUCCESS)
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
