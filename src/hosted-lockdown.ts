import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";

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
    // Recursive because anything at this path counts as locked, a directory
    // included — without it `lockdown off` would throw EISDIR and the door
    // could never be reopened from the CLI.
    rmSync(path, { force: true, recursive: true });
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

/**
 * Absent means absent — everything else means locked.
 *
 * `existsSync` cannot express this: it swallows every error and returns false,
 * so a directory that became unreadable reads as "no marker" and silently
 * reopens a door someone shut. Only ENOENT is an answer; the rest is a failure
 * to observe, and this fails closed on it.
 */
function markerPresent(): boolean {
  try {
    // Anything at the path counts, not just a regular file: a directory there
    // would make hostedLockdownState() report locked (readFileSync throws
    // EISDIR) while this served traffic, and the two must never disagree.
    statSync(getHostedLockdownPath());
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

export function hostedLockdownState(): HostedLockdownState {
  let raw: string;
  try {
    raw = readFileSync(getHostedLockdownPath(), "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { active: false, since: null };
    return { active: true, since: null };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HostedLockdownState>;
    return { active: true, since: typeof parsed?.since === "string" ? parsed.since : null };
  } catch {
    // A file we cannot parse still means someone put it there: fail closed.
    return { active: true, since: null };
  }
}

/** Cached for a second — this runs on every hosted request. */
export function isHostedLockedDown(now = Date.now()): boolean {
  if (cache && now - cache.at < CACHE_MS) return cache.state.active;
  const active = markerPresent();
  cache = { at: now, state: { active, since: null } };
  return active;
}

export function resetHostedLockdownCache(): void {
  cache = null;
}
