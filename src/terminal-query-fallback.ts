import { debug } from "./debug.js";
import type { TerminalHost } from "./terminal-host.js";
import type { TerminalQueryContext, TerminalQueryFallback } from "./terminal-query-broker.js";

export interface TerminalQueryFallbackPolicy {
  canForward(context: TerminalQueryContext): boolean;
}

export class HostTerminalQueryFallback implements TerminalQueryFallback {
  private inFlight = false;

  constructor(
    private readonly terminalHost: TerminalHost,
    private readonly policy: TerminalQueryFallbackPolicy,
  ) {}

  async handleUnknownQuery(context: TerminalQueryContext, query: string): Promise<string | null> {
    if (!this.policy.canForward(context)) return null;
    if (!isAllowedQuery(query)) return null;
    if (this.inFlight) {
      debug(
        `terminal-query fallback skipped: session=${context.sessionId} query=${JSON.stringify(query)} in-flight`,
        "session",
      );
      return null;
    }

    this.inFlight = true;
    try {
      debug(`terminal-query fallback forward: session=${context.sessionId} query=${JSON.stringify(query)}`, "session");
      this.terminalHost.writeQuery(query);
      const response = await this.terminalHost.waitForResponse(createResponseMatcher(query), 180);
      if (response) {
        debug(
          `terminal-query fallback reply: session=${context.sessionId} bytes=${response.length} query=${JSON.stringify(query)}`,
          "session",
        );
      } else {
        debug(
          `terminal-query fallback timeout: session=${context.sessionId} query=${JSON.stringify(query)}`,
          "session",
        );
      }
      return response;
    } finally {
      this.inFlight = false;
    }
  }
}

function isAllowedQuery(query: string): boolean {
  return (
    /^\x1b\](4|10|11|12|13|17|19|104);/.test(query) ||
    /^\x1b\]4;[0-9]+;\?\x1b\\$/.test(query) ||
    /^\x1b\]4;[0-9]+;\?\x07$/.test(query)
  );
}

function createResponseMatcher(query: string): (data: string) => boolean {
  const oscMatch = query.match(/^\x1b\]([0-9]+);([^?\x07\x1b]*\?)?(?:\x1b\\|\x07)$/);
  if (oscMatch) {
    const code = oscMatch[1];
    return (data: string) =>
      new RegExp(`\\x1b\\]${code};`).test(data) && (data.includes("\x1b\\") || data.includes("\x07"));
  }
  return () => false;
}
