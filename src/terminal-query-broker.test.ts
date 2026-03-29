import { describe, expect, it } from "vitest";
import { createDefaultTerminalQueryBroker } from "./terminal-query-broker.js";

describe("TerminalQueryBroker", () => {
  it("responds to cursor position and device attribute queries", () => {
    const broker = createDefaultTerminalQueryBroker();
    const reply = broker.handleOutput({ sessionId: "s1", cursor: { row: 12, col: 34 } }, "\x1b[6n\x1b[c");
    expect(reply).toBe("\x1b[12;34R\x1b[?1;2c");
  });

  it("tracks kitty keyboard flags per session", () => {
    const broker = createDefaultTerminalQueryBroker();
    expect(broker.handleOutput({ sessionId: "s1", cursor: { row: 1, col: 1 } }, "\x1b[>7u")).toBeNull();
    expect(broker.handleOutput({ sessionId: "s1", cursor: { row: 1, col: 1 } }, "\x1b[?u")).toBe("\x1b[?7u");
    broker.clearSession("s1");
    expect(broker.handleOutput({ sessionId: "s1", cursor: { row: 1, col: 1 } }, "\x1b[?u")).toBe("\x1b[?0u");
  });

  it("responds to OSC color queries in both ST and BEL forms", () => {
    const broker = createDefaultTerminalQueryBroker();
    const stReply = broker.handleOutput({ sessionId: "s1", cursor: { row: 1, col: 1 } }, "\x1b]10;?\x1b\\");
    const belReply = broker.handleOutput({ sessionId: "s1", cursor: { row: 1, col: 1 } }, "\x1b]11;?\x07");
    expect(stReply).toBe("\x1b]10;rgb:ffff/ffff/ffff\x1b\\");
    expect(belReply).toBe("\x1b]11;rgb:2020/2323/2a2a\x07");
  });
});
