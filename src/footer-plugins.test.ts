import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

class MockStream extends EventEmitter {}

class MockChildProcess extends EventEmitter {
  stdout = new MockStream();
  stderr = new MockStream();
  kill = vi.fn();
}

describe("footer plugins", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the location plugin immediately and resolves the GitHub PR plugin asynchronously", async () => {
    const { FooterPluginManager } = await import("./footer-plugins.js");

    spawnMock.mockImplementation((command: string, args: string[]) => {
      const child = new MockChildProcess();

      queueMicrotask(() => {
        if (command === "gh" && args[0] === "--version") {
          child.stdout.emit("data", "gh version 2.0.0");
          child.emit("close", 0);
          return;
        }
        if (command === "gh" && args[0] === "auth") {
          child.stdout.emit("data", "Logged in to github.com");
          child.emit("close", 0);
          return;
        }
        if (command === "git") {
          child.stdout.emit("data", "feat/footer-plugins\n");
          child.emit("close", 0);
          return;
        }
        if (command === "gh" && args[0] === "pr" && args[1] === "view") {
          child.stdout.emit("data", "42\thttps://github.com/acme/repo/pull/42\n");
          child.emit("close", 0);
          return;
        }

        child.emit("close", 1);
      });

      return child;
    });

    let updates = 0;
    const manager = new FooterPluginManager(["location", "github-pr"], () => {
      updates += 1;
    });

    const ctx = {
      projectCwd: "/repo",
      activeSessionId: "session-1",
      activeSessionPath: "/repo",
      locationLabel: "Main Checkout · master",
      branch: "feat/footer-plugins",
      worktreeName: "repo",
      isMainCheckout: true,
    };

    expect(manager.render(ctx)).toEqual([{ text: "main:feat/footer-plugins" }]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(updates).toBeGreaterThan(0);
    expect(manager.render(ctx)).toEqual([
      { text: "main:feat/footer-plugins" },
      { text: "#42", href: "https://github.com/acme/repo/pull/42" },
    ]);
  });
});
