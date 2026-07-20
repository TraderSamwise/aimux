import { resolve as pathResolve } from "node:path";
import type { FastControlItem } from "./fast-control.js";
import type { ExposePreviewSnapshot } from "./project-api-contract.js";
import { TmuxRuntimeManager } from "./tmux/runtime-manager.js";
import type { TmuxTarget } from "./tmux/runtime-manager.js";

export const EXPOSE_PREVIEW_CAPTURE_LINES = 40;
const EXPOSE_PREVIEW_REFRESH_MS = 1000;
const EXPOSE_PREVIEW_ACTIVE_MS = 10_000;
const EXPOSE_PREVIEW_MAX_CAPTURE_FAILURES = 3;

type ExposePreviewTarget = Pick<FastControlItem, "id" | "target">;

export interface ExposePreviewCacheLike {
  start(): void;
  stop(): void;
  trackItems(items: ExposePreviewTarget[]): void;
  get(windowId: string): ExposePreviewSnapshot | undefined;
}

export interface ExposePreviewCacheOptions {
  projectRoot: string;
  tmux?: Pick<TmuxRuntimeManager, "captureTargetAsync">;
  listItems: () => ExposePreviewTarget[];
  intervalMs?: number;
  activeMs?: number;
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
  private readonly tmux: Pick<TmuxRuntimeManager, "captureTargetAsync">;
  private readonly intervalMs: number;
  private readonly activeMs: number;
  private readonly lineCount: number;
  private readonly now: () => Date;
  private readonly snapshots = new Map<string, ExposePreviewSnapshot>();
  private readonly trackedTargets = new Map<string, ExposePreviewTarget>();
  private readonly failureCounts = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private refreshing = false;
  private activeUntil = 0;

  constructor(private readonly options: ExposePreviewCacheOptions) {
    this.tmux = options.tmux ?? new TmuxRuntimeManager();
    this.intervalMs = options.intervalMs ?? EXPOSE_PREVIEW_REFRESH_MS;
    this.activeMs = options.activeMs ?? EXPOSE_PREVIEW_ACTIVE_MS;
    this.lineCount = options.lineCount ?? EXPOSE_PREVIEW_CAPTURE_LINES;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    registerExposePreviewCache(this.options.projectRoot, this);
  }

  stop(): void {
    this.running = false;
    unregisterExposePreviewCache(this.options.projectRoot, this);
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  trackItems(items: ExposePreviewTarget[]): void {
    this.activeUntil = this.now().getTime() + this.activeMs;
    for (const item of items) {
      this.trackedTargets.set(item.target.windowId, item);
    }
    if (items.length > 0) this.schedule(0);
  }

  get(windowId: string): ExposePreviewSnapshot | undefined {
    return this.snapshots.get(windowId);
  }

  async refreshNow(): Promise<void> {
    await this.refresh();
  }

  private schedule(delayMs = this.intervalMs): void {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, delayMs);
    this.timer.unref?.();
  }

  private listedTargets(): ExposePreviewTarget[] | null {
    try {
      return this.options.listItems();
    } catch {
      return null;
    }
  }

  private async refresh(): Promise<void> {
    if (!this.running || this.refreshing) return;
    const now = this.now().getTime();
    if (now > this.activeUntil) return;
    this.refreshing = true;
    try {
      const targets = new Map<string, ExposePreviewTarget>();
      const listedTargets = this.listedTargets();
      if (listedTargets) {
        const listedWindowIds = new Set(listedTargets.map((item) => item.target.windowId));
        for (const windowId of this.trackedTargets.keys()) {
          if (!listedWindowIds.has(windowId)) {
            this.trackedTargets.delete(windowId);
            this.failureCounts.delete(windowId);
          }
        }
        for (const windowId of this.snapshots.keys()) {
          if (!listedWindowIds.has(windowId)) {
            this.snapshots.delete(windowId);
            this.failureCounts.delete(windowId);
          }
        }
        for (const item of listedTargets) targets.set(item.target.windowId, item);
      }
      for (const item of this.trackedTargets.values()) targets.set(item.target.windowId, item);
      for (const item of targets.values()) await this.capture(item.target);
    } finally {
      this.refreshing = false;
      if (this.now().getTime() < this.activeUntil) this.schedule();
    }
  }

  private async capture(target: TmuxTarget): Promise<void> {
    try {
      const output = await this.tmux.captureTargetAsync(target, {
        startLine: -this.lineCount,
        includeEscapes: true,
      });
      this.failureCounts.delete(target.windowId);
      this.snapshots.set(target.windowId, {
        output,
        capturedAt: this.now().toISOString(),
        source: "capture",
        windowId: target.windowId,
        startLine: -this.lineCount,
        lineCount: this.lineCount,
      });
    } catch {
      const failures = (this.failureCounts.get(target.windowId) ?? 0) + 1;
      this.failureCounts.set(target.windowId, failures);
      if (failures >= EXPOSE_PREVIEW_MAX_CAPTURE_FAILURES) {
        this.trackedTargets.delete(target.windowId);
        this.snapshots.delete(target.windowId);
        this.failureCounts.delete(target.windowId);
      }
    }
  }
}
