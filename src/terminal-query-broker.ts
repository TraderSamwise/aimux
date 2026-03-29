import { debug } from "./debug.js";

export interface TerminalQueryContext {
  sessionId: string;
  cursor: { row: number; col: number };
}

export interface TerminalQueryHandler {
  handle(context: TerminalQueryContext, data: string): string[];
  clearSession?(sessionId: string): void;
}

class KittyKeyboardHandler implements TerminalQueryHandler {
  private sessionKeyboardFlags = new Map<string, number>();

  handle(context: TerminalQueryContext, data: string): string[] {
    const replies: string[] = [];

    for (const match of data.matchAll(/\x1b\[\?(\d*)u/g)) {
      const raw = match[1];
      const flags = raw ? Number.parseInt(raw, 10) : (this.sessionKeyboardFlags.get(context.sessionId) ?? 0);
      const normalizedFlags = Number.isFinite(flags) ? flags : 0;
      replies.push(`\x1b[?${normalizedFlags}u`);
      debug(`terminal-query reply: session=${context.sessionId} kitty-flags=${normalizedFlags}`, "session");
    }

    for (const match of data.matchAll(/\x1b\[>(\d*)u/g)) {
      const raw = match[1];
      const flags = raw ? Number.parseInt(raw, 10) : 0;
      const normalizedFlags = Number.isFinite(flags) ? flags : 0;
      this.sessionKeyboardFlags.set(context.sessionId, normalizedFlags);
      debug(`terminal-query observed: session=${context.sessionId} kitty-push=${normalizedFlags}`, "session");
    }

    return replies;
  }

  clearSession(sessionId: string): void {
    this.sessionKeyboardFlags.delete(sessionId);
  }
}

class CursorPositionHandler implements TerminalQueryHandler {
  handle(context: TerminalQueryContext, data: string): string[] {
    if (!data.includes("\x1b[6n")) return [];
    debug(
      `terminal-query reply: session=${context.sessionId} cpr=${context.cursor.row},${context.cursor.col}`,
      "session",
    );
    return [`\x1b[${context.cursor.row};${context.cursor.col}R`];
  }
}

class DeviceAttributesHandler implements TerminalQueryHandler {
  handle(context: TerminalQueryContext, data: string): string[] {
    if (!data.includes("\x1b[c")) return [];
    debug(`terminal-query reply: session=${context.sessionId} da1=?1;2c`, "session");
    return ["\x1b[?1;2c"];
  }
}

class OscColorQueryHandler implements TerminalQueryHandler {
  private readonly oscQueries = [
    { code: "10", value: "rgb:ffff/ffff/ffff" },
    { code: "11", value: "rgb:2020/2323/2a2a" },
    { code: "12", value: "rgb:ffff/ffff/ffff" },
  ];

  handle(context: TerminalQueryContext, data: string): string[] {
    const replies: string[] = [];
    for (const { code, value } of this.oscQueries) {
      const st = new RegExp(`\\x1b\\]${code};\\?\\x1b\\\\`, "g");
      const bel = new RegExp(`\\x1b\\]${code};\\?\\x07`, "g");
      if (st.test(data)) {
        replies.push(`\x1b]${code};${value}\x1b\\`);
        debug(`terminal-query reply: session=${context.sessionId} osc${code}=${value}`, "session");
      }
      if (bel.test(data)) {
        replies.push(`\x1b]${code};${value}\x07`);
        debug(`terminal-query reply: session=${context.sessionId} osc${code}=${value}`, "session");
      }
    }
    return replies;
  }
}

export class TerminalQueryBroker {
  constructor(private readonly handlers: TerminalQueryHandler[]) {}

  handleOutput(context: TerminalQueryContext, data: string): string | null {
    const replies: string[] = [];
    for (const handler of this.handlers) {
      replies.push(...handler.handle(context, data));
    }
    return replies.length > 0 ? replies.join("") : null;
  }

  clearSession(sessionId: string): void {
    for (const handler of this.handlers) {
      handler.clearSession?.(sessionId);
    }
  }
}

export function createDefaultTerminalQueryBroker(): TerminalQueryBroker {
  return new TerminalQueryBroker([
    new KittyKeyboardHandler(),
    new CursorPositionHandler(),
    new DeviceAttributesHandler(),
    new OscColorQueryHandler(),
  ]);
}
