import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { getProjectId, getProjectStateDir } from "./paths.js";
import {
  type MetadataTone,
  updateSessionMetadata,
  clearSessionLogs,
  saveMetadataEndpoint,
  loadMetadataState,
  type SessionLogEntry,
  type SessionContextMetadata,
  type SessionServiceMetadata,
} from "./metadata-store.js";
import { notifyAlert } from "./notify.js";
import {
  clearNotifications,
  listNotifications,
  markNotificationsRead,
  unreadNotificationCount,
} from "./notifications.js";
import { updateNotificationContext } from "./notification-context.js";
import { AgentTracker } from "./agent-tracker.js";
import type { AgentActivityState, AgentAttentionState, AgentEvent } from "./agent-events.js";
import {
  createThread,
  listThreadSummaries,
  markThreadSeen,
  readMessages,
  readThread,
  setThreadStatus,
  type MessageKind,
  type ThreadKind,
  type ThreadStatus,
} from "./threads.js";
import { sendDirectMessage, sendThreadMessage } from "./orchestration.js";
import {
  acceptHandoff,
  approveReview,
  acceptTask,
  assignTask,
  blockTask,
  completeHandoff,
  completeTask,
  reopenTask,
  requestTaskChanges,
  sendHandoff,
  type TaskLifecycleResult,
} from "./orchestration-actions.js";
import { buildWorkflowEntries } from "./workflow.js";
import { markLastUsed } from "./last-used.js";
import { formatRelativeRecency } from "./recency.js";
import type { ParsedAgentOutput } from "./agent-output-parser.js";
import type { AgentInputPart } from "./agent-message-parts.js";
import type { SessionInputOperationRecord } from "./session-input-operations.js";
import {
  getAttachment,
  getAttachmentContent,
  ingestAttachmentFromBase64,
  ingestAttachmentFromPath,
} from "./attachment-store.js";
import { ProjectEventBus, type AlertKind } from "./project-events.js";
import { getProjectServiceManifest } from "./project-service-manifest.js";
import {
  listSwitchableAgentItems,
  resolveAttentionAgent,
  resolveNextAgent,
  resolvePrevAgent,
  serializeFastControlItem,
} from "./fast-control.js";
import { TmuxRuntimeManager } from "./tmux/runtime-manager.js";
import type { TmuxTarget } from "./tmux/runtime-manager.js";
import { openTargetForClient } from "./tmux/window-open.js";
import { getDashboardCommandSpec } from "./dashboard/command-spec.js";

interface MetadataServerOptions {
  onChange?: () => void;
  events?: {
    bus?: ProjectEventBus;
  };
  desktop?: {
    getState?: () => Record<string, unknown>;
    listWorktrees?: () => unknown[];
    refreshStatusline?: (input?: { sessionId?: string; force?: boolean }) => Promise<{ ok: true }> | { ok: true };
    createWorktree?: (input: { name: string }) => Promise<{ path: string }> | { path: string };
    removeWorktree?: (input: { path: string }) => Promise<{ path: string }> | { path: string };
    createService?: (input: {
      command?: string;
      worktreePath?: string;
    }) => Promise<{ serviceId: string }> | { serviceId: string };
    stopService?: (input: {
      serviceId: string;
    }) => Promise<{ serviceId: string; status: "stopped" }> | { serviceId: string; status: "stopped" };
    resumeService?: (input: {
      serviceId: string;
    }) => Promise<{ serviceId: string; status: "running" }> | { serviceId: string; status: "running" };
    removeService?: (input: {
      serviceId: string;
    }) => Promise<{ serviceId: string; status: "removed" }> | { serviceId: string; status: "removed" };
    listGraveyard?: () => unknown[];
    resurrectGraveyard?: (input: { sessionId: string }) =>
      | Promise<{ sessionId: string; status: "offline" }>
      | {
          sessionId: string;
          status: "offline";
        };
  };
  threads?: {
    sendMessage?: (input: {
      threadId?: string;
      from?: string;
      to?: string[];
      assignee?: string;
      tool?: string;
      worktreePath?: string;
      kind?: MessageKind;
      body: string;
      title?: string;
    }) => {
      thread: unknown;
      message: unknown;
      deliveredTo?: string[];
      threadCreated?: boolean;
    };
  };
  actions?: {
    sendHandoff?: (input: {
      from?: string;
      to?: string[];
      assignee?: string;
      tool?: string;
      body: string;
      title?: string;
      worktreePath?: string;
    }) => {
      thread: unknown;
      message: unknown;
      deliveredTo?: string[];
      threadCreated?: boolean;
    };
    acceptHandoff?: (input: { threadId: string; from?: string; body?: string }) => {
      thread: unknown;
      message: unknown;
    };
    completeHandoff?: (input: { threadId: string; from?: string; body?: string }) => {
      thread: unknown;
      message: unknown;
    };
    acceptTask?: (input: {
      taskId: string;
      from?: string;
      body?: string;
    }) => Promise<TaskLifecycleResult> | TaskLifecycleResult;
    blockTask?: (input: {
      taskId: string;
      from?: string;
      body?: string;
    }) => Promise<TaskLifecycleResult> | TaskLifecycleResult;
    completeTask?: (input: {
      taskId: string;
      from?: string;
      body?: string;
    }) => Promise<TaskLifecycleResult> | TaskLifecycleResult;
    approveReview?: (input: {
      taskId: string;
      from?: string;
      body?: string;
    }) => Promise<TaskLifecycleResult> | TaskLifecycleResult;
    requestTaskChanges?: (input: {
      taskId: string;
      from?: string;
      body?: string;
    }) => Promise<TaskLifecycleResult> | TaskLifecycleResult;
    reopenTask?: (input: {
      taskId: string;
      from?: string;
      body?: string;
    }) => Promise<TaskLifecycleResult> | TaskLifecycleResult;
  };
  lifecycle?: {
    spawnAgent?: (input: {
      tool: string;
      worktreePath?: string;
      open?: boolean;
    }) => Promise<{ sessionId: string }> | { sessionId: string };
    forkAgent?: (input: {
      sourceSessionId: string;
      tool: string;
      instruction?: string;
      worktreePath?: string;
      open?: boolean;
    }) => Promise<{ sessionId: string; threadId: string }> | { sessionId: string; threadId: string };
    stopAgent?: (input: { sessionId: string }) =>
      | Promise<{ sessionId: string; status: "offline" }>
      | {
          sessionId: string;
          status: "offline";
        };
    interruptAgent?: (input: { sessionId: string }) =>
      | Promise<{ sessionId: string }>
      | {
          sessionId: string;
        };
    renameAgent?: (input: { sessionId: string; label?: string }) =>
      | Promise<{ sessionId: string; label?: string }>
      | {
          sessionId: string;
          label?: string;
        };
    migrateAgent?: (input: {
      sessionId: string;
      worktreePath: string;
    }) => Promise<{ sessionId: string; worktreePath?: string }> | { sessionId: string; worktreePath?: string };
    killAgent?: (input: { sessionId: string }) =>
      | Promise<{
          sessionId: string;
          status: "graveyard";
          previousStatus: "running" | "offline";
        }>
      | {
          sessionId: string;
          status: "graveyard";
          previousStatus: "running" | "offline";
        };
    writeAgentInput?: (input: {
      sessionId: string;
      data?: string;
      parts?: AgentInputPart[];
      clientMessageId?: string;
      submit?: boolean;
    }) =>
      | Promise<{
          sessionId: string;
          accepted: boolean;
          operation: SessionInputOperationRecord;
          messageId?: string;
          error?: string;
        }>
      | {
          sessionId: string;
          accepted: boolean;
          operation: SessionInputOperationRecord;
          messageId?: string;
          error?: string;
        };
    readAgentOutput?: (input: {
      sessionId: string;
      startLine?: number;
    }) =>
      | Promise<{ sessionId: string; output: string; startLine?: number; parsed?: ParsedAgentOutput }>
      | { sessionId: string; output: string; startLine?: number; parsed?: ParsedAgentOutput };
    readAgentHistory?: (input: {
      sessionId: string;
      lastN?: number;
    }) =>
      | Promise<{ sessionId: string; messages: unknown[]; lastN?: number }>
      | { sessionId: string; messages: unknown[]; lastN?: number };
  };
}

function markTargetUsed(
  tmux: TmuxRuntimeManager,
  projectRoot: string,
  target: TmuxTarget,
  currentClientSession?: string,
  itemId?: string,
): void {
  const resolvedItemId =
    itemId ||
    tmux
      .listManagedWindows(tmux.getProjectSession(projectRoot).sessionName)
      .find((entry) => entry.target.windowId === target.windowId)?.metadata.sessionId;
  if (!resolvedItemId) return;
  markLastUsed(projectRoot, {
    itemId: resolvedItemId,
    clientSession: currentClientSession,
  });
}

function desiredPort(): number {
  const hash = createHash("sha1").update(getProjectId()).digest("hex").slice(0, 6);
  return 43000 + (parseInt(hash, 16) % 10000);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  return body ? JSON.parse(body) : {};
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("connection", "close");
  res.end(payload);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, mimeType: string): void {
  res.statusCode = status;
  res.setHeader("content-type", mimeType);
  res.setHeader("content-length", body.byteLength);
  res.setHeader("cache-control", "private, max-age=31536000, immutable");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("connection", "close");
  res.end(body);
}

function sendSseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export class MetadataServer {
  private server: Server | null = null;
  private port = 0;
  private tracker = new AgentTracker();
  private readonly eventBus: ProjectEventBus;
  private unsubscribeAlertSink: (() => void) | null = null;

  constructor(private readonly options: MetadataServerOptions = {}) {
    this.eventBus = options.events?.bus ?? new ProjectEventBus();
    this.unsubscribeAlertSink = this.eventBus.subscribe((event) => {
      if (event.type !== "alert") return;
      notifyAlert(event);
    });
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await this.listen(desiredPort()).catch(async () => {
      await this.listen(0);
    });
    saveMetadataEndpoint({
      host: "127.0.0.1",
      port: this.port,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.unsubscribeAlertSink?.();
    this.unsubscribeAlertSink = null;
  }

  getAddress(): { host: string; port: number } | null {
    if (!this.server || this.port === 0) return null;
    return { host: "127.0.0.1", port: this.port };
  }

  getEventBus(): ProjectEventBus {
    return this.eventBus;
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) return reject(new Error("server not initialized"));
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", () => {
        this.server?.off("error", reject);
        const address = this.server?.address();
        if (!address || typeof address === "string") return reject(new Error("invalid address"));
        this.port = address.port;
        resolve();
      });
    });
  }

  private emitAlert(input: {
    kind: AlertKind;
    sessionId?: string;
    title: string;
    message: string;
    threadId?: string;
    taskId?: string;
    worktreePath?: string;
    dedupeKey?: string;
    cooldownMs?: number;
    forceNotify?: boolean;
  }): void {
    this.eventBus.publishAlert(input);
  }

  private emitThreadWaitingAlert(input: {
    kind: Extract<AlertKind, "message_waiting" | "handoff_waiting">;
    threadId: string;
    from?: string;
    recipients?: string[];
    title: string;
    message: string;
    worktreePath?: string;
    cooldownMs?: number;
  }): void {
    for (const recipient of [...new Set((input.recipients ?? []).map((value) => value?.trim()).filter(Boolean))]) {
      if (recipient === input.from?.trim()) continue;
      this.emitAlert({
        kind: input.kind,
        sessionId: recipient,
        threadId: input.threadId,
        worktreePath: input.worktreePath,
        title: input.title,
        message: input.message,
        dedupeKey: `${input.kind}:${input.threadId}:${recipient}`,
        cooldownMs: input.cooldownMs ?? 15_000,
      });
    }
  }

  private emitAssignedTaskAlert(input: {
    task: {
      id: string;
      description: string;
      assignedTo?: string;
      type?: "task" | "review";
    };
    thread?: {
      id?: string;
      worktreePath?: string;
    };
  }): void {
    const recipient = input.task.assignedTo?.trim();
    if (!recipient) return;
    const kind = input.task.type === "review" ? "review_waiting" : "task_assigned";
    const noun = input.task.type === "review" ? "Review" : "Task";
    this.emitAlert({
      kind,
      sessionId: recipient,
      taskId: input.task.id,
      threadId: input.thread?.id,
      worktreePath: input.thread?.worktreePath,
      title: `${noun} assigned: ${input.task.description}`,
      message:
        input.task.type === "review"
          ? "A review is waiting for your attention."
          : "A task is waiting for your attention.",
      dedupeKey: `${kind}:${input.task.id}:${recipient}`,
      cooldownMs: 15_000,
    });
  }

  private emitReviewOutcomeAlert(input: {
    task: {
      id: string;
      description: string;
      assignedBy: string;
      reviewFeedback?: string;
    };
    thread?: {
      id?: string;
      worktreePath?: string;
    };
    kind: Extract<AlertKind, "task_done" | "blocked">;
    fallbackMessage: string;
  }): void {
    const recipient = input.task.assignedBy?.trim();
    if (!recipient) return;
    const isBlocked = input.kind === "blocked";
    this.emitAlert({
      kind: input.kind,
      sessionId: recipient,
      taskId: input.task.id,
      threadId: input.thread?.id,
      worktreePath: input.thread?.worktreePath,
      title: `${isBlocked ? "Changes requested" : "Review approved"}: ${input.task.description}`,
      message: input.task.reviewFeedback?.trim() || input.fallbackMessage,
      dedupeKey: `${isBlocked ? "review-blocked" : "review-approved"}:${input.task.id}:${recipient}`,
      cooldownMs: 15_000,
    });
  }

  private resolveAlertRecipients(
    explicit: string[] | undefined,
    message: unknown,
    fallback: string[] | undefined,
  ): string[] {
    const fromExplicit = explicit?.map((value) => value?.trim()).filter(Boolean);
    if (fromExplicit && fromExplicit.length > 0) return [...new Set(fromExplicit)];
    const payload = message as { deliveredTo?: string[]; to?: string[] } | undefined;
    const fromMessage = payload?.deliveredTo?.map((value) => value?.trim()).filter(Boolean);
    if (fromMessage && fromMessage.length > 0) return [...new Set(fromMessage)];
    const fallbackRecipients = payload?.to ?? fallback ?? [];
    return [...new Set(fallbackRecipients.map((value) => value?.trim()).filter(Boolean))];
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/events") {
      const sessionFilter = url.searchParams.get("sessionId")?.trim() || null;
      const startLineRaw = url.searchParams.get("startLine");
      const intervalMsRaw = url.searchParams.get("intervalMs");
      const startLine =
        startLineRaw === null || startLineRaw.trim() === "" ? undefined : Number.parseInt(startLineRaw, 10);
      if (startLineRaw !== null && Number.isNaN(startLine)) {
        send(res, 400, { ok: false, error: "startLine must be an integer" });
        return;
      }
      const intervalMs =
        intervalMsRaw === null || intervalMsRaw.trim() === "" ? 500 : Number.parseInt(intervalMsRaw, 10);
      if (Number.isNaN(intervalMs) || intervalMs < 100) {
        send(res, 400, { ok: false, error: "intervalMs must be an integer >= 100" });
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache, no-transform");
      res.setHeader("connection", "keep-alive");
      res.setHeader("x-accel-buffering", "no");
      res.setHeader("access-control-allow-origin", "*");
      res.flushHeaders?.();

      let closed = false;
      let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
      let outputPollTimer: ReturnType<typeof setInterval> | null = null;
      let lastOutput: string | undefined;
      const unsubscribe = this.eventBus.subscribe((event) => {
        if (closed) return;
        if (sessionFilter && event.sessionId && event.sessionId !== sessionFilter) return;
        if (sessionFilter && !event.sessionId) return;
        sendSseEvent(res, event.type, event);
      });

      const cleanup = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (keepaliveTimer) clearInterval(keepaliveTimer);
        keepaliveTimer = null;
        if (outputPollTimer) clearInterval(outputPollTimer);
        outputPollTimer = null;
        res.end();
      };

      req.on("close", cleanup);
      req.on("aborted", cleanup);
      res.on("close", cleanup);

      const pollSessionOutput = async () => {
        if (closed || !sessionFilter || !this.options.lifecycle?.readAgentOutput) return;
        try {
          const result = await this.options.lifecycle.readAgentOutput({ sessionId: sessionFilter, startLine });
          if (closed) return;
          if (result.output !== lastOutput) {
            lastOutput = result.output;
            sendSseEvent(res, "agent_output", {
              sessionId: result.sessionId,
              output: result.output,
              startLine: result.startLine ?? startLine ?? -120,
              parsed: result.parsed,
            });
          }
        } catch (error) {
          sendSseEvent(res, "error", {
            sessionId: sessionFilter,
            error: error instanceof Error ? error.message : String(error),
          });
          cleanup();
        }
      };

      sendSseEvent(res, "ready", {
        projectId: getProjectId(),
        ts: new Date().toISOString(),
        sessionId: sessionFilter,
        startLine: startLine ?? -120,
        intervalMs,
      });
      if (sessionFilter && this.options.lifecycle?.readAgentOutput) {
        await pollSessionOutput();
        outputPollTimer = setInterval(() => {
          void pollSessionOutput();
        }, intervalMs);
        outputPollTimer.unref?.();
      }
      keepaliveTimer = setInterval(() => {
        if (closed) return;
        res.write(": keepalive\n\n");
      }, 15_000);
      keepaliveTimer.unref?.();
      return;
    }

    if (req.method === "GET" && url.pathname === "/notifications") {
      const unreadOnly = url.searchParams.get("unread") === "1";
      const sessionId = url.searchParams.get("sessionId")?.trim() || undefined;
      const notifications = listNotifications({ unreadOnly, sessionId });
      send(res, 200, {
        ok: true,
        notifications,
        unreadCount: unreadNotificationCount({ sessionId }),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      send(res, 200, {
        ok: true,
        projectStateDir: getProjectStateDir(),
        pid: process.pid,
        serviceInfo: getProjectServiceManifest(),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/state") {
      send(res, 200, loadMetadataState());
      return;
    }
    if (req.method === "GET" && url.pathname === "/desktop-state") {
      if (!this.options.desktop?.getState) {
        send(res, 501, { ok: false, error: "desktop state not supported by this service" });
        return;
      }
      send(res, 200, {
        ok: true,
        serviceInfo: getProjectServiceManifest(),
        ...this.options.desktop.getState(),
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/statusline/refresh") {
      if (!this.options.desktop?.refreshStatusline) {
        send(res, 501, { ok: false, error: "statusline refresh not supported by this service" });
        return;
      }
      const body = (await readJson(req).catch(() => ({}))) as { sessionId?: string; force?: boolean };
      await this.options.desktop.refreshStatusline({
        sessionId: body.sessionId?.trim() || undefined,
        force: body.force === true,
      });
      send(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/worktrees") {
      if (!this.options.desktop?.listWorktrees) {
        send(res, 501, { ok: false, error: "worktree listing not supported by this service" });
        return;
      }
      send(res, 200, { ok: true, worktrees: this.options.desktop.listWorktrees() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/graveyard") {
      if (!this.options.desktop?.listGraveyard) {
        send(res, 501, { ok: false, error: "graveyard listing not supported by this service" });
        return;
      }
      send(res, 200, { ok: true, entries: this.options.desktop.listGraveyard() });
      return;
    }
    if (req.method === "GET" && url.pathname === "/threads") {
      send(res, 200, listThreadSummaries(url.searchParams.get("session") ?? undefined));
      return;
    }
    if (req.method === "GET" && url.pathname === "/workflow") {
      send(res, 200, buildWorkflowEntries(url.searchParams.get("participant") ?? "user"));
      return;
    }
    if (req.method === "POST" && url.pathname === "/usage/mark") {
      const body = (await readJson(req)) as { itemId?: string; clientSession?: string };
      const itemId = body.itemId?.trim() || "";
      if (!itemId) {
        send(res, 400, { ok: false, error: "itemId is required" });
        return;
      }
      const state = markLastUsed(process.cwd(), {
        itemId,
        clientSession: body.clientSession?.trim() || undefined,
      });
      send(res, 200, {
        ok: true,
        itemId,
        lastUsedAt: state.items[itemId]?.lastUsedAt ?? null,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/control/switchable-agents") {
      const currentClientSession = url.searchParams.get("currentClientSession")?.trim() || undefined;
      const currentWindow = url.searchParams.get("currentWindow")?.trim() || undefined;
      const currentWindowId = url.searchParams.get("currentWindowId")?.trim() || undefined;
      const currentPath = url.searchParams.get("currentPath")?.trim() || undefined;
      const items = listSwitchableAgentItems(
        {
          projectRoot: process.cwd(),
          currentClientSession,
          currentWindow,
          currentWindowId,
          currentPath,
        },
        new TmuxRuntimeManager(),
      ).map((item) => ({
        ...serializeFastControlItem(item),
        label: item.lastUsedAt ? `${item.label} · ${formatRelativeRecency(item.lastUsedAt)}` : item.label,
      }));
      send(res, 200, { ok: true, items });
      return;
    }
    if (req.method === "GET" && url.pathname === "/agents/output/stream") {
      const sessionId = url.searchParams.get("sessionId")?.trim();
      const startLineRaw = url.searchParams.get("startLine");
      const intervalMsRaw = url.searchParams.get("intervalMs");
      if (!sessionId) {
        send(res, 400, { ok: false, error: "sessionId is required" });
        return;
      }
      if (!this.options.lifecycle?.readAgentOutput) {
        send(res, 501, { ok: false, error: "agent output stream not supported by this service" });
        return;
      }

      const startLine =
        startLineRaw === null || startLineRaw.trim() === "" ? undefined : Number.parseInt(startLineRaw, 10);
      if (startLineRaw !== null && Number.isNaN(startLine)) {
        send(res, 400, { ok: false, error: "startLine must be an integer" });
        return;
      }

      const intervalMs =
        intervalMsRaw === null || intervalMsRaw.trim() === "" ? 500 : Number.parseInt(intervalMsRaw, 10);
      if (Number.isNaN(intervalMs) || intervalMs < 100) {
        send(res, 400, { ok: false, error: "intervalMs must be an integer >= 100" });
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache, no-transform");
      res.setHeader("connection", "keep-alive");
      res.setHeader("x-accel-buffering", "no");
      res.setHeader("access-control-allow-origin", "*");
      res.flushHeaders?.();

      let closed = false;
      let lastOutput: string | undefined;
      let pollTimer: ReturnType<typeof setInterval> | null = null;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        res.end();
      };

      req.on("close", cleanup);
      req.on("aborted", cleanup);
      res.on("close", cleanup);

      const poll = async () => {
        if (closed) return;
        try {
          const result = await this.options.lifecycle!.readAgentOutput!({ sessionId, startLine });
          if (closed) return;
          if (result.output !== lastOutput) {
            lastOutput = result.output;
            sendSseEvent(res, "output", {
              sessionId: result.sessionId,
              output: result.output,
              startLine: result.startLine ?? startLine ?? -120,
              parsed: result.parsed,
            });
          } else {
            res.write(": keepalive\n\n");
          }
        } catch (error) {
          sendSseEvent(res, "error", {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          cleanup();
        }
      };

      sendSseEvent(res, "ready", { sessionId, startLine: startLine ?? -120, intervalMs });
      await poll();
      pollTimer = setInterval(() => {
        void poll();
      }, intervalMs);
      pollTimer.unref?.();
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/threads/")) {
      const threadId = decodeURIComponent(url.pathname.slice("/threads/".length));
      const thread = readThread(threadId);
      if (!thread) {
        send(res, 404, { ok: false, error: "thread not found" });
        return;
      }
      send(res, 200, { thread, messages: readMessages(threadId) });
      return;
    }

    try {
      if (req.method === "POST" && url.pathname === "/set-status") {
        const body = (await readJson(req)) as { session: string; text: string; tone?: MetadataTone };
        updateSessionMetadata(body.session, (current) => ({
          ...current,
          status: { text: body.text, tone: body.tone },
        }));
        this.options.onChange?.();
        send(res, 200, { ok: true });
        return;
      }

      if ((req.method === "GET" || req.method === "POST") && url.pathname === "/control/open-dashboard") {
        const body =
          req.method === "POST"
            ? ((await readJson(req)) as {
                currentClientSession?: string;
                clientTty?: string;
              })
            : {};
        const currentClientSession =
          body.currentClientSession?.trim() || url.searchParams.get("currentClientSession")?.trim() || undefined;
        const clientTty = body.clientTty?.trim() || url.searchParams.get("clientTty")?.trim() || undefined;
        if (!currentClientSession) {
          send(res, 400, { ok: false, error: "currentClientSession is required" });
          return;
        }
        const tmux = new TmuxRuntimeManager();
        const { dashboardCommand, dashboardBuildStamp } = getDashboardCommandSpec(process.cwd());
        const dashboardSession = tmux.ensureProjectSession(process.cwd(), dashboardCommand);
        const openSessionName = tmux.hasSession(currentClientSession)
          ? currentClientSession
          : tmux.getOpenSessionName(dashboardSession.sessionName);
        const target = tmux.ensureDashboardWindow(openSessionName, process.cwd(), dashboardCommand);
        const currentBuildStamp = tmux.getWindowOption(target, "@aimux-dashboard-build");
        if (!tmux.isWindowAlive(target) || currentBuildStamp !== dashboardBuildStamp) {
          tmux.respawnWindow(target, dashboardCommand);
          tmux.setWindowOption(target, "@aimux-dashboard-build", dashboardBuildStamp);
        }
        openTargetForClient(tmux, target, currentClientSession, clientTty);
        send(res, 200, { ok: true });
        return;
      }

      if ((req.method === "GET" || req.method === "POST") && url.pathname === "/control/focus-window") {
        const body =
          req.method === "POST"
            ? ((await readJson(req)) as {
                currentClientSession?: string;
                clientTty?: string;
                windowId?: string;
              })
            : {};
        const currentClientSession =
          body.currentClientSession?.trim() || url.searchParams.get("currentClientSession")?.trim() || undefined;
        const clientTty = body.clientTty?.trim() || url.searchParams.get("clientTty")?.trim() || undefined;
        const windowId = body.windowId?.trim() || url.searchParams.get("windowId")?.trim() || undefined;
        if (!windowId) {
          send(res, 400, { ok: false, error: "windowId is required" });
          return;
        }
        const tmux = new TmuxRuntimeManager();
        const sessionName = currentClientSession || tmux.getProjectSession(process.cwd()).sessionName;
        const target =
          tmux.getTargetByWindowId(sessionName, windowId) ??
          tmux.getTargetByWindowId(tmux.getProjectSession(process.cwd()).sessionName, windowId);
        if (!target) {
          send(res, 404, { ok: false, error: "window not found" });
          return;
        }
        openTargetForClient(tmux, target, currentClientSession, clientTty);
        markTargetUsed(tmux, process.cwd(), target, currentClientSession);
        send(res, 200, { ok: true });
        return;
      }

      if ((req.method === "GET" || req.method === "POST") && url.pathname === "/control/switch-next") {
        const body =
          req.method === "POST"
            ? ((await readJson(req)) as {
                currentClientSession?: string;
                clientTty?: string;
                currentWindow?: string;
                currentWindowId?: string;
                currentPath?: string;
              })
            : {};
        const currentClientSession =
          body.currentClientSession?.trim() || url.searchParams.get("currentClientSession")?.trim() || undefined;
        const clientTty = body.clientTty?.trim() || url.searchParams.get("clientTty")?.trim() || undefined;
        const item = resolveNextAgent(
          {
            projectRoot: process.cwd(),
            currentClientSession,
            currentWindow: body.currentWindow?.trim() || url.searchParams.get("currentWindow")?.trim() || undefined,
            currentWindowId:
              body.currentWindowId?.trim() || url.searchParams.get("currentWindowId")?.trim() || undefined,
            currentPath: body.currentPath?.trim() || url.searchParams.get("currentPath")?.trim() || undefined,
          },
          new TmuxRuntimeManager(),
        );
        if (!item) {
          send(res, 404, { ok: false, error: "no switchable agent found" });
          return;
        }
        const tmux = new TmuxRuntimeManager();
        openTargetForClient(tmux, item.target, currentClientSession, clientTty);
        markTargetUsed(tmux, process.cwd(), item.target, currentClientSession, item.metadata.sessionId);
        send(res, 200, { ok: true });
        return;
      }

      if ((req.method === "GET" || req.method === "POST") && url.pathname === "/control/switch-prev") {
        const body =
          req.method === "POST"
            ? ((await readJson(req)) as {
                currentClientSession?: string;
                clientTty?: string;
                currentWindow?: string;
                currentWindowId?: string;
                currentPath?: string;
              })
            : {};
        const currentClientSession =
          body.currentClientSession?.trim() || url.searchParams.get("currentClientSession")?.trim() || undefined;
        const clientTty = body.clientTty?.trim() || url.searchParams.get("clientTty")?.trim() || undefined;
        const item = resolvePrevAgent(
          {
            projectRoot: process.cwd(),
            currentClientSession,
            currentWindow: body.currentWindow?.trim() || url.searchParams.get("currentWindow")?.trim() || undefined,
            currentWindowId:
              body.currentWindowId?.trim() || url.searchParams.get("currentWindowId")?.trim() || undefined,
            currentPath: body.currentPath?.trim() || url.searchParams.get("currentPath")?.trim() || undefined,
          },
          new TmuxRuntimeManager(),
        );
        if (!item) {
          send(res, 404, { ok: false, error: "no switchable agent found" });
          return;
        }
        const tmux = new TmuxRuntimeManager();
        openTargetForClient(tmux, item.target, currentClientSession, clientTty);
        markTargetUsed(tmux, process.cwd(), item.target, currentClientSession, item.metadata.sessionId);
        send(res, 200, { ok: true });
        return;
      }

      if ((req.method === "GET" || req.method === "POST") && url.pathname === "/control/switch-attention") {
        const body =
          req.method === "POST"
            ? ((await readJson(req)) as {
                currentClientSession?: string;
                clientTty?: string;
                currentWindow?: string;
                currentWindowId?: string;
                currentPath?: string;
              })
            : {};
        const currentClientSession =
          body.currentClientSession?.trim() || url.searchParams.get("currentClientSession")?.trim() || undefined;
        const clientTty = body.clientTty?.trim() || url.searchParams.get("clientTty")?.trim() || undefined;
        const item = resolveAttentionAgent(
          {
            projectRoot: process.cwd(),
            currentClientSession,
            currentWindow: body.currentWindow?.trim() || url.searchParams.get("currentWindow")?.trim() || undefined,
            currentWindowId:
              body.currentWindowId?.trim() || url.searchParams.get("currentWindowId")?.trim() || undefined,
            currentPath: body.currentPath?.trim() || url.searchParams.get("currentPath")?.trim() || undefined,
          },
          new TmuxRuntimeManager(),
        );
        if (!item) {
          send(res, 404, { ok: false, error: "no attention target found" });
          return;
        }
        const tmux = new TmuxRuntimeManager();
        openTargetForClient(tmux, item.target, currentClientSession, clientTty);
        markTargetUsed(tmux, process.cwd(), item.target, currentClientSession, item.metadata.sessionId);
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/set-progress") {
        const body = (await readJson(req)) as {
          session: string;
          current: number;
          total: number;
          label?: string;
        };
        updateSessionMetadata(body.session, (current) => ({
          ...current,
          progress: { current: body.current, total: body.total, label: body.label },
        }));
        this.options.onChange?.();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/set-context") {
        const body = (await readJson(req)) as {
          session: string;
          context: SessionContextMetadata;
        };
        updateSessionMetadata(body.session, (current) => ({
          ...current,
          context: {
            ...(current.context ?? {}),
            ...body.context,
          },
        }));
        this.options.onChange?.();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/set-services") {
        const body = (await readJson(req)) as {
          session: string;
          services: SessionServiceMetadata[];
        };
        updateSessionMetadata(body.session, (current) => ({
          ...current,
          derived: {
            ...(current.derived ?? {}),
            services: body.services,
          },
        }));
        this.options.onChange?.();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/log") {
        const body = (await readJson(req)) as {
          session: string;
          message: string;
          source?: string;
          tone?: MetadataTone;
        };
        const entry: SessionLogEntry = {
          message: body.message,
          source: body.source,
          tone: body.tone,
          ts: new Date().toISOString(),
        };
        updateSessionMetadata(body.session, (current) => ({
          ...current,
          logs: [...(current.logs ?? []).slice(-19), entry],
        }));
        this.options.onChange?.();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/event") {
        const body = (await readJson(req)) as { session: string; event: AgentEvent };
        this.tracker.emit(body.session, body.event);
        this.options.onChange?.();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/mark-seen") {
        const body = (await readJson(req)) as { session: string };
        this.tracker.markSeen(body.session);
        this.options.onChange?.();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/set-activity") {
        const body = (await readJson(req)) as { session: string; activity: AgentActivityState };
        this.tracker.setActivity(body.session, body.activity);
        this.options.onChange?.();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/set-attention") {
        const body = (await readJson(req)) as { session: string; attention: AgentAttentionState };
        this.tracker.setAttention(body.session, body.attention);
        if (body.attention === "needs_input") {
          this.emitAlert({
            kind: "needs_input",
            sessionId: body.session,
            title: `${body.session} needs input`,
            message: "Agent is waiting for input.",
            dedupeKey: `needs_input:${body.session}`,
            cooldownMs: 15_000,
          });
        } else if (body.attention === "blocked") {
          this.emitAlert({
            kind: "blocked",
            sessionId: body.session,
            title: `${body.session} is blocked`,
            message: "Agent reported a blocked state.",
            dedupeKey: `blocked:${body.session}`,
            cooldownMs: 15_000,
          });
        } else if (body.attention === "error") {
          this.emitAlert({
            kind: "task_failed",
            sessionId: body.session,
            title: `${body.session} errored`,
            message: "Agent reported an error state.",
            dedupeKey: `error:${body.session}`,
            cooldownMs: 15_000,
          });
        }
        this.options.onChange?.();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/clear-log") {
        const body = (await readJson(req)) as { session: string };
        clearSessionLogs(body.session);
        this.options.onChange?.();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/notify") {
        const body = (await readJson(req)) as {
          title?: string;
          subtitle?: string;
          message?: string;
          sessionId?: string;
          kind?: string;
          force?: boolean;
        };
        const requestedKind = body.kind?.trim();
        const kind: AlertKind =
          requestedKind === "notification" || requestedKind === "generic"
            ? "notification"
            : requestedKind === "task_done" || requestedKind === "complete"
              ? "task_done"
              : requestedKind === "task_failed" || requestedKind === "error"
                ? "task_failed"
                : requestedKind === "blocked"
                  ? "blocked"
                  : requestedKind === "message_waiting"
                    ? "message_waiting"
                    : requestedKind === "handoff_waiting"
                      ? "handoff_waiting"
                      : requestedKind === "task_assigned"
                        ? "task_assigned"
                        : requestedKind === "review_waiting"
                          ? "review_waiting"
                          : "needs_input";
        this.emitAlert({
          kind,
          sessionId: body.sessionId?.trim() || undefined,
          title: body.title?.trim() || "aimux",
          message: [body.subtitle?.trim(), body.message?.trim() || body.title?.trim() || "aimux"]
            .filter(Boolean)
            .join(" — "),
          dedupeKey: kind === "task_done" ? `notify:complete:${body.title ?? body.message ?? "aimux"}` : undefined,
          forceNotify: Boolean(body.force),
        });
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/notification-context") {
        const body = (await readJson(req)) as {
          source?: "desktop" | "tui";
          focused?: boolean;
          screen?: string;
          sessionId?: string;
          panelOpen?: boolean;
        };
        const source = body.source === "desktop" ? "desktop" : "tui";
        const context = updateNotificationContext(source, {
          focused: Boolean(body.focused),
          screen: body.screen?.trim() || undefined,
          sessionId: body.sessionId?.trim() || undefined,
          panelOpen: Boolean(body.panelOpen),
        });
        send(res, 200, { ok: true, context });
        return;
      }

      if (req.method === "POST" && url.pathname === "/notifications/read") {
        const body = (await readJson(req)) as { id?: string; sessionId?: string };
        const updated = markNotificationsRead({
          id: body.id?.trim() || undefined,
          sessionId: body.sessionId?.trim() || undefined,
        });
        send(res, 200, { ok: true, updated });
        return;
      }

      if (req.method === "POST" && url.pathname === "/notifications/clear") {
        const body = (await readJson(req)) as { id?: string; sessionId?: string };
        const cleared = clearNotifications({
          id: body.id?.trim() || undefined,
          sessionId: body.sessionId?.trim() || undefined,
        });
        send(res, 200, { ok: true, cleared });
        return;
      }

      if (req.method === "POST" && url.pathname === "/threads/open") {
        const body = (await readJson(req)) as {
          title: string;
          from: string;
          participants: string[];
          kind?: ThreadKind;
          worktreePath?: string;
        };
        const thread = createThread({
          title: body.title,
          createdBy: body.from,
          participants: [...new Set([body.from, ...(body.participants ?? [])])],
          kind: (body.kind as ThreadKind) ?? "conversation",
          worktreePath: body.worktreePath,
        });
        this.options.onChange?.();
        send(res, 200, { ok: true, thread });
        return;
      }

      if (req.method === "POST" && url.pathname === "/threads/send") {
        const body = (await readJson(req)) as {
          threadId?: string;
          from?: string;
          to?: string[];
          assignee?: string;
          tool?: string;
          worktreePath?: string;
          kind?: MessageKind;
          body: string;
          title?: string;
        };
        const result = this.options.threads?.sendMessage
          ? this.options.threads.sendMessage(body)
          : body.threadId
            ? sendThreadMessage({
                threadId: body.threadId,
                from: body.from ?? "user",
                to: body.to,
                kind: body.kind,
                body: body.body,
              })
            : sendDirectMessage({
                from: body.from ?? "user",
                to: body.to ?? [],
                kind: body.kind as any,
                body: body.body,
                title: body.title,
                worktreePath: body.worktreePath,
              });
        const messageKind = body.kind ?? "request";
        if (messageKind === "handoff") {
          const recipients = this.resolveAlertRecipients(body.to, result.message, body.to);
          this.emitThreadWaitingAlert({
            kind: "handoff_waiting",
            threadId: (result.thread as { id: string }).id,
            from: body.from ?? "user",
            recipients,
            title: `Handoff for ${recipients.join(", ") || "agent"}`,
            message: body.body.trim() || "A handoff is waiting for you.",
            worktreePath: (result.thread as { worktreePath?: string }).worktreePath ?? body.worktreePath,
          });
        } else if (messageKind === "request" || messageKind === "reply" || messageKind === "note") {
          const recipients = this.resolveAlertRecipients(body.to, result.message, body.to);
          this.emitThreadWaitingAlert({
            kind: "message_waiting",
            threadId: (result.thread as { id: string }).id,
            from: body.from ?? "user",
            recipients,
            title: `Message for ${recipients.join(", ") || "agent"}`,
            message: body.body.trim() || "A new message is waiting.",
            worktreePath: (result.thread as { worktreePath?: string }).worktreePath ?? body.worktreePath,
          });
        }
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/threads/mark-seen") {
        const body = (await readJson(req)) as { threadId: string; session: string };
        const thread = markThreadSeen(body.threadId, body.session);
        if (!thread) {
          send(res, 404, { ok: false, error: "thread not found" });
          return;
        }
        this.options.onChange?.();
        send(res, 200, { ok: true, thread });
        return;
      }

      if (req.method === "POST" && url.pathname === "/threads/status") {
        const body = (await readJson(req)) as {
          threadId: string;
          status: ThreadStatus;
          owner?: string;
          waitingOn?: string[];
        };
        const thread = setThreadStatus(body.threadId, body.status, {
          owner: body.owner?.trim(),
          waitingOn: body.waitingOn?.map((value) => value.trim()).filter(Boolean),
        });
        if (!thread) {
          send(res, 404, { ok: false, error: "thread not found" });
          return;
        }
        this.options.onChange?.();
        send(res, 200, { ok: true, thread });
        return;
      }

      if (req.method === "POST" && url.pathname === "/handoff") {
        const body = (await readJson(req)) as {
          from?: string;
          to?: string[];
          assignee?: string;
          tool?: string;
          body: string;
          title?: string;
          worktreePath?: string;
        };
        const result = this.options.actions?.sendHandoff
          ? this.options.actions.sendHandoff(body)
          : sendHandoff({
              from: body.from?.trim() || "user",
              to: body.to ?? [],
              body: body.body,
              title: body.title,
              worktreePath: body.worktreePath,
            });
        const recipients = this.resolveAlertRecipients(body.to, result.message, body.to);
        this.emitThreadWaitingAlert({
          kind: "handoff_waiting",
          threadId: (result.thread as { id: string }).id,
          from: body.from?.trim() || "user",
          recipients,
          title: `Handoff for ${recipients.join(", ") || "agent"}`,
          message: body.body.trim() || "A handoff is waiting for you.",
          worktreePath: (result.thread as { worktreePath?: string }).worktreePath ?? body.worktreePath,
        });
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/handoff/accept") {
        const body = (await readJson(req)) as { threadId: string; from?: string; body?: string };
        const result = this.options.actions?.acceptHandoff
          ? this.options.actions.acceptHandoff(body)
          : acceptHandoff({
              threadId: body.threadId,
              from: body.from?.trim() || "user",
              body: body.body,
            });
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/handoff/complete") {
        const body = (await readJson(req)) as { threadId: string; from?: string; body?: string };
        const result = this.options.actions?.completeHandoff
          ? this.options.actions.completeHandoff(body)
          : completeHandoff({
              threadId: body.threadId,
              from: body.from?.trim() || "user",
              body: body.body,
            });
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/tasks/assign") {
        const body = (await readJson(req)) as {
          from?: string;
          to?: string;
          assignee?: string;
          tool?: string;
          description: string;
          prompt?: string;
          type?: "task" | "review";
          diff?: string;
          worktreePath?: string;
        };
        const result = await assignTask({
          from: body.from?.trim() || "user",
          to: body.to?.trim(),
          assignee: body.assignee?.trim(),
          tool: body.tool?.trim(),
          description: body.description,
          prompt: body.prompt,
          type: body.type,
          diff: body.diff,
          worktreePath: body.worktreePath,
        });
        this.emitAssignedTaskAlert(result);
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/tasks/accept") {
        const body = (await readJson(req)) as { taskId: string; from?: string; body?: string };
        const result = this.options.actions?.acceptTask
          ? await this.options.actions.acceptTask(body)
          : await acceptTask({
              taskId: body.taskId,
              from: body.from?.trim() || "user",
              body: body.body,
            });
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/tasks/block") {
        const body = (await readJson(req)) as { taskId: string; from?: string; body?: string };
        const result = this.options.actions?.blockTask
          ? await this.options.actions.blockTask(body)
          : await blockTask({
              taskId: body.taskId,
              from: body.from?.trim() || "user",
              body: body.body,
            });
        this.emitAlert({
          kind: "blocked",
          sessionId: result.task.assignedTo,
          taskId: result.task.id,
          threadId: result.thread?.id,
          worktreePath: result.thread?.worktreePath,
          title: `Task blocked: ${result.task.description}`,
          message: result.task.error || body.body || "Task is blocked.",
          dedupeKey: `task-blocked:${result.task.id}`,
          cooldownMs: 15_000,
        });
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/tasks/complete") {
        const body = (await readJson(req)) as { taskId: string; from?: string; body?: string };
        const result = this.options.actions?.completeTask
          ? await this.options.actions.completeTask(body)
          : await completeTask({
              taskId: body.taskId,
              from: body.from?.trim() || "user",
              body: body.body,
            });
        this.emitAlert({
          kind: "task_done",
          sessionId: result.task.assignedTo,
          taskId: result.task.id,
          threadId: result.thread?.id,
          worktreePath: result.thread?.worktreePath,
          title: `Task done: ${result.task.description}`,
          message: body.body?.trim() || result.message?.body || "Task completed.",
          dedupeKey: `task-done:${result.task.id}`,
          cooldownMs: 15_000,
        });
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/agents/spawn") {
        const body = (await readJson(req)) as { tool: string; worktreePath?: string; open?: boolean };
        if (!this.options.lifecycle?.spawnAgent) {
          send(res, 501, { ok: false, error: "agent spawn not supported by this service" });
          return;
        }
        const result = await this.options.lifecycle.spawnAgent(body);
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/agents/fork") {
        const body = (await readJson(req)) as {
          sourceSessionId: string;
          tool: string;
          instruction?: string;
          worktreePath?: string;
          open?: boolean;
        };
        if (!this.options.lifecycle?.forkAgent) {
          send(res, 501, { ok: false, error: "agent fork not supported by this service" });
          return;
        }
        const result = await this.options.lifecycle.forkAgent(body);
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/agents/stop") {
        const body = (await readJson(req)) as { sessionId: string };
        if (!this.options.lifecycle?.stopAgent) {
          send(res, 501, { ok: false, error: "agent stop not supported by this service" });
          return;
        }
        const result = await this.options.lifecycle.stopAgent(body);
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/agents/interrupt") {
        const body = (await readJson(req)) as { sessionId: string };
        if (!this.options.lifecycle?.interruptAgent) {
          send(res, 501, { ok: false, error: "agent interrupt not supported by this service" });
          return;
        }
        const result = await this.options.lifecycle.interruptAgent(body);
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/agents/rename") {
        const body = (await readJson(req)) as { sessionId: string; label?: string };
        if (!this.options.lifecycle?.renameAgent) {
          send(res, 501, { ok: false, error: "agent rename not supported by this service" });
          return;
        }
        const result = await this.options.lifecycle.renameAgent(body);
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/agents/migrate") {
        const body = (await readJson(req)) as { sessionId: string; worktreePath: string };
        if (!this.options.lifecycle?.migrateAgent) {
          send(res, 501, { ok: false, error: "agent migrate not supported by this service" });
          return;
        }
        const result = await this.options.lifecycle.migrateAgent(body);
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/agents/kill") {
        const body = (await readJson(req)) as { sessionId: string };
        if (!this.options.lifecycle?.killAgent) {
          send(res, 501, { ok: false, error: "agent kill not supported by this service" });
          return;
        }
        const result = await this.options.lifecycle.killAgent(body);
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/agents/input") {
        const body = (await readJson(req)) as {
          sessionId: string;
          data?: string;
          parts?: AgentInputPart[];
          clientMessageId?: string;
          submit?: boolean;
        };
        if (!this.options.lifecycle?.writeAgentInput) {
          send(res, 501, { ok: false, error: "agent input not supported by this service" });
          return;
        }
        const result = await this.options.lifecycle.writeAgentInput(body);
        if (this.options.lifecycle.readAgentHistory) {
          try {
            const history = await this.options.lifecycle.readAgentHistory({ sessionId: body.sessionId, lastN: 20 });
            this.eventBus.publishHistoryUpdate({
              sessionId: history.sessionId,
              messages: history.messages,
              lastN: history.lastN,
            });
          } catch {
            // History update is best-effort; the write result should still succeed.
          }
        }
        this.options.onChange?.();
        send(res, 200, { ok: result.accepted, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/attachments") {
        const body = (await readJson(req)) as {
          path?: string;
          filename?: string;
          mimeType?: string;
          contentBase64?: string;
        };
        const attachment = body.path?.trim()
          ? ingestAttachmentFromPath(body.path)
          : ingestAttachmentFromBase64({
              filename: body.filename,
              mimeType: body.mimeType,
              contentBase64: String(body.contentBase64 ?? ""),
            });
        send(res, 200, { ok: true, attachment });
        return;
      }

      const attachmentContentMatch = url.pathname.match(/^\/attachments\/([^/]+)\/content$/);
      if (req.method === "GET" && attachmentContentMatch) {
        const content = getAttachmentContent(decodeURIComponent(attachmentContentMatch[1] || ""));
        if (!content) {
          send(res, 404, { ok: false, error: "attachment not found" });
          return;
        }
        sendBytes(res, 200, content.buffer, content.attachment.mimeType);
        return;
      }

      const attachmentMatch = url.pathname.match(/^\/attachments\/([^/]+)$/);
      if (req.method === "GET" && attachmentMatch) {
        const attachment = getAttachment(decodeURIComponent(attachmentMatch[1] || ""));
        if (!attachment) {
          send(res, 404, { ok: false, error: "attachment not found" });
          return;
        }
        send(res, 200, { ok: true, attachment });
        return;
      }

      if (req.method === "GET" && url.pathname === "/agents/output") {
        const sessionId = url.searchParams.get("sessionId")?.trim();
        const startLineRaw = url.searchParams.get("startLine");
        if (!sessionId) {
          send(res, 400, { ok: false, error: "sessionId is required" });
          return;
        }
        if (!this.options.lifecycle?.readAgentOutput) {
          send(res, 501, { ok: false, error: "agent output not supported by this service" });
          return;
        }
        const startLine =
          startLineRaw === null || startLineRaw.trim() === "" ? undefined : Number.parseInt(startLineRaw, 10);
        if (startLineRaw !== null && Number.isNaN(startLine)) {
          send(res, 400, { ok: false, error: "startLine must be an integer" });
          return;
        }
        const result = await this.options.lifecycle.readAgentOutput({ sessionId, startLine });
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "GET" && url.pathname === "/agents/history") {
        const sessionId = url.searchParams.get("sessionId")?.trim();
        const lastNRaw = url.searchParams.get("lastN");
        if (!sessionId) {
          send(res, 400, { ok: false, error: "sessionId is required" });
          return;
        }
        if (!this.options.lifecycle?.readAgentHistory) {
          send(res, 501, { ok: false, error: "agent history not supported by this service" });
          return;
        }
        const lastN = lastNRaw === null || lastNRaw.trim() === "" ? undefined : Number.parseInt(lastNRaw, 10);
        if (lastNRaw !== null && Number.isNaN(lastN)) {
          send(res, 400, { ok: false, error: "lastN must be an integer" });
          return;
        }
        const result = await this.options.lifecycle.readAgentHistory({ sessionId, lastN });
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/worktrees/create") {
        const body = (await readJson(req)) as { name: string };
        if (!this.options.desktop?.createWorktree) {
          send(res, 501, { ok: false, error: "worktree create not supported by this service" });
          return;
        }
        const result = await this.options.desktop.createWorktree(body);
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/worktrees/remove") {
        const body = (await readJson(req)) as { path: string };
        if (!this.options.desktop?.removeWorktree) {
          send(res, 501, { ok: false, error: "worktree remove not supported by this service" });
          return;
        }
        const result = await this.options.desktop.removeWorktree(body);
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/services/create") {
        const body = (await readJson(req)) as { command?: string; worktreePath?: string };
        if (!this.options.desktop?.createService) {
          send(res, 501, { ok: false, error: "service create not supported by this service" });
          return;
        }
        const result = await this.options.desktop.createService(body);
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/services/stop") {
        const body = (await readJson(req)) as { serviceId: string };
        if (!this.options.desktop?.stopService) {
          send(res, 501, { ok: false, error: "service stop not supported by this service" });
          return;
        }
        const result = await this.options.desktop.stopService(body);
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/services/resume") {
        const body = (await readJson(req)) as { serviceId: string };
        if (!this.options.desktop?.resumeService) {
          send(res, 501, { ok: false, error: "service resume not supported by this service" });
          return;
        }
        const result = await this.options.desktop.resumeService(body);
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/services/remove") {
        const body = (await readJson(req)) as { serviceId: string };
        if (!this.options.desktop?.removeService) {
          send(res, 501, { ok: false, error: "service remove not supported by this service" });
          return;
        }
        const result = await this.options.desktop.removeService(body);
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/graveyard/resurrect") {
        const body = (await readJson(req)) as { sessionId: string };
        if (!this.options.desktop?.resurrectGraveyard) {
          send(res, 501, { ok: false, error: "graveyard resurrect not supported by this service" });
          return;
        }
        const result = await this.options.desktop.resurrectGraveyard(body);
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/reviews/approve") {
        const body = (await readJson(req)) as { taskId: string; from?: string; body?: string };
        const result = this.options.actions?.approveReview
          ? await this.options.actions.approveReview(body)
          : await approveReview({
              taskId: body.taskId,
              from: body.from?.trim() || "user",
              body: body.body,
            });
        this.emitReviewOutcomeAlert({
          kind: "task_done",
          task: result.task,
          thread: result.thread,
          fallbackMessage: body.body?.trim() || result.message?.body || "Review approved.",
        });
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/reviews/request-changes") {
        const body = (await readJson(req)) as { taskId: string; from?: string; body?: string };
        const result = this.options.actions?.requestTaskChanges
          ? await this.options.actions.requestTaskChanges(body)
          : await requestTaskChanges({
              taskId: body.taskId,
              from: body.from?.trim() || "user",
              body: body.body,
            });
        this.emitReviewOutcomeAlert({
          kind: "blocked",
          task: result.task,
          thread: result.thread,
          fallbackMessage: body.body?.trim() || result.message?.body || "Changes requested.",
        });
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/tasks/reopen") {
        const body = (await readJson(req)) as { taskId: string; from?: string; body?: string };
        const result = this.options.actions?.reopenTask
          ? await this.options.actions.reopenTask(body)
          : await reopenTask({
              taskId: body.taskId,
              from: body.from?.trim() || "user",
              body: body.body,
            });
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
        return;
      }
    } catch (error) {
      send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    send(res, 404, { ok: false, error: "not found" });
  }
}
