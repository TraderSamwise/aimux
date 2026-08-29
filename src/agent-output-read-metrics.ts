export type AgentOutputReadSource =
  | "events"
  | "output-stream"
  | "live-pane-output"
  | "live-pane-attach"
  | "chat-preview";

export interface AgentOutputReadMetricInput {
  source: AgentOutputReadSource;
  sessionId: string;
  requestedStartLine?: number;
  startLine?: number;
  endLine?: number;
  captureLineLimit?: number;
  outputBytes?: number;
  responseBytes?: number;
  durationMs: number;
  coalesced?: boolean;
  changed?: boolean;
  error?: string;
}

export interface AgentOutputReadSourceMetrics {
  count: number;
  errors: number;
  changed: number;
  unchanged: number;
  unknownChange: number;
  coalesced: number;
  totalMs: number;
  maxMs: number;
  totalOutputBytes: number;
  maxOutputBytes: number;
  totalResponseBytes: number;
  maxResponseBytes: number;
  lastAt: string | null;
}

export interface AgentOutputReadRecentMetric extends AgentOutputReadMetricInput {
  at: string;
}

export interface AgentOutputReadMetricsSnapshot {
  total: AgentOutputReadSourceMetrics;
  bySource: Record<string, AgentOutputReadSourceMetrics>;
  recent: AgentOutputReadRecentMetric[];
}

const MAX_RECENT_AGENT_OUTPUT_READS = 100;

function emptySourceMetrics(): AgentOutputReadSourceMetrics {
  return {
    count: 0,
    errors: 0,
    changed: 0,
    unchanged: 0,
    unknownChange: 0,
    coalesced: 0,
    totalMs: 0,
    maxMs: 0,
    totalOutputBytes: 0,
    maxOutputBytes: 0,
    totalResponseBytes: 0,
    maxResponseBytes: 0,
    lastAt: null,
  };
}

let total = emptySourceMetrics();
let bySource = new Map<string, AgentOutputReadSourceMetrics>();
let recent: AgentOutputReadRecentMetric[] = [];

function accumulate(target: AgentOutputReadSourceMetrics, input: AgentOutputReadMetricInput, at: string): void {
  target.count += 1;
  if (input.error) target.errors += 1;
  if (input.changed === true) target.changed += 1;
  else if (input.changed === false) target.unchanged += 1;
  else target.unknownChange += 1;
  if (input.coalesced) target.coalesced += 1;
  target.totalMs += input.durationMs;
  target.maxMs = Math.max(target.maxMs, input.durationMs);
  const outputBytes = input.outputBytes ?? 0;
  target.totalOutputBytes += outputBytes;
  target.maxOutputBytes = Math.max(target.maxOutputBytes, outputBytes);
  const responseBytes = input.responseBytes ?? 0;
  target.totalResponseBytes += responseBytes;
  target.maxResponseBytes = Math.max(target.maxResponseBytes, responseBytes);
  target.lastAt = at;
}

export function recordAgentOutputReadMetric(input: AgentOutputReadMetricInput): void {
  const at = new Date().toISOString();
  accumulate(total, input, at);
  let source = bySource.get(input.source);
  if (!source) {
    source = emptySourceMetrics();
    bySource.set(input.source, source);
  }
  accumulate(source, input, at);
  recent.push({ ...input, at });
  if (recent.length > MAX_RECENT_AGENT_OUTPUT_READS) {
    recent = recent.slice(-MAX_RECENT_AGENT_OUTPUT_READS);
  }
}

export function getAgentOutputReadMetrics(): AgentOutputReadMetricsSnapshot {
  const sourceRecord: Record<string, AgentOutputReadSourceMetrics> = {};
  for (const [key, value] of [...bySource.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs)) {
    sourceRecord[key] = { ...value };
  }
  return {
    total: { ...total },
    bySource: sourceRecord,
    recent: recent.map((entry) => ({ ...entry })),
  };
}

export function resetAgentOutputReadMetrics(): void {
  total = emptySourceMetrics();
  bySource = new Map();
  recent = [];
}
