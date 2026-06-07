import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is unsupported on some filesystems; the renamed file is
    // still covered by the temp-file fsync above. Best-effort only.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Crash-safe write: stage to a temp file, fsync its contents, atomically rename
 * into place, then fsync the directory so the rename itself survives power loss.
 * This is the single durable write path for persistent state.
 */
export function atomicWrite(path: string, data: string | Buffer, options?: { mode?: number }): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let fd: number | undefined;
  try {
    writeFileSync(tmpPath, data, options?.mode !== undefined ? { mode: options.mode } : undefined);
    fd = openSync(tmpPath, "r");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, path);
    fsyncDir(dirname(path));
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
    try {
      rmSync(tmpPath, { force: true });
    } catch {}
    throw error;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeTextAtomic(path: string, text: string): void {
  atomicWrite(path, text);
}
