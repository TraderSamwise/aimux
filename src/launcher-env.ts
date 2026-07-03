import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_HOME = join(homedir(), ".aimux");
const DEFAULT_DAEMON_PORT = "43190";
const DEFAULT_WEB_APP_URL = "https://aimux.app";

type MutableEnv = Record<string, string | undefined>;

function blank(value: string | undefined): boolean {
  return !value?.trim();
}

export function prepareStableCliEnv(env: MutableEnv = process.env): void {
  if (blank(env.AIMUX_HOME)) env.AIMUX_HOME = DEFAULT_HOME;
  if (blank(env.AIMUX_DAEMON_PORT)) env.AIMUX_DAEMON_PORT = DEFAULT_DAEMON_PORT;
  if (blank(env.AIMUX_ENV)) env.AIMUX_ENV = "production";
  if (blank(env.AIMUX_WEB_APP_URL)) env.AIMUX_WEB_APP_URL = DEFAULT_WEB_APP_URL;
}

export type CliEntry = "core" | "main";

function commandArgs(argv: string[]): string[] {
  const args = argv.slice(2);
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if ((arg === "--debug" || arg === "--trace") && result.length === 0) continue;
    if ((arg === "--log-level" || arg === "--log-category") && result.length === 0) {
      index += 1;
      continue;
    }
    if ((arg.startsWith("--log-level=") || arg.startsWith("--log-category=")) && result.length === 0) continue;
    result.push(arg);
  }
  return result;
}

function isCoreCliCommand(args: string[]): boolean {
  const [command, subcommand] = args;
  if (command === "host" && subcommand === "status") return true;
  if (command === "daemon") {
    return ["ensure", "status", "projects", "project-ensure"].includes(subcommand ?? "");
  }
  if (command === "projects" && subcommand === "list") return true;
  if (command === "remote") {
    return ["status", "enable", "disable"].includes(subcommand ?? "");
  }
  return false;
}

export function cliEntryFor(argv: string[]): CliEntry {
  return isCoreCliCommand(commandArgs(argv)) ? "core" : "main";
}

export function runRoutedCli(): void {
  const run =
    cliEntryFor(process.argv) === "core"
      ? import("./core-cli.js").then(async ({ runCoreCli }) => {
          const code = await runCoreCli(process.argv.slice(2));
          process.exitCode = code;
        })
      : import("./main.js").then(() => undefined);

  void run.catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
