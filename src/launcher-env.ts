import { homedir } from "node:os";
import { join } from "node:path";
import { coreCommandArgs, isCoreCliCommand } from "./core-cli-routing.js";

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

export function cliEntryFor(argv: string[]): CliEntry {
  return isCoreCliCommand(coreCommandArgs(argv)) ? "core" : "main";
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
