import { beforeEach, describe, expect, it } from "vitest";

import {
  getAgentOutputReadMetrics,
  recordAgentOutputReadMetric,
  resetAgentOutputReadMetrics,
} from "./agent-output-read-metrics.js";

describe("agent output read metrics", () => {
  beforeEach(() => {
    resetAgentOutputReadMetrics();
  });

  it("counts reads by source and changed state without storing output text", () => {
    recordAgentOutputReadMetric({
      source: "output-stream",
      sessionId: "codex-1",
      requestedStartLine: -120,
      startLine: -120,
      outputBytes: 42,
      durationMs: 5,
      responseBytes: 21,
      changed: true,
    });
    recordAgentOutputReadMetric({
      source: "output-stream",
      sessionId: "codex-1",
      requestedStartLine: -120,
      startLine: -120,
      outputBytes: 42,
      responseBytes: 11,
      durationMs: 7,
      coalesced: true,
      changed: false,
    });

    const metrics = getAgentOutputReadMetrics();
    expect(metrics.total).toMatchObject({
      count: 2,
      errors: 0,
      changed: 1,
      unchanged: 1,
      coalesced: 1,
      totalOutputBytes: 84,
      maxOutputBytes: 42,
      totalResponseBytes: 32,
      maxResponseBytes: 21,
    });
    expect(metrics.bySource["output-stream"]).toMatchObject({
      count: 2,
      changed: 1,
      unchanged: 1,
      coalesced: 1,
      totalMs: 12,
    });
    expect(metrics.recent).toHaveLength(2);
    expect(JSON.stringify(metrics)).not.toContain("updated output");
  });

  it("keeps recent reads bounded", () => {
    for (let index = 0; index < 120; index += 1) {
      recordAgentOutputReadMetric({
        source: "live-pane-output",
        sessionId: `session-${index}`,
        durationMs: 1,
      });
    }

    const metrics = getAgentOutputReadMetrics();
    expect(metrics.total.count).toBe(120);
    expect(metrics.recent).toHaveLength(100);
    expect(metrics.recent[0]?.sessionId).toBe("session-20");
  });
});
