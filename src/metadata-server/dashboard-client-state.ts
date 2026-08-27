import { readFileSync } from "node:fs";
import { getDashboardClientUiStatePath } from "../paths.js";
import { writeJsonAtomic } from "../atomic-write.js";
import type { DashboardControlScreen } from "../project-api-contract.js";
import type { TmuxRuntimeManager } from "../tmux/runtime-manager.js";

function dashboardClientKeyFromSession(sessionName: string): string {
  return sessionName.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function persistDashboardClientPreference(
  clientSession: string,
  update: (snapshot: Record<string, unknown>) => void,
): void {
  const path = getDashboardClientUiStatePath(dashboardClientKeyFromSession(clientSession));
  let snapshot: Record<string, unknown> = {};
  try {
    snapshot = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {}
  update(snapshot);
  writeJsonAtomic(path, snapshot);
}

export function parseDashboardControlScreen(input: unknown): DashboardControlScreen | undefined {
  if (typeof input !== "string") return undefined;
  const screen = input.trim();
  if (
    screen === "dashboard" ||
    screen === "coordination" ||
    screen === "project" ||
    screen === "library" ||
    screen === "topology" ||
    screen === "graveyard"
  ) {
    return screen;
  }
  return undefined;
}

export function persistDashboardReturnSelection(
  tmux: TmuxRuntimeManager,
  projectRoot: string,
  currentClientSession: string,
  currentWindowId?: string,
): void {
  persistDashboardClientPreference(currentClientSession, (snapshot) => {
    snapshot.screen = "dashboard";
    if (!currentWindowId) return;
    const match = tmux
      .listProjectManagedWindows(projectRoot)
      .find((entry) => entry.target.windowId === currentWindowId);
    if (!match) return;
    if (!tmux.isWindowAlive(match.target)) {
      delete snapshot.focusedWorktreePath;
      delete snapshot.level;
      delete snapshot.selectedEntryKind;
      delete snapshot.selectedEntryId;
      return;
    }
    snapshot.focusedWorktreePath = match.metadata.worktreePath;
    snapshot.level = "sessions";
    snapshot.selectedEntryKind = match.metadata.kind === "service" ? "service" : "session";
    snapshot.selectedEntryId = match.metadata.sessionId;
  });
}
