import { existsSync, mkdirSync, readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import { getPlansDir, getStatusDir, getTasksDir, getHistoryDir } from "./paths.js";
import type { AimuxPluginInstance, AimuxMetadataAPI } from "./plugin-runtime.js";
import { debug } from "./debug.js";
import { readAllTasks } from "./tasks.js";
import { listSessionIds, readHistory } from "./context/history.js";

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

export function createBuiltinMetadataWatchers(metadata: AimuxMetadataAPI): AimuxPluginInstance[] {
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
    }
  });

  const historyWatcher = new DirectoryWatcher(getHistoryDir(), () => {
    for (const sessionId of listSessionIds()) {
      const turns = readHistory(sessionId, { lastN: 1, maxBytes: 16 * 1024 });
      const turn = turns.at(-1);
      if (!turn) continue;
      if (turn.type === "prompt") {
        metadata.log(sessionId, `Prompt: ${turn.content.slice(0, 80)}`, { source: "history", tone: "info" });
      } else if (turn.type === "response") {
        metadata.log(sessionId, `Response: ${turn.content.slice(0, 80)}`, { source: "history" });
      } else if (turn.type === "git") {
        metadata.log(sessionId, `Git: ${turn.content.slice(0, 80)}`, { source: "git", tone: "success" });
      }
    }
  });

  debug("registered builtin metadata watchers", "plugin");
  return [planWatcher, statusWatcher, taskWatcher, historyWatcher];
}
