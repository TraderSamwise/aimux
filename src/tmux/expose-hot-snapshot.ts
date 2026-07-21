import { existsSync, readFileSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { atomicWriteFast } from "../atomic-write.js";
import type { ExposeScope, ExposeScopeItem, ExposeScopeView, ExposeSublabel } from "./expose-model.js";

const HOT_SNAPSHOT_VERSION = 1;
const HOT_SNAPSHOT_FILE = "expose-hot-snapshots.json";
const HOT_SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;
const MAX_ITEMS = 100;
const MAX_PREVIEW_BYTES = 16 * 1024;
const MAX_PREVIEW_LINES = 80;
const SCOPES = new Set<ExposeScope>(["worktree", "project", "global"]);
const SUBLABELS = new Set<ExposeSublabel>(["none", "worktree", "project-worktree"]);

export interface HotExposeScopeKey {
  projectRoot: string;
  scope: ExposeScope;
  worktreeKey?: string;
  launchWindowId?: string;
}

export interface HotExposeScopePrune {
  projectRoot: string;
  scopes?: ExposeScope[];
  keepLaunchWindowIds?: Set<string>;
}

export interface HotExposeScopeWrite {
  key: HotExposeScopeKey;
  view: ExposeScopeView;
}

interface HotExposeScopeViewRecord extends ExposeScopeView {
  projectRoot: string;
  worktreeKey?: string;
  launchWindowId?: string;
  updatedAt: string;
}

interface HotExposeSnapshotFile {
  version: typeof HOT_SNAPSHOT_VERSION;
  views: Record<string, HotExposeScopeViewRecord>;
}

function snapshotPath(projectStateDir: string): string {
  return join(projectStateDir, HOT_SNAPSHOT_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedProjectRoot(projectRoot: string): string {
  return pathResolve(projectRoot);
}

function normalizedWorktreeKey(worktreeKey?: string): string | undefined {
  return worktreeKey ? pathResolve(worktreeKey) : undefined;
}

export function hotExposeScopeKey(input: HotExposeScopeKey): HotExposeScopeKey {
  return {
    projectRoot: normalizedProjectRoot(input.projectRoot),
    scope: input.scope,
    worktreeKey: input.scope === "worktree" ? normalizedWorktreeKey(input.worktreeKey) : undefined,
    launchWindowId: input.scope === "worktree" && input.launchWindowId ? input.launchWindowId : undefined,
  };
}

function cacheId(input: HotExposeScopeKey): string {
  const key = hotExposeScopeKey(input);
  return [key.scope, key.projectRoot, key.worktreeKey ?? "", key.launchWindowId ?? ""]
    .map(encodeURIComponent)
    .join("|");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPreviewSnapshot(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return (
    typeof value.output === "string" &&
    typeof value.capturedAt === "string" &&
    (value.source === "capture" || value.source === "tap") &&
    (value.windowId === undefined || typeof value.windowId === "string") &&
    (value.startLine === undefined || isFiniteNumber(value.startLine)) &&
    (value.lineCount === undefined || isFiniteNumber(value.lineCount))
  );
}

function isExposeScopeItem(value: unknown): value is ExposeScopeItem {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== "string" ||
    typeof value.label !== "string" ||
    !isFiniteNumber(value.urgency) ||
    !isFiniteNumber(value.activity) ||
    !isFiniteNumber(value.recentRank) ||
    (value.lastUsedAt !== undefined && typeof value.lastUsedAt !== "string") ||
    (value.projectRoot !== undefined && typeof value.projectRoot !== "string") ||
    (value.projectName !== undefined && typeof value.projectName !== "string") ||
    !isPreviewSnapshot(value.previewSnapshot)
  ) {
    return false;
  }
  const target = value.target;
  if (!isRecord(target)) return false;
  if (
    typeof target.sessionName !== "string" ||
    typeof target.windowId !== "string" ||
    !isFiniteNumber(target.windowIndex) ||
    typeof target.windowName !== "string"
  ) {
    return false;
  }
  return isRecord(value.metadata);
}

function parseScope(value: unknown): ExposeScope | null {
  return typeof value === "string" && SCOPES.has(value as ExposeScope) ? (value as ExposeScope) : null;
}

function parseSublabel(value: unknown): ExposeSublabel | null {
  return typeof value === "string" && SUBLABELS.has(value as ExposeSublabel) ? (value as ExposeSublabel) : null;
}

function isFresh(updatedAt: string, now = Date.now()): boolean {
  const parsed = Date.parse(updatedAt);
  return Number.isFinite(parsed) && now - parsed >= 0 && now - parsed <= HOT_SNAPSHOT_MAX_AGE_MS;
}

function parseHotView(value: unknown, key: HotExposeScopeKey): HotExposeScopeViewRecord | null {
  if (!isRecord(value)) return null;
  const scope = parseScope(value.scope);
  const sublabel = parseSublabel(value.sublabel);
  const expected = hotExposeScopeKey(key);
  if (
    scope !== expected.scope ||
    !sublabel ||
    value.projectRoot !== expected.projectRoot ||
    (expected.worktreeKey !== undefined && value.worktreeKey !== expected.worktreeKey) ||
    (expected.worktreeKey === undefined && value.worktreeKey !== undefined) ||
    (expected.launchWindowId !== undefined && value.launchWindowId !== expected.launchWindowId) ||
    (expected.launchWindowId === undefined && value.launchWindowId !== undefined) ||
    typeof value.scopeLabel !== "string" ||
    typeof value.updatedAt !== "string" ||
    !isFresh(value.updatedAt) ||
    !Array.isArray(value.items) ||
    value.items.length === 0 ||
    value.items.length > MAX_ITEMS ||
    !value.items.every(isExposeScopeItem)
  ) {
    return null;
  }
  return {
    scope,
    projectRoot: expected.projectRoot,
    worktreeKey: expected.worktreeKey,
    launchWindowId: expected.launchWindowId,
    scopeLabel: value.scopeLabel,
    sublabel,
    items: value.items,
    updatedAt: value.updatedAt,
  };
}

function readFile(projectStateDir: string): HotExposeSnapshotFile {
  const path = snapshotPath(projectStateDir);
  if (!existsSync(path)) return { version: HOT_SNAPSHOT_VERSION, views: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isRecord(parsed) || parsed.version !== HOT_SNAPSHOT_VERSION || !isRecord(parsed.views)) {
    return { version: HOT_SNAPSHOT_VERSION, views: {} };
  }
  return { version: HOT_SNAPSHOT_VERSION, views: parsed.views as Record<string, HotExposeScopeViewRecord> };
}

function viewMatchesPrune(record: HotExposeScopeViewRecord, prune: HotExposeScopePrune): boolean {
  const projectRoot = normalizedProjectRoot(prune.projectRoot);
  if (record.projectRoot !== projectRoot) return false;
  if (prune.scopes && !prune.scopes.includes(record.scope)) return false;
  return true;
}

function pruneViews(
  views: Record<string, HotExposeScopeViewRecord>,
  prune?: HotExposeScopePrune,
): Record<string, HotExposeScopeViewRecord> {
  const now = Date.now();
  const next: Record<string, HotExposeScopeViewRecord> = {};
  for (const [id, record] of Object.entries(views)) {
    if (!isFresh(record.updatedAt, now)) continue;
    if (
      prune &&
      viewMatchesPrune(record, prune) &&
      record.scope === "worktree" &&
      record.launchWindowId &&
      prune.keepLaunchWindowIds &&
      !prune.keepLaunchWindowIds.has(record.launchWindowId)
    ) {
      continue;
    }
    next[id] = record;
  }
  return next;
}

function truncatePreviewOutput(output: string): string {
  const lines = output.replace(/\r/g, "").split("\n").slice(-MAX_PREVIEW_LINES).join("\n");
  const buffer = Buffer.from(lines, "utf8");
  if (buffer.length <= MAX_PREVIEW_BYTES) return lines;
  return buffer.subarray(buffer.length - MAX_PREVIEW_BYTES).toString("utf8");
}

function boundedItem(item: ExposeScopeItem): ExposeScopeItem {
  if (!item.previewSnapshot) return item;
  return {
    ...item,
    previewSnapshot: {
      ...item.previewSnapshot,
      output: truncatePreviewOutput(item.previewSnapshot.output),
    },
  };
}

export function readHotExposeScopeView(projectStateDir: string, key: HotExposeScopeKey): ExposeScopeView | null {
  try {
    const view = parseHotView(readFile(projectStateDir).views[cacheId(key)], key);
    if (!view) return null;
    return {
      scope: view.scope,
      scopeLabel: view.scopeLabel,
      sublabel: view.sublabel,
      items: view.items,
    };
  } catch {
    return null;
  }
}

export function writeHotExposeScopeViews(
  projectStateDir: string,
  entries: HotExposeScopeWrite[],
  options: { prune?: HotExposeScopePrune } = {},
): void {
  try {
    let file: HotExposeSnapshotFile;
    try {
      file = readFile(projectStateDir);
    } catch {
      file = { version: HOT_SNAPSHOT_VERSION, views: {} };
    }
    file.views = pruneViews(file.views, options.prune);
    for (const { key, view } of entries) {
      const normalizedKey = hotExposeScopeKey(key);
      if (normalizedKey.scope !== view.scope) continue;
      const id = cacheId(normalizedKey);
      if (view.items.length === 0) {
        delete file.views[id];
      } else {
        file.views[id] = {
          ...view,
          projectRoot: normalizedKey.projectRoot,
          worktreeKey: normalizedKey.worktreeKey,
          launchWindowId: normalizedKey.launchWindowId,
          items: view.items.slice(0, MAX_ITEMS).map(boundedItem),
          updatedAt: new Date().toISOString(),
        };
      }
    }
    atomicWriteFast(snapshotPath(projectStateDir), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  } catch {}
}

export function writeHotExposeScopeView(
  projectStateDir: string,
  key: HotExposeScopeKey,
  view: ExposeScopeView,
  options: { prune?: HotExposeScopePrune } = {},
): void {
  writeHotExposeScopeViews(projectStateDir, [{ key, view }], options);
}
