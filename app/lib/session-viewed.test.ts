import { describe, expect, it } from "vitest";

import { sessionViewedMark } from "./session-viewed";

const endpoint = { host: "127.0.0.1", port: 51513 };

describe("sessionViewedMark", () => {
  it("marks a session the viewer owns", () => {
    const mark = sessionViewedMark({
      sessionId: "  codex-1  ",
      endpoint,
      token: "t",
      sharedView: false,
    });
    expect(mark?.sessionId).toBe("codex-1");
    expect(mark?.key.split("\u0000")).toEqual(["codex-1", "127.0.0.1", "51513", "t"]);
  });

  it("does not mark anything in a shared view", () => {
    expect(
      sessionViewedMark({ sessionId: "codex-1", endpoint, token: "t", sharedView: true }),
    ).toBeNull();
  });

  it("does not mark anything without a session or a service", () => {
    expect(sessionViewedMark({ sessionId: "  ", endpoint, sharedView: false })).toBeNull();
    expect(
      sessionViewedMark({ sessionId: "codex-1", endpoint: null, sharedView: false }),
    ).toBeNull();
  });

  it("gives a different key to a different agent, service or identity", () => {
    const base = { sessionId: "codex-1", endpoint, token: "t", sharedView: false } as const;
    const key = sessionViewedMark(base)?.key;
    expect(sessionViewedMark({ ...base, sessionId: "codex-2" })?.key).not.toBe(key);
    expect(sessionViewedMark({ ...base, endpoint: { host: "127.0.0.1", port: 9 } })?.key).not.toBe(
      key,
    );
    expect(sessionViewedMark({ ...base, token: "other" })?.key).not.toBe(key);
  });
});
