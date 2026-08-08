import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";

import { getHostedDir } from "./paths.js";

/**
 * Exclusive file lock for hosted-mode state.
 *
 * Both stores this guards are read-modify-write and both are consulted by the
 * request path, so a lost update is not a cosmetic problem: on the principal
 * store it can un-revoke a token, and on the device store it can emit a
 * duplicate "first use" alert or drop a device and alert again later.
 */

const RETRY_MS = 25;
const TIMEOUT_MS = 5_000;
const STALE_MS = 30_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` while holding the lock for `targetPath`.
 *
 * Returns null without running when `wait` is false and the lock is held, or
 * when a bounded `timeoutMs` expires. Callers reached from a request must use
 * one or the other: the wait is a synchronous `Atomics.wait`, and the default
 * five seconds of it would stall every other thing the daemon is serving.
 */
export function withHostedLock<T>(
  targetPath: string,
  fn: () => T,
  options: { wait?: boolean; timeoutMs?: number } = {},
): T | null {
  const wait = options.wait !== false;
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + (options.timeoutMs ?? TIMEOUT_MS);
  mkdirSync(getHostedDir(), { recursive: true, mode: 0o700 });

  let fd: number | null = null;
  let token = "";
  for (;;) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      // Ownership stamp: a stale-lock stealer must not delete a lock some other
      // process has since legitimately taken.
      token = `${process.pid}.${randomBytes(8).toString("hex")}`;
      writeSync(fd, token);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_MS) rmSync(lockPath, { force: true });
      } catch {
        // Released between our open and stat; retry.
      }
      if (!wait) return null;
      if (Date.now() > deadline) throw new Error("hosted state is locked", { cause: error });
      sleepSync(RETRY_MS);
    }
  }

  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      if (readFileSync(lockPath, "utf-8") === token) rmSync(lockPath, { force: true });
    } catch {
      // Already gone, or now someone else's — either way not ours to remove.
    }
  }
}
