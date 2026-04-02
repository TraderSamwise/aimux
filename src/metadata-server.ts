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
import { notifyComplete, notifyPrompt } from "./notify.js";
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
import type { ParsedAgentOutput } from "./agent-output-parser.js";
import type { AgentInputPart } from "./agent-message-parts.js";
import {
  getAttachment,
  getAttachmentContent,
  ingestAttachmentFromBase64,
  ingestAttachmentFromPath,
} from "./attachment-store.js";

interface MetadataServerOptions {
  onChange?: () => void;
  desktop?: {
    getState?: () => Record<string, unknown>;
    listWorktrees?: () => unknown[];
    createWorktree?: (input: { name: string }) => Promise<{ path: string }> | { path: string };
    removeWorktree?: (input: { path: string }) => Promise<{ path: string }> | { path: string };
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
      submit?: boolean;
    }) => Promise<{ sessionId: string }> | { sessionId: string };
    readAgentOutput?: (input: {
      sessionId: string;
      startLine?: number;
    }) =>
      | Promise<{ sessionId: string; output: string; startLine?: number; parsed?: ParsedAgentOutput }>
      | { sessionId: string; output: string; startLine?: number; parsed?: ParsedAgentOutput };
  };
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
  res.setHeader("connection", "close");
  res.end(payload);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, mimeType: string): void {
  res.statusCode = status;
  res.setHeader("content-type", mimeType);
  res.setHeader("content-length", body.byteLength);
  res.setHeader("cache-control", "private, max-age=31536000, immutable");
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

  constructor(private readonly options: MetadataServerOptions = {}) {}

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
  }

  getAddress(): { host: string; port: number } | null {
    if (!this.server || this.port === 0) return null;
    return { host: "127.0.0.1", port: this.port };
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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (req.method === "GET" && url.pathname === "/health") {
      send(res, 200, { ok: true, projectStateDir: getProjectStateDir(), pid: process.pid });
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
      send(res, 200, { ok: true, ...this.options.desktop.getState() });
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
        const body = (await readJson(req)) as { title?: string; message?: string; kind?: string };
        if (body.kind === "complete") notifyComplete(body.message ?? body.title ?? "aimux");
        else notifyPrompt(body.message ?? body.title ?? "aimux");
        send(res, 200, { ok: true });
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
          submit?: boolean;
        };
        if (!this.options.lifecycle?.writeAgentInput) {
          send(res, 501, { ok: false, error: "agent input not supported by this service" });
          return;
        }
        const result = await this.options.lifecycle.writeAgentInput(body);
        this.options.onChange?.();
        send(res, 200, { ok: true, ...result });
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
