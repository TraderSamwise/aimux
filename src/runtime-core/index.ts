import { createRuntimeTopologyStore, type RuntimeTopology } from "./topology-store.js";

export type RuntimeCoreOperation =
  | "agent.spawn"
  | "agent.fork"
  | "agent.createTeammate"
  | "agent.rename"
  | "agent.stop"
  | "agent.kill"
  | "agent.migrate"
  | "agent.input"
  | "agent.interrupt";

export class RuntimeCoreDisabledError extends Error {
  readonly code = "AIMUX_RUNTIME_CORE_DISABLED";
  readonly status = 501;

  constructor(readonly operation: RuntimeCoreOperation) {
    super(`runtime core replacement required for ${operation}`);
    this.name = "RuntimeCoreDisabledError";
  }
}

export interface RuntimeCore {
  spawnAgent(input: {
    toolConfigKey: string;
    targetSessionId?: string;
    targetWorktreePath?: string;
    open?: boolean;
    extraArgs?: string[];
  }): Promise<{ sessionId: string }>;
  forkAgent(input: {
    sourceSessionId: string;
    targetToolConfigKey: string;
    targetSessionId?: string;
    instruction?: string;
    targetWorktreePath?: string;
    open?: boolean;
    extraArgs?: string[];
  }): Promise<{ sessionId: string; threadId: string }>;
  createTeammateAgent(input: {
    parentSessionId: string;
    role?: string;
    label?: string;
    toolConfigKey?: string;
    targetSessionId?: string;
    targetWorktreePath?: string;
    open?: boolean;
    extraArgs?: string[];
    order?: number;
  }): Promise<{ sessionId: string; parentSessionId: string; teamId: string; role?: string; label?: string }>;
  renameAgent(input: { sessionId: string; label?: string }): Promise<{ sessionId: string; label?: string }>;
  stopAgent(input: { sessionId: string }): Promise<{ sessionId: string; status: "offline" }>;
  killAgent(input: {
    sessionId: string;
    sessionSeed?: unknown;
  }): Promise<{ sessionId: string; status: "graveyard"; previousStatus: "running" | "offline" }>;
  migrateAgent(input: {
    sessionId: string;
    targetWorktreePath: string;
  }): Promise<{ sessionId: string; worktreePath: string }>;
  writeAgentInput(input: {
    sessionId: string;
    data?: string;
    parts?: unknown[];
    clientMessageId?: string;
    submit?: boolean;
    collaboration?: unknown;
  }): Promise<{ sessionId: string; accepted: boolean; error?: string }>;
  interruptAgent(input: { sessionId: string }): Promise<{ sessionId: string }>;
  readTopology(): RuntimeTopology;
}

function disabled(operation: RuntimeCoreOperation): never {
  throw new RuntimeCoreDisabledError(operation);
}

export function createDisabledRuntimeCore(): RuntimeCore {
  return {
    async spawnAgent() {
      disabled("agent.spawn");
    },
    async forkAgent() {
      disabled("agent.fork");
    },
    async createTeammateAgent() {
      disabled("agent.createTeammate");
    },
    async renameAgent() {
      disabled("agent.rename");
    },
    async stopAgent() {
      disabled("agent.stop");
    },
    async killAgent() {
      disabled("agent.kill");
    },
    async migrateAgent() {
      disabled("agent.migrate");
    },
    async writeAgentInput() {
      disabled("agent.input");
    },
    async interruptAgent() {
      disabled("agent.interrupt");
    },
    readTopology() {
      return createRuntimeTopologyStore().read();
    },
  };
}

export const disabledRuntimeCore = createDisabledRuntimeCore();
