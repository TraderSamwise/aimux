import { resolve as pathResolve } from "node:path";
import { loadMetadataState } from "./metadata-store.js";
import { compareLastUsed, getLastUsedAt, getRecentRankMap } from "./last-used.js";
import { parseRecencyTimestamp } from "./recency.js";
import {
  isDashboardWindowName,
  TmuxRuntimeManager,
  type TmuxTarget,
  type TmuxWindowMetadata,
} from "./tmux/runtime-manager.js";
import { compactSessionTitle } from "./statusline-model.js";
import { listWorktrees } from "./worktree.js";

export interface FastControlContext {
  projectRoot: string;
  currentPath?: string;
  currentWindow?: string;
  currentWindowId?: string;
  currentClientSession?: string;
}

export interface FastControlItem {
  id: string;
  target: TmuxTarget;
  metadata: TmuxWindowMetadata;
  label: string;
  urgency: number;
  activity: number;
  lastUsedAt?: string;
  recentRank: number;
}

export function navigationUrgencyScore(input: {
  semantic?: { attention?: string; unseenCount?: number; activity?: string } | null;
  attention?: string;
  unseenCount?: number;
  activity?: string;
}): number {
  if (input.semantic) {
    const semanticAttention = input.semantic.attention;
    if (semanticAttention === "error") return 5;
    if (semanticAttention === "needs_input") return 4;
    if (semanticAttention === "blocked") return 3;
    if ((input.semantic.unseenCount ?? 0) > 0) return 2;
    if (input.semantic.activity === "done") return 1;
    return 0;
  }
  if (input.attention === "error") return 5;
  if (input.attention === "needs_input") return 4;
  if (input.attention === "blocked") return 3;
  if ((input.unseenCount ?? 0) > 0) return 2;
  if (input.activity === "done") return 1;
  return 0;
}

export function resolveScopedWorktreePath(projectRoot: string, currentPath?: string): string {
  const fallback = pathResolve(currentPath || projectRoot);
  const worktrees = listWorktrees(projectRoot)
    .map((worktree) => pathResolve(worktree.path))
    .sort((a, b) => b.length - a.length);
  const match = worktrees.find((worktreePath) => fallback === worktreePath || fallback.startsWith(`${worktreePath}/`));
  return match ?? fallback;
}

function resolveContextWorktreePath(
  context: FastControlContext,
  tmux: TmuxRuntimeManager,
  managedWindows: Array<{ target: TmuxTarget; metadata: TmuxWindowMetadata }>,
): string {
  const byWindowId = context.currentWindowId
    ? managedWindows.find((entry) => entry.target.windowId === context.currentWindowId)
    : undefined;
  if (byWindowId?.metadata.worktreePath) {
    return pathResolve(byWindowId.metadata.worktreePath);
  }

  const currentClientSession = context.currentClientSession?.trim();
  if (currentClientSession) {
    const currentClientWindow = tmux
      .listWindows(currentClientSession)
      .find((window) => window.active && !isDashboardWindowName(window.name));
    if (currentClientWindow) {
      const byActiveClientWindow = managedWindows.find((entry) => entry.target.windowId === currentClientWindow.id);
      if (byActiveClientWindow?.metadata.worktreePath) {
        return pathResolve(byActiveClientWindow.metadata.worktreePath);
      }
    }
  }

  return resolveScopedWorktreePath(context.projectRoot, context.currentPath);
}

function urgencyFor(projectRoot: string, sessionId?: string): number {
  if (!sessionId) return 0;
  const derived = loadMetadataState(projectRoot).sessions[sessionId]?.derived;
  return navigationUrgencyScore(derived ?? {});
}

export function listSwitchableAgentItems(
  context: FastControlContext,
  tmux = new TmuxRuntimeManager(),
): FastControlItem[] {
  const tmuxSession = tmux.getProjectSession(context.projectRoot);
  const recentRankMap = getRecentRankMap(context.projectRoot, context.currentClientSession);
  const managedWindows = tmux.listManagedWindows(tmuxSession.sessionName);
  const scopedWorktreePath = resolveContextWorktreePath(context, tmux, managedWindows);
  let managed = managedWindows
    .filter(({ target, metadata }) => {
      if (isDashboardWindowName(target.windowName)) return false;
      const worktreePath = metadata.worktreePath || context.projectRoot;
      return pathResolve(worktreePath) === scopedWorktreePath;
    })
    .sort((a, b) => {
      const kindRank = a.metadata.kind === "service" ? 1 : 0;
      const otherKindRank = b.metadata.kind === "service" ? 1 : 0;
      if (kindRank !== otherKindRank) return kindRank - otherKindRank;
      return a.target.windowIndex - b.target.windowIndex;
    })
    .map((entry) => ({
      ...entry,
      id: entry.metadata.sessionId,
      label: compactSessionTitle({
        kind: entry.metadata.kind === "service" ? "service" : "agent",
        tool: entry.metadata.command || entry.target.windowName,
        label: entry.metadata.label,
        role: entry.metadata.role,
        id: entry.metadata.sessionId,
      }),
      urgency: urgencyFor(context.projectRoot, entry.metadata.sessionId),
      activity: entry.target.windowIndex,
      lastUsedAt: getLastUsedAt(context.projectRoot, entry.metadata.sessionId),
      recentRank: recentRankMap.get(entry.metadata.sessionId) ?? Number.MAX_SAFE_INTEGER,
    }));

  const activityByWindowId = new Map(
    tmux.listWindows(tmuxSession.sessionName).map((window) => [window.id, window.activity ?? 0] as const),
  );
  managed = managed.map((entry) => ({
    ...entry,
    activity: activityByWindowId.get(entry.target.windowId) ?? 0,
  }));

  return managed;
}

export function resolveCurrentAgentIndex(items: FastControlItem[], context: FastControlContext): number {
  const byId = context.currentWindowId
    ? items.findIndex(({ target }) => target.windowId === context.currentWindowId)
    : -1;
  if (byId >= 0) return byId;
  return items.findIndex(
    ({ target, metadata }) => target.windowName === context.currentWindow || metadata.label === context.currentWindow,
  );
}

export function resolveNextAgent(context: FastControlContext, tmux = new TmuxRuntimeManager()): FastControlItem | null {
  const items = listSwitchableAgentItems(context, tmux);
  if (items.length === 0) return null;
  const currentIndex = resolveCurrentAgentIndex(items, context);
  const resolvedIndex = currentIndex >= 0 ? currentIndex : 0;
  return items[(resolvedIndex + 1) % items.length] ?? null;
}

export function resolvePrevAgent(context: FastControlContext, tmux = new TmuxRuntimeManager()): FastControlItem | null {
  const items = listSwitchableAgentItems(context, tmux);
  if (items.length === 0) return null;
  const currentIndex = resolveCurrentAgentIndex(items, context);
  const resolvedIndex = currentIndex >= 0 ? currentIndex : 0;
  return items[(resolvedIndex - 1 + items.length) % items.length] ?? null;
}

export function resolveAttentionAgent(
  context: FastControlContext,
  tmux = new TmuxRuntimeManager(),
): FastControlItem | null {
  const items = listSwitchableAgentItems(context, tmux)
    .filter((entry) => entry.urgency > 0)
    .sort((a, b) => b.urgency - a.urgency);
  if (items.length === 0) return null;
  const nonCurrent = items.find(({ target, metadata }) => {
    return (
      target.windowId !== context.currentWindowId &&
      target.windowName !== context.currentWindow &&
      metadata.label !== context.currentWindow
    );
  });
  return nonCurrent ?? items[0] ?? null;
}

export function serializeFastControlItem(item: FastControlItem) {
  return {
    target: item.target,
    id: item.metadata.sessionId,
    metadata: item.metadata,
    label: item.label,
    urgency: item.urgency,
    activity: item.activity,
    lastUsedAt: item.lastUsedAt,
    recentRank: item.recentRank,
  };
}

export function listSwitchableAgentMenuItems(
  context: FastControlContext,
  tmux = new TmuxRuntimeManager(),
): FastControlItem[] {
  const recentRankMap = getRecentRankMap(context.projectRoot, context.currentClientSession);
  return [...listSwitchableAgentItems(context, tmux)].sort((a, b) => {
    const lastUsedDiff = compareLastUsed(a, b, recentRankMap);
    if (lastUsedDiff !== 0) return lastUsedDiff;
    if ((parseRecencyTimestamp(b.lastUsedAt) ?? 0) !== (parseRecencyTimestamp(a.lastUsedAt) ?? 0)) {
      return (parseRecencyTimestamp(b.lastUsedAt) ?? 0) - (parseRecencyTimestamp(a.lastUsedAt) ?? 0);
    }
    if (b.activity !== a.activity) return b.activity - a.activity;
    return a.target.windowIndex - b.target.windowIndex;
  });
}
