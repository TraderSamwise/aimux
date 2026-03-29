import { describe, expect, it } from "vitest";
import { TerminalQueryBroker, createDefaultTerminalQueryBroker } from "./terminal-query-broker.js";
import { HostTerminalQueryFallback } from "./terminal-query-fallback.js";

describe("TerminalQueryBroker", () => {
  it("responds to cursor position and device attribute queries", async () => {
    const broker = createDefaultTerminalQueryBroker();
    const reply = await broker.handleOutput({ sessionId: "s1", cursor: { row: 12, col: 34 } }, "\x1b[6n\x1b[c");
    expect(reply).toBe("\x1b[12;34R\x1b[?1;2c");
  });

  it("tracks kitty keyboard flags per session", async () => {
    const broker = createDefaultTerminalQueryBroker();
    expect(await broker.handleOutput({ sessionId: "s1", cursor: { row: 1, col: 1 } }, "\x1b[>7u")).toBeNull();
    expect(await broker.handleOutput({ sessionId: "s1", cursor: { row: 1, col: 1 } }, "\x1b[?u")).toBe("\x1b[?7u");
    broker.clearSession("s1");
    expect(await broker.handleOutput({ sessionId: "s1", cursor: { row: 1, col: 1 } }, "\x1b[?u")).toBe("\x1b[?0u");
  });

  it("responds to OSC color queries in both ST and BEL forms", async () => {
    const broker = createDefaultTerminalQueryBroker();
    const stReply = await broker.handleOutput({ sessionId: "s1", cursor: { row: 1, col: 1 } }, "\x1b]10;?\x1b\\");
    const belReply = await broker.handleOutput({ sessionId: "s1", cursor: { row: 1, col: 1 } }, "\x1b]11;?\x07");
    expect(stReply).toBe("\x1b]10;rgb:ffff/ffff/ffff\x1b\\");
    expect(belReply).toBe("\x1b]11;rgb:2020/2323/2a2a\x07");
  });

  it("can delegate unknown queries to a fallback", async () => {
    const broker = new TerminalQueryBroker([], {
      handleUnknownQuery: async (_context, query) =>
        query === "\x1b]4;1;?\x1b\\" ? "\x1b]4;1;rgb:ffff/0000/0000\x1b\\" : null,
    });
    const reply = await broker.handleOutput({ sessionId: "s1", cursor: { row: 1, col: 1 } }, "\x1b]4;1;?\x1b\\");
    expect(reply).toBe("\x1b]4;1;rgb:ffff/0000/0000\x1b\\");
  });

  it("host fallback only forwards allowlisted queries", async () => {
    const writes: string[] = [];
    const fallback = new HostTerminalQueryFallback(
      {
        writeQuery: (data: string) => {
          writes.push(data);
        },
        waitForResponse: async () => "\x1b]4;1;rgb:ffff/0000/0000\x1b\\",
      } as any,
      {
        canForward: () => true,
      },
    );

    const allowed = await fallback.handleUnknownQuery(
      { sessionId: "s1", cursor: { row: 1, col: 1 } },
      "\x1b]4;1;?\x1b\\",
    );
    const denied = await fallback.handleUnknownQuery({ sessionId: "s1", cursor: { row: 1, col: 1 } }, "\x1b[5n");

    expect(allowed).toBe("\x1b]4;1;rgb:ffff/0000/0000\x1b\\");
    expect(denied).toBeNull();
    expect(writes).toEqual(["\x1b]4;1;?\x1b\\"]);
  });
});
