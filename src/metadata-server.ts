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
} from "./metadata-store.js";
import { notifyComplete, notifyPrompt } from "./notify.js";
import { AgentTracker } from "./agent-tracker.js";
import type { AgentActivityState, AgentAttentionState, AgentEvent } from "./agent-events.js";

interface MetadataServerOptions {
  onChange?: () => void;
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
    if (req.method === "GET" && req.url === "/health") {
      send(res, 200, { ok: true, projectStateDir: getProjectStateDir(), pid: process.pid });
      return;
    }
    if (req.method === "GET" && req.url === "/state") {
      send(res, 200, loadMetadataState());
      return;
    }

    try {
      if (req.method === "POST" && req.url === "/set-status") {
        const body = (await readJson(req)) as { session: string; text: string; tone?: MetadataTone };
        updateSessionMetadata(body.session, (current) => ({
          ...current,
          status: { text: body.text, tone: body.tone },
        }));
        this.options.onChange?.();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && req.url === "/set-progress") {
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

      if (req.method === "POST" && req.url === "/set-context") {
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

      if (req.method === "POST" && req.url === "/log") {
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

      if (req.method === "POST" && req.url === "/event") {
        const body = (await readJson(req)) as { session: string; event: AgentEvent };
        this.tracker.emit(body.session, body.event);
        this.options.onChange?.();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && req.url === "/mark-seen") {
        const body = (await readJson(req)) as { session: string };
        this.tracker.markSeen(body.session);
        this.options.onChange?.();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && req.url === "/set-activity") {
        const body = (await readJson(req)) as { session: string; activity: AgentActivityState };
        this.tracker.setActivity(body.session, body.activity);
        this.options.onChange?.();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && req.url === "/set-attention") {
        const body = (await readJson(req)) as { session: string; attention: AgentAttentionState };
        this.tracker.setAttention(body.session, body.attention);
        this.options.onChange?.();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && req.url === "/clear-log") {
        const body = (await readJson(req)) as { session: string };
        clearSessionLogs(body.session);
        this.options.onChange?.();
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && req.url === "/notify") {
        const body = (await readJson(req)) as { title?: string; message?: string; kind?: string };
        if (body.kind === "complete") notifyComplete(body.message ?? body.title ?? "aimux");
        else notifyPrompt(body.message ?? body.title ?? "aimux");
        send(res, 200, { ok: true });
        return;
      }
    } catch (error) {
      send(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    send(res, 404, { ok: false, error: "not found" });
  }
}
