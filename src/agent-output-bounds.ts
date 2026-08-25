export const DEFAULT_AGENT_OUTPUT_START_LINE = -120;
export const MAX_AGENT_OUTPUT_CAPTURE_LINES = 2_000;

export interface AgentOutputCaptureWindow {
  requestedStartLine: number;
  startLine: number;
  endLine?: number;
  maxLines: number;
  tailOnly: boolean;
  clamped: boolean;
}

export function boundedAgentOutputStartLine(startLine?: number): number {
  if (startLine === undefined) return DEFAULT_AGENT_OUTPUT_START_LINE;
  if (startLine < -MAX_AGENT_OUTPUT_CAPTURE_LINES) return -MAX_AGENT_OUTPUT_CAPTURE_LINES;
  return startLine;
}

export function boundedAgentOutputEndLine(startLine: number): number | undefined {
  if (startLine < 0) return undefined;
  return startLine + MAX_AGENT_OUTPUT_CAPTURE_LINES - 1;
}

export function agentOutputCaptureWindow(startLine?: number): AgentOutputCaptureWindow {
  const requestedStartLine = startLine ?? DEFAULT_AGENT_OUTPUT_START_LINE;
  const boundedStartLine = boundedAgentOutputStartLine(startLine);
  return {
    requestedStartLine,
    startLine: boundedStartLine,
    endLine: boundedAgentOutputEndLine(boundedStartLine),
    maxLines: MAX_AGENT_OUTPUT_CAPTURE_LINES,
    tailOnly: boundedStartLine < 0,
    clamped: requestedStartLine !== boundedStartLine,
  };
}
