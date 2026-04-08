import type { PendingDashboardActionKind } from "./pending-actions.js";
import type { SessionRuntime } from "../session-runtime.js";

export interface DashboardOfflineEntryLike {
  id: string;
  command: string;
  label?: string;
}

interface DashboardActionDeps {
  getSessionLabel(sessionId: string): string | undefined;
  getPendingAction(sessionId: string): PendingDashboardActionKind | undefined;
  setPendingAction(sessionId: string, kind: PendingDashboardActionKind | null): void;
  stopSessionToOffline(session: SessionRuntime): void;
  isGraveyardAfterStop(sessionId: string): boolean;
  sendAgentToGraveyard(sessionId: string): Promise<void>;
  resumeOfflineSession(session: DashboardOfflineEntryLike): void;
  refreshLocalDashboardModel(): void;
  adjustAfterRemove(hasWorktrees: boolean): void;
  renderDashboard(): void;
  showDashboardError(title: string, lines: string[]): void;
  setFooterFlash(message: string, ticks: number): void;
  getRuntimeById(sessionId: string): SessionRuntime | undefined;
  isSessionRuntimeLive(session: SessionRuntime): boolean;
}

export function waitForSessionExit(session: SessionRuntime, timeoutMs = 15_000): Promise<void> {
  if (session.exited) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${session.id} to exit`)), timeoutMs);
    session.onExit(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function waitForSessionStart(
  sessionId: string,
  deps: Pick<DashboardActionDeps, "getRuntimeById" | "isSessionRuntimeLive">,
  timeoutMs = 8000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runtime = deps.getRuntimeById(sessionId);
    if (runtime && deps.isSessionRuntimeLive(runtime)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

export async function stopSessionToOfflineWithFeedback(
  deps: DashboardActionDeps,
  session: SessionRuntime,
): Promise<void> {
  const label = deps.getSessionLabel(session.id) ?? session.command;
  deps.setPendingAction(session.id, "stopping");
  try {
    deps.stopSessionToOffline(session);
    await waitForSessionExit(session);
    if (!deps.isGraveyardAfterStop(session.id)) {
      deps.setPendingAction(session.id, null);
    }
    deps.refreshLocalDashboardModel();
    deps.setFooterFlash(`Stopped ${label}`, 3);
    deps.renderDashboard();
  } catch (err) {
    deps.setPendingAction(session.id, null);
    const message = err instanceof Error ? err.message : String(err);
    deps.showDashboardError(`Failed to stop "${label}"`, [message]);
  }
}

export async function graveyardSessionWithFeedback(
  deps: DashboardActionDeps,
  session: DashboardOfflineEntryLike | SessionRuntime | undefined,
  sessionId: string,
  hasWorktrees: boolean,
): Promise<void> {
  if (!session) return;
  const label = deps.getSessionLabel(sessionId) ?? ("label" in session ? session.label : undefined) ?? session.command;
  deps.setPendingAction(sessionId, "graveyarding");
  try {
    await deps.sendAgentToGraveyard(sessionId);
    deps.setPendingAction(sessionId, null);
    deps.refreshLocalDashboardModel();
    deps.adjustAfterRemove(hasWorktrees);
    deps.setFooterFlash(`Sent ${label} to graveyard`, 3);
    deps.renderDashboard();
  } catch (err) {
    deps.setPendingAction(sessionId, null);
    const message = err instanceof Error ? err.message : String(err);
    deps.showDashboardError(`Failed to graveyard "${label}"`, [message]);
  }
}

export async function resumeOfflineSessionWithFeedback(
  deps: DashboardActionDeps,
  session: DashboardOfflineEntryLike,
): Promise<void> {
  const label = session.label ?? session.command;
  if (deps.getPendingAction(session.id) === "starting") {
    return;
  }
  deps.setPendingAction(session.id, "starting");
  deps.setFooterFlash(`Restoring ${label}`, 3);
  try {
    deps.resumeOfflineSession(session);
    const started = await waitForSessionStart(session.id, deps);
    deps.setPendingAction(session.id, null);
    deps.refreshLocalDashboardModel();
    deps.setFooterFlash(started ? `Restored ${label}` : `Failed to restore ${label}`, 3);
    deps.renderDashboard();
  } catch {
    deps.setPendingAction(session.id, null);
    deps.setFooterFlash(`Failed to restore ${label}`, 4);
    deps.renderDashboard();
  }
}
