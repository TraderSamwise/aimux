import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { FastControlItem } from "./fast-control.js";
import { TmuxRuntimeManager } from "./tmux/runtime-manager.js";
import type { TmuxTarget } from "./tmux/runtime-manager.js";

export const EXPOSE_PANE_TAP_ACTIVE_MS = 10_000;
export const EXPOSE_PANE_TAP_MAX_BYTES = 128_000;
export const EXPOSE_PANE_TAP_MAINTENANCE_MS = 1000;

type ExposePaneOutputTapTarget = Pick<FastControlItem, "id" | "target">;
type TrackedExposePaneOutputTap = ExposePaneOutputTapTarget & {
  expiresAt: number;
  filePath: string;
  token: string;
  tokenFilePath: string;
};

interface TapOwnershipToken {
  token: string;
  pid?: number;
}

export interface ExposePaneOutputTapSnapshot {
  output: string;
  capturedAt: string;
  source: "tap";
  windowId: string;
  byteCount: number;
}

export interface ExposePaneOutputTapLike {
  start(): void;
  stop(): void;
  trackItems(items: ExposePaneOutputTapTarget[]): void;
  read(windowId: string, maxBytes?: number): ExposePaneOutputTapSnapshot | undefined;
}

export interface ExposePaneOutputTapOptions {
  projectStateDir: string;
  tmux?: Pick<TmuxRuntimeManager, "isPanePiped" | "pipeTargetToFile" | "stopPanePipe">;
  activeMs?: number;
  maxBytes?: number;
  maintenanceMs?: number;
  now?: () => Date;
}

export class ExposePaneOutputTap implements ExposePaneOutputTapLike {
  private readonly tmux: Pick<TmuxRuntimeManager, "isPanePiped" | "pipeTargetToFile" | "stopPanePipe">;
  private readonly activeMs: number;
  private readonly maxBytes: number;
  private readonly maintenanceMs: number;
  private readonly now: () => Date;
  private readonly tapDir: string;
  private readonly trackedTargets = new Map<string, TrackedExposePaneOutputTap>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly options: ExposePaneOutputTapOptions) {
    this.tmux = options.tmux ?? new TmuxRuntimeManager();
    this.activeMs = options.activeMs ?? EXPOSE_PANE_TAP_ACTIVE_MS;
    this.maxBytes = options.maxBytes ?? EXPOSE_PANE_TAP_MAX_BYTES;
    this.maintenanceMs = Math.max(1, options.maintenanceMs ?? EXPOSE_PANE_TAP_MAINTENANCE_MS);
    this.now = options.now ?? (() => new Date());
    this.tapDir = join(options.projectStateDir, "expose-pane-taps");
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    try {
      mkdirSync(this.tapDir, { recursive: true });
    } catch {}
  }

  stop(): void {
    this.running = false;
    this.clearTimer();
    const tracked = [...this.trackedTargets.values()];
    this.trackedTargets.clear();
    for (const item of tracked) this.stopTracked(item);
  }

  trackItems(items: ExposePaneOutputTapTarget[]): void {
    if (!this.running) return;
    const now = this.now().getTime();
    this.pruneExpired(now);
    if (items.length === 0) return;

    try {
      mkdirSync(this.tapDir, { recursive: true });
    } catch {
      return;
    }
    const expiresAt = now + this.activeMs;
    for (const item of items) {
      const current = this.trackedTargets.get(item.target.windowId);
      if (current && sameTarget(current.target, item.target) && existsSync(current.filePath)) {
        current.id = item.id;
        current.expiresAt = expiresAt;
        this.compactFile(current.filePath);
        continue;
      }
      if (current) {
        this.trackedTargets.delete(item.target.windowId);
        this.stopTracked(current);
      }
      this.startTracked(item, expiresAt);
    }
    this.scheduleMaintenance();
  }

  read(windowId: string, maxBytes = this.maxBytes): ExposePaneOutputTapSnapshot | undefined {
    this.pruneExpired(this.now().getTime());
    const current = this.trackedTargets.get(windowId);
    if (!current) return undefined;
    const limit = Math.min(Math.max(0, maxBytes), this.maxBytes);
    if (limit <= 0) return undefined;
    const tail = readTail(current.filePath, limit);
    if (!tail || tail.buffer.length === 0) return undefined;
    if (tail.totalBytes > this.maxBytes) this.compactFile(current.filePath);
    return {
      output: tail.buffer.toString("utf8"),
      capturedAt: this.now().toISOString(),
      source: "tap",
      windowId,
      byteCount: tail.buffer.length,
    };
  }

  private startTracked(item: ExposePaneOutputTapTarget, expiresAt: number): void {
    let filePath: string | undefined;
    let tokenFilePath: string | undefined;
    try {
      filePath = this.tapFilePath(item.target.windowId);
      tokenFilePath = this.tapTokenFilePath(item.target.windowId);
      if (this.tmux.isPanePiped(item.target)) {
        this.adoptExistingTap(item, expiresAt, filePath, tokenFilePath);
        return;
      }
      const token = randomUUID();
      rmSync(filePath, { force: true });
      rmSync(tokenFilePath, { force: true });
      writeFileSync(filePath, "");
      this.tmux.pipeTargetToFile(item.target, filePath, {
        onlyIfNotPiped: true,
        ownership: { token, tokenFilePath },
      });
      if (!waitForOwnershipToken(tokenFilePath, token)) {
        rmSync(filePath, { force: true });
        rmSync(tokenFilePath, { force: true });
        return;
      }
      this.trackedTargets.set(item.target.windowId, { ...item, expiresAt, filePath, token, tokenFilePath });
    } catch {
      if (filePath) {
        try {
          rmSync(filePath, { force: true });
        } catch {}
      }
      if (tokenFilePath) {
        try {
          rmSync(tokenFilePath, { force: true });
        } catch {}
      }
    }
  }

  private adoptExistingTap(
    item: ExposePaneOutputTapTarget,
    expiresAt: number,
    filePath: string,
    tokenFilePath: string,
  ): void {
    const ownership = readOwnershipToken(tokenFilePath);
    if (!ownership || !isOwnershipLive(ownership)) {
      removeDeadTapFiles(filePath, tokenFilePath);
      return;
    }
    this.trackedTargets.set(item.target.windowId, {
      ...item,
      expiresAt,
      filePath,
      token: ownership.token,
      tokenFilePath,
    });
  }

  private stopTracked(item: TrackedExposePaneOutputTap): void {
    if (ownsToken(item.tokenFilePath, item.token)) {
      try {
        this.tmux.stopPanePipe(item.target);
      } catch {}
    }
    try {
      rmSync(item.filePath, { force: true });
    } catch {}
    try {
      rmSync(item.tokenFilePath, { force: true });
    } catch {}
  }

  private scheduleMaintenance(): void {
    if (!this.running || this.timer || this.trackedTargets.size === 0) return;
    const now = this.now().getTime();
    const nextExpiry = Math.min(...[...this.trackedTargets.values()].map((item) => item.expiresAt));
    this.timer = setTimeout(
      () => {
        this.timer = null;
        const currentTime = this.now().getTime();
        this.pruneExpired(currentTime);
        this.compactTrackedFiles(currentTime);
        this.scheduleMaintenance();
      },
      Math.max(0, Math.min(this.maintenanceMs, nextExpiry - now)),
    );
    this.timer.unref?.();
  }

  private pruneExpired(now: number): void {
    for (const [windowId, item] of this.trackedTargets) {
      if (now < item.expiresAt) continue;
      this.trackedTargets.delete(windowId);
      this.stopTracked(item);
    }
    if (this.trackedTargets.size === 0) this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private compactFile(filePath: string): void {
    const tail = readTail(filePath, this.maxBytes);
    if (!tail || tail.totalBytes <= this.maxBytes) return;
    try {
      writeFileSync(filePath, tail.buffer);
    } catch {}
  }

  private tapFilePath(windowId: string): string {
    const hash = createHash("sha256").update(windowId).digest("hex").slice(0, 16);
    return join(this.tapDir, `${hash}.log`);
  }

  private tapTokenFilePath(windowId: string): string {
    const hash = createHash("sha256").update(windowId).digest("hex").slice(0, 16);
    return join(this.tapDir, `${hash}.token`);
  }

  private compactTrackedFiles(now: number): void {
    for (const item of this.trackedTargets.values()) {
      if (now < item.expiresAt) this.compactFile(item.filePath);
    }
  }
}

function sameTarget(left: TmuxTarget, right: TmuxTarget): boolean {
  return left.windowId === right.windowId;
}

function readTail(filePath: string, maxBytes: number): { buffer: Buffer; totalBytes: number } | null {
  let fd: number | null = null;
  try {
    const totalBytes = statSync(filePath).size;
    const byteCount = Math.min(totalBytes, maxBytes);
    const buffer = Buffer.alloc(byteCount);
    fd = openSync(filePath, "r");
    const bytesRead = readSync(fd, buffer, 0, byteCount, totalBytes - byteCount);
    return { buffer: bytesRead === byteCount ? buffer : buffer.subarray(0, bytesRead), totalBytes };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

function ownsToken(tokenFilePath: string, token: string): boolean {
  const ownership = readOwnershipToken(tokenFilePath);
  return Boolean(ownership && ownership.token === token && isOwnershipLive(ownership));
}

function readOwnershipToken(tokenFilePath: string): TapOwnershipToken | null {
  try {
    const raw = readFileSync(tokenFilePath, "utf8").trim();
    if (!raw) return null;
    const [first, second] = raw.split(/\s+/, 2);
    if (second && /^\d+$/.test(first)) return { pid: Number(first), token: second };
    return { token: raw };
  } catch {
    return null;
  }
}

function waitForOwnershipToken(tokenFilePath: string, token: string): boolean {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (ownsToken(tokenFilePath, token)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
  return false;
}

function isOwnershipLive(ownership: TapOwnershipToken): boolean {
  if (!ownership.pid) return true;
  try {
    process.kill(ownership.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function removeDeadTapFiles(filePath: string, tokenFilePath: string): void {
  try {
    rmSync(filePath, { force: true });
  } catch {}
  try {
    rmSync(tokenFilePath, { force: true });
  } catch {}
}
