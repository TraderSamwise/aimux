import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { getProjectStateDirFor } from "./paths.js";
import { join } from "node:path";
import { parseRecencyTimestamp } from "./recency.js";
import { writeJsonAtomic } from "./atomic-write.js";

const LAST_USED_VERSION = 1;
const MAX_RECENT_IDS = 64;

export interface LastUsedEntry {
  lastUsedAt: string;
}

export interface LastUsedClientState {
  recentIds: string[];
  items: Record<string, LastUsedEntry>;
  updatedAt: string;
}

export interface LastUsedState {
  version: number;
  items: Record<string, LastUsedEntry>;
  clients: Record<string, LastUsedClientState>;
  projectRecentIds: string[];
  updatedAt?: string;
}

export interface MarkLastUsedOptions {
  itemId: string;
  clientSession?: string;
  usedAt?: string;
}

const EMPTY_STATE: LastUsedState = {
  version: LAST_USED_VERSION,
  items: {},
  clients: {},
  projectRecentIds: [],
};

export function getLastUsedPath(projectRoot: string): string {
  return join(getProjectStateDirFor(projectRoot), "last-used.json");
}

export function loadLastUsedState(projectRoot: string): LastUsedState {
  const path = getLastUsedPath(projectRoot);
  if (!existsSync(path)) return { ...EMPTY_STATE };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LastUsedState>;
    return normalizeLastUsedState(parsed);
  } catch {
    return { ...EMPTY_STATE };
  }
}

export function markLastUsed(projectRoot: string, options: MarkLastUsedOptions): LastUsedState {
  const itemId = options.itemId?.trim();
  if (!itemId) return loadLastUsedState(projectRoot);

  const requestedUsedAt = options.usedAt?.trim() || new Date().toISOString();
  const usedAt = parseRecencyTimestamp(requestedUsedAt) == null ? new Date().toISOString() : requestedUsedAt;
  const state = loadLastUsedState(projectRoot);
  const existingUsedAt = state.items[itemId]?.lastUsedAt;
  if (!existingUsedAt || recencyMs(usedAt) >= recencyMs(existingUsedAt)) {
    state.items[itemId] = { lastUsedAt: usedAt };
  }
  state.projectRecentIds = sortRecentIds(pushRecentId(state.projectRecentIds, itemId), state.items);

  const clientSession = options.clientSession?.trim();
  if (clientSession) {
    const existing = state.clients[clientSession] ?? { recentIds: [], items: {}, updatedAt: usedAt };
    const clientItems = { ...existing.items };
    const existingClientUsedAt = clientItems[itemId]?.lastUsedAt;
    if (!existingClientUsedAt || recencyMs(usedAt) >= recencyMs(existingClientUsedAt)) {
      clientItems[itemId] = { lastUsedAt: usedAt };
    }
    const updatedAt = recencyMs(usedAt) >= recencyMs(existing.updatedAt) ? usedAt : existing.updatedAt;
    state.clients[clientSession] = {
      recentIds: sortRecentIds(pushRecentId(existing.recentIds, itemId), clientItems),
      items: clientItems,
      updatedAt,
    };
  }

  state.updatedAt = !state.updatedAt || recencyMs(usedAt) >= recencyMs(state.updatedAt) ? usedAt : state.updatedAt;
  persistLastUsedState(projectRoot, state);
  return state;
}

export function getLastUsedAt(projectRoot: string, itemId: string): string | undefined {
  return loadLastUsedState(projectRoot).items[itemId]?.lastUsedAt;
}

export function getRecentRankMap(projectRoot: string, clientSession?: string): Map<string, number> {
  const state = loadLastUsedState(projectRoot);
  const clientIds = clientSession ? (state.clients[clientSession]?.recentIds ?? []) : [];
  const ordered = [...clientIds, ...state.projectRecentIds.filter((id) => !clientIds.includes(id))];
  return new Map(ordered.map((id, index) => [id, index] as const));
}

export function compareLastUsed(
  left: { id: string; lastUsedAt?: string },
  right: { id: string; lastUsedAt?: string },
  rankMap: Map<string, number>,
): number {
  const leftRank = rankMap.get(left.id) ?? Number.MAX_SAFE_INTEGER;
  const rightRank = rankMap.get(right.id) ?? Number.MAX_SAFE_INTEGER;
  if (leftRank !== rightRank) return leftRank - rightRank;
  const leftUsedAt = parseRecencyTimestamp(left.lastUsedAt) ?? 0;
  const rightUsedAt = parseRecencyTimestamp(right.lastUsedAt) ?? 0;
  return rightUsedAt - leftUsedAt;
}

function persistLastUsedState(projectRoot: string, state: LastUsedState): void {
  const dir = getProjectStateDirFor(projectRoot);
  mkdirSync(dir, { recursive: true });
  writeJsonAtomic(getLastUsedPath(projectRoot), state);
}

function normalizeLastUsedState(state: Partial<LastUsedState>): LastUsedState {
  const items = Object.fromEntries(
    Object.entries(state.items ?? {}).flatMap(([itemId, value]) =>
      typeof value?.lastUsedAt === "string" ? [[itemId, { lastUsedAt: value.lastUsedAt }]] : [],
    ),
  );
  const clients = Object.fromEntries(
    Object.entries(state.clients ?? {}).map(([clientSession, value]) => [
      clientSession,
      {
        recentIds: Array.isArray(value?.recentIds) ? value.recentIds.filter(Boolean).slice(0, MAX_RECENT_IDS) : [],
        items: normalizeItems(value?.items),
        updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : "",
      },
    ]),
  );
  return {
    version: LAST_USED_VERSION,
    items,
    clients,
    projectRecentIds: Array.isArray(state.projectRecentIds)
      ? state.projectRecentIds.filter(Boolean).slice(0, MAX_RECENT_IDS)
      : [],
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : undefined,
  };
}

function normalizeItems(items: unknown): Record<string, LastUsedEntry> {
  if (!items || typeof items !== "object") return {};
  return Object.fromEntries(
    Object.entries(items as Record<string, Partial<LastUsedEntry>>).flatMap(([itemId, value]) =>
      typeof value?.lastUsedAt === "string" ? [[itemId, { lastUsedAt: value.lastUsedAt }]] : [],
    ),
  );
}

function pushRecentId(ids: string[], itemId: string): string[] {
  return [itemId, ...ids.filter((entry) => entry !== itemId)].slice(0, MAX_RECENT_IDS);
}

function sortRecentIds(ids: string[], items: Record<string, LastUsedEntry>): string[] {
  return [...ids]
    .sort((a, b) => {
      const diff = recencyMs(items[b]?.lastUsedAt) - recencyMs(items[a]?.lastUsedAt);
      if (diff !== 0) return diff;
      return ids.indexOf(a) - ids.indexOf(b);
    })
    .slice(0, MAX_RECENT_IDS);
}

function recencyMs(value?: string): number {
  return parseRecencyTimestamp(value) ?? 0;
}
