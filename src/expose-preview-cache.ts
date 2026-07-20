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
type TrackedExposePreviewTarget = ExposePreviewTarget & { expiresAt: number; generation: number };

export interface ExposePreviewCacheLike {
  start(): void;
  stop(): void;
  trackItems(items: ExposePreviewTarget[]): void;
  get(windowId: string): ExposePreviewSnapshot | undefined;
}

export interface ExposePreviewCacheOptions {
  projectRoot: string;
  tmux?: Pick<TmuxRuntimeManager, "captureTargetAsync">;
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

export function trackExposePreviewItems(projectRoot: string, items: ExposePreviewTarget[]): void {
  cachesByProjectRoot.get(normalizedProjectRoot(projectRoot))?.trackItems(items);
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
  private readonly trackedTargets = new Map<string, TrackedExposePreviewTarget>();
  private readonly failureCounts = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private refreshing = false;
  private refreshPending = false;
  private generation = 0;

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
    const now = this.now().getTime();
    this.pruneExpired(now);
    const expiresAt = now + this.activeMs;
    let changed = false;
    const nextGeneration = this.generation + 1;
    for (const item of items) {
      const current = this.trackedTargets.get(item.target.windowId);
      if (current && sameTarget(current.target, item.target)) {
        current.id = item.id;
        current.expiresAt = expiresAt;
        continue;
      }
      if (current) {
        this.snapshots.delete(item.target.windowId);
        this.failureCounts.delete(item.target.windowId);
      }
      this.trackedTargets.set(item.target.windowId, { ...item, expiresAt, generation: nextGeneration });
      changed = true;
    }
    if (changed) this.generation += 1;
    if (items.length > 0) this.schedule(0);
  }

  get(windowId: string): ExposePreviewSnapshot | undefined {
    this.pruneExpired(this.now().getTime());
    return this.snapshots.get(windowId);
  }

  async refreshNow(): Promise<void> {
    await this.refresh();
  }

  private schedule(delayMs = this.intervalMs): void {
    if (!this.running) return;
    if (this.refreshing) {
      if (delayMs === 0) this.refreshPending = true;
      return;
    }
    if (this.timer) {
      if (delayMs !== 0) return;
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, delayMs);
    this.timer.unref?.();
  }

  private async refresh(): Promise<void> {
    const now = this.now().getTime();
    if (!this.running) return;
    if (this.refreshing) {
      this.refreshPending = true;
      return;
    }
    this.pruneExpired(now);
    if (this.trackedTargets.size === 0) return;
    this.refreshing = true;
    const refreshGeneration = this.generation;
    try {
      const targets = [...this.trackedTargets.values()];
      for (const item of targets) {
        if (this.generation !== refreshGeneration) break;
        if (this.now().getTime() >= item.expiresAt || this.trackedTargets.get(item.target.windowId) !== item) continue;
        await this.capture(item);
      }
    } finally {
      this.refreshing = false;
      this.pruneExpired(this.now().getTime());
      if (this.refreshPending) {
        this.refreshPending = false;
        this.schedule(0);
      } else if (this.trackedTargets.size > 0) {
        this.schedule();
      }
    }
  }

  private async capture(item: TrackedExposePreviewTarget): Promise<void> {
    const { target } = item;
    try {
      const output = await this.tmux.captureTargetAsync(target, {
        startLine: -this.lineCount,
        includeEscapes: true,
      });
      if (!this.isCurrentTarget(item)) return;
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
      if (!this.isCurrentTarget(item)) return;
      const failures = (this.failureCounts.get(target.windowId) ?? 0) + 1;
      this.failureCounts.set(target.windowId, failures);
      if (failures >= EXPOSE_PREVIEW_MAX_CAPTURE_FAILURES) {
        this.trackedTargets.delete(target.windowId);
        this.snapshots.delete(target.windowId);
        this.failureCounts.delete(target.windowId);
      }
    }
  }

  private isCurrentTarget(item: TrackedExposePreviewTarget): boolean {
    const current = this.trackedTargets.get(item.target.windowId);
    return Boolean(
      current &&
      current.generation === item.generation &&
      this.now().getTime() < current.expiresAt &&
      sameTarget(current.target, item.target),
    );
  }

  private pruneExpired(now: number): void {
    let changed = false;
    for (const [windowId, item] of this.trackedTargets) {
      if (now < item.expiresAt) continue;
      this.trackedTargets.delete(windowId);
      this.snapshots.delete(windowId);
      this.failureCounts.delete(windowId);
      changed = true;
    }
    if (changed) this.generation += 1;
  }
}

function sameTarget(left: TmuxTarget, right: TmuxTarget): boolean {
  return left.windowId === right.windowId;
}
