import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";

import { atomicWrite } from "./atomic-write.js";
import { getHostedDir, getHostedLockdownPath } from "./paths.js";

/**
 * Emergency lockdown for the hosted listener.
 *
 * Kept in a file rather than config because the CLI and the daemon are separate
 * processes and hosted config is read once at start — an operator shutting the
 * door must not have to restart the daemon to do it. The listener therefore
 * consults this on every request, behind a one-second cache so the check costs
 * a stat rather than a read.
 */

export interface HostedLockdownState {
  active: boolean;
  since: string | null;
}

const CACHE_MS = 1_000;
let cache: { at: number; state: HostedLockdownState } | null = null;

export function setHostedLockdown(active: boolean): HostedLockdownState {
  const path = getHostedLockdownPath();
  cache = null;
  if (!active) {
    rmSync(path, { force: true });
    return { active: false, since: null };
  }
  const state: HostedLockdownState = { active: true, since: new Date().toISOString() };
  // Created explicitly at 0700: atomicWrite's own mkdir uses the default mode,
  // and on a fresh box `lockdown on` can be the first thing that ever creates
  // this directory — after which a later 0700 mkdir would silently no-op.
  mkdirSync(getHostedDir(), { recursive: true, mode: 0o700 });
  atomicWrite(path, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  return state;
}

export function hostedLockdownState(): HostedLockdownState {
  const path = getHostedLockdownPath();
  if (!existsSync(path)) return { active: false, since: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<HostedLockdownState>;
    return { active: true, since: typeof parsed?.since === "string" ? parsed.since : null };
  } catch {
    // A file we cannot read still means someone put it there: fail closed.
    return { active: true, since: null };
  }
}

/** Cached for a second — this runs on every hosted request. */
export function isHostedLockedDown(now = Date.now()): boolean {
  if (cache && now - cache.at < CACHE_MS) return cache.state.active;
  let active = false;
  try {
    active = existsSync(getHostedLockdownPath()) && statSync(getHostedLockdownPath()).isFile();
  } catch {
    active = false;
  }
  cache = { at: now, state: { active, since: null } };
  return active;
}

export function resetHostedLockdownCache(): void {
  cache = null;
}
