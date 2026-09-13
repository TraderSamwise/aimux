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
