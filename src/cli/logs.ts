import type { Command } from "commander";
import { clearLogFile, parseLineCount, readLastLogLines, selectedLogPath, type LogSelectionOptions } from "../logs.js";

export interface LogsCommandDeps {
  selectedLogPath?: typeof selectedLogPath;
  readLastLogLines?: typeof readLastLogLines;
  parseLineCount?: typeof parseLineCount;
  clearLogFile?: typeof clearLogFile;
}

interface TailOptions extends LogSelectionOptions {
  lines?: string;
}

export function registerLogsCommand(program: Command, deps: LogsCommandDeps = {}): void {
  const selectPath = deps.selectedLogPath ?? selectedLogPath;
  const readLines = deps.readLastLogLines ?? readLastLogLines;
  const parseLines = deps.parseLineCount ?? parseLineCount;
  const clearFile = deps.clearLogFile ?? clearLogFile;
  const logsCmd = program.command("logs").description("Inspect persistent aimux logs");

  logsCmd
    .command("path")
    .description("Print the active log file path")
    .option("--daemon", "Show the global daemon log path")
    .option("--project <path>", "Project path")
    .action((opts: LogSelectionOptions) => {
      console.log(selectPath(opts));
    });

  logsCmd
    .command("tail")
    .description("Print recent log lines")
    .option("--daemon", "Tail the global daemon log")
    .option("--project <path>", "Project path")
    .option("-n, --lines <number>", "Number of lines to print", "80")
    .action((opts: TailOptions) => {
      const path = selectPath(opts);
      const output = readLines(path, parseLines(opts.lines));
      if (output) {
        console.log(output);
        return;
      }
      console.error(`No log entries at ${path}`);
      process.exit(1);
    });

  logsCmd
    .command("clear")
    .description("Clear the active log file")
    .option("--daemon", "Clear the global daemon log")
    .option("--project <path>", "Project path")
    .action((opts: LogSelectionOptions) => {
      const path = selectPath(opts);
      clearFile(path);
      console.log(`Cleared ${path}`);
    });
}
