import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initPaths } from "./paths.js";
import { AgentTracker } from "./agent-tracker.js";
import { loadMetadataState } from "./metadata-store.js";

describe("AgentTracker", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-agent-tracker-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("derives running prompt and done response state", () => {
    const tracker = new AgentTracker();
    tracker.emit("s1", { kind: "prompt", message: "do the work" }, repoRoot);
    tracker.emit("s1", { kind: "task_done", message: "Done: auth" }, repoRoot);

    const derived = loadMetadataState(repoRoot).sessions.s1?.derived;
    expect(derived?.activity).toBe("done");
    expect(derived?.attention).toBe("normal");
    expect(derived?.unseenCount).toBe(1);
    expect(derived?.lastEvent?.kind).toBe("task_done");
  });

  it("tracks needs-input attention and clears unseen on seen", () => {
    const tracker = new AgentTracker();
    tracker.emit(
      "s1",
      { kind: "needs_input", message: "Need your approval", threadId: "t-1", threadName: "Approval" },
      repoRoot,
    );
    tracker.markSeen("s1", repoRoot);

    const derived = loadMetadataState(repoRoot).sessions.s1?.derived;
    expect(derived?.activity).toBe("waiting");
    expect(derived?.attention).toBe("needs_input");
    expect(derived?.unseenCount).toBe(0);
    expect(derived?.threadId).toBe("t-1");
    expect(derived?.threadName).toBe("Approval");
  });

  it("tracks failed tasks as error attention", () => {
    const tracker = new AgentTracker();
    tracker.emit("s1", { kind: "task_failed", message: "Failed: tests", tone: "error" }, repoRoot);

    const derived = loadMetadataState(repoRoot).sessions.s1?.derived;
    expect(derived?.activity).toBe("error");
    expect(derived?.attention).toBe("error");
    expect(derived?.unseenCount).toBe(1);
  });
});
