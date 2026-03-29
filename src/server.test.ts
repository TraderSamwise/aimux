import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmpDir: string;
const mockPtys = new Map<string, MockPtySession>();

class MockPtySession {
  id: string;
  command: string;
  status = "running";
  exited = false;
  backendSessionId?: string;
  private exitListeners: Array<(code: number) => void> = [];

  constructor(opts: { command: string; id: string }) {
    this.command = opts.command;
    this.id = opts.id;
    mockPtys.set(this.id, this);
  }

  onData(_cb: (data: string) => void): void {}

  onExit(cb: (code: number) => void): void {
    this.exitListeners.push(cb);
  }

  resize(_cols: number, _rows: number): void {}

  write(_data: string): void {}

  getScreenState(): string {
    return "";
  }

  getTerminalSnapshot(): {
    cols: number;
    rows: number;
    cursor: { row: number; col: number };
    viewportY: number;
    baseY: number;
    startLine: number;
    lines: string[];
  } {
    return {
      cols: 120,
      rows: 40,
      cursor: { row: 1, col: 1 },
      viewportY: 0,
      baseY: 0,
      startLine: 0,
      lines: [],
    };
  }

  destroy(): void {
    this.emitExit(0);
  }

  emitExit(code: number): void {
    this.exited = true;
    this.status = "exited";
    for (const cb of this.exitListeners) cb(code);
  }
}

vi.mock("./pty-session.js", () => ({
  PtySession: MockPtySession,
}));

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
    mockPtys.clear();
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

  it("persists a server-backed session when the tool exits naturally", async () => {
    const { AimuxServer } = await import("./server.js");

    const server = new AimuxServer("/repo");
    (server as any).handleSpawn(
      { write: vi.fn() },
      {
        type: "spawn",
        id: "codex-live",
        command: "codex",
        args: ["--dangerously-bypass-approvals-and-sandbox"],
        toolConfigKey: "codex",
        backendSessionId: "backend-123",
        worktreePath: "/repo/worktrees/feature-a",
        label: "Feature A",
        cols: 120,
        rows: 40,
      },
    );

    mockPtys.get("codex-live")!.emitExit(0);

    const saved = JSON.parse(readFileSync(join(tmpDir, "state.json"), "utf-8"));
    expect(saved.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "codex-live",
          tool: "codex",
          toolConfigKey: "codex",
          command: "codex",
          args: ["--dangerously-bypass-approvals-and-sandbox"],
          backendSessionId: "backend-123",
          worktreePath: "/repo/worktrees/feature-a",
          label: "Feature A",
        }),
      ]),
    );
    expect((server as any).sessions.has("codex-live")).toBe(false);
  });

  it("does not persist a killed server-backed session", async () => {
    const { AimuxServer } = await import("./server.js");

    const server = new AimuxServer("/repo");
    (server as any).handleSpawn(
      { write: vi.fn() },
      {
        type: "spawn",
        id: "codex-killed",
        command: "codex",
        args: ["--dangerously-bypass-approvals-and-sandbox"],
        toolConfigKey: "codex",
        backendSessionId: "backend-killed",
        cols: 120,
        rows: 40,
      },
    );

    (server as any).handleKill({ type: "kill", id: "codex-killed" });

    expect((server as any).sessions.has("codex-killed")).toBe(false);
    expect(existsSync(join(tmpDir, "state.json"))).toBe(false);
  });

  it("updates and broadcasts server-backed session labels immediately", async () => {
    const { AimuxServer } = await import("./server.js");

    const writes: string[] = [];
    const server = new AimuxServer("/repo");
    (server as any).clients = new Set([
      {
        write: (data: string) => {
          writes.push(data);
        },
      },
    ]);

    (server as any).handleSpawn(
      { write: vi.fn() },
      {
        type: "spawn",
        id: "codex-live",
        command: "codex",
        args: ["--dangerously-bypass-approvals-and-sandbox"],
        toolConfigKey: "codex",
        backendSessionId: "backend-rename",
        cols: 120,
        rows: 40,
      },
    );

    (server as any).handleRename({ write: vi.fn() }, { type: "rename", id: "codex-live", label: "Cache backend" });

    expect((server as any).sessions.get("codex-live").state.label).toBe("Cache backend");

    const saved = JSON.parse(readFileSync(join(tmpDir, "state.json"), "utf-8"));
    expect(saved.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "codex-live",
          label: "Cache backend",
        }),
      ]),
    );

    expect(
      writes.some((line) => line.includes('"type":"session_updated"') && line.includes('"label":"Cache backend"')),
    ).toBe(true);
  });
});
