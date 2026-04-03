import { resolve as pathResolve } from "node:path";
import { loadMetadataState } from "./metadata-store.js";
import {
  isDashboardWindowName,
  TmuxRuntimeManager,
  type TmuxTarget,
  type TmuxWindowMetadata,
} from "./tmux-runtime-manager.js";
import { listWorktrees } from "./worktree.js";

export interface FastControlContext {
  projectRoot: string;
  currentPath?: string;
  currentWindow?: string;
  currentWindowId?: string;
  currentClientSession?: string;
}

export interface FastControlItem {
  target: TmuxTarget;
  metadata: TmuxWindowMetadata;
  label: string;
  urgency: number;
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
  const scopedWorktreePath = resolveScopedWorktreePath(context.projectRoot, context.currentPath);
  let managed = tmux
    .listManagedWindows(tmuxSession.sessionName)
    .filter(({ target, metadata }) => {
      if (isDashboardWindowName(target.windowName)) return false;
      const worktreePath = metadata.worktreePath || context.projectRoot;
      return pathResolve(worktreePath) === scopedWorktreePath;
    })
    .sort((a, b) => a.target.windowIndex - b.target.windowIndex)
    .map((entry) => ({
      ...entry,
      label: entry.metadata.label || entry.metadata.command || entry.metadata.sessionId || entry.target.windowName,
      urgency: urgencyFor(context.projectRoot, entry.metadata.sessionId),
    }));

  if (context.currentClientSession) {
    const managedByWindowId = new Map(managed.map((entry) => [entry.target.windowId, entry] as const));
    const clientOrdered = tmux
      .listWindows(context.currentClientSession)
      .filter((window) => !isDashboardWindowName(window.name))
      .map((window) => managedByWindowId.get(window.id))
      .filter((entry): entry is FastControlItem => Boolean(entry));
    if (clientOrdered.length > 0) {
      managed = clientOrdered;
    }
  }

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
    metadata: item.metadata,
    label: item.label,
    urgency: item.urgency,
  };
}
