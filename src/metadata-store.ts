import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getProjectStateDir, getProjectStateDirFor } from "./paths.js";
import type { AgentActivityState, AgentAttentionState, AgentEvent, SessionDerivedState } from "./agent-events.js";

export type MetadataTone = "neutral" | "info" | "success" | "warn" | "error";

export interface SessionStatusMetadata {
  text: string;
  tone?: MetadataTone;
}

export interface SessionProgressMetadata {
  current: number;
  total: number;
  label?: string;
}

export interface SessionLogEntry {
  message: string;
  source?: string;
  tone?: MetadataTone;
  ts: string;
}

export interface SessionPrMetadata {
  number?: number;
  title?: string;
  url?: string;
  headRef?: string;
  baseRef?: string;
}

export interface SessionRepoMetadata {
  owner?: string;
  name?: string;
  remote?: string;
}

export interface SessionContextMetadata {
  cwd?: string;
  worktreePath?: string;
  worktreeName?: string;
  branch?: string;
  pr?: SessionPrMetadata;
  repo?: SessionRepoMetadata;
}

export interface SessionServiceMetadata {
  label?: string;
  url?: string;
  port?: number;
}

export interface SessionDerivedMetadata extends SessionDerivedState {
  activity?: AgentActivityState;
  attention?: AgentAttentionState;
  threadId?: string;
  threadName?: string;
  lastEvent?: AgentEvent;
  events?: AgentEvent[];
  services?: SessionServiceMetadata[];
}

export interface SessionMetadata {
  status?: SessionStatusMetadata;
  progress?: SessionProgressMetadata;
  logs?: SessionLogEntry[];
  context?: SessionContextMetadata;
  derived?: SessionDerivedMetadata;
  updatedAt: string;
}

export interface MetadataState {
  version: 1;
  sessions: Record<string, SessionMetadata>;
}

export interface MetadataApiEndpoint {
  host: string;
  port: number;
  pid: number;
  updatedAt: string;
}

interface HostMetadataEndpoint {
  metadataPort?: number;
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function metadataPathFor(projectRoot?: string): string {
  return join(projectRoot ? getProjectStateDirFor(projectRoot) : getProjectStateDir(), "metadata.json");
}

function endpointPathFor(projectRoot?: string): string {
  return join(projectRoot ? getProjectStateDirFor(projectRoot) : getProjectStateDir(), "metadata-api.json");
}

function loadJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function saveJson(path: string, value: unknown): void {
  ensureParent(path);
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmpPath, path);
}

export function loadMetadataState(projectRoot?: string): MetadataState {
  return loadJson<MetadataState>(metadataPathFor(projectRoot), { version: 1, sessions: {} });
}

export function saveMetadataState(state: MetadataState, projectRoot?: string): void {
  saveJson(metadataPathFor(projectRoot), state);
}

export function updateSessionMetadata(
  sessionId: string,
  updater: (current: SessionMetadata) => SessionMetadata,
  projectRoot?: string,
): MetadataState {
  const state = loadMetadataState(projectRoot);
  const current = state.sessions[sessionId] ?? { updatedAt: new Date().toISOString() };
  state.sessions[sessionId] = {
    ...updater(current),
    updatedAt: new Date().toISOString(),
  };
  saveMetadataState(state, projectRoot);
  return state;
}

export function clearSessionLogs(sessionId: string, projectRoot?: string): MetadataState {
  return updateSessionMetadata(
    sessionId,
    (current) => {
      const next = { ...current };
      delete next.logs;
      return next;
    },
    projectRoot,
  );
}

export function loadMetadataEndpoint(projectRoot?: string): MetadataApiEndpoint | null {
  return loadJson<MetadataApiEndpoint | null>(endpointPathFor(projectRoot), null);
}

export function resolveProjectServiceEndpoint(projectRoot?: string): { host: string; port: number } | null {
  const metadataEndpoint = loadMetadataEndpoint(projectRoot);
  if (metadataEndpoint) {
    return {
      host: metadataEndpoint.host,
      port: metadataEndpoint.port,
    };
  }
  const hostPath = join(projectRoot ? getProjectStateDirFor(projectRoot) : getProjectStateDir(), "host.json");
  const hostState = loadJson<HostMetadataEndpoint | null>(hostPath, null);
  if (!hostState?.metadataPort || !Number.isFinite(hostState.metadataPort)) {
    return null;
  }
  return {
    host: "127.0.0.1",
    port: hostState.metadataPort,
  };
}

export function saveMetadataEndpoint(endpoint: MetadataApiEndpoint, projectRoot?: string): void {
  saveJson(endpointPathFor(projectRoot), endpoint);
}

export function removeMetadataEndpoint(projectRoot?: string): void {
  try {
    writeFileSync(endpointPathFor(projectRoot), "");
  } catch {}
}
