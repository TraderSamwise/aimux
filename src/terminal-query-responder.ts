import {
  TerminalQueryBroker,
  createDefaultTerminalQueryBroker,
  type TerminalQueryContext,
  type TerminalQueryFallback,
  type TerminalQueryHandler,
} from "./terminal-query-broker.js";

export type { TerminalQueryContext, TerminalQueryFallback, TerminalQueryHandler } from "./terminal-query-broker.js";

export class TerminalQueryResponder {
  private broker = createDefaultTerminalQueryBroker();

  constructor(handlers?: TerminalQueryHandler[], fallback?: TerminalQueryFallback) {
    if (handlers) {
      this.broker = new TerminalQueryBroker(handlers, fallback);
    } else if (fallback) {
      this.broker = createDefaultTerminalQueryBroker(fallback);
    }
  }

  async handleOutput(context: TerminalQueryContext, data: string): Promise<string | null> {
    return this.broker.handleOutput(context, data);
  }

  clearSession(sessionId: string): void {
    this.broker.clearSession(sessionId);
  }
}
