import { listProcessArgs, isPidAlive as defaultIsPidAlive, type ProcessArgsEntry } from "./process-inspector.js";
import { TmuxRuntimeManager } from "./tmux/runtime-manager.js";

export interface LifecycleOrphanCleanupResult {
  processPids: number[];
  tmuxSessions: string[];
  errors: string[];
}

export interface LifecycleOrphanTmux {
  isAvailable(): boolean;
  listSessionNames?(): string[];
  getSessionOption?(sessionName: string, key: string): string | null;
  killSession?(sessionName: string): void;
}

export interface CleanupLifecycleOrphansOptions {
  listProcesses?: () => ProcessArgsEntry[];
  isPidAlive?: (pid: number) => boolean;
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  tmux?: LifecycleOrphanTmux;
  processExitTimeoutMs?: number;
  processKillGraceMs?: number;
  currentPid?: number;
}

const VALIDATION_NATIVE_LABEL = /\/\.aimux\/native\/[^/\s]*lifecycle-(?:validate|visible)[^/\s]*/;
const VALIDATION_HOME = /(?:^|\s)(?:AIMUX_HOME=)?\/tmp\/aimux-home-(?:validate|lifecycle)[^\s]*/;
const AIMUX_NATIVE_ENTRY = /\/\.aimux\/native\/[^/\s]+\/dist\/(?:launcher-bin|main)\.js/;
const VALIDATION_SESSION_NAME = /^aimux-.*lifecycle-(?:validate|visible)/;
const VALIDATION_OPTION = /\/tmp\/aimux-(?:home-)?(?:validate|lifecycle)|lifecycle-(?:validate|visible)/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].filter((value) => Number.isInteger(value) && value > 0).sort((a, b) => a - b);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function isLifecycleValidationProcessArgs(args: string): boolean {
  return AIMUX_NATIVE_ENTRY.test(args) && (VALIDATION_HOME.test(args) || VALIDATION_NATIVE_LABEL.test(args));
}

export function isLifecycleValidationTmuxSession(sessionName: string, tmux?: LifecycleOrphanTmux): boolean {
  if (VALIDATION_SESSION_NAME.test(sessionName)) return true;
  const projectRoot = tmux?.getSessionOption?.(sessionName, "@aimux-project-root") ?? "";
  const stateDir = tmux?.getSessionOption?.(sessionName, "@aimux-project-state-dir") ?? "";
  return VALIDATION_OPTION.test(projectRoot) || VALIDATION_OPTION.test(stateDir);
}

async function waitForPidExit(input: {
  pid: number;
  timeoutMs: number;
  isPidAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (!input.isPidAlive(input.pid)) return true;
    await input.sleep(100);
  }
  return !input.isPidAlive(input.pid);
}

export async function cleanupLifecycleValidationOrphans(
  options: CleanupLifecycleOrphansOptions = {},
): Promise<LifecycleOrphanCleanupResult> {
  const listProcesses = options.listProcesses ?? listProcessArgs;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const killPid = options.killPid ?? ((pid, signal) => process.kill(pid, signal));
  const sleepFn = options.sleep ?? sleep;
  const tmux = options.tmux ?? new TmuxRuntimeManager();
  const processExitTimeoutMs = options.processExitTimeoutMs ?? 2_000;
  const processKillGraceMs = options.processKillGraceMs ?? 2_000;
  const currentPid = options.currentPid ?? process.pid;
  const errors: string[] = [];
  const tmuxSessions: string[] = [];

  if (tmux.isAvailable() && tmux.listSessionNames && tmux.killSession) {
    for (const sessionName of uniqueStrings(tmux.listSessionNames())) {
      if (!isLifecycleValidationTmuxSession(sessionName, tmux)) continue;
      try {
        tmux.killSession(sessionName);
        tmuxSessions.push(sessionName);
      } catch (error) {
        errors.push(`${sessionName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const processPids = uniqueNumbers(
    listProcesses()
      .filter((entry) => entry.pid !== currentPid && isLifecycleValidationProcessArgs(entry.args))
      .map((entry) => entry.pid),
  );
  for (const pid of processPids) {
    try {
      killPid(pid, "SIGTERM");
    } catch {}
  }
  for (const pid of processPids) {
    if (await waitForPidExit({ pid, timeoutMs: processExitTimeoutMs, isPidAlive, sleep: sleepFn })) continue;
    try {
      killPid(pid, "SIGKILL");
    } catch {}
    if (!(await waitForPidExit({ pid, timeoutMs: processKillGraceMs, isPidAlive, sleep: sleepFn }))) {
      errors.push(`pid ${pid}: still alive after SIGKILL`);
    }
  }

  return { processPids, tmuxSessions, errors };
}
