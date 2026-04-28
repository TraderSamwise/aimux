import { basename } from "node:path";

import { composeTwoPane, truncateAnsi, truncatePlain, wrapKeyValue, wrapText } from "../tui/render/text.js";
import {
  graveyardSessionWithFeedback as runGraveyardSessionWithFeedback,
  resumeOfflineSessionWithFeedback as runResumeOfflineSessionWithFeedback,
  stopSessionToOfflineWithFeedback as runStopSessionToOfflineWithFeedback,
  waitForSessionExit,
  waitForSessionStart,
} from "../dashboard/session-actions.js";

type DashboardOpsHost = any;

export async function runDashboardOperation<T>(
  host: DashboardOpsHost,
  title: string,
  lines: string[],
  work: () => Promise<T> | T,
  errorTitle = title,
): Promise<T | undefined> {
  return host.dashboardFeedback.runOperation(title, lines, work, errorTitle);
}

export function setPendingDashboardSessionAction(host: DashboardOpsHost, sessionId: string, kind: any): void {
  host.dashboardPendingActions.set(sessionId, kind);
  if (typeof host.reapplyDashboardPendingActions === "function") {
    host.reapplyDashboardPendingActions();
  }
}

export async function stopSessionToOfflineWithFeedback(host: DashboardOpsHost, session: any): Promise<void> {
  await runStopSessionToOfflineWithFeedback(dashboardSessionActionDeps(host), session);
}

export function clearDashboardSubscreens(host: DashboardOpsHost): void {
  host.dashboardState.resetSubscreen();
}

export function renderSessionDetails(host: DashboardOpsHost, session: any, width: number, height: number): string[] {
  if (!session) return new Array(height).fill("");
  const lines: string[] = [];
  lines.push("\x1b[1mDetails\x1b[0m");
  lines.push(...wrapKeyValue("Agent", `${session.label ?? session.command} (${session.id})`, width));
  lines.push(...wrapKeyValue("Tool", session.command, width));
  if (session.worktreeName || session.worktreeBranch) {
    lines.push(
      ...wrapKeyValue(
        "Worktree",
        `${session.worktreeName ?? "main"}${session.worktreeBranch ? ` · ${session.worktreeBranch}` : ""}`,
        width,
      ),
    );
  }
  if (session.cwd) {
    lines.push(...wrapKeyValue("CWD", session.cwd, width));
  }
  if (session.prNumber || session.prTitle || session.prUrl) {
    const prHeader = [`PR${session.prNumber ? ` #${session.prNumber}` : ""}`];
    if (session.prTitle) prHeader.push(session.prTitle);
    lines.push(...wrapKeyValue("PR", prHeader.join(": "), width));
    if (session.prUrl) lines.push(...wrapKeyValue("URL", session.prUrl, width));
  }
  if (session.repoOwner || session.repoName) {
    lines.push(...wrapKeyValue("Repo", `${session.repoOwner ?? "?"}/${session.repoName ?? "?"}`, width));
  }
  if (session.repoRemote) {
    lines.push(...wrapKeyValue("Remote", session.repoRemote, width));
  }
  if (session.activity) {
    lines.push(...wrapKeyValue("Activity", session.activity, width));
  }
  if (session.attention && session.attention !== "normal") {
    lines.push(...wrapKeyValue("Attention", session.attention, width));
  }
  if ((session.unseenCount ?? 0) > 0) {
    lines.push(...wrapKeyValue("Unseen", String(session.unseenCount), width));
  }
  if (session.lastEvent?.message) {
    lines.push(...wrapKeyValue("Last", session.lastEvent.message, width));
  }
  if (session.threadName || session.threadId) {
    lines.push(...wrapKeyValue("Thread", session.threadName ?? session.threadId ?? "", width));
  }
  if (
    (session.threadUnreadCount ?? 0) > 0 ||
    (session.threadWaitingOnMeCount ?? 0) > 0 ||
    (session.threadWaitingOnThemCount ?? 0) > 0 ||
    (session.threadPendingCount ?? 0) > 0
  ) {
    lines.push(
      ...wrapKeyValue(
        "Threads",
        `${session.threadUnreadCount ?? 0} unread · ${session.threadWaitingOnMeCount ?? 0} on me · ${session.threadWaitingOnThemCount ?? 0} on them · ${session.threadPendingCount ?? 0} pending`,
        width,
      ),
    );
  }
  if ((session.services?.length ?? 0) > 0) {
    lines.push(...wrapKeyValue("Services", session.services.map((s: any) => s.url ?? `:${s.port}`).join(", "), width));
  }
  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
}

export function composeSplitScreen(
  host: DashboardOpsHost,
  leftLines: string[],
  rightLines: string[],
  cols: number,
  viewportHeight: number,
  focusLine: number,
  twoPane: boolean,
): string[] {
  const content = [...leftLines];
  let scrollOffset = 0;
  const maxScroll = Math.max(0, content.length - viewportHeight);
  if (focusLine >= 0) {
    if (focusLine < scrollOffset + 1) {
      scrollOffset = Math.max(0, focusLine - 1);
    } else if (focusLine >= scrollOffset + viewportHeight - 1) {
      scrollOffset = Math.min(maxScroll, focusLine - viewportHeight + 2);
    }
  }
  const visibleLeft = content.slice(scrollOffset, scrollOffset + viewportHeight);
  const canScrollUp = scrollOffset > 0;
  const canScrollDown = scrollOffset < maxScroll;
  if (canScrollUp && visibleLeft.length > 0) visibleLeft[0] = host.centerInWidth("\x1b[2m▲ more ▲\x1b[0m", cols);
  if (canScrollDown && visibleLeft.length > 0) {
    visibleLeft[visibleLeft.length - 1] = host.centerInWidth("\x1b[2m▼ more ▼\x1b[0m", cols);
  }
  while (visibleLeft.length < viewportHeight) visibleLeft.push("");
  if (!twoPane) return visibleLeft;
  return composeTwoPaneLines(visibleLeft, rightLines, cols);
}

export function composeTwoPaneLines(left: string[], right: string[], cols: number): string[] {
  return composeTwoPane(left, right, cols);
}

export function wrapKeyValueForHost(key: string, value: string, width: number): string[] {
  return wrapKeyValue(key, value, width);
}

export function wrapTextForHost(text: string, width: number): string[] {
  return wrapText(text, width);
}

export function truncatePlainForHost(text: string, max: number): string {
  return truncatePlain(text, max);
}

export function truncateAnsiForHost(text: string, max: number): string {
  return truncateAnsi(text, max);
}

export function basenameForHost(value: string): string {
  return basename(value);
}

export async function graveyardSessionWithFeedback(
  host: DashboardOpsHost,
  sessionId: string,
  hasWorktrees: boolean,
): Promise<void> {
  const session =
    host.offlineSessions.find((s: any) => s.id === sessionId) ?? host.sessions.find((s: any) => s.id === sessionId);
  await runGraveyardSessionWithFeedback(dashboardSessionActionDeps(host), session, sessionId, hasWorktrees);
}

export async function resumeOfflineSessionWithFeedback(host: DashboardOpsHost, session: any): Promise<void> {
  await runResumeOfflineSessionWithFeedback(dashboardSessionActionDeps(host), session);
}

export async function waitForSessionStartForHost(
  host: DashboardOpsHost,
  sessionId: string,
  timeoutMs = 8000,
): Promise<boolean> {
  return waitForSessionStart(sessionId, dashboardSessionActionDeps(host), timeoutMs);
}

export function dashboardSessionActionDeps(host: DashboardOpsHost) {
  return {
    getSessionLabel: (sessionId: string) => host.getSessionLabel(sessionId),
    getPendingAction: (sessionId: string) => host.dashboardPendingActions.get(sessionId),
    setPendingAction: (sessionId: string, kind: any) => setPendingDashboardSessionAction(host, sessionId, kind),
    stopSessionToOffline: (session: any) => host.stopSessionToOffline(session),
    isGraveyardAfterStop: (sessionId: string) => host.graveyardAfterStopSessionIds.has(sessionId),
    sendAgentToGraveyard: (sessionId: string) => host.sendAgentToGraveyard(sessionId).then(() => undefined),
    resumeOfflineSession: (session: any) =>
      host.mode === "dashboard"
        ? host.postToProjectService("/agents/resume", { sessionId: session.id }).then(() => undefined)
        : host.resumeOfflineSession(session),
    refreshLocalDashboardModel: () => host.refreshLocalDashboardModel(),
    adjustAfterRemove: (hasWorktrees: boolean) => host.adjustAfterRemove(hasWorktrees),
    renderDashboard: () => host.renderDashboard(),
    showDashboardError: (title: string, lines: string[]) => host.showDashboardError(title, lines),
    setFooterFlash: (message: string, ticks: number) => {
      host.footerFlash = message;
      host.footerFlashTicks = ticks;
    },
    getRuntimeById: (sessionId: string) => host.sessions.find((session: any) => session.id === sessionId),
    isSessionRuntimeLive: (session: any) => host.isSessionRuntimeLive(session),
  };
}

export async function takeoverFromDashEntryWithFeedback(host: DashboardOpsHost, entry: any): Promise<void> {
  const label = entry.label ?? entry.command;
  await runDashboardOperation(
    host,
    `Taking over "${label}"`,
    [`  Session: ${entry.id}`],
    () => host.takeoverSessionFromDashEntry(entry),
    `Failed to take over "${label}"`,
  );
}

export async function migrateSessionWithFeedback(
  host: DashboardOpsHost,
  session: any,
  targetPath: string,
  targetName: string,
): Promise<void> {
  const label = host.getSessionLabel(session.id) ?? session.command;
  host.setPendingDashboardSessionAction(session.id, "migrating");
  void (async () => {
    try {
      await host.migrateAgent(session.id, targetPath);
      await waitForSessionExit(session);
      host.setPendingDashboardSessionAction(session.id, null);
      host.refreshLocalDashboardModel();
      host.footerFlash = `Migrated ${label} to ${targetName}`;
      host.footerFlashTicks = 3;
      host.renderDashboard();
    } catch (error) {
      host.setPendingDashboardSessionAction(session.id, null);
      host.showDashboardError(`Failed to migrate "${label}"`, [error instanceof Error ? error.message : String(error)]);
    }
  })();
}
