import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getLastUsedPath, loadLastUsedState, markLastUsed } from "./last-used.js";

let previousAimuxHome: string | undefined;
let aimuxHome = "";
let projectRoot = "";

function seededLastUsedState(entries: Array<readonly [string, { lastUsedAt: string }]>, clientSession = "client-1") {
  const recentIds = entries.map(([itemId]) => itemId).reverse();
  return {
    version: 1,
    items: Object.fromEntries(entries),
    clients: {
      [clientSession]: {
        recentIds,
        items: Object.fromEntries(entries),
        updatedAt: entries.at(-1)?.[1].lastUsedAt ?? "",
      },
    },
    projectRecentIds: recentIds,
  };
}

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

  it("keeps each client's recency independent from other clients using the same item", () => {
    markLastUsed(projectRoot, {
      itemId: "agent-a",
      clientSession: "client-1",
      usedAt: "2026-06-28T04:00:01.000Z",
    });
    markLastUsed(projectRoot, {
      itemId: "agent-a",
      clientSession: "client-2",
      usedAt: "2026-06-28T04:00:03.000Z",
    });
    markLastUsed(projectRoot, {
      itemId: "agent-b",
      clientSession: "client-1",
      usedAt: "2026-06-28T04:00:02.000Z",
    });

    const state = loadLastUsedState(projectRoot);
    expect(state.projectRecentIds.slice(0, 2)).toEqual(["agent-a", "agent-b"]);
    expect(state.clients["client-1"]?.recentIds.slice(0, 2)).toEqual(["agent-b", "agent-a"]);
    expect(state.clients["client-2"]?.recentIds.slice(0, 1)).toEqual(["agent-a"]);
  });

  it("prunes per-client item timestamps to the recent id limit", () => {
    const path = getLastUsedPath(projectRoot);
    mkdirSync(join(path, ".."), { recursive: true });
    const seededEntries = Array.from({ length: 69 }, (_, index) => {
      const itemId = `agent-${index}`;
      return [itemId, { lastUsedAt: new Date(Date.UTC(2026, 5, 28, 4, 0, index)).toISOString() }] as const;
    });
    writeFileSync(path, JSON.stringify(seededLastUsedState(seededEntries)));

    markLastUsed(projectRoot, {
      itemId: "agent-69",
      clientSession: "client-1",
      usedAt: "2026-06-28T04:01:09.000Z",
    });

    const client = loadLastUsedState(projectRoot).clients["client-1"];
    expect(client?.recentIds).toHaveLength(64);
    expect(Object.keys(client?.items ?? {})).toHaveLength(64);
    expect(client?.items["agent-69"]?.lastUsedAt).toBe("2026-06-28T04:01:09.000Z");
    expect(client?.items["agent-0"]).toBeUndefined();
  });

  it("seeds legacy client recency timestamps from saved order", () => {
    const path = getLastUsedPath(projectRoot);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        items: {
          "agent-a": { lastUsedAt: "2026-06-28T04:00:01.000Z" },
          "agent-b": { lastUsedAt: "2026-06-28T04:00:02.000Z" },
        },
        clients: {
          "client-1": {
            recentIds: ["agent-a", "agent-b"],
            updatedAt: "2026-06-28T04:00:03.000Z",
          },
        },
        projectRecentIds: ["agent-b", "agent-a"],
      }),
    );

    markLastUsed(projectRoot, {
      itemId: "agent-b",
      clientSession: "client-1",
      usedAt: "2026-06-28T04:00:02.000Z",
    });

    expect(loadLastUsedState(projectRoot).clients["client-1"]?.recentIds.slice(0, 2)).toEqual(["agent-a", "agent-b"]);
  });
});
