import { existsSync, mkdirSync, readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import { execFile, type ExecFileException } from "node:child_process";
import { getPlansDir, getStatusDir, getTasksDir, getHistoryDir } from "./paths.js";
import type { AimuxPluginInstance, AimuxPluginAPI } from "./plugin-runtime.js";
import { debug } from "./debug.js";
import { readAllTasks } from "./tasks.js";
import { listSessionIds, readHistory } from "./context/history.js";
import { TmuxRuntimeManager } from "./tmux/runtime-manager.js";
import { listWorktreesAsync } from "./worktree.js";

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

class DirectoryWatcher implements AimuxPluginInstance {
  private watcher: FSWatcher | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly dir: string,
    private readonly onScan: () => void,
  ) {}

  start(): void {
    mkdirSync(this.dir, { recursive: true });
    this.onScan();
    this.watcher = watch(this.dir, () => this.scheduleScan());
  }

  async stop(): Promise<void> {
    this.watcher?.close();
    this.watcher = null;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
  }

  private scheduleScan(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      this.onScan();
    }, 100);
  }
}

class PollingWatcher implements AimuxPluginInstance {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private rerunRequested = false;
  private stopped = false;

  constructor(
    private readonly intervalMs: number,
    private readonly onPoll: () => void | Promise<void>,
  ) {}

  start(): void {
    this.stopped = false;
    void this.runPoll();
    this.timer = setInterval(() => void this.runPoll(), this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async runPoll(): Promise<void> {
    if (this.running) {
      this.rerunRequested = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.rerunRequested = false;
        await this.onPoll();
      } while (this.rerunRequested && !this.stopped);
    } finally {
      this.running = false;
    }
  }
}

function execFileText(cwd: string, command: string, args: string[], timeoutMs = 2_000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (error: ExecFileException | null, stdout: string) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

async function gitBranch(cwd: string): Promise<string | undefined> {
  return (await execFileText(cwd, "git", ["rev-parse", "--abbrev-ref", "HEAD"])) || undefined;
}

async function gitRemote(cwd: string): Promise<string | undefined> {
  return (await execFileText(cwd, "git", ["remote", "get-url", "origin"])) || undefined;
}

function parseRemote(remote: string | undefined): { owner?: string; name?: string; remote?: string } {
  if (!remote) return {};
  const match = remote.match(/github\.com[:/](.+?)\/(.+?)(?:\.git)?$/);
  if (!match) return { remote };
  return {
    owner: match[1],
    name: match[2],
    remote,
  };
}

type PrContext = {
  number?: number;
  title?: string;
  url?: string;
  headRef?: string;
  baseRef?: string;
};

const prCache = new Map<string, { expiresAt: number; value: PrContext | null }>();

async function ghPr(cwd: string, branch: string | undefined): Promise<PrContext | undefined> {
  if (!branch) return undefined;
  const key = `${cwd}:${branch}`;
  const cached = prCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value ?? undefined;
  let value: PrContext | null = null;
  const raw = await execFileText(
    cwd,
    "gh",
    [
      "pr",
      "view",
      "--json",
      "number,title,url,headRefName,baseRefName",
      "--jq",
      "{number: .number, title: .title, url: .url, headRef: .headRefName, baseRef: .baseRefName}",
    ],
    3_000,
  );
  if (raw) {
    try {
      value = JSON.parse(raw) as PrContext;
    } catch {}
  }
  prCache.set(key, { value, expiresAt: Date.now() + 60_000 });
  return value ?? undefined;
}

export function createBuiltinMetadataWatchers(api: AimuxPluginAPI): AimuxPluginInstance[] {
  const { metadata, projectRoot } = api;
  const lastStatusBySession = new Map<string, string>();
  const lastTaskBySession = new Map<string, string>();
  const lastHistoryBySession = new Map<string, string>();
  const planWatcher = new DirectoryWatcher(getPlansDir(), () => {
    for (const file of existsSync(getPlansDir()) ? readdirSync(getPlansDir()) : []) {
      const sessionId = sessionIdFromFile(file, ".md");
      if (!sessionId) continue;
      const progress = parsePlanProgress(safeRead(join(getPlansDir(), file)));
      if (progress) {
        metadata.setProgress(sessionId, progress.current, progress.total, progress.label);
      }
    }
  });

  const statusWatcher = new DirectoryWatcher(getStatusDir(), () => {
    for (const file of existsSync(getStatusDir()) ? readdirSync(getStatusDir()) : []) {
      const sessionId = sessionIdFromFile(file, ".md");
      if (!sessionId) continue;
      const headline = parseStatusHeadline(safeRead(join(getStatusDir(), file)));
      if (headline) {
        metadata.setStatus(sessionId, headline, "info");
        if (lastStatusBySession.get(sessionId) !== headline) {
          metadata.emitEvent(sessionId, { kind: "status", message: headline, tone: "info", source: "status" });
          lastStatusBySession.set(sessionId, headline);
        }
      }
    }
  });

  const taskWatcher = new DirectoryWatcher(getTasksDir(), () => {
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
      metadata.log(sessionId, entry.message, { source: "tasks", tone: entry.tone });
      if (lastTaskBySession.get(sessionId) !== entry.message) {
        metadata.emitEvent(sessionId, {
          kind: entry.tone === "error" ? "task_failed" : entry.tone === "success" ? "task_done" : "task_assigned",
          message: entry.message,
          tone: entry.tone,
          source: "tasks",
        });
        lastTaskBySession.set(sessionId, entry.message);
      }
    }
  });

  const historyWatcher = new DirectoryWatcher(getHistoryDir(), () => {
    for (const sessionId of listSessionIds()) {
      const turns = readHistory(sessionId, { lastN: 1, maxBytes: 16 * 1024 });
      const turn = turns.at(-1);
      if (!turn) continue;
      const historyKey = `${turn.ts}:${turn.type}:${turn.content}`;
      if (turn.type === "prompt") {
        metadata.log(sessionId, `Prompt: ${turn.content.slice(0, 80)}`, { source: "history", tone: "info" });
        if (lastHistoryBySession.get(sessionId) !== historyKey) {
          metadata.emitEvent(sessionId, {
            kind: "prompt",
            message: turn.content.slice(0, 120),
            tone: "info",
            source: "history",
            ts: turn.ts,
          });
          lastHistoryBySession.set(sessionId, historyKey);
        }
      } else if (turn.type === "response") {
        metadata.log(sessionId, `Response: ${turn.content.slice(0, 80)}`, { source: "history" });
        if (lastHistoryBySession.get(sessionId) !== historyKey) {
          metadata.emitEvent(sessionId, {
            kind: "response",
            message: turn.content.slice(0, 120),
            source: "history",
            ts: turn.ts,
          });
          lastHistoryBySession.set(sessionId, historyKey);
        }
      } else if (turn.type === "git") {
        metadata.log(sessionId, `Git: ${turn.content.slice(0, 80)}`, { source: "git", tone: "success" });
        if (lastHistoryBySession.get(sessionId) !== historyKey) {
          metadata.emitEvent(sessionId, {
            kind: "notify",
            message: turn.content.slice(0, 120),
            source: "git",
            tone: "success",
            ts: turn.ts,
          });
          lastHistoryBySession.set(sessionId, historyKey);
        }
      }
    }
  });

  debug("registered builtin metadata watchers", "plugin");
  return [planWatcher, statusWatcher, taskWatcher, historyWatcher];
}
