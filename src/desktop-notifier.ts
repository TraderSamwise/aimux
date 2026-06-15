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
  arch?: NodeJS.Architecture;
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

export interface DesktopNotificationDeliveryResult extends DesktopNotificationAttempt {
  ok: boolean;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export interface MacNotifierHelperCheck {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface DesktopNotifierDoctorReport {
  platform: NodeJS.Platform;
  transport: DesktopNotificationTransport;
  helperPath: string | null;
  helperCandidates: string[];
  helperCheck?: MacNotifierHelperCheck;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

function packageRoot(moduleDir: string): string {
  return dirname(moduleDir);
}

function isMacNotifierAppExecutable(candidate: string): boolean {
  return /aimux-notifier\.app\/Contents\/MacOS\/aimux-notifier$/.test(candidate);
}

export function macNotifierCandidates(deps: Pick<DesktopNotifierDeps, "arch" | "env" | "moduleDir"> = {}): string[] {
  const env = deps.env ?? process.env;
  const override = env.AIMUX_NOTIFIER_HELPER?.trim();
  const root = packageRoot(deps.moduleDir ?? MODULE_DIR);
  const arch = deps.arch ?? process.arch;
  const candidates = [
    override,
    join(root, "native", "darwin", "aimux-notifier.app", "Contents", "MacOS", "aimux-notifier"),
    join(root, "native", `darwin-${arch}`, "aimux-notifier.app", "Contents", "MacOS", "aimux-notifier"),
  ];

  return candidates
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((candidate) => resolve(candidate))
    .filter(isMacNotifierAppExecutable);
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
    debug(`mac notification helper failed: ${error.message}`, "notify");
  });
  return { transport: "mac-helper", helperPath };
}

function sendViaMacHelperAndWait(
  helperPath: string,
  payload: DesktopNotificationPayload,
  deps: DesktopNotifierDeps,
): Promise<DesktopNotificationDeliveryResult> {
  const execFile = deps.execFile ?? nodeExecFile;

  return new Promise((resolveSend) => {
    execFile(helperPath, macHelperArgs(payload), { timeout: 10000 }, (error, stdout, stderr) => {
      resolveSend({
        transport: "mac-helper",
        helperPath,
        ok: !error,
        exitCode: exitCodeFromError(error),
        stdout: typeof stdout === "string" ? stdout.trim() : "",
        stderr: typeof stderr === "string" ? stderr.trim() : "",
        error: error?.message,
      });
    });
  });
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

export async function sendDesktopNotificationAndWait(
  payload: DesktopNotificationPayload,
  deps: DesktopNotifierDeps = {},
): Promise<DesktopNotificationDeliveryResult> {
  if ((deps.platform ?? process.platform) !== "darwin") {
    return { ...sendViaNodeNotifier(payload, deps), ok: true };
  }

  const helperPath = findMacNotifierHelper(deps);
  if (!helperPath) return { ...sendViaNodeNotifier(payload, deps), ok: true };
  return sendViaMacHelperAndWait(helperPath, payload, deps);
}

function exitCodeFromError(error: Error | null): number | null {
  if (!error) return 0;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "number" ? code : null;
}

export function checkMacNotifierHelper(
  helperPath: string,
  deps: Pick<DesktopNotifierDeps, "execFile"> = {},
): Promise<MacNotifierHelperCheck> {
  const execFile = deps.execFile ?? nodeExecFile;

  return new Promise((resolveCheck) => {
    execFile(helperPath, ["--check"], { timeout: 10000 }, (error, stdout, stderr) => {
      resolveCheck({
        ok: !error,
        exitCode: exitCodeFromError(error),
        stdout: typeof stdout === "string" ? stdout.trim() : "",
        stderr: typeof stderr === "string" ? stderr.trim() : "",
        error: error?.message,
      });
    });
  });
}

export async function buildDesktopNotifierDoctorReport(
  deps: Pick<DesktopNotifierDeps, "platform" | "env" | "moduleDir" | "existsSync" | "execFile"> = {},
): Promise<DesktopNotifierDoctorReport> {
  const platform = deps.platform ?? process.platform;
  const helperCandidates = platform === "darwin" ? macNotifierCandidates(deps) : [];
  const helperPath = platform === "darwin" ? findMacNotifierHelper(deps) : null;
  const helperCheck = helperPath ? await checkMacNotifierHelper(helperPath, deps) : undefined;

  return {
    platform,
    transport: platform === "darwin" && helperPath ? "mac-helper" : "node-notifier",
    helperPath,
    helperCandidates,
    helperCheck,
  };
}

export function renderDesktopNotifierDoctorReport(report: DesktopNotifierDoctorReport): string {
  const lines = ["Desktop notifications", `Platform: ${report.platform}`, `Transport: ${report.transport}`];

  if (report.platform !== "darwin") {
    lines.push("macOS helper: not used on this platform");
    return lines.join("\n");
  }

  lines.push(`Helper: ${report.helperPath ?? "not found"}`);
  if (report.helperCheck) {
    lines.push(`Helper check: ${report.helperCheck.ok ? "ok" : "failed"}`);
    if (report.helperCheck.stdout) lines.push(`Helper stdout: ${report.helperCheck.stdout}`);
    if (report.helperCheck.stderr) lines.push(`Helper stderr: ${report.helperCheck.stderr}`);
    if (report.helperCheck.error) lines.push(`Helper error: ${report.helperCheck.error}`);
  }
  if (!report.helperPath && report.helperCandidates.length > 0) {
    lines.push("Checked:");
    for (const candidate of report.helperCandidates) lines.push(`  ${candidate}`);
  }

  return lines.join("\n");
}
