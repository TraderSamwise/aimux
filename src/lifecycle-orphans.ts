import {
  listProcessArgs,
  readProcessArgs as defaultReadProcessArgs,
  isPidAlive as defaultIsPidAlive,
  type ProcessArgsEntry,
} from "./process-inspector.js";
import { TmuxRuntimeManager } from "./tmux/runtime-manager.js";

export interface LifecycleOrphanCleanupResult {
  attemptedProcessPids: number[];
  processPids: number[];
  failedProcessPids: number[];
  attemptedTmuxSessions: string[];
  tmuxSessions: string[];
  failedTmuxSessions: string[];
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
  readProcessArgs?: (pid: number) => string | null;
  isPidAlive?: (pid: number) => boolean;
  killPid?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  tmux?: LifecycleOrphanTmux;
  processExitTimeoutMs?: number;
  processKillGraceMs?: number;
  currentPid?: number;
}

const VALIDATION_NATIVE_NODE_ENTRY =
  /(?:^|\s)(?:\S*\/)?node(?:\s+--\S+)*\s+\/\S*\/\.aimux\/native\/local-[0-9a-f]+-lifecycle-(?:validate|visible)[^/\s]*\/dist\/(?:launcher-bin|main)\.js(?:\s|$)/;
const VALIDATION_HOME = /(?:^|\s)(?:AIMUX_HOME=)?\/tmp\/aimux-home-(?:validate|lifecycle)[^\s]*/;
const AIMUX_NATIVE_ENTRY = /\/\.aimux\/native\/[^/\s]+\/dist\/(?:launcher-bin|main)\.js/;
const VALIDATION_SESSION_NAME =
  /^aimux-(?:aimux-)?lifecycle-(?:validate|visible)[A-Za-z0-9._-]*$|^aimux-smoke-lifecycle-(?:validate|visible)[A-Za-z0-9._-]*$/;
const VALIDATION_OPTION = /\/tmp\/aimux-(?:home-)?(?:validate|lifecycle)[A-Za-z0-9._/-]*/;

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
  return VALIDATION_NATIVE_NODE_ENTRY.test(args) || (AIMUX_NATIVE_ENTRY.test(args) && VALIDATION_HOME.test(args));
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
  const readProcessArgs = options.readProcessArgs ?? defaultReadProcessArgs;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const killPid = options.killPid ?? ((pid, signal) => process.kill(pid, signal));
  const sleepFn = options.sleep ?? sleep;
  const tmux = options.tmux ?? new TmuxRuntimeManager();
  const processExitTimeoutMs = options.processExitTimeoutMs ?? 2_000;
  const processKillGraceMs = options.processKillGraceMs ?? 2_000;
  const currentPid = options.currentPid ?? process.pid;
  const errors: string[] = [];
  const attemptedTmuxSessions: string[] = [];
  const tmuxSessions: string[] = [];
  const failedTmuxSessions: string[] = [];

  if (tmux.isAvailable() && tmux.listSessionNames && tmux.killSession) {
    for (const sessionName of uniqueStrings(tmux.listSessionNames())) {
      if (!isLifecycleValidationTmuxSession(sessionName, tmux)) continue;
      attemptedTmuxSessions.push(sessionName);
      try {
        tmux.killSession(sessionName);
        tmuxSessions.push(sessionName);
      } catch (error) {
        failedTmuxSessions.push(sessionName);
        errors.push(`${sessionName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const candidatePids = uniqueNumbers(
    listProcesses()
      .filter((entry) => entry.pid !== currentPid && isLifecycleValidationProcessArgs(entry.args))
      .map((entry) => entry.pid),
  );
  const attemptedProcessPids: number[] = [];
  const processPids: number[] = [];
  const failedProcessPids: number[] = [];
  for (const pid of candidatePids) {
    const latestArgs = readProcessArgs(pid);
    if (!latestArgs || !isLifecycleValidationProcessArgs(latestArgs)) continue;
    attemptedProcessPids.push(pid);
    try {
      killPid(pid, "SIGTERM");
    } catch (error) {
      if (isPidAlive(pid)) {
        failedProcessPids.push(pid);
        errors.push(`pid ${pid}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    if (await waitForPidExit({ pid, timeoutMs: processExitTimeoutMs, isPidAlive, sleep: sleepFn })) continue;
    const argsBeforeKill = readProcessArgs(pid);
    if (!argsBeforeKill || !isLifecycleValidationProcessArgs(argsBeforeKill)) {
      failedProcessPids.push(pid);
      errors.push(`pid ${pid}: command changed before SIGKILL`);
      continue;
    }
    try {
      killPid(pid, "SIGKILL");
    } catch (error) {
      if (isPidAlive(pid)) {
        failedProcessPids.push(pid);
        errors.push(`pid ${pid}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }
    if (await waitForPidExit({ pid, timeoutMs: processKillGraceMs, isPidAlive, sleep: sleepFn })) {
      processPids.push(pid);
    } else {
      failedProcessPids.push(pid);
      errors.push(`pid ${pid}: still alive after SIGKILL`);
    }
  }

  for (const pid of attemptedProcessPids) {
    if (!failedProcessPids.includes(pid) && !isPidAlive(pid) && !processPids.includes(pid)) processPids.push(pid);
  }

  return {
    attemptedProcessPids: uniqueNumbers(attemptedProcessPids),
    processPids: uniqueNumbers(processPids),
    failedProcessPids: uniqueNumbers(failedProcessPids),
    attemptedTmuxSessions: uniqueStrings(attemptedTmuxSessions),
    tmuxSessions: uniqueStrings(tmuxSessions),
    failedTmuxSessions: uniqueStrings(failedTmuxSessions),
    errors,
  };
}
