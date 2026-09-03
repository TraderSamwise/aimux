import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { quarantineCorruptFile, writeJsonAtomic } from "../atomic-write.js";
import {
  getGlobalAimuxDir,
  getProjectIdFor,
  getProjectStateDir,
  getRepoRoot,
  listProjects,
  withProjectPaths,
} from "../paths.js";
import type { SessionTeamMetadata } from "../team.js";

const WRITER_INSTANCE_ID = `${process.pid}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

export interface AgentRestoreSession {
  id: string;
  tool?: string;
  command?: string;
  label?: string;
  worktreePath?: string;
  team?: SessionTeamMetadata;
  overseer?: boolean;
  scribe?: boolean;
  projectControl?: boolean;
}

export interface AgentRestoreWorktreeGroup {
  path?: string;
  name: string;
  count: number;
}

export interface LastOnlineAgentsSnapshot {
  version: 1;
  id: string;
  writerInstanceId: string;
  createdAt: string;
  updatedAt: string;
  sessionIds: string[];
  sessions: AgentRestoreSession[];
  worktreeGroups?: AgentRestoreWorktreeGroup[];
}

export interface AgentRestoreOffer {
  version: 1;
  id: string;
  snapshotId: string;
  snapshotUpdatedAt: string;
  source?: "last-online";
  createdAt: string;
  updatedAt: string;
  sessionIds: string[];
  sessions: AgentRestoreSession[];
  worktreeGroups?: AgentRestoreWorktreeGroup[];
}

interface RestoreOfferAck {
  version: 1;
  snapshotId: string;
  source?: "last-online";
  acknowledgedAt: string;
}

export interface AgentRestorePromptGate {
  version: 1;
  projectId: string;
  projectRoot: string;
  daemonBootId: string;
  snapshotId: string;
  snapshotUpdatedAt: string;
  createdAt: string;
  askedAt?: string;
}

interface AgentRestorePromptGateState {
  version: 1;
  daemonBootId: string;
  updatedAt: string;
  projects: Record<string, AgentRestorePromptGate>;
}

function lastOnlinePath(): string {
  return join(getProjectStateDir(), "last-online-agents.json");
}

function offerPath(): string {
  return join(getProjectStateDir(), "agent-restore-offer.json");
}

function ackPath(): string {
  return join(getProjectStateDir(), "agent-restore-offer-ack.json");
}

function promptGatePath(): string {
  return join(getGlobalAimuxDir(), "restore-prompt-gates.json");
}

function readJsonFile<T>(path: string, normalize: (value: unknown) => T | null): T | null {
  if (!existsSync(path)) return null;
  try {
    return normalize(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    quarantineCorruptFile(path);
    return null;
  }
}

function normalizeSession(value: unknown): AgentRestoreSession | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.trim()) return null;
  const optional = (key: string) => (typeof record[key] === "string" && record[key].trim() ? record[key] : undefined);
  const teamRecord = record.team && typeof record.team === "object" ? (record.team as Record<string, unknown>) : null;
  const team =
    typeof teamRecord?.teamId === "string" && typeof teamRecord.parentSessionId === "string"
      ? {
          teamId: teamRecord.teamId,
          parentSessionId: teamRecord.parentSessionId,
          role: typeof teamRecord.role === "string" ? teamRecord.role : undefined,
          label: typeof teamRecord.label === "string" ? teamRecord.label : undefined,
          order: typeof teamRecord.order === "number" ? teamRecord.order : undefined,
        }
      : undefined;
  return {
    id: record.id,
    tool: optional("tool"),
    command: optional("command"),
    label: optional("label"),
    worktreePath: optional("worktreePath"),
    team,
    overseer: typeof record.overseer === "boolean" ? record.overseer : undefined,
    scribe: typeof record.scribe === "boolean" ? record.scribe : undefined,
    projectControl: typeof record.projectControl === "boolean" ? record.projectControl : undefined,
  };
}

function normalizeSessions(value: unknown): AgentRestoreSession[] {
  if (!Array.isArray(value)) return [];
  const byId = new Map<string, AgentRestoreSession>();
  for (const session of value.map(normalizeSession).filter(Boolean) as AgentRestoreSession[]) {
    byId.set(session.id, session);
  }
  return [...byId.values()];
}

function worktreeGroupName(path: string | undefined): string {
  if (!path) return "Main Checkout";
  const marker = "/.aimux/worktrees/";
  const markerIndex = path.indexOf(marker);
  if (markerIndex >= 0) return path.slice(markerIndex + marker.length).split("/")[0] || path;
  return "Main Checkout";
}

function worktreeGroupKey(path: string | undefined): string {
  if (!path) return "";
  const marker = "/.aimux/worktrees/";
  const markerIndex = path.indexOf(marker);
  if (markerIndex < 0) return "";
  return path.slice(0, markerIndex + marker.length + worktreeGroupName(path).length);
}

function buildWorktreeGroups(sessions: AgentRestoreSession[]): AgentRestoreWorktreeGroup[] {
  const groups = new Map<string, AgentRestoreWorktreeGroup>();
  for (const session of sessions) {
    const key = worktreeGroupKey(session.worktreePath);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    groups.set(key, {
      path: key || undefined,
      name: worktreeGroupName(session.worktreePath),
      count: 1,
    });
  }
  return [...groups.values()].sort((left, right) => {
    if (left.name === "Main Checkout" && right.name !== "Main Checkout") return -1;
    if (left.name !== "Main Checkout" && right.name === "Main Checkout") return 1;
    return left.name.localeCompare(right.name);
  });
}

export function agentRestoreSessionKey(sessions: AgentRestoreSession[]): string {
  return JSON.stringify(
    sessions.map((session) => [
      session.id,
      session.tool ?? "",
      session.command ?? "",
      session.label ?? "",
      session.worktreePath ?? "",
      session.team?.teamId ?? "",
      session.team?.parentSessionId ?? "",
      session.team?.role ?? "",
      session.overseer === undefined ? "" : String(session.overseer),
      session.scribe === undefined ? "" : String(session.scribe),
      session.projectControl === undefined ? "" : String(session.projectControl),
    ]),
  );
}

function sameSessionIds(left: AgentRestoreSession[], right: AgentRestoreSession[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((session, index) => session.id === right[index]?.id);
}

function sameSessions(left: AgentRestoreSession[], right: AgentRestoreSession[]): boolean {
  if (!sameSessionIds(left, right)) return false;
  return left.every((session, index) => {
    const other = right[index];
    return (
      session.tool === other?.tool &&
      session.command === other.command &&
      session.label === other.label &&
      session.worktreePath === other.worktreePath &&
      session.team?.teamId === other.team?.teamId &&
      session.team?.parentSessionId === other.team?.parentSessionId &&
      session.team?.role === other.team?.role &&
      session.overseer === other.overseer &&
      session.scribe === other.scribe &&
      session.projectControl === other.projectControl
    );
  });
}

function normalizeSnapshot(value: unknown): LastOnlineAgentsSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const sessions = normalizeSessions(record.sessions);
  if (sessions.length === 0) return null;
  const now = new Date().toISOString();
  return {
    version: 1,
    id: typeof record.id === "string" && record.id.trim() ? record.id : `online-${sessions.map((s) => s.id).join("-")}`,
    writerInstanceId:
      typeof record.writerInstanceId === "string" && record.writerInstanceId.trim()
        ? record.writerInstanceId
        : "unknown",
    createdAt: typeof record.createdAt === "string" && record.createdAt.trim() ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt.trim() ? record.updatedAt : now,
    sessionIds: sessions.map((session) => session.id),
    sessions,
    worktreeGroups: buildWorktreeGroups(sessions),
  };
}

function normalizeOffer(value: unknown): AgentRestoreOffer | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.source === "restorable-inventory") return null;
  const sessions = normalizeSessions(record.sessions);
  if (sessions.length === 0) return null;
  const now = new Date().toISOString();
  const snapshotId = typeof record.snapshotId === "string" && record.snapshotId.trim() ? record.snapshotId : "unknown";
  return {
    version: 1,
    id: typeof record.id === "string" && record.id.trim() ? record.id : `restore-${snapshotId}`,
    snapshotId,
    snapshotUpdatedAt:
      typeof record.snapshotUpdatedAt === "string" && record.snapshotUpdatedAt.trim() ? record.snapshotUpdatedAt : now,
    source: "last-online",
    createdAt: typeof record.createdAt === "string" && record.createdAt.trim() ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt.trim() ? record.updatedAt : now,
    sessionIds: sessions.map((session) => session.id),
    sessions,
    worktreeGroups: buildWorktreeGroups(sessions),
  };
}

function normalizeAck(value: unknown): RestoreOfferAck | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.snapshotId !== "string" || !record.snapshotId.trim()) return null;
  return {
    version: 1,
    snapshotId: record.snapshotId,
    source: "last-online",
    acknowledgedAt:
      typeof record.acknowledgedAt === "string" && record.acknowledgedAt.trim()
        ? record.acknowledgedAt
        : new Date().toISOString(),
  };
}

function normalizePromptGate(value: unknown): AgentRestorePromptGate | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const projectId = typeof record.projectId === "string" && record.projectId.trim() ? record.projectId : "";
  const projectRoot = typeof record.projectRoot === "string" && record.projectRoot.trim() ? record.projectRoot : "";
  const daemonBootId = typeof record.daemonBootId === "string" && record.daemonBootId.trim() ? record.daemonBootId : "";
  const snapshotId = typeof record.snapshotId === "string" && record.snapshotId.trim() ? record.snapshotId : "";
  const snapshotUpdatedAt =
    typeof record.snapshotUpdatedAt === "string" && record.snapshotUpdatedAt.trim() ? record.snapshotUpdatedAt : "";
  const createdAt = typeof record.createdAt === "string" && record.createdAt.trim() ? record.createdAt : "";
  if (!projectId || !projectRoot || !daemonBootId || !snapshotId || !snapshotUpdatedAt || !createdAt) return null;
  return {
    version: 1,
    projectId,
    projectRoot,
    daemonBootId,
    snapshotId,
    snapshotUpdatedAt,
    createdAt,
    askedAt: typeof record.askedAt === "string" && record.askedAt.trim() ? record.askedAt : undefined,
  };
}

function normalizePromptGateState(value: unknown): AgentRestorePromptGateState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const daemonBootId = typeof record.daemonBootId === "string" && record.daemonBootId.trim() ? record.daemonBootId : "";
  const updatedAt = typeof record.updatedAt === "string" && record.updatedAt.trim() ? record.updatedAt : "";
  if (!daemonBootId || !updatedAt || !record.projects || typeof record.projects !== "object") return null;
  const projects: Record<string, AgentRestorePromptGate> = {};
  for (const gate of Object.values(record.projects as Record<string, unknown>)) {
    const normalized = normalizePromptGate(gate);
    if (normalized) projects[normalized.projectId] = normalized;
  }
  return {
    version: 1,
    daemonBootId,
    updatedAt,
    projects,
  };
}

function readPromptGateState(): AgentRestorePromptGateState | null {
  return readJsonFile(promptGatePath(), normalizePromptGateState);
}

function readPromptGate(projectRoot: string): AgentRestorePromptGate | null {
  const state = readPromptGateState();
  if (!state) return null;
  return state.projects[getProjectIdFor(projectRoot)] ?? null;
}

function offerHasPromptGate(offer: AgentRestoreOffer, projectRoot: string): boolean {
  const gate = readPromptGate(projectRoot);
  return Boolean(gate && gate.snapshotId === offer.snapshotId);
}

function clearOffer(): void {
  rmSync(offerPath(), { force: true });
}

function currentProjectRoot(inputRoot?: string): string {
  return inputRoot ?? getRepoRoot();
}

export function seedAgentRestorePromptGatesForDaemonBoot(input: {
  daemonBootId: string;
  projects?: { id?: string; repoRoot: string }[];
  now?: string;
}): AgentRestorePromptGateState {
  const now = input.now ?? new Date().toISOString();
  const projects: Record<string, AgentRestorePromptGate> = {};
  for (const project of input.projects ?? listProjects()) {
    const snapshot = readLastOnlineAgentsSnapshot(project.repoRoot);
    if (!snapshot) continue;
    const projectId = project.id ?? getProjectIdFor(project.repoRoot);
    projects[projectId] = {
      version: 1,
      projectId,
      projectRoot: project.repoRoot,
      daemonBootId: input.daemonBootId,
      snapshotId: snapshot.id,
      snapshotUpdatedAt: snapshot.updatedAt,
      createdAt: now,
    };
  }
  const state: AgentRestorePromptGateState = {
    version: 1,
    daemonBootId: input.daemonBootId,
    updatedAt: now,
    projects,
  };
  writeJsonAtomic(promptGatePath(), state);
  return state;
}

export function readAgentRestorePromptGate(projectRoot?: string): AgentRestorePromptGate | null {
  return readPromptGate(currentProjectRoot(projectRoot));
}

export function markAgentRestorePromptGateAsked(
  projectRoot?: string,
  input: { snapshotId?: string; now?: string } = {},
): AgentRestorePromptGate | null {
  const resolvedProjectRoot = currentProjectRoot(projectRoot);
  const state = readPromptGateState();
  if (!state) return null;
  const projectId = getProjectIdFor(resolvedProjectRoot);
  const gate = state.projects[projectId];
  if (!gate || (input.snapshotId && gate.snapshotId !== input.snapshotId)) return null;
  if (gate.askedAt) return gate;
  const askedAt = input.now ?? new Date().toISOString();
  const updated: AgentRestorePromptGate = { ...gate, askedAt };
  const nextState: AgentRestorePromptGateState = {
    ...state,
    updatedAt: askedAt,
    projects: { ...state.projects, [projectId]: updated },
  };
  writeJsonAtomic(promptGatePath(), nextState);
  return updated;
}

export function readAgentRestoreOffer(projectRoot?: string): AgentRestoreOffer | null {
  const read = () => {
    const path = offerPath();
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      if (
        parsed &&
        typeof parsed === "object" &&
        (parsed as Record<string, unknown>).source === "restorable-inventory"
      ) {
        rmSync(path, { force: true });
        return null;
      }
      return normalizeOffer(parsed);
    } catch {
      quarantineCorruptFile(path);
      return null;
    }
  };
  return projectRoot ? withProjectPaths(projectRoot, read) : read();
}

export function readDisplayableAgentRestoreOffer(projectRoot?: string): AgentRestoreOffer | null {
  const read = () => {
    const offer = readAgentRestoreOffer();
    if (!offer) return null;
    if (offerHasPromptGate(offer, currentProjectRoot(projectRoot))) return offer;
    clearOffer();
    return null;
  };
  return projectRoot ? withProjectPaths(projectRoot, read) : read();
}

export function readLastOnlineAgentsSnapshot(projectRoot?: string): LastOnlineAgentsSnapshot | null {
  const read = () => readJsonFile(lastOnlinePath(), normalizeSnapshot);
  return projectRoot ? withProjectPaths(projectRoot, read) : read();
}

export function recordLastOnlineAgents(
  sessions: AgentRestoreSession[],
  input: { projectRoot?: string; now?: string } = {},
): LastOnlineAgentsSnapshot | null {
  const write = () => {
    const normalized = normalizeSessions(sessions);
    if (normalized.length === 0) {
      return readLastOnlineAgentsSnapshot();
    }
    const now = input.now ?? new Date().toISOString();
    const existing = readLastOnlineAgentsSnapshot();
    if (existing && sameSessions(existing.sessions, normalized) && existing.writerInstanceId === WRITER_INSTANCE_ID) {
      return existing;
    }
    const reuseGeneration =
      existing && sameSessionIds(existing.sessions, normalized) && existing.writerInstanceId === WRITER_INSTANCE_ID;
    const snapshot: LastOnlineAgentsSnapshot = {
      version: 1,
      id: reuseGeneration ? existing.id : `online-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      writerInstanceId: WRITER_INSTANCE_ID,
      createdAt: reuseGeneration ? existing.createdAt : now,
      updatedAt: now,
      sessionIds: normalized.map((session) => session.id),
      sessions: normalized,
      worktreeGroups: buildWorktreeGroups(normalized),
    };
    writeJsonAtomic(lastOnlinePath(), snapshot);
    return snapshot;
  };
  return input.projectRoot ? withProjectPaths(input.projectRoot, write) : write();
}

export function removeLastOnlineAgentSessions(
  sessionIds: Iterable<string>,
  input: { projectRoot?: string; now?: string } = {},
): LastOnlineAgentsSnapshot | null {
  const remove = () => {
    const snapshot = readLastOnlineAgentsSnapshot();
    if (!snapshot) return null;
    const removed = new Set(sessionIds);
    const sessions = snapshot.sessions.filter((session) => !removed.has(session.id));
    if (sessions.length === snapshot.sessions.length) return snapshot;
    if (sessions.length === 0) {
      rmSync(lastOnlinePath(), { force: true });
      return null;
    }
    const now = input.now ?? new Date().toISOString();
    const updated: LastOnlineAgentsSnapshot = {
      ...snapshot,
      id: `online-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
      updatedAt: now,
      sessionIds: sessions.map((session) => session.id),
      sessions,
      worktreeGroups: buildWorktreeGroups(sessions),
    };
    writeJsonAtomic(lastOnlinePath(), updated);
    return updated;
  };
  return input.projectRoot ? withProjectPaths(input.projectRoot, remove) : remove();
}

export function deriveAgentRestoreOffer(
  liveSessionIds: Iterable<string>,
  input: { projectRoot?: string; now?: string } = {},
): AgentRestoreOffer | null {
  const derive = () => {
    const projectRoot = currentProjectRoot(input.projectRoot);
    const liveIds = new Set(liveSessionIds);
    const now = input.now ?? new Date().toISOString();
    const existing = readAgentRestoreOffer();
    const snapshot = readLastOnlineAgentsSnapshot();
    if (existing && offerHasPromptGate(existing, projectRoot)) {
      const sessions = existing.sessions.filter((session) => !liveIds.has(session.id));
      if (sessions.length === 0) {
        clearOffer();
        return null;
      }
      if (sessions.length === existing.sessions.length) return existing;
      const updated: AgentRestoreOffer = {
        ...existing,
        updatedAt: now,
        sessionIds: sessions.map((session) => session.id),
        sessions,
        worktreeGroups: buildWorktreeGroups(sessions),
      };
      writeJsonAtomic(offerPath(), updated);
      return updated;
    }
    if (existing && !offerHasPromptGate(existing, projectRoot)) clearOffer();
    if (!snapshot || snapshot.writerInstanceId === WRITER_INSTANCE_ID) return null;

    const gate = readPromptGate(projectRoot);
    if (!gate || gate.snapshotId !== snapshot.id || gate.askedAt) return null;

    const ack = readJsonFile(ackPath(), normalizeAck);
    if (ack?.snapshotId === snapshot.id) {
      clearOffer();
      return null;
    }

    const sessions = snapshot.sessions.filter((session) => !liveIds.has(session.id));
    if (sessions.length === 0) {
      clearOffer();
      return null;
    }

    const offer: AgentRestoreOffer = {
      version: 1,
      id: `restore-${snapshot.id}`,
      snapshotId: snapshot.id,
      snapshotUpdatedAt: snapshot.updatedAt,
      source: "last-online",
      createdAt: now,
      updatedAt: now,
      sessionIds: sessions.map((session) => session.id),
      sessions,
      worktreeGroups: buildWorktreeGroups(sessions),
    };
    writeJsonAtomic(offerPath(), offer);
    return offer;
  };
  return input.projectRoot ? withProjectPaths(input.projectRoot, derive) : derive();
}

export function acknowledgeAgentRestoreOffer(projectRoot?: string): void {
  const acknowledge = () => {
    const offer = readAgentRestoreOffer();
    if (offer) {
      writeJsonAtomic(ackPath(), {
        version: 1,
        snapshotId: offer.snapshotId,
        source: "last-online",
        acknowledgedAt: new Date().toISOString(),
      } satisfies RestoreOfferAck);
    }
    rmSync(offerPath(), { force: true });
  };
  return projectRoot ? withProjectPaths(projectRoot, acknowledge) : acknowledge();
}

export function writeAgentRestoreRetryOffer(
  baseOffer: AgentRestoreOffer,
  failedSessionIds: Iterable<string>,
  projectRoot?: string,
): AgentRestoreOffer | null {
  const write = () => {
    const failed = new Set(failedSessionIds);
    const sessions = baseOffer.sessions.filter((session) => failed.has(session.id));
    if (sessions.length === 0) return null;
    const retryOffer: AgentRestoreOffer = {
      ...baseOffer,
      updatedAt: new Date().toISOString(),
      sessionIds: sessions.map((session) => session.id),
      sessions,
      worktreeGroups: buildWorktreeGroups(sessions),
    };
    writeJsonAtomic(offerPath(), retryOffer);
    return retryOffer;
  };
  return projectRoot ? withProjectPaths(projectRoot, write) : write();
}

export function removeAgentRestoreOfferSessions(
  sessionIds: Iterable<string>,
  projectRoot?: string,
): AgentRestoreOffer | null {
  const remove = () => {
    const offer = readAgentRestoreOffer();
    if (!offer) return null;
    const removed = new Set(sessionIds);
    const sessions = offer.sessions.filter((session) => !removed.has(session.id));
    if (sessions.length === 0) {
      acknowledgeAgentRestoreOffer();
      return null;
    }
    const updated: AgentRestoreOffer = {
      ...offer,
      updatedAt: new Date().toISOString(),
      sessionIds: sessions.map((session) => session.id),
      sessions,
      worktreeGroups: buildWorktreeGroups(sessions),
    };
    writeJsonAtomic(offerPath(), updated);
    return updated;
  };
  return projectRoot ? withProjectPaths(projectRoot, remove) : remove();
}

export function reconcileAgentRestoreOfferWithRestorableSessions(
  offer: AgentRestoreOffer | null,
  restorableSessionIds: Iterable<string>,
  projectRoot?: string,
): AgentRestoreOffer | null {
  const reconcile = () => {
    if (!offer) return null;
    const restorable = new Set(restorableSessionIds);
    const sessions = offer.sessions.filter((session) => restorable.has(session.id));
    if (sessions.length === offer.sessions.length) {
      markAgentRestorePromptGateAsked(projectRoot, { snapshotId: offer.snapshotId });
      return offer;
    }
    if (sessions.length === 0) {
      acknowledgeAgentRestoreOffer();
      return null;
    }
    const updated: AgentRestoreOffer = {
      ...offer,
      updatedAt: new Date().toISOString(),
      sessionIds: sessions.map((session) => session.id),
      sessions,
      worktreeGroups: buildWorktreeGroups(sessions),
    };
    writeJsonAtomic(offerPath(), updated);
    markAgentRestorePromptGateAsked(projectRoot, { snapshotId: updated.snapshotId });
    return updated;
  };
  return projectRoot ? withProjectPaths(projectRoot, reconcile) : reconcile();
}
