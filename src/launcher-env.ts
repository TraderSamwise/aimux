import { homedir } from "node:os";
import { join } from "node:path";
import {
  coreCommandArgs,
  hasCoreGlobalLoggingArgs,
  isCoreCliCommand,
  isCoreProjectEnsureCommand,
  isValidCoreProjectEnsureArgs,
} from "./core-cli-routing.js";

export const DEFAULT_HOME = join(homedir(), ".aimux");
export const DEFAULT_DAEMON_PORT = "43190";
export const DEFAULT_ENV = "production";
export const DEFAULT_WEB_APP_URL = "https://aimux.app";

type MutableEnv = Record<string, string | undefined>;

function blank(value: string | undefined): boolean {
  return !value?.trim();
}

export function prepareStableCliEnv(env: MutableEnv = process.env): void {
  if (blank(env.AIMUX_HOME)) env.AIMUX_HOME = DEFAULT_HOME;
  if (blank(env.AIMUX_DAEMON_PORT)) env.AIMUX_DAEMON_PORT = DEFAULT_DAEMON_PORT;
  if (blank(env.AIMUX_ENV)) env.AIMUX_ENV = DEFAULT_ENV;
  if (blank(env.AIMUX_WEB_APP_URL)) env.AIMUX_WEB_APP_URL = DEFAULT_WEB_APP_URL;
}

export type CliEntry = "core" | "expose" | "main";

export function cliEntryFor(argv: string[]): CliEntry {
  if (argv[2] === "expose") return "expose";
  const args = coreCommandArgs(argv);
  if (hasCoreGlobalLoggingArgs(argv)) {
    return isCoreProjectEnsureCommand(args) && !isValidCoreProjectEnsureArgs(args) ? "core" : "main";
  }
  return isCoreCliCommand(args) ? "core" : "main";
}

export function runRoutedCli(): void {
  const entry = cliEntryFor(process.argv);
  const run =
    entry === "core"
      ? import("./core-cli.js").then(async ({ runCoreCli }) => {
          const code = await runCoreCli(process.argv.slice(2));
          process.exitCode = code;
        })
      : entry === "expose"
        ? import("./popup-expose.js").then((m) => m.runExpose())
        : import("./main.js").then(() => undefined);

  void run.catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
