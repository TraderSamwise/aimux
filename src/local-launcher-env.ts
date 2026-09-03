import {
  coreCommandArgs,
  hasCoreGlobalLoggingArgs,
  isCoreCliCommand,
  isCoreProjectEnsureCommand,
  isValidCoreProjectEnsureArgs,
} from "./core-cli-routing.js";
export {
  DEFAULT_DAEMON_PORT,
  DEFAULT_ENV,
  DEFAULT_HOME,
  DEFAULT_WEB_APP_URL,
  prepareStableCliEnv,
} from "./launcher-defaults.js";

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
