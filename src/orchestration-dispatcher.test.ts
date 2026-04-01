import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths } from "./paths.js";
import { sendDirectMessage } from "./orchestration.js";
import { OrchestrationDispatcher } from "./orchestration-dispatcher.js";
import { readMessages } from "./threads.js";

function makeSession(id: string, status: string) {
  const written: string[] = [];
  return {
    id,
    status,
    exited: false,
    write(data: string) {
      written.push(data);
    },
    written,
  };
}

describe("OrchestrationDispatcher", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-orch-dispatcher-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("delivers previously undelivered messages when the recipient becomes available", () => {
    const result = sendDirectMessage({
      from: "user",
      to: ["codex-1"],
      body: "Please pick up the parser fix.",
    });
    const session = makeSession("codex-1", "idle");
    const dispatcher = new OrchestrationDispatcher((id) => (id === "codex-1" ? session : undefined));
    dispatcher.tick(["codex-1"]);
    expect(session.written).toHaveLength(1);
    expect(session.written[0]).toContain("[AIMUX MESSAGE");
    const messages = readMessages(result.thread.id);
    expect(messages[0]?.deliveredTo).toContain("codex-1");
    expect(dispatcher.drainEvents()).toHaveLength(1);
  });

  it("does not redeliver a message once marked delivered", () => {
    const result = sendDirectMessage({
      from: "user",
      to: ["codex-1"],
      body: "Please pick up the parser fix.",
    });
    const session = makeSession("codex-1", "idle");
    const dispatcher = new OrchestrationDispatcher((id) => (id === "codex-1" ? session : undefined));
    dispatcher.tick(["codex-1"]);
    dispatcher.drainEvents();
    dispatcher.tick(["codex-1"]);
    expect(session.written).toHaveLength(1);
    const messages = readMessages(result.thread.id);
    expect(messages[0]?.deliveredTo).toEqual(["codex-1"]);
  });
});
