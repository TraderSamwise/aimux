import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { quarantineCorruptFile, writeJsonAtomic } from "../atomic-write.js";
import { getProjectStateDir, withProjectPaths } from "../paths.js";

const WRITER_INSTANCE_ID = `${process.pid}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;

export interface AgentRestoreSession {
  id: string;
  tool?: string;
  command?: string;
  label?: string;
  worktreePath?: string;
}

export interface LastOnlineAgentsSnapshot {
  version: 1;
  id: string;
  writerInstanceId: string;
  createdAt: string;
  updatedAt: string;
  sessionIds: string[];
  sessions: AgentRestoreSession[];
}

export interface AgentRestoreOffer {
  version: 1;
  id: string;
  snapshotId: string;
  snapshotUpdatedAt: string;
  source?: "last-online" | "restorable-inventory";
  createdAt: string;
  updatedAt: string;
  sessionIds: string[];
  sessions: AgentRestoreSession[];
}

interface RestoreOfferAck {
  version: 1;
  snapshotId: string;
  acknowledgedAt: string;
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
  return {
    id: record.id,
    tool: optional("tool"),
    command: optional("command"),
    label: optional("label"),
    worktreePath: optional("worktreePath"),
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

export function agentRestoreSessionKey(sessions: AgentRestoreSession[]): string {
  return JSON.stringify(
    sessions.map((session) => [
      session.id,
      session.tool ?? "",
      session.command ?? "",
      session.label ?? "",
      session.worktreePath ?? "",
    ]),
  );
}

function inventorySnapshotId(sessions: AgentRestoreSession[]): string {
  return `inventory-${createHash("sha256").update(agentRestoreSessionKey(sessions)).digest("hex").slice(0, 16)}`;
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
      session.worktreePath === other.worktreePath
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
  };
}

function normalizeOffer(value: unknown): AgentRestoreOffer | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
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
    source: record.source === "restorable-inventory" ? "restorable-inventory" : "last-online",
    createdAt: typeof record.createdAt === "string" && record.createdAt.trim() ? record.createdAt : now,
    updatedAt: typeof record.updatedAt === "string" && record.updatedAt.trim() ? record.updatedAt : now,
    sessionIds: sessions.map((session) => session.id),
    sessions,
  };
}

function normalizeAck(value: unknown): RestoreOfferAck | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.snapshotId !== "string" || !record.snapshotId.trim()) return null;
  return {
    version: 1,
    snapshotId: record.snapshotId,
    acknowledgedAt:
      typeof record.acknowledgedAt === "string" && record.acknowledgedAt.trim()
        ? record.acknowledgedAt
        : new Date().toISOString(),
  };
}

export function readAgentRestoreOffer(projectRoot?: string): AgentRestoreOffer | null {
  const read = () => readJsonFile(offerPath(), normalizeOffer);
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
      rmSync(lastOnlinePath(), { force: true });
      rmSync(offerPath(), { force: true });
      rmSync(ackPath(), { force: true });
      return null;
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
    };
    writeJsonAtomic(lastOnlinePath(), snapshot);
    return snapshot;
  };
  return input.projectRoot ? withProjectPaths(input.projectRoot, write) : write();
}

export function deriveAgentRestoreOffer(
  liveSessionIds: Iterable<string>,
  input: { projectRoot?: string; now?: string } = {},
): AgentRestoreOffer | null {
  const derive = () => {
    const existing = readAgentRestoreOffer();
    const snapshot = readLastOnlineAgentsSnapshot();
    if (
      existing &&
      (!snapshot || snapshot.id === existing.snapshotId || snapshot.writerInstanceId === WRITER_INSTANCE_ID)
    ) {
      return existing;
    }
    if (!snapshot || snapshot.writerInstanceId === WRITER_INSTANCE_ID) return null;

    const ack = readJsonFile(ackPath(), normalizeAck);
    if (ack?.snapshotId === snapshot.id) {
      rmSync(offerPath(), { force: true });
      return null;
    }

    const liveIds = new Set(liveSessionIds);
    const sessions = snapshot.sessions.filter((session) => !liveIds.has(session.id));
    if (sessions.length === 0) {
      rmSync(offerPath(), { force: true });
      return null;
    }

    const now = input.now ?? new Date().toISOString();
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
    };
    writeJsonAtomic(offerPath(), offer);
    return offer;
  };
  return input.projectRoot ? withProjectPaths(input.projectRoot, derive) : derive();
}

export function deriveAgentRestoreOfferFromRestorableInventory(
  liveSessionIds: Iterable<string>,
  candidateSessions: AgentRestoreSession[],
  input: { projectRoot?: string; now?: string } = {},
): AgentRestoreOffer | null {
  const derive = () => {
    const existing = readAgentRestoreOffer();
    if (existing) return existing;

    const liveIds = new Set(liveSessionIds);
    const sessions = normalizeSessions(candidateSessions).filter((session) => !liveIds.has(session.id));
    if (sessions.length === 0) {
      rmSync(offerPath(), { force: true });
      return null;
    }

    const snapshotId = inventorySnapshotId(sessions);
    const ack = readJsonFile(ackPath(), normalizeAck);
    if (ack?.snapshotId === snapshotId) {
      rmSync(offerPath(), { force: true });
      return null;
    }

    const now = input.now ?? new Date().toISOString();
    const offer: AgentRestoreOffer = {
      version: 1,
      id: `restore-${snapshotId}`,
      snapshotId,
      snapshotUpdatedAt: now,
      source: "restorable-inventory",
      createdAt: now,
      updatedAt: now,
      sessionIds: sessions.map((session) => session.id),
      sessions,
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
        acknowledgedAt: new Date().toISOString(),
      } satisfies RestoreOfferAck);
    }
    rmSync(offerPath(), { force: true });
  };
  return projectRoot ? withProjectPaths(projectRoot, acknowledge) : acknowledge();
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
    };
    writeJsonAtomic(offerPath(), updated);
    return updated;
  };
  return projectRoot ? withProjectPaths(projectRoot, remove) : remove();
}
