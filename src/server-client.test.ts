import { describe, expect, it } from "vitest";
import { ServerSession } from "./server-client.js";
import { SessionTerminalState } from "./session-terminal-state.js";

async function settleTerminal(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("ServerSession snapshot hydration", () => {
  it("restores the same visible viewport from a structured terminal snapshot", async () => {
    const source = new SessionTerminalState(40, 8);
    source.write("> write me a poem\r\n");
    source.write(
      [
        "The branch was young, the night was thin,",
        "We pulled new master slowly in.",
        "No conflict cracked, no red lines burned,",
        "Just two small commits, cleanly turned.",
        "",
        "Now local glass on 8123",
        "Holds a chart in latency.",
        "A skeleton with signal breath,",
        "A shape still warm from recent depth.",
      ].join("\r\n"),
    );
    await settleTerminal();

    const expected = source.getDebugState();
    const snapshot = source.exportSnapshot();

    const session = new ServerSession("test", "codex", { send() {} } as any, 40, 8);
    await session._hydrateSnapshot(snapshot);

    expect(session.getDebugState()).toEqual(expected);
    expect(session.getScreenState()).toBe(source.getScreenState());
  });
});
