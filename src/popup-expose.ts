import { Command } from "commander";
import { resolve as pathResolve } from "node:path";
import { runTmuxExpose, type TmuxExposeOptions } from "./tmux/expose.js";

export interface ExposeCliOptions {
  projectRoot: string;
  projectStateDir: string;
  currentClientSession?: string;
  clientTty?: string;
  currentWindow?: string;
  currentWindowId?: string;
  currentPath?: string;
  paneId?: string;
  aimuxHome?: string;
  backdropFile?: string;
}

/** Map parsed CLI flags to runTmuxExpose options, resolving the two paths to absolute. */
export function toExposeOptions(opts: ExposeCliOptions): TmuxExposeOptions {
  return {
    projectRoot: pathResolve(opts.projectRoot),
    projectStateDir: pathResolve(opts.projectStateDir),
    currentClientSession: opts.currentClientSession,
    clientTty: opts.clientTty,
    currentWindow: opts.currentWindow,
    currentWindowId: opts.currentWindowId,
    currentPath: opts.currentPath,
    paneId: opts.paneId,
    aimuxHome: opts.aimuxHome,
    backdropFile: opts.backdropFile,
  };
}

/**
 * Single source of truth for the `expose` command, registered both on the full CLI (main.ts)
 * and on the lightweight program below so the two never drift.
 */
export function registerExposeCommand(program: Command): void {
  program
    .command("expose")
    .description("Internal tmux popup exposé")
    .requiredOption("--project-root <path>", "Project root")
    .requiredOption("--project-state-dir <path>", "Project state dir")
    .option("--current-client-session <name>", "Current client session")
    .option("--client-tty <tty>", "Client tty")
    .option("--current-window <name>", "Current window name")
    .option("--current-window-id <id>", "Current window id")
    .option("--current-path <path>", "Current path")
    .option("--pane-id <id>", "Current pane id")
    .option("--aimux-home <path>", "AIMUX_HOME to scope cross-project Exposé")
    .option("--backdrop-file <path>", "Pre-popup host snapshot to dim as the backdrop")
    .action(async (opts: ExposeCliOptions) => {
      const code = await runTmuxExpose(toExposeOptions(opts));
      process.exit(code);
    });
}

/**
 * A minimal commander program with only the `expose` command, so the popup launcher can run
 * exposé without loading the full CLI's command graph — the bulk of the cold-start latency.
 */
export function buildExposeProgram(): Command {
  const program = new Command();
  registerExposeCommand(program);
  return program;
}

/** Entry point invoked by bin/aimux for the `expose` subcommand. */
export function runExpose(): void {
  buildExposeProgram().parse();
}
