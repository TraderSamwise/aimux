import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The pane is cached; what the session is doing is not.
 *
 * readAgentOutput memoises the parse and the projection against the exact pane
 * text, because a still pane is the common case. Activity is deliberately read
 * outside that memo: an agent that finishes leaves its last frame on screen, so
 * a value cached behind a text comparison would report "running" forever. This
 * is the only place that distinction is visible, and it is silent when wrong.
 */

let derived: { activity?: string; attention?: string } | undefined;

vi.mock("../metadata-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../metadata-store.js")>();
  return {
    ...actual,
    loadMetadataState: () => ({ version: 1, sessions: { "codex-1": { derived } } }),
  };
});

const { readAgentOutput } = await import("./session-runtime-core.js");

function hostWithPane(text: string) {
  const target = { sessionName: "aimux-test", windowId: "@1" };
  return {
    projectRoot: "/tmp/aimux-liveness-test",
    sessions: [{ id: "codex-1", exited: false }],
    sessionTmuxTargets: new Map([["codex-1", target]]),
    sessionToolKeys: new Map([["codex-1", "codex"]]),
    tmuxRuntimeManager: { captureTarget: () => text },
  } as any;
}

describe("readAgentOutput liveness", () => {
  beforeEach(() => {
    derived = undefined;
  });

  it("reports fresh activity even when the pane is byte-for-byte identical", async () => {
    const host = hostWithPane("nothing about this pane changes");

    derived = { activity: "running" };
    const first = await readAgentOutput(host, "codex-1");
    expect(first.activity).toBe("running");

    derived = { activity: "done" };
    const second = await readAgentOutput(host, "codex-1");

    // The transcript came from the memo — same pane, same objects…
    expect(second.messages).toBe(first.messages);
    // …and the activity did not.
    expect(second.activity).toBe("done");
  });

  it("leaves activity undefined when the session has no derived state", async () => {
    const host = hostWithPane("some output");
    const result = await readAgentOutput(host, "codex-1");

    expect(result.activity).toBeUndefined();
    expect(result.attention).toBeUndefined();
  });

  it("still projects the pane into messages", async () => {
    const host = hostWithPane("> hello\n\nHi there");
    const result = await readAgentOutput(host, "codex-1");

    expect(Array.isArray(result.messages)).toBe(true);
  });
});
