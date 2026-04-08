import { parseKeys } from "../key-parser.js";
import { markThreadSeen, setThreadStatus, type OrchestrationThread, type ThreadStatus } from "../threads.js";
import {
  acceptHandoff,
  acceptTask,
  approveReview,
  blockTask,
  completeHandoff,
  completeTask,
  reopenTask,
  requestTaskChanges,
} from "../orchestration-actions.js";
import {
  buildThreadEntries,
  buildWorkflowEntries,
  describeWorkflowNextAction,
  filterWorkflowEntries,
  type ThreadEntry,
  type WorkflowEntry,
  type WorkflowFilter,
} from "../workflow.js";
import {
  renderActivityScreen,
  renderThreadDetails,
  renderThreadsScreen,
  renderWorkflowDetails,
  renderWorkflowScreen,
} from "../tui/screens/subscreen-renderers.js";
import { navigationUrgencyScore } from "../fast-control.js";

type SubscreenHost = any;

export function attentionScore(host: SubscreenHost, entry: any): number {
  return navigationUrgencyScore(entry);
}

export function getActivityEntries(host: SubscreenHost): any[] {
  return host
    .getDashboardSessionsInVisualOrder()
    .filter(
      (entry: any) =>
        attentionScore(host, entry) > 0 ||
        !!entry.activity ||
        entry.status === "running" ||
        entry.status === "waiting" ||
        (entry.unseenCount ?? 0) > 0,
    )
    .sort((a: any, b: any) => {
      const scoreDiff = attentionScore(host, b) - attentionScore(host, a);
      if (scoreDiff !== 0) return scoreDiff;
      const activeDiff = Number(b.active) - Number(a.active);
      if (activeDiff !== 0) return activeDiff;
      const aName = a.label ?? a.command;
      const bName = b.label ?? b.command;
      return aName.localeCompare(bName);
    });
}

export function showActivityDashboard(host: SubscreenHost): void {
  host.clearDashboardSubscreens();
  host.activityEntries = getActivityEntries(host);
  if (host.activityIndex >= host.activityEntries.length) {
    host.activityIndex = Math.max(0, host.activityEntries.length - 1);
  }
  host.setDashboardScreen("activity");
  host.writeStatuslineFile();
  renderActivityDashboard(host);
}

export function buildWorkflowEntriesForHost(host: SubscreenHost): WorkflowEntry[] {
  return filterWorkflowEntries(buildWorkflowEntries("user"), host.workflowFilter, "user");
}

export function showWorkflow(host: SubscreenHost): void {
  host.clearDashboardSubscreens();
  host.workflowEntries = buildWorkflowEntriesForHost(host);
  if (host.workflowIndex >= host.workflowEntries.length) {
    host.workflowIndex = Math.max(0, host.workflowEntries.length - 1);
  }
  host.setDashboardScreen("workflow");
  host.writeStatuslineFile();
  renderWorkflow(host);
}

export function renderWorkflow(host: SubscreenHost): void {
  renderWorkflowScreen(host);
}

export function renderWorkflowDetailsForHost(host: SubscreenHost, width: number, height: number): string[] {
  return renderWorkflowDetails(host, width, height);
}

export function handleWorkflowKey(host: SubscreenHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;
  const event = events[0];
  const key = event.name || event.char;
  const isTabToggle = key === "tab" || event.raw === "\t" || (event.ctrl && key === "i");

  if (isTabToggle) {
    host.dashboardState.toggleDetailsSidebar();
    renderWorkflow(host);
    return;
  }
  if (key === "q") {
    host.exitDashboardClientOrProcess();
    return;
  }
  if (key === "escape" || key === "d") {
    host.setDashboardScreen("dashboard");
    host.renderDashboard();
    return;
  }
  if (host.handleDashboardSubscreenNavigationKey(key, "workflow")) return;
  if (key === "?") {
    host.showHelp();
    return;
  }
  if (key === "f") {
    cycleWorkflowFilter(host);
    return;
  }
  if (key === "s") {
    const entry = host.workflowEntries[host.workflowIndex];
    if (entry) {
      host.threadEntries = buildThreadEntries();
      host.threadIndex = Math.max(
        0,
        host.threadEntries.findIndex((thread: ThreadEntry) => thread.thread.id === entry.thread.id),
      );
      host.threadReplyActive = true;
      host.threadReplyBuffer = "";
      host.setDashboardScreen("threads");
      renderThreadReply(host);
    }
    return;
  }
  if (key === "a" || key === "c" || key === "b" || key === "o" || key === "x") {
    const entry = host.workflowEntries[host.workflowIndex];
    if (!entry) return;
    if (entry.task) {
      if (key === "a") {
        void runTaskLifecycleAction(host, "accept", entry.task.id);
        return;
      }
      if (key === "b") {
        void runTaskLifecycleAction(host, "block", entry.task.id);
        return;
      }
      if (key === "c" || key === "x") {
        void runTaskLifecycleAction(host, "complete", entry.task.id);
        return;
      }
    }
    if (key === "a" && entry.thread.kind === "handoff") {
      void runThreadHandoffAction(host, "accept", entry.thread.id);
      return;
    }
    if (key === "c" && entry.thread.kind === "handoff") {
      void runThreadHandoffAction(host, "complete", entry.thread.id);
      return;
    }
    const statusMap: Record<string, ThreadStatus> = { b: "blocked", o: "open", x: "done" };
    const status = statusMap[key];
    if (status) {
      void runThreadStatusAction(host, entry.thread.id, status);
    }
    return;
  }
  if (key === "P" || key === "J" || key === "E") {
    const entry = host.workflowEntries[host.workflowIndex];
    if (!entry?.task) return;
    if (key === "P") {
      void runReviewLifecycleAction(host, "approve", entry.task.id);
      return;
    }
    if (key === "J") {
      void runReviewLifecycleAction(host, "request_changes", entry.task.id);
      return;
    }
    if (key === "E") {
      void runTaskLifecycleAction(host, "reopen", entry.task.id);
    }
    return;
  }
  if (key === "down" || key === "j" || key === "n") {
    if (host.workflowEntries.length > 1) {
      host.workflowIndex = (host.workflowIndex + 1) % host.workflowEntries.length;
      renderWorkflow(host);
    }
    return;
  }
  if (key === "up" || key === "k") {
    if (host.workflowEntries.length > 1) {
      host.workflowIndex = (host.workflowIndex - 1 + host.workflowEntries.length) % host.workflowEntries.length;
      renderWorkflow(host);
    }
    return;
  }
  if (key >= "1" && key <= "9") {
    const idx = parseInt(key, 10) - 1;
    if (idx < host.workflowEntries.length) {
      host.workflowIndex = idx;
      renderWorkflow(host);
    }
    return;
  }
  if (key === "enter" || key === "return") {
    const entry = host.workflowEntries[host.workflowIndex];
    if (!entry) return;
    host.threadEntries = buildThreadEntries();
    host.threadIndex = Math.max(
      0,
      host.threadEntries.findIndex((thread: ThreadEntry) => thread.thread.id === entry.thread.id),
    );
    host.setDashboardScreen("threads");
    renderThreads(host);
  }
}

export function renderActivityDashboard(host: SubscreenHost): void {
  renderActivityScreen(host);
}

export function handleActivityKey(host: SubscreenHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;
  const event = events[0];
  const key = event.name || event.char;
  const isTabToggle = key === "tab" || event.raw === "\t" || (event.ctrl && key === "i");

  if (isTabToggle) {
    host.dashboardState.toggleDetailsSidebar();
    renderActivityDashboard(host);
    return;
  }
  if (key === "q") {
    host.exitDashboardClientOrProcess();
    return;
  }
  if (key === "escape" || key === "d") {
    host.setDashboardScreen("dashboard");
    host.renderDashboard();
    return;
  }
  if (host.handleDashboardSubscreenNavigationKey(key, "activity")) return;
  if (key === "?") {
    host.showHelp();
    return;
  }
  if (key === "u") {
    void activateNextAttentionEntry(host);
    return;
  }
  if (key === "down" || key === "j" || key === "n") {
    if (host.activityEntries.length > 1) {
      host.activityIndex = (host.activityIndex + 1) % host.activityEntries.length;
      renderActivityDashboard(host);
    }
    return;
  }
  if (key === "up" || key === "k") {
    if (host.activityEntries.length > 1) {
      host.activityIndex = (host.activityIndex - 1 + host.activityEntries.length) % host.activityEntries.length;
      renderActivityDashboard(host);
    }
    return;
  }
  if (key >= "1" && key <= "9") {
    const idx = parseInt(key, 10) - 1;
    const entry = host.activityEntries[idx];
    if (entry) void host.activateDashboardEntry(entry);
    return;
  }
  if (key === "enter" || key === "return") {
    const entry = host.activityEntries[host.activityIndex];
    if (entry) void host.activateDashboardEntry(entry);
  }
}

export function showThreads(host: SubscreenHost): void {
  host.clearDashboardSubscreens();
  host.threadEntries = buildThreadEntries();
  if (host.threadIndex >= host.threadEntries.length) {
    host.threadIndex = Math.max(0, host.threadEntries.length - 1);
  }
  host.setDashboardScreen("threads");
  host.writeStatuslineFile();
  renderThreads(host);
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

export function openRelevantThreadForSession(host: SubscreenHost, sessionId: string): void {
  const entries = buildThreadEntries();
  const idx = getPreferredThreadIndexForParticipant(host, sessionId, entries);
  if (idx < 0 || idx >= entries.length) {
    host.footerFlash = `No thread for ${sessionId}`;
    host.footerFlashTicks = 3;
    host.renderDashboard();
    return;
  }
  host.threadEntries = entries;
  host.threadIndex = idx;
  host.setDashboardScreen("threads");
  host.writeStatuslineFile();
  const entry = host.threadEntries[host.threadIndex];
  if (entry && (entry.thread.waitingOn ?? []).includes(sessionId)) {
    host.threadReplyActive = true;
    host.threadReplyBuffer = "";
    renderThreadReply(host);
    return;
  }
  renderThreads(host);
}

export function renderThreads(host: SubscreenHost): void {
  renderThreadsScreen(host);
}

export function renderThreadDetailsForHost(host: SubscreenHost, width: number, height: number): string[] {
  return renderThreadDetails(host, width, height);
}

export function handleThreadsKey(host: SubscreenHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;
  const event = events[0];
  const key = event.name || event.char;
  const isTabToggle = key === "tab" || event.raw === "\t" || (event.ctrl && key === "i");

  if (isTabToggle) {
    host.dashboardState.toggleDetailsSidebar();
    renderThreads(host);
    return;
  }
  if (key === "q") {
    host.exitDashboardClientOrProcess();
    return;
  }
  if (key === "escape" || key === "d") {
    host.setDashboardScreen("dashboard");
    host.renderDashboard();
    return;
  }
  if (host.handleDashboardSubscreenNavigationKey(key, "threads")) return;
  if (key === "?") {
    host.showHelp();
    return;
  }
  if (key === "r") {
    host.threadEntries = buildThreadEntries();
    if (host.threadIndex >= host.threadEntries.length) {
      host.threadIndex = Math.max(0, host.threadEntries.length - 1);
    }
    renderThreads(host);
    return;
  }
  if (key === "s") {
    if (host.threadEntries[host.threadIndex]) {
      host.threadReplyActive = true;
      host.threadReplyBuffer = "";
      renderThreadReply(host);
    }
    return;
  }
  if (key === "a") {
    const entry = host.threadEntries[host.threadIndex];
    if (entry?.thread.kind === "handoff") void runThreadHandoffAction(host, "accept", entry.thread.id);
    return;
  }
  if (key === "c") {
    const entry = host.threadEntries[host.threadIndex];
    if (entry?.thread.kind === "handoff") void runThreadHandoffAction(host, "complete", entry.thread.id);
    return;
  }
  if (key === "b") {
    const entry = host.threadEntries[host.threadIndex];
    if (entry) void runThreadStatusAction(host, entry.thread.id, "blocked");
    return;
  }
  if (key === "o") {
    const entry = host.threadEntries[host.threadIndex];
    if (entry) void runThreadStatusAction(host, entry.thread.id, "open");
    return;
  }
  if (key === "x") {
    const entry = host.threadEntries[host.threadIndex];
    if (entry) void runThreadStatusAction(host, entry.thread.id, "done");
    return;
  }
  if (key === "down" || key === "j" || key === "n") {
    if (host.threadEntries.length > 1) {
      host.threadIndex = (host.threadIndex + 1) % host.threadEntries.length;
      renderThreads(host);
    }
    return;
  }
  if (key === "up" || key === "k") {
    if (host.threadEntries.length > 1) {
      host.threadIndex = (host.threadIndex - 1 + host.threadEntries.length) % host.threadEntries.length;
      renderThreads(host);
    }
    return;
  }
  if (key >= "1" && key <= "9") {
    const idx = parseInt(key, 10) - 1;
    if (idx < host.threadEntries.length) {
      host.threadIndex = idx;
      renderThreads(host);
    }
    return;
  }
  if (key === "enter" || key === "return") {
    const entry = host.threadEntries[host.threadIndex];
    if (!entry) return;
    const targetSessionId = entry.thread.owner ?? entry.thread.waitingOn?.[0] ?? entry.thread.participants[0];
    if (targetSessionId) {
      markThreadSeen(entry.thread.id, targetSessionId);
      const dashEntry = host.getDashboardSessions().find((session: any) => session.id === targetSessionId);
      if (dashEntry) void host.activateDashboardEntry(dashEntry);
    }
  }
}

export function renderThreadReply(host: SubscreenHost): void {
  const entry = host.threadEntries[host.threadIndex];
  if (!entry) return;
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const targets =
    entry.thread.waitingOn?.length && entry.thread.waitingOn.length > 0
      ? entry.thread.waitingOn
      : entry.thread.participants.filter((participant: string) => participant !== "user");
  const title = host.truncatePlain(entry.displayTitle, Math.max(16, cols - 24));
  const buffer = host.truncatePlain(host.threadReplyBuffer, Math.max(12, cols - 24));
  const lines = [
    "Reply in thread:",
    "",
    `  Thread: ${title}`,
    `  To: ${targets.join(", ") || "participants"}`,
    "",
    `  Message: ${buffer}_`,
    "",
    "  [Enter] send  [Esc] cancel",
  ];
  const boxWidth = Math.max(...lines.map((line) => host.stripAnsi(line).length)) + 4;
  const startRow = Math.floor((rows - lines.length - 2) / 2);
  const startCol = Math.floor((cols - boxWidth) / 2);
  let output = "\x1b7";
  for (let i = 0; i < lines.length + 2; i++) {
    const row = startRow + i;
    output += `\x1b[${row};${startCol}H`;
    if (i === 0 || i === lines.length + 1) {
      output += `\x1b[44;97m${"─".repeat(boxWidth)}\x1b[0m`;
    } else {
      const line = lines[i - 1]!;
      output += `\x1b[44;97m  ${line.padEnd(boxWidth - 2)}\x1b[0m`;
    }
  }
  output += "\x1b8";
  process.stdout.write(output);
}

export function describeHandoffState(_host: SubscreenHost, thread: OrchestrationThread): string {
  if (thread.status === "done") return `completed by ${thread.owner ?? "unknown"}`;
  if ((thread.waitingOn?.length ?? 0) > 0) {
    return `${thread.owner ?? thread.createdBy} waiting on ${thread.waitingOn!.join(", ")}`;
  }
  if (thread.owner && thread.owner !== thread.createdBy) return `accepted by ${thread.owner}`;
  return `awaiting acceptance from ${thread.participants.filter((id) => id !== thread.createdBy).join(", ") || "recipient"}`;
}

export async function runThreadHandoffAction(
  host: SubscreenHost,
  mode: "accept" | "complete",
  threadId: string,
): Promise<void> {
  try {
    if (mode === "accept") {
      await host.postToProjectService("/handoff/accept", { threadId, from: "user" });
      host.footerFlash = "⇢ Handoff accepted";
    } else {
      await host.postToProjectService("/handoff/complete", { threadId, from: "user" });
      host.footerFlash = "⇢ Handoff completed";
    }
    host.footerFlashTicks = 3;
  } catch {
    try {
      if (mode === "accept") {
        acceptHandoff({ threadId, from: "user" });
        host.footerFlash = "⇢ Handoff accepted";
      } else {
        completeHandoff({ threadId, from: "user" });
        host.footerFlash = "⇢ Handoff completed";
      }
      host.footerFlashTicks = 3;
    } catch (error) {
      host.showDashboardError(`Failed to ${mode} handoff`, [error instanceof Error ? error.message : String(error)]);
      return;
    }
  }
  host.threadEntries = buildThreadEntries();
  host.threadIndex = Math.min(host.threadIndex, Math.max(0, host.threadEntries.length - 1));
  renderThreads(host);
}

export async function runThreadStatusAction(
  host: SubscreenHost,
  threadId: string,
  status: ThreadStatus,
): Promise<void> {
  try {
    await host.postToProjectService("/threads/status", { threadId, status });
    host.footerFlash = `Thread marked ${status}`;
    host.footerFlashTicks = 3;
  } catch {
    try {
      setThreadStatus(threadId, status);
      host.footerFlash = `Thread marked ${status}`;
      host.footerFlashTicks = 3;
    } catch (error) {
      host.showDashboardError("Failed to update thread status", [
        error instanceof Error ? error.message : String(error),
      ]);
      return;
    }
  }
  host.threadEntries = buildThreadEntries();
  host.threadIndex = Math.min(host.threadIndex, Math.max(0, host.threadEntries.length - 1));
  renderThreads(host);
}

export async function runTaskLifecycleAction(
  host: SubscreenHost,
  mode: "accept" | "block" | "complete" | "reopen",
  taskId: string,
): Promise<void> {
  try {
    if (mode === "accept") {
      await host.postToProjectService("/tasks/accept", { taskId, from: "user" });
      host.footerFlash = "⧫ Task accepted";
    } else if (mode === "block") {
      await host.postToProjectService("/tasks/block", { taskId, from: "user" });
      host.footerFlash = "⧫ Task blocked";
    } else if (mode === "reopen") {
      await host.postToProjectService("/tasks/reopen", { taskId, from: "user" });
      host.footerFlash = "↺ Task reopened";
    } else {
      await host.postToProjectService("/tasks/complete", { taskId, from: "user" });
      host.footerFlash = "✓ Task completed";
    }
    host.footerFlashTicks = 3;
  } catch {
    try {
      if (mode === "accept") {
        await acceptTask({ taskId, from: "user" });
        host.footerFlash = "⧫ Task accepted";
      } else if (mode === "block") {
        await blockTask({ taskId, from: "user" });
        host.footerFlash = "⧫ Task blocked";
      } else if (mode === "reopen") {
        await reopenTask({ taskId, from: "user" });
        host.footerFlash = "↺ Task reopened";
      } else {
        await completeTask({ taskId, from: "user" });
        host.footerFlash = "✓ Task completed";
      }
      host.footerFlashTicks = 3;
    } catch (error) {
      host.showDashboardError(`Failed to ${mode} task`, [error instanceof Error ? error.message : String(error)]);
      return;
    }
  }
  host.workflowEntries = buildWorkflowEntriesForHost(host);
  host.workflowIndex = Math.min(host.workflowIndex, Math.max(0, host.workflowEntries.length - 1));
  renderWorkflow(host);
}

export async function runReviewLifecycleAction(
  host: SubscreenHost,
  mode: "approve" | "request_changes",
  taskId: string,
): Promise<void> {
  try {
    if (mode === "approve") {
      await host.postToProjectService("/reviews/approve", { taskId, from: "user" });
      host.footerFlash = "✓ Review approved";
    } else {
      await host.postToProjectService("/reviews/request-changes", { taskId, from: "user" });
      host.footerFlash = "↺ Changes requested";
    }
    host.footerFlashTicks = 3;
  } catch {
    try {
      if (mode === "approve") {
        await approveReview({ taskId, from: "user" });
        host.footerFlash = "✓ Review approved";
      } else {
        await requestTaskChanges({ taskId, from: "user" });
        host.footerFlash = "↺ Changes requested";
      }
      host.footerFlashTicks = 3;
    } catch (error) {
      host.showDashboardError(`Failed to ${mode === "approve" ? "approve review" : "request changes"}`, [
        error instanceof Error ? error.message : String(error),
      ]);
      return;
    }
  }
  host.workflowEntries = buildWorkflowEntriesForHost(host);
  host.workflowIndex = Math.min(host.workflowIndex, Math.max(0, host.workflowEntries.length - 1));
  renderWorkflow(host);
}

export function describeWorkflowFilter(host: SubscreenHost): string {
  if (host.workflowFilter === "on_me") return "waiting on me";
  if (host.workflowFilter === "blocked") return "blocked";
  if (host.workflowFilter === "families") return "families";
  return "all";
}

export function cycleWorkflowFilter(host: SubscreenHost): void {
  const order: WorkflowFilter[] = ["all", "on_me", "blocked", "families"];
  const current = order.indexOf(host.workflowFilter);
  host.workflowFilter = order[(current + 1) % order.length] ?? "all";
  host.workflowEntries = buildWorkflowEntriesForHost(host);
  host.workflowIndex = Math.min(host.workflowIndex, Math.max(0, host.workflowEntries.length - 1));
  host.footerFlash = `Workflow filter: ${describeWorkflowFilter(host)}`;
  host.footerFlashTicks = 3;
  renderWorkflow(host);
}

export function handleThreadReplyKey(host: SubscreenHost, data: Buffer): void {
  const events = parseKeys(data);
  if (events.length === 0) return;
  const event = events[0];
  const key = event.name || event.char;

  if (key === "escape") {
    host.threadReplyActive = false;
    host.threadReplyBuffer = "";
    renderThreads(host);
    return;
  }

  if (key === "enter" || key === "return") {
    const body = host.threadReplyBuffer.trim();
    const entry = host.threadEntries[host.threadIndex];
    host.threadReplyActive = false;
    host.threadReplyBuffer = "";
    if (!entry || !body) {
      renderThreads(host);
      return;
    }
    try {
      host.sendOrchestrationMessage({
        threadId: entry.thread.id,
        from: "user",
        kind: "reply",
        body,
      });
    } catch (error) {
      host.showDashboardError("Failed to reply in thread", [error instanceof Error ? error.message : String(error)]);
      return;
    }
    host.threadEntries = buildThreadEntries();
    host.threadIndex = Math.min(host.threadIndex, Math.max(0, host.threadEntries.length - 1));
    renderThreads(host);
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
