import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;

vi.mock("./paths.js", () => ({
  getProjectStateDir: () => tmpDir,
  getStatePath: () => join(tmpDir, "state.json"),
}));

vi.mock("./debug.js", () => ({
  debug: () => {},
}));

function makeTmpDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "aimux-server-test-")));
}

describe("server", () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("uses project-scoped pid and socket paths", async () => {
    const { getPidPath, getSocketPath } = await import("./server.js");

    expect(getPidPath()).toBe(join(tmpDir, "aimux.pid"));
    expect(getSocketPath()).toBe(join(tmpDir, "aimux.sock"));
  });

  it("persists resumable server-backed session state", async () => {
    const { AimuxServer } = await import("./server.js");

    writeFileSync(
      join(tmpDir, "state.json"),
      JSON.stringify({
        savedAt: "2020-01-01T00:00:00.000Z",
        cwd: "/existing",
        sessions: [
          {
            id: "keep-me",
            tool: "claude",
            toolConfigKey: "claude",
            command: "claude",
            args: ["--continue"],
            backendSessionId: "other-backend",
          },
          {
            id: "replace-me",
            tool: "codex",
            toolConfigKey: "codex",
            command: "codex",
            args: ["resume", "stale"],
            backendSessionId: "shared-backend",
          },
        ],
      }),
    );

    const server = new AimuxServer("/repo");
    (server as any).sessions = new Map([
      [
        "server-session",
        {
          pty: { id: "server-session", command: "codex" },
          state: {
            id: "server-session",
            tool: "codex",
            toolConfigKey: "codex",
            command: "codex",
            args: ["resume", "shared-backend", "--full-auto"],
            backendSessionId: "shared-backend",
            worktreePath: "/repo/worktrees/feature-a",
            label: "Feature A",
          },
        },
      ],
    ]);

    (server as any).saveState();

    const saved = JSON.parse(readFileSync(join(tmpDir, "state.json"), "utf-8"));
    expect(saved.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "keep-me",
          command: "claude",
          toolConfigKey: "claude",
        }),
        expect.objectContaining({
          id: "server-session",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: ["resume", "shared-backend", "--full-auto"],
          backendSessionId: "shared-backend",
          worktreePath: "/repo/worktrees/feature-a",
          label: "Feature A",
        }),
      ]),
    );
    expect(saved.sessions.find((session: { id: string }) => session.id === "replace-me")).toBeUndefined();
  });
});
