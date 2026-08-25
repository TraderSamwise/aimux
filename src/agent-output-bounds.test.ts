import { describe, expect, it } from "vitest";

import {
  agentOutputCaptureWindow,
  boundedAgentOutputEndLine,
  boundedAgentOutputStartLine,
  DEFAULT_AGENT_OUTPUT_START_LINE,
  MAX_AGENT_OUTPUT_CAPTURE_LINES,
} from "./agent-output-bounds.js";

describe("agent output bounds", () => {
  it("defaults missing output requests to a short recent tail", () => {
    expect(boundedAgentOutputStartLine()).toBe(DEFAULT_AGENT_OUTPUT_START_LINE);
  });

  it("caps large negative scrollback requests", () => {
    expect(boundedAgentOutputStartLine(-999_999)).toBe(-MAX_AGENT_OUTPUT_CAPTURE_LINES);
  });

  it("leaves valid recent and absolute start lines intact", () => {
    expect(boundedAgentOutputStartLine(-80)).toBe(-80);
    expect(boundedAgentOutputStartLine(25)).toBe(25);
  });

  it("uses an explicit end line for absolute reads only", () => {
    expect(boundedAgentOutputEndLine(-80)).toBeUndefined();
    expect(boundedAgentOutputEndLine(0)).toBe(MAX_AGENT_OUTPUT_CAPTURE_LINES - 1);
    expect(boundedAgentOutputEndLine(25)).toBe(25 + MAX_AGENT_OUTPUT_CAPTURE_LINES - 1);
  });

  it("describes bounded capture windows for clients", () => {
    expect(agentOutputCaptureWindow(-999_999)).toEqual({
      requestedStartLine: -999_999,
      startLine: -MAX_AGENT_OUTPUT_CAPTURE_LINES,
      endLine: undefined,
      maxLines: MAX_AGENT_OUTPUT_CAPTURE_LINES,
      tailOnly: true,
      clamped: true,
    });
    expect(agentOutputCaptureWindow(25)).toEqual({
      requestedStartLine: 25,
      startLine: 25,
      endLine: 25 + MAX_AGENT_OUTPUT_CAPTURE_LINES - 1,
      maxLines: MAX_AGENT_OUTPUT_CAPTURE_LINES,
      tailOnly: false,
      clamped: false,
    });
  });
});
