import type { ParsedAgentOutput } from "./agent-output-parser.js";
import { readAgentOutput } from "./multiplexer/session-runtime-core.js";
import type { TmuxTarget } from "./tmux/runtime-manager.js";

export interface AgentOutputParserHarnessSession {
  id: string;
  tool: string;
  output: string;
}

export interface AgentOutputParserHarnessRead {
  sessionId: string;
  output: string;
  startLine?: number;
  parsed: ParsedAgentOutput;
}

export interface AgentOutputParserHarness {
  read(sessionId: string, startLine?: number): Promise<AgentOutputParserHarnessRead>;
  readAll(startLine?: number): Promise<AgentOutputParserHarnessRead[]>;
  setOutput(sessionId: string, output: string): void;
}

export function createAgentOutputParserHarness(
  sessions: AgentOutputParserHarnessSession[],
  options: { projectRoot?: string; sessionName?: string } = {},
): AgentOutputParserHarness {
  const sessionName = options.sessionName ?? "aimux-parser-harness";
  const outputs = new Map(sessions.map((session) => [session.id, session.output]));
  const targets = new Map<string, TmuxTarget>();
  const sessionsByWindowId = new Map<string, string>();

  sessions.forEach((session, index) => {
    const target = {
      sessionName,
      windowId: `@parser-${index + 1}`,
      windowIndex: index + 1,
      windowName: session.tool,
    };
    targets.set(session.id, target);
    sessionsByWindowId.set(target.windowId, session.id);
  });

  const host = {
    sessions: sessions.map((session) => ({ id: session.id, exited: false })),
    sessionToolKeys: new Map(sessions.map((session) => [session.id, session.tool])),
    sessionTmuxTargets: targets,
    tmuxRuntimeManager: {
      captureTarget(target: TmuxTarget) {
        const sessionId = sessionsByWindowId.get(target.windowId);
        return sessionId ? (outputs.get(sessionId) ?? "") : "";
      },
    },
    projectRoot: options.projectRoot ?? "/tmp/aimux-parser-harness",
  };

  return {
    read(sessionId: string, startLine?: number) {
      return readAgentOutput(host, sessionId, startLine);
    },
    readAll(startLine?: number) {
      return Promise.all(sessions.map((session) => readAgentOutput(host, session.id, startLine)));
    },
    setOutput(sessionId: string, output: string) {
      if (!outputs.has(sessionId)) {
        throw new Error(`Unknown parser harness session "${sessionId}"`);
      }
      outputs.set(sessionId, output);
    },
  };
}
