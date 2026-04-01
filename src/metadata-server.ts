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
  acceptTask,
  assignTask,
  blockTask,
  completeHandoff,
  completeTask,
  sendHandoff,
  type TaskLifecycleResult,
} from "./orchestration-actions.js";
import { buildWorkflowEntries } from "./workflow.js";

interface MetadataServerOptions {
  onChange?: () => void;
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
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
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
    if (req.method === "GET" && url.pathname === "/threads") {
      send(res, 200, listThreadSummaries(url.searchParams.get("session") ?? undefined));
      return;
    }
    if (req.method === "GET" && url.pathname === "/workflow") {
      send(res, 200, buildWorkflowEntries(url.searchParams.get("participant") ?? "user"));
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
    } catch (error) {
      send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    send(res, 404, { ok: false, error: "not found" });
  }
}
