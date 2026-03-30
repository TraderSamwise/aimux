import { existsSync, mkdirSync, readdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import { getPlansDir, getStatusDir } from "./paths.js";
import type { AimuxPluginInstance, AimuxMetadataAPI } from "./plugin-runtime.js";
import { debug } from "./debug.js";

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

  debug("registered builtin metadata watchers", "plugin");
  return [planWatcher, statusWatcher];
}
