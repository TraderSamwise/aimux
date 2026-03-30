import type { AimuxPluginAPI, AimuxPluginInstance } from "./plugin-runtime.js";
import type { AgentEvent } from "./agent-events.js";

export interface AgentWatcherContext {
  api: AimuxPluginAPI;
}

export interface AgentWatcher extends AimuxPluginInstance {
  readonly name: string;
}

export interface AgentObservation {
  sessionId: string;
  tool: string;
  event?: AgentEvent;
  activity?: import("./agent-events.js").AgentActivityState;
  attention?: import("./agent-events.js").AgentAttentionState;
}
