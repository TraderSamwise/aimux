import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getReadOnlyProjectPathsFor, type ReadOnlyProjectPaths } from "./paths.js";
import { TmuxRuntimeManager, type TmuxWindowMetadata, type TmuxTarget } from "./tmux/runtime-manager.js";
import { listWorktrees, type WorktreeInfo } from "./worktree.js";
import { RuntimeTopologyStore, type RuntimeTopology } from "./runtime-core/topology-store.js";
import { RuntimeExchangeStore, type RuntimeExchange } from "./runtime-core/exchange-store.js";

type SourceStatus = "found" | "missing" | "unavailable" | "error";
type TargetResolutionStatus = "matched" | "missing" | "ambiguous";
type TargetKind =
  | "session"
  | "service"
  | "worktree"
  | "backend-session"
  | "notification"
  | "operation-failure"
  | "instance-session"
  | "tmux-window";

export interface SourceResult<T> {
  status: SourceStatus;
  path?: string;
  reason?: string;
  error?: string;
  value?: T;
}

export interface TargetMatch {
  canonicalKey: string;
  kind: TargetKind;
  source: string;
  id?: string;
  backendSessionId?: string;
  worktreePath?: string;
  worktreeName?: string;
  label?: string;
  raw: unknown;
}

export interface DebugStateReport {
  version: 1;
  target: string;
  project: {
    repoRoot: string;
    projectId: string;
    projectStateDir: string;
    localAimuxDir: string;
  };
  targetResolution: {
    status: TargetResolutionStatus;
    entityCount: number;
    matches: TargetMatch[];
  };
  sources: {
    savedState: SourceResult<{ services: unknown[] }>;
    runtimeTopology: SourceResult<{ sessions: unknown[]; services: unknown[]; worktrees: unknown[] }>;
    metadata: SourceResult<{ sessions: unknown[] }>;
    tmux: SourceResult<{ windows: Array<{ target: TmuxTarget; metadata: TmuxWindowMetadata }> }>;
    gitWorktrees: SourceResult<{ worktrees: WorktreeInfo[] }>;
    graveyard: SourceResult<{ entries: unknown[] }>;
    worktreeGraveyard: SourceResult<{ entries: unknown[] }>;
    notifications: SourceResult<{ notifications: unknown[] }>;
    operationFailures: SourceResult<{ failures: unknown[] }>;
    instances: SourceResult<{ files: Array<SourceResult<{ instances: unknown[] }>> }>;
    runtimeRows: SourceResult<never>;
    pendingActions: SourceResult<never>;
    dashboardSnapshot: SourceResult<never>;
  };
}

export interface BuildDebugStateReportOptions {
  cwd?: string;
  target: string;
  paths?: ReadOnlyProjectPaths;
  tmuxWindows?: Array<{ target: TmuxTarget; metadata: TmuxWindowMetadata }> | Error;
  worktrees?: WorktreeInfo[] | Error;
}

interface JsonObject {
  [key: string]: unknown;
}

function asObject(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function getString(record: JsonObject | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function readJson(path: string): SourceResult<unknown> {
  if (!existsSync(path)) return { status: "missing", path };
  try {
    return { status: "found", path, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    return {
      status: "error",
      path,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function readRuntimeTopology(path: string): SourceResult<RuntimeTopology> {
  if (!existsSync(path)) return { status: "missing", path };
  try {
    return { status: "found", path, value: new RuntimeTopologyStore(path).read() };
  } catch (err) {
    return {
      status: "error",
      path,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function readRuntimeExchange(path: string): SourceResult<RuntimeExchange> {
  if (!existsSync(path)) return { status: "missing", path };
  try {
    return { status: "found", path, value: new RuntimeExchangeStore(path).read() };
  } catch (err) {
    return {
      status: "error",
      path,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function normalizePathLike(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

function looksPathLike(value: string): boolean {
  return value.includes("/") || value.startsWith("~");
}

function matchesString(candidate: string | undefined, target: string): boolean {
  if (!candidate) return false;
  if (candidate === target) return true;
  if (looksPathLike(candidate) || looksPathLike(target)) {
    return normalizePathLike(candidate) === normalizePathLike(target);
  }
  return false;
}

function serviceCanonical(id: string | undefined, worktreePath?: string): string {
  return id ? `service:${id}` : `service:${worktreePath ?? "unknown"}`;
}

function sessionCanonical(id: string | undefined, backendSessionId?: string): string {
  if (id) return `session:${id}`;
  if (backendSessionId) return `backend-session:${backendSessionId}`;
  return "session:unknown";
}

function worktreeCanonical(path: string | undefined, name: string | undefined): string {
  return `worktree:${path ?? name ?? "unknown"}`;
}

function addMatch(matches: TargetMatch[], seen: Set<string>, match: TargetMatch): void {
  const key = `${match.canonicalKey}:${match.source}:${match.kind}:${match.id ?? ""}:${match.backendSessionId ?? ""}`;
  if (seen.has(key)) return;
  seen.add(key);
  matches.push(match);
}

function sourceUnavailable(reason: string): SourceResult<never> {
  return { status: "unavailable", reason };
}

function filterSavedState(
  source: SourceResult<unknown>,
  target: string,
  matches: TargetMatch[],
  seen: Set<string>,
): SourceResult<{ services: unknown[] }> {
  if (source.status !== "found") return { ...source, value: undefined };
  const root = asObject(source.value);
  const services = asArray(root?.services).filter((entry) => {
    const record = asObject(entry);
    const id = getString(record, "id");
    const worktreePath = getString(record, "worktreePath");
    const cwd = getString(record, "cwd");
    const label = getString(record, "label");
    const matched =
      matchesString(id, target) ||
      matchesString(worktreePath, target) ||
      matchesString(cwd, target) ||
      matchesString(label, target);
    if (matched) {
      addMatch(matches, seen, {
        canonicalKey: serviceCanonical(id, worktreePath),
        kind: "service",
        source: "savedState",
        id,
        worktreePath,
        label,
        raw: entry,
      });
    }
    return matched;
  });
  return { status: "found", path: source.path, value: { services } };
}

function filterMetadata(
  source: SourceResult<unknown>,
  target: string,
  matches: TargetMatch[],
  seen: Set<string>,
): SourceResult<{ sessions: unknown[] }> {
  if (source.status !== "found") return { ...source, value: undefined };
  const sessionsRecord = asObject(asObject(source.value)?.sessions);
  const sessions = Object.entries(sessionsRecord ?? {})
    .filter(([sessionId, entry]) => {
      const record = asObject(entry);
      const context = asObject(record?.context);
      const backendSessionId = getString(record, "backendSessionId");
      const worktreePath = getString(context, "worktreePath");
      const worktreeName = getString(context, "worktreeName");
      const branch = getString(context, "branch");
      const cwd = getString(context, "cwd");
      const label = getString(record, "label");
      const matched =
        matchesString(sessionId, target) ||
        matchesString(backendSessionId, target) ||
        matchesString(worktreePath, target) ||
        matchesString(worktreeName, target) ||
        matchesString(branch, target) ||
        matchesString(cwd, target) ||
        matchesString(label, target);
      if (matched) {
        addMatch(matches, seen, {
          canonicalKey: sessionCanonical(sessionId, backendSessionId),
          kind: backendSessionId === target && sessionId !== target ? "backend-session" : "session",
          source: "metadata",
          id: sessionId,
          backendSessionId,
          worktreePath,
          worktreeName,
          label,
          raw: entry,
        });
      }
      return matched;
    })
    .map(([sessionId, entry]) => ({ sessionId, ...(asObject(entry) ?? {}) }));
  return { status: "found", path: source.path, value: { sessions } };
}

function filterTmux(
  tmuxWindows: Array<{ target: TmuxTarget; metadata: TmuxWindowMetadata }> | Error | undefined,
  paths: ReadOnlyProjectPaths,
  target: string,
  matches: TargetMatch[],
  seen: Set<string>,
): SourceResult<{ windows: Array<{ target: TmuxTarget; metadata: TmuxWindowMetadata }> }> {
  let windows = tmuxWindows;
  if (!windows) {
    try {
      windows = new TmuxRuntimeManager().listProjectManagedWindows(paths.repoRoot);
    } catch (err) {
      return {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  if (windows instanceof Error) return { status: "error", error: windows.message };
  const filtered = windows.filter((entry) => {
    const metadata = entry.metadata;
    const matched =
      matchesString(metadata.sessionId, target) ||
      matchesString(metadata.backendSessionId, target) ||
      matchesString(metadata.worktreePath, target) ||
      matchesString(metadata.label, target) ||
      matchesString(metadata.launchCommandLine, target) ||
      matchesString(entry.target.windowName, target);
    if (matched) {
      addMatch(matches, seen, {
        canonicalKey:
          metadata.kind === "service"
            ? serviceCanonical(metadata.sessionId, metadata.worktreePath)
            : sessionCanonical(metadata.sessionId, metadata.backendSessionId),
        kind: "tmux-window",
        source: "tmux",
        id: metadata.sessionId,
        backendSessionId: metadata.backendSessionId,
        worktreePath: metadata.worktreePath,
        label: metadata.label,
        raw: entry,
      });
    }
    return matched;
  });
  return { status: "found", value: { windows: filtered } };
}

function filterGitWorktrees(
  worktreesInput: WorktreeInfo[] | Error | undefined,
  paths: ReadOnlyProjectPaths,
  target: string,
  matches: TargetMatch[],
  seen: Set<string>,
): SourceResult<{ worktrees: WorktreeInfo[] }> {
  let worktrees = worktreesInput;
  if (!worktrees) {
    try {
      worktrees = listWorktrees(paths.repoRoot);
    } catch (err) {
      return {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  if (worktrees instanceof Error) return { status: "error", error: worktrees.message };
  const filtered = worktrees.filter((entry) => {
    const matched =
      matchesString(entry.name, target) || matchesString(entry.path, target) || matchesString(entry.branch, target);
    if (matched) {
      addMatch(matches, seen, {
        canonicalKey: worktreeCanonical(entry.path, entry.name),
        kind: "worktree",
        source: "gitWorktrees",
        worktreePath: entry.path,
        worktreeName: entry.name,
        raw: entry,
      });
    }
    return matched;
  });
  return { status: "found", value: { worktrees: filtered } };
}

function filterGraveyard(
  source: SourceResult<unknown>,
  target: string,
  matches: TargetMatch[],
  seen: Set<string>,
): SourceResult<{ entries: unknown[] }> {
  if (source.status !== "found") return { ...source, value: undefined };
  const root = source.value;
  const entries = asArray(Array.isArray(root) ? root : asObject(root)?.sessions).filter((entry) => {
    const record = asObject(entry);
    const status = getString(record, "status");
    if (status && status !== "graveyard") return false;
    const id = getString(record, "id");
    const backendSessionId = getString(record, "backendSessionId");
    const worktreePath = getString(record, "worktreePath");
    const label = getString(record, "label");
    const matched =
      matchesString(id, target) ||
      matchesString(backendSessionId, target) ||
      matchesString(worktreePath, target) ||
      matchesString(label, target);
    if (matched) {
      addMatch(matches, seen, {
        canonicalKey: sessionCanonical(id, backendSessionId),
        kind: "session",
        source: "graveyard",
        id,
        backendSessionId,
        worktreePath,
        label,
        raw: entry,
      });
    }
    return matched;
  });
  return { status: "found", path: source.path, value: { entries } };
}

function filterRuntimeTopology(
  source: SourceResult<RuntimeTopology>,
  target: string,
  matches: TargetMatch[],
  seen: Set<string>,
): SourceResult<{ sessions: unknown[]; services: unknown[]; worktrees: unknown[] }> {
  if (source.status !== "found") return { ...source, value: undefined };
  const topology = source.value as RuntimeTopology;
  const sessions = topology.sessions.filter((entry) => {
    const id = entry.id;
    const backendSessionId = entry.backendSessionId;
    const worktreePath = entry.worktreePath;
    const label = entry.label;
    const matched =
      matchesString(id, target) ||
      matchesString(backendSessionId, target) ||
      matchesString(worktreePath, target) ||
      matchesString(label, target);
    if (matched) {
      addMatch(matches, seen, {
        canonicalKey: sessionCanonical(id, backendSessionId),
        kind: backendSessionId === target && id !== target ? "backend-session" : "session",
        source: "runtimeTopology",
        id,
        backendSessionId,
        worktreePath,
        label,
        raw: entry,
      });
    }
    return matched;
  });
  const services = topology.services.filter((entry) => {
    const matched =
      matchesString(entry.id, target) ||
      matchesString(entry.worktreePath, target) ||
      matchesString(entry.cwd, target) ||
      matchesString(entry.label, target) ||
      matchesString(entry.launchCommandLine, target);
    if (matched) {
      addMatch(matches, seen, {
        canonicalKey: serviceCanonical(entry.id, entry.worktreePath),
        kind: "service",
        source: "runtimeTopology",
        id: entry.id,
        worktreePath: entry.worktreePath,
        label: entry.label,
        raw: entry,
      });
    }
    return matched;
  });
  const worktrees = topology.worktrees.filter((entry) => {
    const matched =
      matchesString(entry.name, target) || matchesString(entry.path, target) || matchesString(entry.branch, target);
    if (matched) {
      addMatch(matches, seen, {
        canonicalKey: worktreeCanonical(entry.path, entry.name),
        kind: "worktree",
        source: "runtimeTopology",
        worktreePath: entry.path,
        worktreeName: entry.name,
        raw: entry,
      });
    }
    return matched;
  });
  return { status: "found", path: source.path, value: { sessions, services, worktrees } };
}

function filterWorktreeGraveyard(
  source: SourceResult<unknown>,
  target: string,
  matches: TargetMatch[],
  seen: Set<string>,
): SourceResult<{ entries: unknown[] }> {
  if (source.status !== "found") return { ...source, value: undefined };
  const entries = asArray(source.value).filter((entry) => {
    const record = asObject(entry);
    const name = getString(record, "name");
    const path = getString(record, "path");
    const branch = getString(record, "branch");
    const agents = asArray(record?.agents);
    const services = asArray(record?.services);
    const childMatched = [...agents, ...services].some((child) => {
      const childRecord = asObject(child);
      return (
        matchesString(getString(childRecord, "id"), target) ||
        matchesString(getString(childRecord, "backendSessionId"), target)
      );
    });
    const matched =
      childMatched || matchesString(name, target) || matchesString(path, target) || matchesString(branch, target);
    if (matched) {
      addMatch(matches, seen, {
        canonicalKey: worktreeCanonical(path, name),
        kind: "worktree",
        source: "worktreeGraveyard",
        worktreePath: path,
        worktreeName: name,
        raw: entry,
      });
    }
    return matched;
  });
  return { status: "found", path: source.path, value: { entries } };
}

function filterNotifications(
  source: SourceResult<RuntimeExchange>,
  target: string,
  matches: TargetMatch[],
  seen: Set<string>,
): SourceResult<{ notifications: unknown[] }> {
  if (source.status !== "found") return { ...source, value: undefined };
  const exchange = source.value;
  if (!exchange) return { ...source, value: { notifications: [] } };
  const messagesByThread = new Map(exchange.messages.map((message) => [message.threadId, message] as const));
  const notifications = exchange.threads.filter((entry) => {
    if (!entry.tags?.includes("notification")) return false;
    const message = messagesByThread.get(entry.id);
    const sessionId =
      typeof message?.metadata?.notificationSessionId === "string" ? message.metadata.notificationSessionId : undefined;
    const targetKey =
      typeof message?.metadata?.notificationTargetKey === "string" ? message.metadata.notificationTargetKey : undefined;
    const id =
      typeof message?.metadata?.notificationRecordId === "string" ? message.metadata.notificationRecordId : entry.id;
    const matched = matchesString(sessionId, target) || matchesString(targetKey, target) || matchesString(id, target);
    if (matched) {
      addMatch(matches, seen, {
        canonicalKey: `notification:${id ?? targetKey ?? sessionId ?? "unknown"}`,
        kind: "notification",
        source: "runtimeExchange",
        id,
        raw: entry,
      });
    }
    return matched;
  });
  return { status: "found", path: source.path, value: { notifications } };
}

function filterOperationFailures(
  source: SourceResult<unknown>,
  target: string,
  matches: TargetMatch[],
  seen: Set<string>,
): SourceResult<{ failures: unknown[] }> {
  if (source.status !== "found") return { ...source, value: undefined };
  const failures = asArray(asObject(source.value)?.failures).filter((entry) => {
    const record = asObject(entry);
    const id = getString(record, "id");
    const targetId = getString(record, "targetId");
    const worktreePath = getString(record, "worktreePath");
    const worktreeName = getString(record, "worktreeName");
    const matched =
      matchesString(id, target) ||
      matchesString(targetId, target) ||
      matchesString(worktreePath, target) ||
      matchesString(worktreeName, target);
    if (matched) {
      addMatch(matches, seen, {
        canonicalKey: `operation-failure:${id ?? targetId ?? worktreePath ?? "unknown"}`,
        kind: "operation-failure",
        source: "operationFailures",
        id,
        worktreePath,
        worktreeName,
        raw: entry,
      });
    }
    return matched;
  });
  return { status: "found", path: source.path, value: { failures } };
}

function filterInstances(
  paths: ReadOnlyProjectPaths,
  target: string,
  matches: TargetMatch[],
  seen: Set<string>,
): SourceResult<{ files: Array<SourceResult<{ instances: unknown[] }>> }> {
  const uniquePaths = [...new Set([paths.instancesPath, paths.localInstancesPath])];
  const files = uniquePaths.map((path) => {
    const source = readJson(path);
    if (source.status !== "found") return { ...source, value: undefined } as SourceResult<{ instances: unknown[] }>;
    const instances = asArray(source.value).filter((instance) => {
      const instanceRecord = asObject(instance);
      const sessions = asArray(instanceRecord?.sessions);
      return sessions.some((session) => {
        const sessionRecord = asObject(session);
        const id = getString(sessionRecord, "id");
        const backendSessionId = getString(sessionRecord, "backendSessionId");
        const worktreePath = getString(sessionRecord, "worktreePath");
        const matched =
          matchesString(id, target) || matchesString(backendSessionId, target) || matchesString(worktreePath, target);
        if (matched) {
          addMatch(matches, seen, {
            canonicalKey: sessionCanonical(id, backendSessionId),
            kind: "instance-session",
            source: `instances:${path}`,
            id,
            backendSessionId,
            worktreePath,
            raw: instance,
          });
        }
        return matched;
      });
    });
    return { status: "found", path, value: { instances } } as SourceResult<{ instances: unknown[] }>;
  });
  return { status: "found", value: { files } };
}

function resolveStatus(matches: TargetMatch[]): { status: TargetResolutionStatus; entityCount: number } {
  const canonicalKeys = new Set(matches.map((match) => match.canonicalKey));
  if (canonicalKeys.size === 0) return { status: "missing", entityCount: 0 };
  if (canonicalKeys.size === 1) return { status: "matched", entityCount: 1 };
  return { status: "ambiguous", entityCount: canonicalKeys.size };
}

export function buildDebugStateReport(options: BuildDebugStateReportOptions): DebugStateReport {
  const cwd = options.cwd ?? process.cwd();
  const paths = options.paths ?? getReadOnlyProjectPathsFor(cwd);
  const matches: TargetMatch[] = [];
  const seen = new Set<string>();
  const target = options.target;

  const savedState = filterSavedState(readJson(paths.statePath), target, matches, seen);
  const rawRuntimeTopology = readRuntimeTopology(paths.runtimeTopologyPath);
  const rawRuntimeExchange = readRuntimeExchange(paths.runtimeExchangePath);
  const runtimeTopology = filterRuntimeTopology(rawRuntimeTopology, target, matches, seen);
  const metadata = filterMetadata(readJson(paths.metadataPath), target, matches, seen);
  const tmux = filterTmux(options.tmuxWindows, paths, target, matches, seen);
  const gitWorktrees = filterGitWorktrees(options.worktrees, paths, target, matches, seen);
  const graveyard = filterGraveyard(runtimeTopology, target, matches, seen);
  const worktreeGraveyard = filterWorktreeGraveyard(
    rawRuntimeTopology.status === "found"
      ? { status: "found", path: rawRuntimeTopology.path, value: rawRuntimeTopology.value?.worktreeGraveyard ?? [] }
      : rawRuntimeTopology,
    target,
    matches,
    seen,
  );
  const notifications = filterNotifications(rawRuntimeExchange, target, matches, seen);
  const operationFailures = filterOperationFailures(
    readJson(paths.dashboardOperationFailuresPath),
    target,
    matches,
    seen,
  );
  const instances = filterInstances(paths, target, matches, seen);
  const resolution = resolveStatus(matches);

  return {
    version: 1,
    target,
    project: {
      repoRoot: paths.repoRoot,
      projectId: paths.projectId,
      projectStateDir: paths.projectStateDir,
      localAimuxDir: paths.localAimuxDir,
    },
    targetResolution: {
      ...resolution,
      matches,
    },
    sources: {
      savedState,
      runtimeTopology,
      metadata,
      tmux,
      gitWorktrees,
      graveyard,
      worktreeGraveyard,
      notifications,
      operationFailures,
      instances,
      runtimeRows: sourceUnavailable("standalone debug-state does not attach to the live project runtime"),
      pendingActions: sourceUnavailable("pending actions are in-memory dashboard state"),
      dashboardSnapshot: sourceUnavailable("dashboard snapshot requires project-service/dashboard runtime"),
    },
  };
}

export function renderDebugStateReport(report: DebugStateReport): string {
  return JSON.stringify(report, null, 2);
}
