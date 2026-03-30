import { debug } from "./debug.js";
import {
  TerminalQueryResponder,
  type TerminalQueryObservation,
  type TerminalQueryObserver,
} from "./terminal-query-responder.js";

export interface SessionOutputContext {
  id: string;
  command: string;
  write: (data: string) => void;
  getCursorPosition: () => { row: number; col: number };
}

export class SessionOutputPipeline {
  private sessionFirstOutputTrace = new Map<string, number>();
  private codexOutputTraceCounts = new Map<string, number>();
  private unsupportedQueryCounts = new Map<string, Map<string, number>>();
  private terminalQueryResponder: TerminalQueryResponder;
  private queryObservationLogger: TerminalQueryObserver = {
    onQuery: (observation) => this.handleQueryObservation(observation),
  };

  constructor(terminalQueryResponder?: TerminalQueryResponder) {
    this.terminalQueryResponder =
      terminalQueryResponder ?? new TerminalQueryResponder(undefined, undefined, this.queryObservationLogger);
  }

  getQueryObserver(): TerminalQueryObserver {
    return this.queryObservationLogger;
  }

  setTerminalQueryResponder(terminalQueryResponder: TerminalQueryResponder): void {
    this.terminalQueryResponder = terminalQueryResponder;
  }

  trackSessionStart(sessionId: string, startedAt: number): void {
    this.sessionFirstOutputTrace.set(sessionId, startedAt);
  }

  clearSession(sessionId: string): void {
    this.sessionFirstOutputTrace.delete(sessionId);
    this.codexOutputTraceCounts.delete(sessionId);
    this.unsupportedQueryCounts.delete(sessionId);
    this.terminalQueryResponder.clearSession(sessionId);
  }

  async handleOutput(session: SessionOutputContext, data: string): Promise<void> {
    if (session.command === "codex") {
      const count = this.codexOutputTraceCounts.get(session.id) ?? 0;
      if (count < 12) {
        debug(
          `codex-output[${count + 1}] session=${session.id} bytes=${data.length} chunk=${this.formatOutputChunkForDebug(data)}`,
          "session",
        );
        this.codexOutputTraceCounts.set(session.id, count + 1);
      }
    }

    const queryReply = await this.terminalQueryResponder.handleOutput(
      { sessionId: session.id, cursor: session.getCursorPosition() },
      data,
    );
    if (queryReply) {
      session.write(queryReply);
    }

    const createdAt = this.sessionFirstOutputTrace.get(session.id);
    if (createdAt !== undefined) {
      debug(
        `session-first-output: session=${session.id} dt=${Date.now() - createdAt}ms bytes=${data.length}`,
        "session",
      );
      this.sessionFirstOutputTrace.delete(session.id);
    }
  }

  private formatOutputChunkForDebug(data: string): string {
    return JSON.stringify(
      data.replace(/\x1b/g, "\\x1b").replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t"),
    );
  }

  private handleQueryObservation(observation: TerminalQueryObservation): void {
    if (observation.resolved || observation.strategy !== "unsupported") return;
    const perSession = this.unsupportedQueryCounts.get(observation.sessionId) ?? new Map<string, number>();
    const key = observation.queryId ?? observation.query;
    const nextCount = (perSession.get(key) ?? 0) + 1;
    perSession.set(key, nextCount);
    this.unsupportedQueryCounts.set(observation.sessionId, perSession);
    if (nextCount <= 3) {
      debug(
        `terminal-query unsupported-summary: session=${observation.sessionId} query=${JSON.stringify(observation.query)} count=${nextCount}`,
        "session",
      );
    }
  }
}
