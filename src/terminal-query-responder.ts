import {
  TerminalQueryBroker,
  createDefaultTerminalQueryBroker,
  type TerminalQueryContext,
  type TerminalQueryHandler,
} from "./terminal-query-broker.js";

export type { TerminalQueryContext, TerminalQueryHandler } from "./terminal-query-broker.js";

export class TerminalQueryResponder {
  private broker = createDefaultTerminalQueryBroker();

  constructor(handlers?: TerminalQueryHandler[]) {
    if (handlers) {
      this.broker = new TerminalQueryBroker(handlers);
    }
  }

  handleOutput(context: TerminalQueryContext, data: string): string | null {
    return this.broker.handleOutput(context, data);
  }

  clearSession(sessionId: string): void {
    this.broker.clearSession(sessionId);
  }
}
