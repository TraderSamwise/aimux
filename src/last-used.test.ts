import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadLastUsedState, markLastUsed } from "./last-used.js";

let previousAimuxHome: string | undefined;
let aimuxHome = "";
let projectRoot = "";

describe("last-used recency", () => {
  beforeEach(() => {
    previousAimuxHome = process.env.AIMUX_HOME;
    aimuxHome = mkdtempSync(join(tmpdir(), "aimux-last-used-home-"));
    projectRoot = mkdtempSync(join(tmpdir(), "aimux-last-used-project-"));
    process.env.AIMUX_HOME = aimuxHome;
  });

  afterEach(() => {
    if (previousAimuxHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousAimuxHome;
    rmSync(aimuxHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("keeps recent ordering monotonic when older usage marks arrive late", () => {
    markLastUsed(projectRoot, {
      itemId: "agent-a",
      clientSession: "client-1",
      usedAt: "2026-06-28T04:00:01.000Z",
    });
    markLastUsed(projectRoot, {
      itemId: "agent-b",
      clientSession: "client-1",
      usedAt: "2026-06-28T04:00:02.000Z",
    });
    markLastUsed(projectRoot, {
      itemId: "agent-a",
      clientSession: "client-1",
      usedAt: "2026-06-28T04:00:01.000Z",
    });

    const state = loadLastUsedState(projectRoot);
    expect(state.projectRecentIds.slice(0, 2)).toEqual(["agent-b", "agent-a"]);
    expect(state.clients["client-1"]?.recentIds.slice(0, 2)).toEqual(["agent-b", "agent-a"]);
    expect(state.updatedAt).toBe("2026-06-28T04:00:02.000Z");
    expect(state.clients["client-1"]?.updatedAt).toBe("2026-06-28T04:00:02.000Z");
  });

  it("does not let an older mark overwrite a newer item timestamp", () => {
    markLastUsed(projectRoot, { itemId: "agent-a", usedAt: "2026-06-28T04:00:03.000Z" });
    markLastUsed(projectRoot, { itemId: "agent-a", usedAt: "2026-06-28T04:00:01.000Z" });

    expect(loadLastUsedState(projectRoot).items["agent-a"]?.lastUsedAt).toBe("2026-06-28T04:00:03.000Z");
  });
});
