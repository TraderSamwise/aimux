import { describe, expect, it } from "vitest";

import {
  initialAgentOutputFeedLoadedState,
  initialAgentOutputFeedTimedOutState,
  type InitialAgentOutputFeedState,
} from "./agent-output-feed-state";

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
