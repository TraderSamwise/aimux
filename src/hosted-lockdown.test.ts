import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  hostedLockdownState,
  isHostedLockedDown,
  resetHostedLockdownCache,
  setHostedLockdown,
} from "./hosted-lockdown.js";
import { drainHostedOutbox, raiseHostedCliEvent, spoolHostedEvent } from "./hosted-outbox.js";
import { getHostedDir, getHostedLockdownPath, getHostedOutboxPath } from "./paths.js";
import { tailHostedAudit } from "./hosted-audit.js";
import type { HostedEvent } from "./hosted-events.js";

let previousAimuxHome: string | undefined;
let aimuxHome = "";

beforeEach(() => {
  previousAimuxHome = process.env.AIMUX_HOME;
  aimuxHome = mkdtempSync(join(tmpdir(), "aimux-hosted-lockdown-"));
  process.env.AIMUX_HOME = aimuxHome;
  resetHostedLockdownCache();
});

afterEach(() => {
  if (previousAimuxHome === undefined) delete process.env.AIMUX_HOME;
  else process.env.AIMUX_HOME = previousAimuxHome;
  rmSync(aimuxHome, { recursive: true, force: true });
  resetHostedLockdownCache();
});

describe("hosted lockdown", () => {
  it("is off until engaged, and clears again", () => {
    expect(isHostedLockedDown()).toBe(false);
    expect(hostedLockdownState()).toEqual({ active: false, since: null });

    const engaged = setHostedLockdown(true);
    expect(engaged.active).toBe(true);
    expect(isHostedLockedDown()).toBe(true);
    expect(hostedLockdownState().since).toBe(engaged.since);

    setHostedLockdown(false);
    expect(isHostedLockedDown()).toBe(false);
    expect(existsSync(getHostedLockdownPath())).toBe(false);
  });

  it("writes the marker 0600", () => {
    setHostedLockdown(true);
    expect(statSync(getHostedLockdownPath()).mode & 0o777).toBe(0o600);
  });

  it("treats an unreadable marker as locked down", () => {
    mkdirSync(getHostedDir(), { recursive: true });
    writeFileSync(getHostedLockdownPath(), "{ not json");
    // Someone put it there; fail closed rather than reopening the door.
    expect(hostedLockdownState().active).toBe(true);
    expect(isHostedLockedDown()).toBe(true);
  });

  it("stays locked down when the marker cannot be observed", () => {
    // existsSync() answers false for EVERY failure, so an unreadable directory
    // used to read as "no marker" and silently reopen the door. Only ENOENT is
    // an answer; anything else is a failure to observe and must fail closed.
    mkdirSync(getHostedDir(), { recursive: true });
    writeFileSync(getHostedLockdownPath(), "{}");
    chmodSync(getHostedDir(), 0o000);
    try {
      let denied = false;
      try {
        statSync(getHostedLockdownPath());
      } catch {
        denied = true;
      }
      // Running as root defeats the premise; there is nothing to assert then.
      if (denied) {
        resetHostedLockdownCache();
        expect(isHostedLockedDown()).toBe(true);
        expect(hostedLockdownState().active).toBe(true);
      }
    } finally {
      chmodSync(getHostedDir(), 0o700);
    }
  });

  it("caches for a second but sees a change after it expires", () => {
    expect(isHostedLockedDown(1_000)).toBe(false);
    mkdirSync(getHostedDir(), { recursive: true });
    writeFileSync(getHostedLockdownPath(), "{}");

    // Within the cache window the old answer stands.
    expect(isHostedLockedDown(1_500)).toBe(false);
    expect(isHostedLockedDown(2_500)).toBe(true);
  });
});

describe("hosted outbox", () => {
  const event = (kind: HostedEvent["kind"] = "hosted_lockdown"): HostedEvent => ({
    id: `evt_${kind}`,
    kind,
    ts: new Date().toISOString(),
    principalId: "prn_a",
    label: "cli",
    fingerprint: null,
    addressKnown: false,
    userAgent: null,
  });

  it("drains what was spooled and leaves the file empty", () => {
    spoolHostedEvent(event("hosted_token_revoked"));
    spoolHostedEvent(event("hosted_grant_changed"));

    const drained = drainHostedOutbox();
    expect(drained.map((entry) => entry.kind)).toEqual(["hosted_token_revoked", "hosted_grant_changed"]);
    expect(existsSync(getHostedOutboxPath())).toBe(false);
    expect(drainHostedOutbox()).toEqual([]);
  });

  it("skips a torn line rather than failing the drain", () => {
    spoolHostedEvent(event());
    writeFileSync(getHostedOutboxPath(), `${JSON.stringify(event())}\n{"kind":"hosted_`, { flag: "a" });

    expect(drainHostedOutbox()).toHaveLength(2);
  });

  it("records a CLI event in the audit log as well as the outbox", () => {
    raiseHostedCliEvent("hosted_token_revoked", "prn_a", "revoked via CLI");

    // Audited so the record survives whether or not a webhook is configured.
    const audited = tailHostedAudit(10);
    expect(audited.at(-1)?.event).toBe("hosted_token_revoked");
    expect(audited.at(-1)?.detail).toBe("revoked via CLI");
    expect(drainHostedOutbox().map((entry) => entry.kind)).toEqual(["hosted_token_revoked"]);
  });
});
