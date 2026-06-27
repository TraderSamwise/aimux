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

/** Which CLI entry to load for the given argv. `expose` uses the lightweight popup entry. */
export function cliEntryFor(argv: string[]): "expose" | "main" {
  return argv[2] === "expose" ? "expose" : "main";
}

/**
 * Load and run the CLI entry for the current argv. `expose` routes to the lightweight
 * popup entry (no full-CLI graph) to avoid the cold-start blank; everything else loads
 * the full program, which self-runs via its top-level parse().
 */
export function runRoutedCli(): void {
  const run =
    cliEntryFor(process.argv) === "expose"
      ? import("./popup-expose.js").then((m) => m.runExpose())
      : import("./main.js").then(() => undefined);

  void run.catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
