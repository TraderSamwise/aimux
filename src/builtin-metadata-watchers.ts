import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getStatusDir, getHistoryDir, getRuntimeExchangePath } from "./paths.js";
import type { AimuxPluginInstance, AimuxPluginAPI } from "./plugin-runtime.js";
import { debug } from "./debug.js";
import { readAllTasks } from "./tasks.js";
import { readHistory } from "./context/history.js";
import { getPlanAuthorityDir, listPlanAuthorityEntries } from "./runtime-core/plan-authority.js";

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function sessionIdFromFile(file: string, ext: string): string | null {
  return file.endsWith(ext) ? basename(file, ext) : null;
}

function parsePlanProgress(content: string): { current: number; total: number; label?: string } | null {
  const matches = content.match(/^- \[( |x)\] /gim) ?? [];
  const total = matches.length;
  if (total === 0) return null;
  const complete = (content.match(/^- \[x\] /gim) ?? []).length;
  return { current: complete, total, label: "plan" };
}

function parseStatusHeadline(content: string): string | null {
  const first = content
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return first || null;
}

class DirectoryPoller implements AimuxPluginInstance {
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly dir: string,
    private readonly onScan: () => void,
  ) {}

  start(): void {
    mkdirSync(this.dir, { recursive: true });
    this.onScan();
    this.startPolling();
  }

  async stop(): Promise<void> {
    if (this.poller) clearInterval(this.poller);
    this.poller = null;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
  }

  private startPolling(): void {
    if (this.poller) return;
    this.poller = setInterval(() => this.scheduleScan(), 2_000);
    this.poller.unref?.();
  }

  private scheduleScan(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.onScan();
    }, 100);
    this.debounce.unref?.();
  }
}

export function createBuiltinMetadataWatchers(api: AimuxPluginAPI): AimuxPluginInstance[] {
  const { metadata } = api;
  const lastStatusBySession = new Map<string, string>();
  const lastProgressBySession = new Map<string, string>();
  const lastTaskBySession = new Map<string, string>();
  const lastHistoryBySession = new Map<string, string>();
  let taskWatcherPrimed = false;
  let historyWatcherPrimed = false;
  const planWatcher = new DirectoryPoller(getPlanAuthorityDir(), () => {
    for (const { sessionId, content } of listPlanAuthorityEntries()) {
      const progress = parsePlanProgress(content);
      if (progress) {
        const progressKey = `${progress.current}/${progress.total}/${progress.label ?? ""}`;
        if (lastProgressBySession.get(sessionId) === progressKey) continue;
        lastProgressBySession.set(sessionId, progressKey);
        metadata.setProgress(sessionId, progress.current, progress.total, progress.label);
      }
    }
  });

  const statusWatcher = new DirectoryPoller(getStatusDir(), () => {
    for (const file of existsSync(getStatusDir()) ? readdirSync(getStatusDir()) : []) {
      const sessionId = sessionIdFromFile(file, ".md");
      if (!sessionId) continue;
      const headline = parseStatusHeadline(safeRead(join(getStatusDir(), file)));
      if (headline) {
        if (lastStatusBySession.get(sessionId) === headline) continue;
        lastStatusBySession.set(sessionId, headline);
        metadata.setStatus(sessionId, headline, "info");
        metadata.emitEvent(sessionId, { kind: "status", message: headline, tone: "info", source: "status" });
      }
    }
  });

  const taskWatcher = new DirectoryPoller(dirname(getRuntimeExchangePath()), () => {
    const tasks = readAllTasks();
    const latestBySession = new Map<string, { message: string; tone?: "warn" | "success" | "error" }>();
    for (const task of tasks) {
      const sessionId = task.assignedTo ?? task.assignedBy;
      if (!sessionId) continue;
      const tone = task.status === "failed" ? "error" : task.status === "done" ? "success" : "warn";
      const prefix =
        task.status === "assigned"
          ? "Task"
          : task.status === "pending"
            ? "Queued"
            : task.status === "done"
              ? "Done"
              : "Failed";
      latestBySession.set(sessionId, { message: `${prefix}: ${task.description}`, tone });
    }
    for (const [sessionId, entry] of latestBySession) {
      if (lastTaskBySession.get(sessionId) !== entry.message) {
        lastTaskBySession.set(sessionId, entry.message);
        if (!taskWatcherPrimed) continue;
        metadata.log(sessionId, entry.message, { source: "tasks", tone: entry.tone });
        metadata.emitEvent(sessionId, {
          kind: entry.tone === "error" ? "task_failed" : entry.tone === "success" ? "task_done" : "task_assigned",
          message: entry.message,
          tone: entry.tone,
          source: "tasks",
        });
      }
    }
    taskWatcherPrimed = true;
  });

  const historyWatcher = new DirectoryPoller(getHistoryDir(), () => {
    for (const { id: sessionId } of api.sessions.list()) {
      const turns = readHistory(sessionId, { lastN: 1, maxBytes: 16 * 1024 });
      const turn = turns.at(-1);
      if (!turn) continue;
      const historyKey = `${turn.ts}:${turn.type}:${turn.content}`;
      if (lastHistoryBySession.get(sessionId) === historyKey) continue;
      lastHistoryBySession.set(sessionId, historyKey);
      if (!historyWatcherPrimed) continue;
      if (turn.type === "prompt") {
        metadata.log(sessionId, `Prompt: ${turn.content.slice(0, 80)}`, { source: "history", tone: "info" });
        metadata.emitEvent(sessionId, {
          kind: "prompt",
          message: turn.content.slice(0, 120),
          tone: "info",
          source: "history",
          ts: turn.ts,
        });
      } else if (turn.type === "response") {
        metadata.log(sessionId, `Response: ${turn.content.slice(0, 80)}`, { source: "history" });
        metadata.emitEvent(sessionId, {
          kind: "response",
          message: turn.content.slice(0, 120),
          source: "history",
          ts: turn.ts,
        });
      } else if (turn.type === "git") {
        metadata.log(sessionId, `Git: ${turn.content.slice(0, 80)}`, { source: "git", tone: "success" });
        metadata.emitEvent(sessionId, {
          kind: "notify",
          message: turn.content.slice(0, 120),
          source: "git",
          tone: "success",
          ts: turn.ts,
        });
      }
    }
    historyWatcherPrimed = true;
  });

  debug("registered builtin metadata pollers", "plugin");
  return [planWatcher, statusWatcher, taskWatcher, historyWatcher];
}
