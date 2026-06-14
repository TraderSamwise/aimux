import { execFile as nodeExecFile } from "node:child_process";
import { existsSync as nodeExistsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import notifier from "node-notifier";
import { debug } from "./debug.js";

export interface DesktopNotificationPayload {
  title: string;
  message: string;
  sound?: boolean;
}

type ExecFile = typeof nodeExecFile;
type ExistsSync = typeof nodeExistsSync;

interface NodeNotifierLike {
  notify(options: { title: string; message: string; sound?: boolean }): void;
}

export interface DesktopNotifierDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  moduleDir?: string;
  execFile?: ExecFile;
  existsSync?: ExistsSync;
  nodeNotifier?: NodeNotifierLike;
}

export type DesktopNotificationTransport = "mac-helper" | "node-notifier";

export interface DesktopNotificationAttempt {
  transport: DesktopNotificationTransport;
  helperPath?: string;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function packageRoot(moduleDir: string): string {
  return dirname(moduleDir);
}

export function macNotifierCandidates(deps: Pick<DesktopNotifierDeps, "env" | "moduleDir"> = {}): string[] {
  const env = deps.env ?? process.env;
  const override = env.AIMUX_NOTIFIER_HELPER?.trim();
  const root = packageRoot(deps.moduleDir ?? MODULE_DIR);
  const candidates = [
    override,
    join(root, "native", "darwin", "aimux-notifier.app", "Contents", "MacOS", "aimux-notifier"),
    join(root, "native", "darwin", "aimux-notifier"),
  ];

  return candidates
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((candidate) => resolve(candidate));
}

export function findMacNotifierHelper(
  deps: Pick<DesktopNotifierDeps, "env" | "moduleDir" | "existsSync"> = {},
): string | null {
  const existsSync = deps.existsSync ?? nodeExistsSync;
  for (const candidate of macNotifierCandidates(deps)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function sendViaNodeNotifier(
  payload: DesktopNotificationPayload,
  deps: DesktopNotifierDeps,
): DesktopNotificationAttempt {
  const nodeNotifier = deps.nodeNotifier ?? notifier;
  nodeNotifier.notify({ title: payload.title, message: payload.message, sound: payload.sound ?? true });
  return { transport: "node-notifier" };
}

function macHelperArgs(payload: DesktopNotificationPayload): string[] {
  const args = ["--title", payload.title, "--message", payload.message];
  if (payload.sound ?? true) args.push("--sound");
  return args;
}

function sendViaMacHelper(
  helperPath: string,
  payload: DesktopNotificationPayload,
  deps: DesktopNotifierDeps,
): DesktopNotificationAttempt {
  const execFile = deps.execFile ?? nodeExecFile;
  execFile(helperPath, macHelperArgs(payload), (error) => {
    if (!error) return;
    debug(`mac notification helper fallback: ${error.message}`, "notify");
    sendViaNodeNotifier(payload, deps);
  });
  return { transport: "mac-helper", helperPath };
}

export function sendDesktopNotification(
  payload: DesktopNotificationPayload,
  deps: DesktopNotifierDeps = {},
): DesktopNotificationAttempt {
  if ((deps.platform ?? process.platform) !== "darwin") {
    return sendViaNodeNotifier(payload, deps);
  }

  const helperPath = findMacNotifierHelper(deps);
  if (!helperPath) return sendViaNodeNotifier(payload, deps);
  return sendViaMacHelper(helperPath, payload, deps);
}
