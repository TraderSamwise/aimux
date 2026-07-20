import { resolve as pathResolve } from "node:path";
import type { FastControlItem } from "./fast-control.js";
import type { ExposePreviewSnapshot } from "./project-api-contract.js";
import { TmuxRuntimeManager } from "./tmux/runtime-manager.js";
import type { TmuxTarget } from "./tmux/runtime-manager.js";

export const EXPOSE_PREVIEW_CAPTURE_LINES = 40;
const EXPOSE_PREVIEW_REFRESH_MS = 1000;

type ExposePreviewTarget = Pick<FastControlItem, "id" | "target">;

export interface ExposePreviewCacheLike {
  start(): void;
  stop(): void;
  trackItems(items: ExposePreviewTarget[]): void;
  get(windowId: string): ExposePreviewSnapshot | undefined;
}

export interface ExposePreviewCacheOptions {
  projectRoot: string;
  tmux?: Pick<TmuxRuntimeManager, "captureTarget">;
  listItems: () => ExposePreviewTarget[];
  intervalMs?: number;
  lineCount?: number;
  now?: () => Date;
}

const cachesByProjectRoot = new Map<string, ExposePreviewCacheLike>();

function normalizedProjectRoot(projectRoot: string): string {
  return pathResolve(projectRoot);
}

export function getExposePreviewSnapshot(projectRoot: string, windowId: string): ExposePreviewSnapshot | undefined {
  return cachesByProjectRoot.get(normalizedProjectRoot(projectRoot))?.get(windowId);
}

function registerExposePreviewCache(projectRoot: string, cache: ExposePreviewCacheLike): void {
  cachesByProjectRoot.set(normalizedProjectRoot(projectRoot), cache);
}

function unregisterExposePreviewCache(projectRoot: string, cache: ExposePreviewCacheLike): void {
  const normalized = normalizedProjectRoot(projectRoot);
  if (cachesByProjectRoot.get(normalized) === cache) cachesByProjectRoot.delete(normalized);
}

export class ExposePreviewCache implements ExposePreviewCacheLike {
  private readonly tmux: Pick<TmuxRuntimeManager, "captureTarget">;
  private readonly intervalMs: number;
  private readonly lineCount: number;
  private readonly now: () => Date;
  private readonly snapshots = new Map<string, ExposePreviewSnapshot>();
  private readonly trackedTargets = new Map<string, ExposePreviewTarget>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private refreshing = false;

  constructor(private readonly options: ExposePreviewCacheOptions) {
    this.tmux = options.tmux ?? new TmuxRuntimeManager();
    this.intervalMs = options.intervalMs ?? EXPOSE_PREVIEW_REFRESH_MS;
    this.lineCount = options.lineCount ?? EXPOSE_PREVIEW_CAPTURE_LINES;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    registerExposePreviewCache(this.options.projectRoot, this);
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    unregisterExposePreviewCache(this.options.projectRoot, this);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  trackItems(items: ExposePreviewTarget[]): void {
    for (const item of items) {
      this.trackedTargets.set(item.target.windowId, item);
    }
  }

  get(windowId: string): ExposePreviewSnapshot | undefined {
    return this.snapshots.get(windowId);
  }

  refreshNow(): void {
    this.refresh();
  }

  private schedule(delayMs = this.intervalMs): void {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.refresh();
    }, delayMs);
    this.timer.unref?.();
  }

  private listedTargets(): ExposePreviewTarget[] {
    try {
      return this.options.listItems();
    } catch {
      return [];
    }
  }

  private refresh(): void {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const targets = new Map<string, ExposePreviewTarget>();
      for (const item of this.listedTargets()) targets.set(item.target.windowId, item);
      for (const item of this.trackedTargets.values()) targets.set(item.target.windowId, item);
      for (const item of targets.values()) this.capture(item.target);
    } finally {
      this.refreshing = false;
      this.schedule();
    }
  }

  private capture(target: TmuxTarget): void {
    try {
      const output = this.tmux.captureTarget(target, {
        startLine: -this.lineCount,
        includeEscapes: true,
      });
      this.snapshots.set(target.windowId, {
        output,
        capturedAt: this.now().toISOString(),
        source: "capture",
        windowId: target.windowId,
        startLine: -this.lineCount,
        lineCount: this.lineCount,
      });
    } catch {
      return;
    }
  }
}
