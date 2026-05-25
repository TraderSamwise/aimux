import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { getStatePath } from "../paths.js";
import type { TmuxRuntimeManager } from "../tmux/runtime-manager.js";
import type { SavedState, ServiceState, SessionState } from "./index.js";
import { buildServiceStateFromMetadata } from "./services.js";
import { listWorktreeGraveyardPaths } from "./worktree-graveyard.js";
import { upsertTopologySession } from "../runtime-core/topology-sessions.js";

function sanitizeSnapshotSession(session: SessionState): SessionState {
  const { tmuxTarget: _tmuxTarget, ...rest } = session;
  return { ...rest, lifecycle: "offline" };
}

function isAvailableSnapshotWorktree(worktreePath?: string, graveyardPaths = listWorktreeGraveyardPaths()): boolean {
  if (!worktreePath) return true;
  if (graveyardPaths.has(worktreePath)) return false;
  return existsSync(worktreePath);
}

export function mergeRuntimeSnapshots(
  state: SavedState | null,
  snapshots: { sessions?: SessionState[]; services?: ServiceState[] },
  cwd: string,
  savedAt = new Date().toISOString(),
): SavedState {
  for (const session of snapshots.sessions ?? []) {
    const offline = sanitizeSnapshotSession(session);
    upsertTopologySession(offline, "offline");
  }

  const byId = new Map<string, ServiceState>();
  for (const service of state?.services ?? []) {
    byId.set(service.id, service);
  }
  for (const service of snapshots.services ?? []) {
    byId.set(service.id, {
      ...service,
      tmuxTarget: undefined,
      retained: undefined,
    });
  }
  return {
    savedAt,
    cwd: state?.cwd ?? cwd,
    services: [...byId.values()],
  };
}

export function mergeServiceSnapshots(
  state: SavedState | null,
  snapshots: ServiceState[],
  cwd: string,
  savedAt = new Date().toISOString(),
): SavedState {
  return mergeRuntimeSnapshots(state, { services: snapshots }, cwd, savedAt);
}

export function snapshotProjectAgentWindows(projectRoot: string, tmux: TmuxRuntimeManager): SessionState[] {
  const seen = new Set<string>();
  const graveyardPaths = listWorktreeGraveyardPaths();
  const snapshots: SessionState[] = [];
  for (const { target, metadata } of tmux.listProjectManagedWindows(projectRoot)) {
    if (metadata.kind !== "agent") continue;
    if (seen.has(metadata.sessionId)) continue;
    if (!isAvailableSnapshotWorktree(metadata.worktreePath, graveyardPaths)) continue;
    if (tmux.isWindowAlive && !tmux.isWindowAlive(target)) continue;
    seen.add(metadata.sessionId);
    snapshots.push({
      id: metadata.sessionId,
      tool: metadata.command,
      toolConfigKey: metadata.toolConfigKey ?? metadata.command,
      command: metadata.command,
      args: metadata.args ?? [],
      lifecycle: "offline",
      createdAt: metadata.createdAt,
      backendSessionId: metadata.backendSessionId,
      team: metadata.team,
      worktreePath: metadata.worktreePath,
      label: metadata.label,
      headline: metadata.statusText,
    });
  }
  return snapshots;
}

export function snapshotProjectServiceWindows(projectRoot: string, tmux: TmuxRuntimeManager): ServiceState[] {
  const seen = new Set<string>();
  const graveyardPaths = listWorktreeGraveyardPaths();
  const snapshots: ServiceState[] = [];
  for (const { target, metadata } of tmux.listProjectManagedWindows(projectRoot)) {
    if (metadata.kind !== "service") continue;
    if (seen.has(metadata.sessionId)) continue;
    if (!isAvailableSnapshotWorktree(metadata.worktreePath, graveyardPaths)) continue;
    if (tmux.isWindowAlive && !tmux.isWindowAlive(target)) continue;
    seen.add(metadata.sessionId);
    snapshots.push(
      buildServiceStateFromMetadata(metadata.sessionId, metadata, {
        cwd: tmux.displayMessage("#{pane_current_path}", target.windowId) ?? metadata.worktreePath,
      }),
    );
  }
  return snapshots;
}

export function persistProjectRuntimeSnapshotsBeforeTmuxStop(
  projectRoot: string,
  tmux: TmuxRuntimeManager,
): { sessions: SessionState[]; services: ServiceState[] } {
  const sessions = snapshotProjectAgentWindows(projectRoot, tmux);
  const services = snapshotProjectServiceWindows(projectRoot, tmux);
  if (sessions.length === 0 && services.length === 0) return { sessions, services };

  const statePath = getStatePath();
  let existing: SavedState | null = null;
  if (existsSync(statePath)) {
    try {
      existing = JSON.parse(readFileSync(statePath, "utf-8")) as SavedState;
    } catch {
      existing = null;
    }
  }

  const nextState = mergeRuntimeSnapshots(existing, { sessions, services }, projectRoot);
  writeFileSync(statePath, JSON.stringify(nextState, null, 2) + "\n");
  return { sessions, services };
}

export function persistProjectServiceSnapshotsBeforeRuntimeStop(
  projectRoot: string,
  tmux: TmuxRuntimeManager,
): ServiceState[] {
  return persistProjectRuntimeSnapshotsBeforeTmuxStop(projectRoot, tmux).services;
}
