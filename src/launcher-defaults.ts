import { homedir } from "node:os";
import { join } from "node:path";

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
