import { commandKey, parseKeys } from "../key-parser.js";
import { type OrchestrationThread, type ThreadStatus } from "../threads.js";
import { type ThreadEntry } from "../workflow.js";
import { applyCoordinationFilter } from "./notifications.js";
import { navigationUrgencyScore } from "../fast-control.js";
import { PROJECT_API_ROUTES } from "../project-api-contract.js";
import { hints } from "../tui/screens/overlay-renderers.js";
import { renderOverlayBox } from "../tui/render/box.js";
import { style } from "../tui/render/theme.js";

type SubscreenHost = any;

export function attentionScore(host: SubscreenHost, entry: any): number {
  return navigationUrgencyScore(entry);
}

export function getPreferredThreadIndexForParticipant(
  _host: SubscreenHost,
  participantId: string,
  entries: ThreadEntry[],
): number {
  const participantEntries = entries.filter((entry) => entry.thread.participants.includes(participantId));
  const targetEntries = participantEntries;
  if (targetEntries.length === 0) return -1;
  const scored = targetEntries
    .map((entry) => {
      const waitingOnMe = (entry.thread.waitingOn ?? []).includes(participantId) ? 3 : 0;
      const unread = (entry.thread.unreadBy ?? []).includes(participantId) ? 2 : 0;
      const ownsWaiting = entry.thread.owner === participantId && (entry.thread.waitingOn?.length ?? 0) > 0 ? 1 : 0;
      return { entry, score: waitingOnMe + unread + ownsWaiting };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.entry.thread.updatedAt < b.entry.thread.updatedAt
          ? 1
          : a.entry.thread.updatedAt > b.entry.thread.updatedAt
            ? -1
            : 0),
    );
  const targetId = scored[0]!.entry.thread.id;
  return entries.findIndex((entry) => entry.thread.id === targetId);
}

export async function openRelevantThreadForSession(host: SubscreenHost, sessionId: string): Promise<void> {
  const refreshed =
    typeof host.refreshCoordinationFromService === "function" ? await host.refreshCoordinationFromService() : true;
  if (!refreshed && !host.coordinationLoaded) {
    host.footerFlash = "Coordination refresh failed";
    host.footerFlashTicks = 3;
    host.renderDashboard();
    return;
  }
  const entries: ThreadEntry[] = Array.isArray(host.threadEntries) ? host.threadEntries : [];
  const idx = getPreferredThreadIndexForParticipant(host, sessionId, entries);
  if (idx < 0 || idx >= entries.length) {
    host.footerFlash = `No thread for ${sessionId}`;
    host.footerFlashTicks = 3;
    host.renderDashboard();
    return;
  }
  host.threadEntries = entries;
  host.threadIndex = idx;
  host.setDashboardScreen("coordination");
  host.writeStatuslineFile();
  const entry = host.threadEntries[host.threadIndex];
  host.coordinationFilter = "all";
  applyCoordinationFilter(host);
  if (Array.isArray(host.coordinationWorklist) && entry) {
    const widx = host.coordinationWorklist.findIndex(
      (item: any) => item.kind === "thread" && item.thread?.thread.id === entry.thread.id,
    );
    if (widx >= 0) host.coordinationIndex = widx;
  }
  if (entry && (entry.thread.waitingOn ?? []).includes(sessionId)) {
    host.openDashboardOverlay("thread-reply");
    host.threadReplyBuffer = "";
    renderThreadReply(host);
    return;
  }
  host.renderCoordination();
}

export function renderThreadReply(host: SubscreenHost): void {
  if (host.mode === "dashboard" && typeof host.redrawDashboardWithOverlay === "function") {
    host.redrawDashboardWithOverlay();
    return;
  }
  const { cols, rows } = host.getViewportSize();
  const output = buildThreadReplyOverlayOutput(host, cols, rows);
  if (output) process.stdout.write(output);
}

export function buildThreadReplyOverlayOutput(host: SubscreenHost, cols: number, rows: number): string | null {
  const entry = host.threadEntries[host.threadIndex];
  if (!entry) return null;
  const targets =
    entry.thread.waitingOn?.length && entry.thread.waitingOn.length > 0
      ? entry.thread.waitingOn
      : entry.thread.participants.filter((participant: string) => participant !== "user");
  const title = host.truncatePlain(entry.displayTitle, Math.max(16, cols - 24));
  const buffer = host.truncatePlain(host.threadReplyBuffer, Math.max(12, cols - 24));
  const body = [
    `  ${style("Thread:", "muted")} ${title}`,
    `  ${style("To:", "muted")} ${targets.join(", ") || "participants"}`,
    "",
    `  ${style("Message:", "muted")} ${buffer}_`,
    "",
    hints([
      ["Enter", "send"],
      ["Esc", "cancel"],
    ]),
  ];
  return renderOverlayBox({ title: "Reply in thread", body, cols, rows });
}

export function describeHandoffState(_host: SubscreenHost, thread: OrchestrationThread): string {
  if (thread.status === "done") return `completed by ${thread.owner ?? "unknown"}`;
  if ((thread.waitingOn?.length ?? 0) > 0) {
    return `${thread.owner ?? thread.createdBy} waiting on ${thread.waitingOn!.join(", ")}`;
  }
  if (thread.owner && thread.owner !== thread.createdBy) return `accepted by ${thread.owner}`;
  return `awaiting acceptance from ${thread.participants.filter((id) => id !== thread.createdBy).join(", ") || "recipient"}`;
}

async function refreshCoordinationThreads(host: SubscreenHost): Promise<void> {
  const refreshed =
    typeof host.refreshCoordinationFromService === "function" ? await host.refreshCoordinationFromService() : true;
  if (typeof host.threadIndex !== "number" || Number.isNaN(host.threadIndex)) host.threadIndex = 0;
  host.threadIndex = Math.min(host.threadIndex, Math.max(0, (host.threadEntries?.length ?? 0) - 1));
  if (!refreshed) {
    host.footerFlash = "Coordination refresh failed";
    host.footerFlashTicks = 3;
  }
  host.renderCoordination();
}

export async function runThreadHandoffAction(
  host: SubscreenHost,
  mode: "accept" | "complete",
  threadId: string,
): Promise<void> {
  try {
    if (mode === "accept") {
      await host.postToProjectService(PROJECT_API_ROUTES.handoff.accept, { threadId, from: "user" });
      host.footerFlash = "⇢ Handoff accepted";
    } else {
      await host.postToProjectService(PROJECT_API_ROUTES.handoff.complete, { threadId, from: "user" });
      host.footerFlash = "⇢ Handoff completed";
    }
    host.footerFlashTicks = 3;
  } catch (error) {
    host.showDashboardError(`Failed to ${mode} handoff`, [error instanceof Error ? error.message : String(error)]);
    return;
  }
  void refreshCoordinationThreads(host).catch(() => {});
}

export async function runThreadStatusAction(
  host: SubscreenHost,
  threadId: string,
  status: ThreadStatus,
): Promise<void> {
  try {
    await host.postToProjectService(PROJECT_API_ROUTES.threads.status, { threadId, status });
    host.footerFlash = `Thread marked ${status}`;
    host.footerFlashTicks = 3;
  } catch (error) {
    host.showDashboardError("Failed to update thread status", [error instanceof Error ? error.message : String(error)]);
    return;
  }
  void refreshCoordinationThreads(host).catch(() => {});
}

export async function runTaskLifecycleAction(
  host: SubscreenHost,
  mode: "accept" | "block" | "complete" | "reopen",
  taskId: string,
): Promise<void> {
  try {
    if (mode === "accept") {
      await host.postToProjectService(PROJECT_API_ROUTES.tasks.accept, { taskId, from: "user" });
      host.footerFlash = "⧫ Task accepted";
    } else if (mode === "block") {
      await host.postToProjectService(PROJECT_API_ROUTES.tasks.block, { taskId, from: "user" });
      host.footerFlash = "⧫ Task blocked";
    } else if (mode === "reopen") {
      await host.postToProjectService(PROJECT_API_ROUTES.tasks.reopen, { taskId, from: "user" });
      host.footerFlash = "↺ Task reopened";
    } else {
      await host.postToProjectService(PROJECT_API_ROUTES.tasks.complete, { taskId, from: "user" });
      host.footerFlash = "✓ Task completed";
    }
    host.footerFlashTicks = 3;
  } catch (error) {
    host.showDashboardError(`Failed to ${mode} task`, [error instanceof Error ? error.message : String(error)]);
    return;
  }
  void refreshCoordinationThreads(host).catch(() => {});
}

export async function runReviewLifecycleAction(
  host: SubscreenHost,
  mode: "approve" | "request_changes",
  taskId: string,
): Promise<void> {
  try {
    if (mode === "approve") {
      await host.postToProjectService(PROJECT_API_ROUTES.reviews.approve, { taskId, from: "user" });
      host.footerFlash = "✓ Review approved";
    } else {
      await host.postToProjectService(PROJECT_API_ROUTES.reviews.requestChanges, { taskId, from: "user" });
      host.footerFlash = "↺ Changes requested";
    }
    host.footerFlashTicks = 3;
  } catch (error) {
    host.showDashboardError(`Failed to ${mode === "approve" ? "approve review" : "request changes"}`, [
      error instanceof Error ? error.message : String(error),
    ]);
    return;
  }
  void refreshCoordinationThreads(host).catch(() => {});
}

export function handleThreadReplyKey(host: SubscreenHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;
  const event = events[0];
  const key = commandKey(event);

  if (key === "escape") {
    host.clearDashboardOverlay();
    host.threadReplyBuffer = "";
    host.renderCoordination();
    return;
  }

  if (key === "enter" || key === "return") {
    const body = host.threadReplyBuffer.trim();
    const entry = host.threadEntries[host.threadIndex];
    host.clearDashboardOverlay();
    host.threadReplyBuffer = "";
    if (!entry || !body) {
      host.renderCoordination();
      return;
    }
    // Reply through the service (sole writer) rather than mutating the thread store in-process.
    void host
      .postToProjectService(PROJECT_API_ROUTES.threads.send, {
        threadId: entry.thread.id,
        from: "user",
        kind: "reply",
        body,
      })
      .then(() => refreshCoordinationThreads(host))
      .catch((error: unknown) =>
        host.showDashboardError("Failed to reply in thread", [error instanceof Error ? error.message : String(error)]),
      );
    return;
  }

  if (key === "backspace" || key === "delete") {
    host.threadReplyBuffer = host.threadReplyBuffer.slice(0, -1);
    renderThreadReply(host);
    return;
  }

  if (event.char && event.char.length === 1 && !event.ctrl && !event.alt) {
    host.threadReplyBuffer += event.char;
    renderThreadReply(host);
  }
}

export async function activateNextAttentionEntry(host: SubscreenHost): Promise<void> {
  const ordered = host
    .getDashboardSessionsInVisualOrder()
    .map((entry: any, index: number) => ({ entry, index, score: attentionScore(host, entry) }))
    .filter((entry: any) => entry.score > 0)
    .sort((a: any, b: any) => b.score - a.score || a.index - b.index);
  if (ordered.length === 0) return;

  const currentSessionId =
    host.dashboardState.level === "sessions" && host.dashboardState.worktreeEntries.length > 0
      ? host.dashboardState.worktreeEntries[host.dashboardState.sessionIndex]?.kind === "session"
        ? host.dashboardState.worktreeEntries[host.dashboardState.sessionIndex]?.id
        : undefined
      : host.getDashboardSessions()[host.activeIndex]?.id;
  const currentIdx = currentSessionId ? ordered.findIndex((entry: any) => entry.entry.id === currentSessionId) : -1;
  const next = ordered[currentIdx >= 0 ? (currentIdx + 1) % ordered.length : 0]!;
  await host.activateDashboardEntryByNumber(next.index);
}
