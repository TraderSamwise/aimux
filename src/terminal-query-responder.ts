import {
  TerminalQueryBroker,
  createDefaultTerminalQueryBroker,
  type TerminalQueryContext,
  type TerminalQueryFallback,
  type TerminalQueryHandler,
  type TerminalQueryObserver,
} from "./terminal-query-broker.js";

export type {
  TerminalQueryContext,
  TerminalQueryFallback,
  TerminalQueryHandler,
  TerminalQueryObservation,
  TerminalQueryObserver,
} from "./terminal-query-broker.js";

export class TerminalQueryResponder {
  private broker = createDefaultTerminalQueryBroker();

  constructor(handlers?: TerminalQueryHandler[], fallback?: TerminalQueryFallback, observer?: TerminalQueryObserver) {
    if (handlers) {
      this.broker = new TerminalQueryBroker(handlers, fallback, observer);
    } else if (fallback) {
      this.broker = createDefaultTerminalQueryBroker(fallback, observer);
    } else if (observer) {
      this.broker = createDefaultTerminalQueryBroker(undefined, observer);
    }
  }

  async handleOutput(context: TerminalQueryContext, data: string): Promise<string | null> {
    return this.broker.handleOutput(context, data);
  }

  clearSession(sessionId: string): void {
    this.broker.clearSession(sessionId);
  }
}
