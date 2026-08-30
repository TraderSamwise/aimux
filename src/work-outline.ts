import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { quarantineCorruptFile, writeJsonAtomic } from "./atomic-write.js";
import { getProjectStateDir, getProjectStateDirFor } from "./paths.js";

export type WorkOutlineStatus = "active" | "done" | "superseded" | "stale";
export type WorkOutlineSource = "agent" | "scribe" | "system" | "human";

export interface WorkOutlineEvidenceRange {
  source?: string;
  startLine?: number;
  endLine?: number;
  capturedAt?: string;
}

export interface WorkOutlineEntry {
  entryId: string;
  topicKey: string;
  title: string;
  summary: string;
  status: WorkOutlineStatus;
  source: WorkOutlineSource;
  sessionIds: string[];
  worktreePath?: string;
  evidence?: WorkOutlineEvidenceRange;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface WorkOutlineState {
  version: 1;
  entries: WorkOutlineEntry[];
}

export interface WorkOutlineUpdateInput {
  entryId?: string;
  topicKey?: string;
  title?: string;
  summary?: string;
  status?: string;
  source?: string;
  sessionId?: string;
  sessionIds?: string[];
  worktreePath?: string;
  evidence?: WorkOutlineEvidenceRange;
}

export interface WorkOutlineQuery {
  q?: string;
  sessionId?: string;
  worktreePath?: string;
  status?: WorkOutlineStatus;
  limit?: number;
}

export const WORK_OUTLINE_MAX_ENTRIES = 500;
export const WORK_OUTLINE_DEFAULT_LIMIT = 80;
export const WORK_OUTLINE_MAX_LIMIT = 200;
export const WORK_OUTLINE_TITLE_MAX_CHARS = 160;
export const WORK_OUTLINE_SUMMARY_MAX_CHARS = 1200;
export const WORK_OUTLINE_TOPIC_KEY_MAX_CHARS = 180;
export const WORK_OUTLINE_MAX_SESSION_IDS = 32;
export const WORK_OUTLINE_SESSION_ID_MAX_CHARS = 120;

function workOutlinePath(projectRoot?: string): string {
  return join(projectRoot ? getProjectStateDirFor(projectRoot) : getProjectStateDir(), "work-outline.json");
}

function emptyState(): WorkOutlineState {
  return { version: 1, entries: [] };
}

function truncateText(value: string, maxChars: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length <= maxChars ? trimmed : `${trimmed.slice(0, maxChars - 3).trimEnd()}...`;
}

function normalizeOptionalText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = truncateText(value, maxChars);
  return normalized || undefined;
}

function normalizeTopicKey(input: WorkOutlineUpdateInput): string {
  const raw = normalizeOptionalText(input.topicKey, WORK_OUTLINE_TOPIC_KEY_MAX_CHARS);
  if (raw) return raw.toLowerCase();
  const title = normalizeOptionalText(input.title, WORK_OUTLINE_TOPIC_KEY_MAX_CHARS);
  if (title) return title.toLowerCase();
  return "";
}

function normalizeStatus(value: unknown): WorkOutlineStatus {
  return value === "done" || value === "superseded" || value === "stale" ? value : "active";
}

function normalizeSource(value: unknown): WorkOutlineSource {
  return value === "scribe" || value === "system" || value === "human" ? value : "agent";
}

function normalizeSessionIds(input: WorkOutlineUpdateInput): string[] {
  const ids = new Set<string>();
  if (typeof input.sessionId === "string" && input.sessionId.trim()) {
    ids.add(truncateText(input.sessionId, WORK_OUTLINE_SESSION_ID_MAX_CHARS));
  }
  if (Array.isArray(input.sessionIds)) {
    for (const id of input.sessionIds) {
      if (typeof id === "string" && id.trim()) ids.add(truncateText(id, WORK_OUTLINE_SESSION_ID_MAX_CHARS));
    }
  }
  return [...ids].sort().slice(0, WORK_OUTLINE_MAX_SESSION_IDS);
}

function normalizeLine(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function normalizeEvidence(value: unknown): WorkOutlineEvidenceRange | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const evidence: WorkOutlineEvidenceRange = {};
  const source = normalizeOptionalText(record.source, 120);
  const capturedAt = normalizeOptionalText(record.capturedAt, 40);
  const startLine = normalizeLine(record.startLine);
  const endLine = normalizeLine(record.endLine);
  if (source) evidence.source = source;
  if (capturedAt) evidence.capturedAt = capturedAt;
  if (startLine !== undefined) evidence.startLine = startLine;
  if (endLine !== undefined) evidence.endLine = endLine;
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

function entryIdentity(topicKey: string, worktreePath?: string): string {
  return `${topicKey}\0${worktreePath ?? ""}`;
}

function generatedEntryId(topicKey: string, worktreePath?: string): string {
  const digest = createHash("sha1").update(entryIdentity(topicKey, worktreePath)).digest("hex").slice(0, 12);
  return `outline-${digest}`;
}

function normalizeState(value: unknown): WorkOutlineState {
  if (!value || typeof value !== "object") return emptyState();
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.entries)) return emptyState();
  const entries: WorkOutlineEntry[] = [];
  for (const row of record.entries) {
    if (!row || typeof row !== "object") continue;
    const entry = row as Record<string, unknown>;
    const topicKey = normalizeOptionalText(entry.topicKey, WORK_OUTLINE_TOPIC_KEY_MAX_CHARS);
    const title = normalizeOptionalText(entry.title, WORK_OUTLINE_TITLE_MAX_CHARS);
    const summary = normalizeOptionalText(entry.summary, WORK_OUTLINE_SUMMARY_MAX_CHARS);
    if (!topicKey || !title || !summary) continue;
    const sessionIds = normalizeSessionIds({
      sessionIds: Array.isArray(entry.sessionIds) ? entry.sessionIds : [],
    });
    const worktreePath = normalizeOptionalText(entry.worktreePath, 1000);
    const evidence = normalizeEvidence(entry.evidence);
    const createdAt = normalizeOptionalText(entry.createdAt, 40) ?? new Date(0).toISOString();
    const updatedAt = normalizeOptionalText(entry.updatedAt, 40) ?? createdAt;
    const lastSeenAt = normalizeOptionalText(entry.lastSeenAt, 40) ?? updatedAt;
    entries.push({
      entryId: normalizeOptionalText(entry.entryId, 80) ?? generatedEntryId(topicKey.toLowerCase(), worktreePath),
      topicKey: topicKey.toLowerCase(),
      title,
      summary,
      status: normalizeStatus(entry.status),
      source: normalizeSource(entry.source),
      sessionIds,
      ...(worktreePath ? { worktreePath } : {}),
      ...(evidence ? { evidence } : {}),
      createdAt,
      updatedAt,
      lastSeenAt,
    });
  }
  return { version: 1, entries: boundEntries(entries) };
}

function boundEntries(entries: WorkOutlineEntry[]): WorkOutlineEntry[] {
  return [...entries]
    .sort(
      (left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || left.entryId.localeCompare(right.entryId),
    )
    .slice(0, WORK_OUTLINE_MAX_ENTRIES);
}

export function readWorkOutlineState(projectRoot?: string): WorkOutlineState {
  const path = workOutlinePath(projectRoot);
  if (!existsSync(path)) return emptyState();
  try {
    return normalizeState(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    quarantineCorruptFile(path);
    return emptyState();
  }
}

function writeWorkOutlineState(state: WorkOutlineState, projectRoot?: string): void {
  writeJsonAtomic(workOutlinePath(projectRoot), { version: 1, entries: boundEntries(state.entries) });
}

export function updateWorkOutlineEntry(
  input: WorkOutlineUpdateInput,
  opts: { projectRoot?: string; now?: string } = {},
): WorkOutlineEntry {
  const now = opts.now ?? new Date().toISOString();
  const topicKey = normalizeTopicKey(input);
  const title = normalizeOptionalText(input.title, WORK_OUTLINE_TITLE_MAX_CHARS);
  const summary = normalizeOptionalText(input.summary, WORK_OUTLINE_SUMMARY_MAX_CHARS);
  if (!topicKey) throw new Error("topicKey or title is required");
  if (!title) throw new Error("title is required");
  if (!summary) throw new Error("summary is required");

  const state = readWorkOutlineState(opts.projectRoot);
  const worktreePath = normalizeOptionalText(input.worktreePath, 1000);
  const evidence = normalizeEvidence(input.evidence);
  const requestedEntryId = normalizeOptionalText(input.entryId, 80);
  const existingIndex = state.entries.findIndex((entry) =>
    requestedEntryId
      ? entry.entryId === requestedEntryId
      : entryIdentity(entry.topicKey, entry.worktreePath) === entryIdentity(topicKey, worktreePath),
  );
  const existing = existingIndex >= 0 ? state.entries[existingIndex] : undefined;
  const sessionIds = normalizeSessionIds({
    sessionIds: [...(existing?.sessionIds ?? []), ...normalizeSessionIds(input)],
  });
  const next: WorkOutlineEntry = {
    entryId: existing?.entryId ?? requestedEntryId ?? generatedEntryId(topicKey, worktreePath),
    topicKey,
    title,
    summary,
    status: normalizeStatus(input.status),
    source: normalizeSource(input.source),
    sessionIds,
    ...(worktreePath ? { worktreePath } : {}),
    ...(evidence ? { evidence } : existing?.evidence ? { evidence: existing.evidence } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastSeenAt: now,
  };
  if (existingIndex >= 0) state.entries[existingIndex] = next;
  else state.entries.push(next);
  writeWorkOutlineState(state, opts.projectRoot);
  return next;
}

export function listWorkOutlineEntries(query: WorkOutlineQuery = {}, projectRoot?: string): WorkOutlineEntry[] {
  const needle = query.q?.trim().toLowerCase();
  const limit = Math.min(Math.max(1, query.limit ?? WORK_OUTLINE_DEFAULT_LIMIT), WORK_OUTLINE_MAX_LIMIT);
  return readWorkOutlineState(projectRoot)
    .entries.filter((entry) => {
      if (query.status && entry.status !== query.status) return false;
      if (query.sessionId && !entry.sessionIds.includes(query.sessionId)) return false;
      if (query.worktreePath && entry.worktreePath !== query.worktreePath) return false;
      if (!needle) return true;
      return [entry.topicKey, entry.title, entry.summary, entry.worktreePath, ...entry.sessionIds]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .some((value) => value.toLowerCase().includes(needle));
    })
    .slice(0, limit);
}

export function getWorkOutlineEntry(entryId: string, projectRoot?: string): WorkOutlineEntry | undefined {
  return readWorkOutlineState(projectRoot).entries.find((entry) => entry.entryId === entryId);
}
