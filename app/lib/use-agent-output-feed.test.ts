import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  initialAgentOutputFeedLoadedState,
  initialAgentOutputFeedTimedOutState,
  type InitialAgentOutputFeedState,
} from "./agent-output-feed-state";
import { agentOutputFeedRequestStartLines } from "./agent-output-feed-start-lines";

describe("initial agent output feed status", () => {
  it("keeps a loaded feed idle when the stale timeout fires", () => {
    const loaded = initialAgentOutputFeedLoadedState(
      { key: "endpoint:session:chat", status: "loading" },
      "endpoint:session:chat",
    );

    expect(initialAgentOutputFeedTimedOutState(loaded, "endpoint:session:chat")).toEqual({
      key: "endpoint:session:chat",
      status: "idle",
    });
  });

  it("ignores stale timeout callbacks from a previous feed key", () => {
    const current: InitialAgentOutputFeedState = {
      key: "endpoint:session:full",
      status: "loading",
    };

    expect(initialAgentOutputFeedTimedOutState(current, "endpoint:session:chat")).toBe(current);
  });
});

describe("agent output feed start lines", () => {
  it("uses an older startLine for one-shot history snapshots without widening the live stream", () => {
    expect(
      agentOutputFeedRequestStartLines({
        liveStartLine: -160,
        snapshotStartLine: -480,
      }),
    ).toEqual({
      snapshotStartLine: -480,
      streamStartLine: -160,
    });
  });

  it("keeps ordinary snapshots and the 500ms stream on the shallow live startLine", () => {
    expect(agentOutputFeedRequestStartLines({ liveStartLine: -160 })).toEqual({
      snapshotStartLine: -160,
      streamStartLine: -160,
    });
  });
});

describe("the feed hands over the start line it was served", () => {
  // This hook cannot be driven here -- the app has no renderer in its test
  // setup, which is why every other test in this file covers the extracted
  // pure helpers. So the one thing the pager depends on is pinned at the
  // source: without it the pager sees `undefined` for every page, reads that
  // as "nothing arrived", and stops paging after three scroll-ups.
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "use-agent-output-feed.ts"),
    "utf8",
  );

  it("reports it as the snapshot is applied", () => {
    const applied = source.indexOf("const loaded = applySnapshotResult(result);");
    expect(applied, "the snapshot is still applied here").toBeGreaterThan(0);
    const branch = source.slice(applied, source.indexOf("return loaded;", applied));
    expect(branch).toContain("options.onSnapshotApplied?.(result.startLine);");
  });

  it("reports the SERVED line, not the requested one", () => {
    // A service clamps the request to its own capture limit, so handing back
    // the request would re-create the bug this exists to fix.
    expect(source).not.toContain("onSnapshotApplied?.(options.startLine)");
    expect(source).not.toContain("onSnapshotApplied?.(requestStartLines.snapshotStartLine)");
  });
});
