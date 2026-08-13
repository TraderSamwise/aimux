import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  AgentActivityState,
  AgentAttentionState,
  AgentEvent,
  MetadataTone,
  SessionDerivedState,
} from "./agent-events-contract.js";
import { quarantineCorruptFile, writeJsonAtomic, writeTextAtomic } from "./atomic-write.js";
import { getProjectStateDir, getProjectStateDirById, getProjectStateDirFor } from "./paths.js";
export type { MetadataTone } from "./agent-events-contract.js";

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
  transcriptPath?: string;
  pr?: SessionPrMetadata;
  repo?: SessionRepoMetadata;
}

export interface SessionServiceMetadata {
  label?: string;
  url?: string;
  port?: number;
}

export interface SessionStatuslineSegment {
  id?: string;
  text: string;
  tone?: MetadataTone;
  /**
   * When this segment stops being true, ISO-8601. Absent means indefinitely.
   *
   * A plugin does not need one: the runtime knows when a plugin stops and
   * withdraws what it owned. A publisher OUTSIDE this process has no such
   * lifecycle — it can be killed, uninstalled, or simply stop running — and a
   * rail that goes on asserting a fact nobody is maintaining is worse than an
   * empty one.
   *
   * Applied when the state is READ, so there is no sweeper to fall behind and
   * nothing to schedule. Every reader of the store sees an expired segment as
   * gone, immediately and exactly.
   *
   * A bar that has already been drawn is the exception, and worth being plain
   * about: the tmux statusline runs at `status-interval 0` and is rewritten
   * from a snapshot when something changes, so an expiry that is the only
   * thing to have happened leaves the old text on screen until the next
   * change. Expiry is exact for anything that asks and best-effort for
   * anything already painted — which is the right trade for a publisher that
   * republishes on an interval, and the reason this is a TTL rather than a
   * promise.
   */
  expiresAt?: string;
  /**
   * Anything the publisher wants its own reader to have, carried verbatim.
   *
   * Never parsed here, and deliberately untyped: this layer transports
   * segments and has no opinion about what a segment is about. `text` remains
   * the answer for anything that can only render a line — a client that had to
   * recover structure by parsing prose would be a client that breaks the first
   * time the wording changes.
   */
  data?: unknown;
}

export interface SessionStatuslineMetadata {
  top?: SessionStatuslineSegment[];
  bottom?: SessionStatuslineSegment[];
}

export interface SessionDerivedMetadata extends SessionDerivedState {
  activity?: AgentActivityState;
  attention?: AgentAttentionState;
  threadId?: string;
  threadName?: string;
  lastEvent?: AgentEvent;
  events?: AgentEvent[];
  services?: SessionServiceMetadata[];
  shellCommand?: string;
  shellCommandState?: "running" | "prompt";
}

export type SessionLoopSource = "human" | "dashboard" | "overseer" | "agent" | "task" | "system" | "unknown";

export type SessionLoopAction = "add" | "remove" | "done" | "block";

export interface SessionLoopProvenance {
  source?: SessionLoopSource;
  updatedBy?: string;
  updatedBySessionId?: string;
  updatedByRole?: string;
  reason?: string;
}

export interface SessionLoopActionMetadata extends SessionLoopProvenance {
  action: SessionLoopAction;
  at: string;
  goal?: string;
}

export interface SessionLoopMetadata extends SessionLoopProvenance {
  active: boolean;
  goal?: string;
  since: string;
}

export interface SessionMetadata {
  status?: SessionStatusMetadata;
  progress?: SessionProgressMetadata;
  logs?: SessionLogEntry[];
  context?: SessionContextMetadata;
  statusline?: SessionStatuslineMetadata;
  derived?: SessionDerivedMetadata;
  /** This session is the project overseer (top-down orchestrator). */
  overseer?: boolean;
  /** This session is in a managed loop the overseer keeps running. */
  loop?: SessionLoopMetadata;
  /** Last explicit loop membership mutation, retained after loop removal. */
  loopLastAction?: SessionLoopActionMetadata;
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

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function metadataPathFor(projectRoot?: string): string {
  return join(projectRoot ? getProjectStateDirFor(projectRoot) : getProjectStateDir(), "metadata.json");
}

function endpointPathFor(projectRoot?: string): string {
  return join(projectRoot ? getProjectStateDirFor(projectRoot) : getProjectStateDir(), "metadata-api.json");
}

function endpointPathForProjectId(projectId: string): string {
  return join(getProjectStateDirById(projectId), "metadata-api.json");
}

function endpointTextPathFor(projectRoot?: string): string {
  return join(projectRoot ? getProjectStateDirFor(projectRoot) : getProjectStateDir(), "metadata-api.txt");
}

function loadJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    quarantineCorruptFile(path);
    return fallback;
  }
}

function saveJson(path: string, value: unknown): void {
  writeJsonAtomic(path, value);
}

function scrubProjectionAuthorityFields(state: MetadataState): MetadataState {
  const sessions = (state as { sessions?: unknown }).sessions;
  if (!sessions || typeof sessions !== "object") return state;
  for (const session of Object.values(sessions as Record<string, unknown>)) {
    if (session && typeof session === "object") {
      delete (session as { backendSessionId?: unknown }).backendSessionId;
      delete (session as { label?: unknown }).label;
    }
  }
  return state;
}

function stableMetadataPayload(session: SessionMetadata | undefined): string {
  if (!session || typeof session !== "object") return "";
  const { updatedAt: _updatedAt, ...payload } = session;
  return JSON.stringify(payload);
}

/**
 * Segments whose moment has passed are not returned.
 *
 * On read rather than on a timer: nothing to schedule, nothing to fall behind,
 * and no window in which a reader and a sweeper disagree. The next write of
 * this session's metadata persists the removal as a side effect, which is a
 * tidy-up rather than the mechanism.
 */
function dropExpiredSegments(state: MetadataState, now: number): MetadataState {
  // Every level is type-checked before it is walked, the same way
  // `scrubProjectionAuthorityFields` above does. This runs inside
  // `loadMetadataState`, which is the read path for the whole daemon — a throw
  // here is not a bad segment, it is a store nobody can open again. The file
  // is written by other processes and only has to be valid JSON to get this
  // far, so `{"sessions":{"a":{"statusline":{"top":"x"}}}}` is a reachable
  // input rather than a hypothetical one.
  for (const session of Object.values(state.sessions ?? {})) {
    if (!session || typeof session !== "object") continue;
    const statusline = (session as SessionMetadata).statusline;
    if (!statusline || typeof statusline !== "object") continue;
    for (const line of ["top", "bottom"] as const) {
      const segments = statusline[line];
      if (!Array.isArray(segments)) continue;
      const live = segments.filter((segment) => {
        if (!segment || typeof segment !== "object") return true;
        if (!segment.expiresAt) return true;
        const at = Date.parse(segment.expiresAt);
        // An unparseable date is not an expiry claim. Dropping the segment
        // would let one malformed publisher silently empty a rail.
        return Number.isNaN(at) || at > now;
      });
      if (live.length === segments.length) continue;
      if (live.length > 0) statusline[line] = live;
      else delete statusline[line];
    }
    if (!statusline.top?.length && !statusline.bottom?.length) delete (session as SessionMetadata).statusline;
  }
  return state;
}

export function loadMetadataState(projectRoot?: string): MetadataState {
  const state = loadJson<MetadataState>(metadataPathFor(projectRoot), { version: 1, sessions: {} });
  return dropExpiredSegments(scrubProjectionAuthorityFields(state), Date.now());
}

/**
 * The largest a segment's opaque payload may be, serialized.
 *
 * Every segment is copied wholesale into the statusline snapshot on each
 * redraw, so an unbounded payload is not one large file but a large file
 * rewritten constantly. Four kilobytes is a generous structured summary and
 * nowhere near a document.
 */
export const MAX_SEGMENT_DATA_BYTES = 4096;

/**
 * The longest a publisher may claim a segment stays true.
 *
 * A day. Past that the claim is not a TTL, it is an assertion that something
 * will still be the case tomorrow — which is exactly what the field exists to
 * stop an absent publisher making.
 */
export const MAX_SEGMENT_TTL_SECONDS = 86_400;

/** Why a segment was refused, or null if it is fine. */
export function segmentRejection(segment: SessionStatuslineSegment): string | null {
  if (typeof segment.id !== "string" || !segment.id) return "a segment needs an id to be replaceable";
  if (typeof segment.text !== "string") return "a segment needs text";
  if (segment.expiresAt && Number.isNaN(Date.parse(segment.expiresAt))) return "expiresAt is not a date";
  if (segment.data !== undefined) {
    const size = Buffer.byteLength(JSON.stringify(segment.data) ?? "");
    if (size > MAX_SEGMENT_DATA_BYTES) return `data is ${size} bytes; the limit is ${MAX_SEGMENT_DATA_BYTES}`;
  }
  return null;
}

/**
 * Put a segment on a rail, replacing any with the same id.
 *
 * Here rather than in the plugin runtime because there are now two callers —
 * a plugin in this process and an HTTP publisher outside it — and two copies
 * of "replace by id, then tidy up the empties" is two copies that drift.
 */
export function putStatuslineSegment(
  sessionId: string,
  line: "top" | "bottom",
  segment: SessionStatuslineSegment,
  projectRoot?: string,
): MetadataState {
  return updateSessionMetadata(
    sessionId,
    (existing) => ({
      ...existing,
      statusline: {
        ...(existing.statusline ?? {}),
        [line]: [...(existing.statusline?.[line] ?? []).filter((entry) => entry.id !== segment.id), segment],
      },
    }),
    projectRoot,
  );
}

/** Take one off, from a named rail or from both. */
export function dropStatuslineSegment(
  sessionId: string,
  id: string,
  line?: "top" | "bottom",
  projectRoot?: string,
): MetadataState {
  return updateSessionMetadata(
    sessionId,
    (existing) => {
      const next = { ...existing };
      if (!next.statusline) return next;
      next.statusline = { ...next.statusline };
      for (const currentLine of line ? [line] : (["top", "bottom"] as const)) {
        const filtered = (next.statusline[currentLine] ?? []).filter((entry) => entry.id !== id);
        if (filtered.length > 0) next.statusline[currentLine] = filtered;
        else delete next.statusline[currentLine];
      }
      if (!next.statusline.top?.length && !next.statusline.bottom?.length) delete next.statusline;
      return next;
    },
    projectRoot,
  );
}

export function saveMetadataState(state: MetadataState, projectRoot?: string): void {
  saveJson(metadataPathFor(projectRoot), scrubProjectionAuthorityFields(state));
}

export function updateSessionMetadata(
  sessionId: string,
  updater: (current: SessionMetadata) => SessionMetadata,
  projectRoot?: string,
): MetadataState {
  const state = loadMetadataState(projectRoot);
  const current = state.sessions[sessionId] ?? { updatedAt: new Date().toISOString() };
  const next = updater(current);
  if (stableMetadataPayload(current) === stableMetadataPayload(next)) {
    return state;
  }
  state.sessions[sessionId] = {
    ...next,
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

export function clearSessionTranscriptPath(sessionId: string, projectRoot?: string): MetadataState {
  const state = loadMetadataState(projectRoot);
  const current = state.sessions[sessionId];
  if (!current?.context?.transcriptPath) return state;
  const context = { ...current.context };
  delete context.transcriptPath;
  state.sessions[sessionId] = {
    ...current,
    context,
    updatedAt: new Date().toISOString(),
  };
  saveMetadataState(state, projectRoot);
  return state;
}

export function setSessionLoop(sessionId: string, loop: SessionLoopMetadata, projectRoot?: string): MetadataState {
  const loopLastAction: SessionLoopActionMetadata = {
    action: "add",
    at: loop.since,
    goal: loop.goal,
    source: loop.source,
    updatedBy: loop.updatedBy,
    updatedBySessionId: loop.updatedBySessionId,
    updatedByRole: loop.updatedByRole,
    reason: loop.reason,
  };
  return updateSessionMetadata(sessionId, (current) => ({ ...current, loop, loopLastAction }), projectRoot);
}

export function clearSessionLoop(
  sessionId: string,
  projectRoot?: string,
  loopLastAction?: SessionLoopActionMetadata,
): MetadataState {
  return updateSessionMetadata(
    sessionId,
    (current) => {
      const next = { ...current };
      delete next.loop;
      if (loopLastAction) next.loopLastAction = loopLastAction;
      return next;
    },
    projectRoot,
  );
}

export function setSessionOverseer(sessionId: string, value: boolean, projectRoot?: string): MetadataState {
  if (!value) {
    return updateSessionMetadata(
      sessionId,
      (current) => {
        const next = { ...current };
        delete next.overseer;
        return next;
      },
      projectRoot,
    );
  }
  // Enforce a single overseer per project: clear any stale flags before setting this one,
  // otherwise a dead overseer's flag lingers and "create or enter" keeps spawning new ones.
  const state = loadMetadataState(projectRoot);
  const now = new Date().toISOString();
  for (const [id, session] of Object.entries(state.sessions)) {
    if (session?.overseer && id !== sessionId) {
      delete session.overseer;
      session.updatedAt = now;
    }
  }
  const current = state.sessions[sessionId] ?? { updatedAt: now };
  state.sessions[sessionId] = { ...current, overseer: true, updatedAt: now };
  saveMetadataState(state, projectRoot);
  return state;
}

export function findOverseerSessionId(state: MetadataState): string | undefined {
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    if (session.overseer) return sessionId;
  }
  return undefined;
}

export function loadMetadataEndpoint(projectRoot?: string): MetadataApiEndpoint | null {
  return loadJson<MetadataApiEndpoint | null>(endpointPathFor(projectRoot), null);
}

export function loadMetadataEndpointByProjectId(projectId: string): MetadataApiEndpoint | null {
  return loadJson<MetadataApiEndpoint | null>(endpointPathForProjectId(projectId), null);
}

export function resolveProjectServiceEndpoint(projectRoot?: string): { host: string; port: number } | null {
  const metadataEndpoint = loadMetadataEndpoint(projectRoot);
  if (!metadataEndpoint) return null;
  return {
    host: metadataEndpoint.host,
    port: metadataEndpoint.port,
  };
}

export function saveMetadataEndpoint(endpoint: MetadataApiEndpoint, projectRoot?: string): void {
  saveJson(endpointPathFor(projectRoot), endpoint);
  const textPath = endpointTextPathFor(projectRoot);
  ensureParent(textPath);
  writeTextAtomic(textPath, `http://${endpoint.host}:${endpoint.port}\n`);
}

export function removeMetadataEndpoint(projectRoot?: string): void {
  try {
    rmSync(endpointPathFor(projectRoot), { force: true });
  } catch {}
  try {
    rmSync(endpointTextPathFor(projectRoot), { force: true });
  } catch {}
  try {
    rmSync(join(projectRoot ? getProjectStateDirFor(projectRoot) : getProjectStateDir(), "host.json"), { force: true });
  } catch {}
}
