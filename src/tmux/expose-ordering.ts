import { basename, resolve as pathResolve } from "node:path";
import { dashboardCreatedSortKey } from "../dashboard/sort.js";
import { parseRecencyTimestamp } from "../recency.js";
import type { ExposeScopeItem, ExposeScopeView, ExposeSublabel } from "./expose-model.js";
import { listWorktrees, type WorktreeInfo } from "../worktree.js";
import { worktreeColorCode } from "../worktree-colors.js";

export type ExposeSortMode = "default" | "recent-output";

export interface ExposeOrderingOptions {
  worktreeOrderByProjectRoot?: Record<string, string[]>;
  sortMode?: ExposeSortMode;
}

export interface ExposeTileContext {
  worktree: string;
  /** Only in the global scope, where project and worktree both identify the tile. */
  project?: string;
  /** Deterministic 24-bit RGB worktree identity color. */
  tone?: number;
}

export function shortWorktree(item: ExposeScopeItem, projectRoot: string): string {
  const wt = item.metadata.worktreePath;
  if (!wt || pathResolve(wt) === pathResolve(projectRoot)) return "main";
  return basename(wt);
}

export function worktreeToneKey(item: ExposeScopeItem, projectRoot: string): string {
  return pathResolve(item.metadata.worktreePath || projectRoot);
}

export function orderExposeItems(
  view: ExposeScopeView,
  projectRoot = "/",
  options: ExposeOrderingOptions = {},
): ExposeScopeItem[] {
  if (options.sortMode === "recent-output") return orderExposeItemsByRecentOutput(view.items);
  if (view.sublabel === "none") return view.items;
  if (view.sublabel === "worktree") {
    const groups = groupItemsByWorktree(view.items, projectRoot, options);
    return groups.length < 2 ? view.items : groups.flatMap((group) => group.items);
  }
  const groups = groupItemsByProject(view.items);
  if (groups.length < 2) {
    const root = view.items[0]?.projectRoot ?? projectRoot;
    const worktreeGroups = groupItemsByWorktree(view.items, root, options);
    return worktreeGroups.length < 2 ? view.items : worktreeGroups.flatMap((group) => group.items);
  }
  return groups.flatMap((project) => {
    const root = project.items[0]?.projectRoot ?? projectRoot;
    const worktreeGroups = groupItemsByWorktree(project.items, root, options);
    return worktreeGroups.length < 2 ? project.items : worktreeGroups.flatMap((group) => group.items);
  });
}

function recencySortKey(item: ExposeScopeItem): { timestamp: number; recentRank: number } {
  return {
    timestamp: parseRecencyTimestamp(item.metadata.recencyAt) ?? Number.NEGATIVE_INFINITY,
    recentRank: Number.isFinite(item.recentRank) ? item.recentRank : Number.MAX_SAFE_INTEGER,
  };
}

export function orderExposeItemsByRecentOutput(items: ExposeScopeItem[]): ExposeScopeItem[] {
  return items
    .map((item, index) => ({ item, index, key: recencySortKey(item) }))
    .sort((a, b) => {
      const timestampDiff = b.key.timestamp - a.key.timestamp;
      if (timestampDiff !== 0) return timestampDiff;
      const rankDiff = a.key.recentRank - b.key.recentRank;
      if (rankDiff !== 0) return rankDiff;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

/** Ordered project groups, preserving first-seen project order and item order within one. */
export function groupItemsByProject(items: ExposeScopeItem[]): Array<{ label: string; items: ExposeScopeItem[] }> {
  const order: string[] = [];
  const buckets = new Map<string, ExposeScopeItem[]>();
  for (const item of items) {
    const label = item.projectName?.trim() || "unknown project";
    let bucket = buckets.get(label);
    if (!bucket) {
      bucket = [];
      buckets.set(label, bucket);
      order.push(label);
    }
    bucket.push(item);
  }
  return order.map((label) => ({ label, items: buckets.get(label)! }));
}

/** Ordered worktree groups, matching dashboard worktree order and item order within one. */
export function groupItemsByWorktree(
  items: ExposeScopeItem[],
  projectRoot: string,
  options: ExposeOrderingOptions = {},
): Array<{ label: string; items: ExposeScopeItem[] }> {
  const order: string[] = [];
  const labels = new Map<string, string>();
  const buckets = new Map<string, ExposeScopeItem[]>();
  for (const item of items) {
    const root = item.projectRoot ?? projectRoot;
    const key = worktreeToneKey(item, root);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      labels.set(key, shortWorktree(item, root));
      order.push(key);
    }
    bucket.push(item);
  }
  if (order.length < 2) return order.map((key) => ({ label: labels.get(key) ?? "main", items: buckets.get(key)! }));
  const ranks = worktreeOrderRanks(projectRoot, options);
  const firstSeen = new Map(order.map((key, index) => [key, index]));
  const fallbackRank = ranks.size;
  const sorted = [...order].sort((a, b) => {
    const aRank = ranks.get(a) ?? fallbackRank + (firstSeen.get(a) ?? 0);
    const bRank = ranks.get(b) ?? fallbackRank + (firstSeen.get(b) ?? 0);
    return aRank - bRank;
  });
  return sorted.map((key) => ({ label: labels.get(key) ?? "main", items: buckets.get(key)! }));
}

function worktreeOrderRanks(projectRoot: string, options: ExposeOrderingOptions): Map<string, number> {
  const root = pathResolve(projectRoot);
  const configured = options.worktreeOrderByProjectRoot?.[root];
  const paths = configured ?? dashboardWorktreeOrderPaths(projectRoot);
  const ranks = new Map<string, number>();
  for (const path of paths) {
    const key = pathResolve(path);
    if (!ranks.has(key)) ranks.set(key, ranks.size);
  }
  if (!ranks.has(root)) {
    const shifted = new Map<string, number>([[root, 0]]);
    for (const [key, rank] of ranks) shifted.set(key, rank + 1);
    return shifted;
  }
  return ranks;
}

export function dashboardWorktreeOrderPaths(projectRoot: string, worktrees = listWorktrees(projectRoot)): string[] {
  const root = pathResolve(projectRoot);
  const secondary = worktrees
    .filter((worktree) => !worktree.isBare && pathResolve(worktree.path) !== root)
    .sort((a: WorktreeInfo, b: WorktreeInfo) => dashboardCreatedSortKey(b) - dashboardCreatedSortKey(a));
  return [root, ...secondary.map((worktree) => worktree.path)];
}

/** A deterministic tint per worktree, keyed by identity rather than render order. */
export function assignWorktreeTones(items: ExposeScopeItem[], projectRoot: string): Map<string, number> {
  const tones = new Map<string, number>();
  for (const item of items) {
    const root = item.projectRoot ?? projectRoot;
    const key = worktreeToneKey(item, root);
    if (!tones.has(key)) tones.set(key, worktreeColorCode({ path: key, projectRoot: root }));
  }
  return tones;
}

export function exposeTileContextForItem(
  item: ExposeScopeItem,
  sublabel: ExposeSublabel,
  projectRoot: string,
  tones: Map<string, number>,
): ExposeTileContext {
  if (sublabel === "none") return { worktree: "" };
  const root = item.projectRoot ?? projectRoot;
  const tone = tones.get(worktreeToneKey(item, root));
  const worktree = shortWorktree(item, root);
  if (sublabel === "project-worktree" && item.projectName) return { worktree, project: item.projectName, tone };
  return { worktree, tone };
}
