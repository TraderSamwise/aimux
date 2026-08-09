import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearRuntimeGuardRepairAttempts,
  loadRuntimeGuardRepairAttempts,
  recordRuntimeGuardRepairAttempt,
  runtimeGuardRepairHistoryPath,
} from "./runtime-guard-repair-history.js";

const WINDOW = 120_000;
let home: string | null = null;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.AIMUX_HOME;
  home = mkdtempSync(join(tmpdir(), "aimux-guard-history-"));
  process.env.AIMUX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.AIMUX_HOME;
  else process.env.AIMUX_HOME = previousHome;
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

describe("runtime guard repair history", () => {
  it("survives the process that recorded it, which is the entire point", () => {
    // A repair reloads the dashboard, so anything held in memory is gone by the
    // time the next repair is considered. On disk it outlives the reload.
    recordRuntimeGuardRepairAttempt("/p", WINDOW);
    recordRuntimeGuardRepairAttempt("/p", WINDOW);

    expect(loadRuntimeGuardRepairAttempts("/p", WINDOW)).toHaveLength(2);
  });

  it("counts up to a limit rather than resetting", () => {
    for (let i = 0; i < 5; i += 1) recordRuntimeGuardRepairAttempt("/p", WINDOW);
    expect(loadRuntimeGuardRepairAttempts("/p", WINDOW).length).toBeGreaterThanOrEqual(5);
  });

  it("forgets attempts older than the window", () => {
    const now = 1_000_000;
    recordRuntimeGuardRepairAttempt("/p", WINDOW, now - WINDOW - 1);
    recordRuntimeGuardRepairAttempt("/p", WINDOW, now);

    expect(loadRuntimeGuardRepairAttempts("/p", WINDOW, now)).toEqual([now]);
  });

  it("keeps projects separate, so one flapping project does not spend another's budget", () => {
    recordRuntimeGuardRepairAttempt("/a", WINDOW);
    recordRuntimeGuardRepairAttempt("/a", WINDOW);
    recordRuntimeGuardRepairAttempt("/b", WINDOW);

    expect(loadRuntimeGuardRepairAttempts("/a", WINDOW)).toHaveLength(2);
    expect(loadRuntimeGuardRepairAttempts("/b", WINDOW)).toHaveLength(1);
  });

  it("normalizes the key, so the same project by another spelling is the same project", () => {
    recordRuntimeGuardRepairAttempt("/p/../p", WINDOW);
    expect(loadRuntimeGuardRepairAttempts("/p", WINDOW)).toHaveLength(1);
  });

  it("clears on request, so a settled project starts from zero", () => {
    recordRuntimeGuardRepairAttempt("/p", WINDOW);
    clearRuntimeGuardRepairAttempts("/p");
    expect(loadRuntimeGuardRepairAttempts("/p", WINDOW)).toEqual([]);
  });

  it("treats unreadable history as empty rather than blocking repair", () => {
    // The breaker exists to stop a loop, not to become one more thing that can
    // wedge recovery.
    const path = runtimeGuardRepairHistoryPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json");

    expect(loadRuntimeGuardRepairAttempts("/p", WINDOW)).toEqual([]);
    expect(() => recordRuntimeGuardRepairAttempt("/p", WINDOW)).not.toThrow();
  });

  it("reaches the limit across processes, which the in-memory counter never could", () => {
    // The loop this bounds: repair -> dashboard reload -> new process. Each
    // "process" here is just another call against the same file.
    const LIMIT = 5;
    for (let i = 0; i < LIMIT; i += 1) {
      expect(loadRuntimeGuardRepairAttempts("/p", WINDOW).length).toBeLessThan(LIMIT);
      recordRuntimeGuardRepairAttempt("/p", WINDOW);
    }
    expect(loadRuntimeGuardRepairAttempts("/p", WINDOW).length).toBeGreaterThanOrEqual(LIMIT);
  });

  it("does not grow without bound as projects come and go", () => {
    const now = 5_000_000;
    recordRuntimeGuardRepairAttempt("/gone", WINDOW, now - WINDOW - 1);
    recordRuntimeGuardRepairAttempt("/live", WINDOW, now);

    expect(loadRuntimeGuardRepairAttempts("/gone", WINDOW, now)).toEqual([]);
  });
});
