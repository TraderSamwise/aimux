import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runTmuxExpose } from "./expose.js";

vi.mock("./runtime-manager.js", () => ({
  isDashboardWindowName: (name: string) => name === "dashboard" || name.startsWith("dashboard-"),
  isMetaDashboardWindowName: (name: string) => name === "meta-dashboard" || name.startsWith("meta-dashboard-"),
  TmuxRuntimeManager: class {
    captureTarget(): string {
      return "agent output\n";
    }
  },
}));

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tempRoots.length) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sendJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function waitForOutput(output: PassThrough, pattern: string, ms = 1000): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve) => {
      let seen = "";
      const onData = (chunk: Buffer) => {
        seen += chunk.toString("utf8");
        if (seen.includes(pattern)) {
          output.off("data", onData);
          resolve();
        }
      };
      output.on("data", onData);
    }),
    ms,
  );
}

function readNextOutput(output: PassThrough, ms = 1000): Promise<string> {
  return withTimeout(
    new Promise<string>((resolve) => {
      output.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
    }),
    ms,
  );
}

describe("runTmuxExpose", () => {
  it("returns the relaunch code when the controlling client size changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-expose-resize-test-"));
    tempRoots.push(root);
    const projectStateDir = join(root, "state");
    const binDir = join(root, "bin");
    mkdirSync(projectStateDir);
    mkdirSync(binDir);
    const tmuxPath = join(binDir, "tmux");
    const tmuxLog = join(root, "tmux.log");
    writeFileSync(
      tmuxPath,
      `#!/bin/sh
printf '%s\\n' "$*" >> "${tmuxLog}"
if [ "$1" = "display-message" ]; then
  printf '100x30'
  exit 0
fi
exit 0
`,
    );
    chmodSync(tmuxPath, 0o755);

    const server = createServer((_req, res) => {
      sendJson(res, {
        ok: true,
        items: [
          {
            id: "session-1",
            label: "codex",
            urgency: 0,
            activity: 0,
            recentRank: 0,
            target: { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "codex" },
            metadata: {
              kind: "agent",
              sessionId: "session-1",
              command: "codex",
              args: [],
              toolConfigKey: "codex",
              worktreePath: "/repo",
            },
          },
        ],
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(join(projectStateDir, "metadata-api.txt"), `${endpoint}\n`);
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { columns: number; rows: number };
    output.columns = 80;
    output.rows = 24;
    output.on("data", () => {});
    const oldPath = process.env.PATH;
    process.env.PATH = `${binDir}:${oldPath ?? ""}`;

    try {
      await expect(
        withTimeout(
          runTmuxExpose({
            projectRoot: "/repo",
            projectStateDir,
            currentWindow: "codex",
            currentWindowId: "@1",
            currentPath: "/repo",
            clientTty: "/dev/ttys001",
            input,
            output,
            manageTerminal: false,
            columns: 80,
            rows: 24,
            exposeConfig: { initialScope: "project" },
          }),
          1500,
        ),
      ).resolves.toBe(75);
      expect(readFileSync(tmuxLog, "utf8")).toContain(
        "display-message -c /dev/ttys001 -p -F #{client_width}x#{client_height}",
      );
    } finally {
      process.env.PATH = oldPath;
      server.close();
      input.destroy();
      output.destroy();
    }
  });

  it("honors Enter received before the API-backed item list resolves", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-expose-render-test-"));
    tempRoots.push(root);
    const projectStateDir = join(root, "state");
    mkdirSync(projectStateDir);

    const switchableRequested = deferred();
    const allowSwitchableResponse = deferred();
    const server = createServer(async (req, res) => {
      if (req.url?.startsWith("/control/switchable-agents")) {
        switchableRequested.resolve();
        await allowSwitchableResponse.promise;
        sendJson(res, {
          ok: true,
          items: [
            {
              id: "session-1",
              label: "codex",
              urgency: 0,
              activity: 0,
              recentRank: 0,
              target: { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "codex" },
              metadata: {
                kind: "agent",
                sessionId: "session-1",
                command: "codex",
                args: [],
                toolConfigKey: "codex",
                worktreePath: "/repo",
              },
            },
            {
              id: "session-2",
              label: "claude",
              urgency: 0,
              activity: 0,
              recentRank: 1,
              target: { sessionName: "aimux-test", windowId: "@2", windowIndex: 2, windowName: "claude" },
              metadata: {
                kind: "agent",
                sessionId: "session-2",
                command: "claude",
                args: [],
                toolConfigKey: "claude",
                worktreePath: "/repo",
              },
            },
          ],
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(join(projectStateDir, "metadata-api.txt"), `${endpoint}\n`);
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { columns: number; rows: number };
    output.columns = 80;
    output.rows = 24;
    output.on("data", () => {});
    const selectionFile = join(root, "selected-window");

    try {
      const result = runTmuxExpose({
        projectRoot: "/repo",
        projectStateDir,
        currentWindow: "claude",
        currentWindowId: "@2",
        currentPath: "/repo",
        input,
        output,
        manageTerminal: false,
        columns: 80,
        rows: 24,
        selectionFile,
        exposeConfig: { initialScope: "project" },
      });

      await switchableRequested.promise;
      input.write("\x1b[I\r");
      allowSwitchableResponse.resolve();

      await expect(withTimeout(result, 1000)).resolves.toBe(0);
      expect(readFileSync(selectionFile, "utf8")).toBe("@2\n");
    } finally {
      server.close();
      input.destroy();
      output.destroy();
    }
  });

  it("falls back to the project-service focus route when no selection file is provided", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-expose-focus-fallback-test-"));
    tempRoots.push(root);
    const projectStateDir = join(root, "state");
    mkdirSync(projectStateDir);

    let focusedWindow = "";
    const focusRequested = deferred();
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/control/switchable-agents")) {
        sendJson(res, {
          ok: true,
          items: [
            {
              id: "session-1",
              label: "codex",
              urgency: 0,
              activity: 0,
              recentRank: 0,
              target: { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "codex" },
              metadata: {
                kind: "agent",
                sessionId: "session-1",
                command: "codex",
                args: [],
                toolConfigKey: "codex",
                worktreePath: "/repo",
              },
            },
          ],
        });
        return;
      }
      if (req.url?.startsWith("/control/focus-window")) {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString("utf8");
        });
        req.on("end", () => {
          focusedWindow = (JSON.parse(body) as { windowId?: string }).windowId ?? "";
          focusRequested.resolve();
          sendJson(res, { ok: true });
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(join(projectStateDir, "metadata-api.txt"), `${endpoint}\n`);
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { columns: number; rows: number };
    output.columns = 80;
    output.rows = 24;
    output.on("data", () => {});

    try {
      const result = runTmuxExpose({
        projectRoot: "/repo",
        projectStateDir,
        currentWindow: "codex",
        currentWindowId: "@1",
        currentPath: "/repo",
        currentClientSession: "aimux-test-client-12345678",
        clientTty: "/dev/ttys001",
        input,
        output,
        manageTerminal: false,
        columns: 80,
        rows: 24,
        exposeConfig: { initialScope: "project" },
      });

      await waitForOutput(output, "codex");
      input.write("\r");

      await focusRequested.promise;
      await expect(withTimeout(result, 1000)).resolves.toBe(0);
      expect(focusedWindow).toBe("@1");
    } finally {
      server.close();
      input.destroy();
      output.destroy();
    }
  });

  it("recovers when queued Enter resolves to a failed project-service focus", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-expose-focus-reload-test-"));
    tempRoots.push(root);
    const projectStateDir = join(root, "state");
    mkdirSync(projectStateDir);

    const firstSwitchableRequested = deferred();
    const allowFirstSwitchableResponse = deferred();
    const secondSwitchableRequested = deferred();
    const allowSecondSwitchableResponse = deferred();
    let switchableRequestCount = 0;
    const focusRequested = deferred();
    const server = createServer(async (req, res) => {
      if (req.url?.startsWith("/control/switchable-agents")) {
        switchableRequestCount += 1;
        if (switchableRequestCount === 1) {
          firstSwitchableRequested.resolve();
          await allowFirstSwitchableResponse.promise;
        }
        if (switchableRequestCount >= 2) {
          secondSwitchableRequested.resolve();
          await allowSecondSwitchableResponse.promise;
        }
        sendJson(res, {
          ok: true,
          items: [
            {
              id: "session-1",
              label: "codex",
              urgency: 0,
              activity: 0,
              recentRank: 0,
              target: { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "codex" },
              metadata: {
                kind: "agent",
                sessionId: "session-1",
                command: "codex",
                args: [],
                toolConfigKey: "codex",
                worktreePath: "/repo",
              },
            },
          ],
        });
        return;
      }
      if (req.url?.startsWith("/control/focus-window")) {
        req.on("data", () => {});
        req.on("end", () => {
          focusRequested.resolve();
          sendJson(res, { ok: false });
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(join(projectStateDir, "metadata-api.txt"), `${endpoint}\n`);
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { columns: number; rows: number };
    output.columns = 80;
    output.rows = 24;
    output.on("data", () => {});

    try {
      const result = runTmuxExpose({
        projectRoot: "/repo",
        projectStateDir,
        currentWindow: "codex",
        currentWindowId: "@1",
        currentPath: "/repo",
        currentClientSession: "aimux-test-client-12345678",
        clientTty: "/dev/ttys001",
        input,
        output,
        manageTerminal: false,
        columns: 80,
        rows: 24,
        exposeConfig: { initialScope: "project" },
      });

      await firstSwitchableRequested.promise;
      input.write("\r");
      allowFirstSwitchableResponse.resolve();

      await focusRequested.promise;
      await secondSwitchableRequested.promise;
      let settled = false;
      const observedResult = result.finally(() => {
        settled = true;
      });
      input.write("q");
      await Promise.resolve();
      expect(settled).toBe(false);
      allowSecondSwitchableResponse.resolve();

      await expect(withTimeout(observedResult, 1000)).resolves.toBe(0);
      expect(switchableRequestCount).toBeGreaterThanOrEqual(2);
    } finally {
      server.close();
      input.destroy();
      output.destroy();
    }
  });

  it("uses the daemon focus route for cross-project selection files", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-expose-cross-project-selection-test-"));
    tempRoots.push(root);
    const projectStateDir = join(root, "state");
    mkdirSync(projectStateDir);

    let focusedWindow = "";
    let focusedProjectRoot = "";
    const focusRequested = deferred();
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/core/expose/items")) {
        sendJson(res, {
          ok: true,
          items: [
            {
              id: "session-remote",
              label: "codex",
              projectRoot: "/other-repo",
              projectName: "Other",
              urgency: 0,
              activity: 0,
              recentRank: 0,
              target: { sessionName: "aimux-other", windowId: "@9", windowIndex: 9, windowName: "codex" },
              metadata: {
                kind: "agent",
                sessionId: "session-remote",
                command: "codex",
                args: [],
                toolConfigKey: "codex",
                worktreePath: "/other-repo",
              },
            },
          ],
        });
        return;
      }
      if (req.url?.startsWith("/core/expose/focus")) {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString("utf8");
        });
        req.on("end", () => {
          const parsed = JSON.parse(body) as { windowId?: string; projectRoot?: string };
          focusedWindow = parsed.windowId ?? "";
          focusedProjectRoot = parsed.projectRoot ?? "";
          focusRequested.resolve();
          sendJson(res, { ok: true });
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(join(projectStateDir, "metadata-api.txt"), `${endpoint}\n`);
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { columns: number; rows: number };
    output.columns = 80;
    output.rows = 24;
    output.on("data", () => {});
    const selectionFile = join(root, "selected-window");

    try {
      const result = runTmuxExpose({
        projectRoot: "/repo",
        projectStateDir,
        currentWindow: "codex",
        currentWindowId: "@1",
        currentPath: "/repo",
        daemonEndpoint: endpoint,
        input,
        output,
        manageTerminal: false,
        columns: 80,
        rows: 24,
        selectionFile,
        exposeConfig: { initialScope: "global" },
      });

      await waitForOutput(output, "codex");
      input.write("\r");

      await focusRequested.promise;
      await expect(withTimeout(result, 1000)).resolves.toBe(0);
      expect(existsSync(selectionFile)).toBe(false);
      expect(focusedWindow).toBe("@9");
      expect(focusedProjectRoot).toBe("/other-repo");
    } finally {
      server.close();
      input.destroy();
      output.destroy();
    }
  });

  it("opens a global-scope tile with its number key", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-expose-global-number-test-"));
    tempRoots.push(root);
    const projectStateDir = join(root, "state");
    mkdirSync(projectStateDir);

    let focusedWindow = "";
    let focusedProjectRoot = "";
    const focusRequested = deferred();
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/core/expose/items")) {
        sendJson(res, {
          ok: true,
          items: [
            {
              id: "session-remote",
              label: "codex",
              projectRoot: "/other-repo",
              projectName: "Other",
              urgency: 0,
              activity: 0,
              recentRank: 0,
              target: { sessionName: "aimux-other", windowId: "@9", windowIndex: 9, windowName: "codex" },
              metadata: {
                kind: "agent",
                sessionId: "session-remote",
                command: "codex",
                args: [],
                toolConfigKey: "codex",
                worktreePath: "/other-repo",
              },
            },
          ],
        });
        return;
      }
      if (req.url?.startsWith("/core/expose/focus")) {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString("utf8");
        });
        req.on("end", () => {
          const parsed = JSON.parse(body) as { windowId?: string; projectRoot?: string };
          focusedWindow = parsed.windowId ?? "";
          focusedProjectRoot = parsed.projectRoot ?? "";
          focusRequested.resolve();
          sendJson(res, { ok: true });
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(join(projectStateDir, "metadata-api.txt"), `${endpoint}\n`);
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { columns: number; rows: number };
    output.columns = 80;
    output.rows = 24;
    output.on("data", () => {});

    try {
      const result = runTmuxExpose({
        projectRoot: "/repo",
        projectStateDir,
        currentWindow: "meta-dashboard",
        currentWindowId: "@1",
        currentPath: "/repo",
        daemonEndpoint: endpoint,
        input,
        output,
        manageTerminal: false,
        columns: 80,
        rows: 24,
      });

      await waitForOutput(output, "codex");
      input.write("1");

      await focusRequested.promise;
      await expect(withTimeout(result, 1000)).resolves.toBe(0);
      expect(focusedWindow).toBe("@9");
      expect(focusedProjectRoot).toBe("/other-repo");
    } finally {
      server.close();
      input.destroy();
      output.destroy();
    }
  });

  it("redraws only the moved selection tiles for single-step navigation", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-expose-selection-redraw-test-"));
    tempRoots.push(root);
    const projectStateDir = join(root, "state");
    mkdirSync(projectStateDir);

    const server = createServer((req, res) => {
      if (req.url?.startsWith("/control/switchable-agents")) {
        sendJson(res, {
          ok: true,
          items: [
            {
              id: "session-1",
              label: "codex",
              urgency: 0,
              activity: 0,
              recentRank: 0,
              target: { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "codex" },
              metadata: {
                kind: "agent",
                sessionId: "session-1",
                command: "codex",
                args: [],
                toolConfigKey: "codex",
                worktreePath: "/repo",
              },
            },
            {
              id: "session-2",
              label: "claude",
              urgency: 0,
              activity: 0,
              recentRank: 1,
              target: { sessionName: "aimux-test", windowId: "@2", windowIndex: 2, windowName: "claude" },
              metadata: {
                kind: "agent",
                sessionId: "session-2",
                command: "claude",
                args: [],
                toolConfigKey: "claude",
                worktreePath: "/repo",
              },
            },
            {
              id: "session-3",
              label: "aider",
              urgency: 0,
              activity: 0,
              recentRank: 2,
              target: { sessionName: "aimux-test", windowId: "@3", windowIndex: 3, windowName: "aider" },
              metadata: {
                kind: "agent",
                sessionId: "session-3",
                command: "aider",
                args: [],
                toolConfigKey: "aider",
                worktreePath: "/repo",
              },
            },
          ],
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(join(projectStateDir, "metadata-api.txt"), `${endpoint}\n`);
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { columns: number; rows: number };
    output.columns = 100;
    output.rows = 30;
    output.on("data", () => {});

    try {
      const result = runTmuxExpose({
        projectRoot: "/repo",
        projectStateDir,
        currentWindow: "codex",
        currentWindowId: "@1",
        currentPath: "/repo",
        input,
        output,
        manageTerminal: false,
        columns: 100,
        rows: 30,
        exposeConfig: { initialScope: "project" },
      });

      await waitForOutput(output, "aider");
      const redraw = readNextOutput(output);
      input.write("\x1b[C");
      const chunk = await redraw;

      expect(chunk).toContain("codex");
      expect(chunk).toContain("claude");
      expect(chunk).not.toContain("aider");
      input.write("q");
      await expect(withTimeout(result, 1000)).resolves.toBe(0);
    } finally {
      server.close();
      input.destroy();
      output.destroy();
    }
  });

  it("preserves selection changes made while a refresh reload is pending", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-expose-reload-selection-test-"));
    tempRoots.push(root);
    const projectStateDir = join(root, "state");
    mkdirSync(projectStateDir);

    const secondSwitchableRequested = deferred();
    const allowSecondSwitchableResponse = deferred();
    const focusRequested = deferred();
    let switchableRequestCount = 0;
    let focusedWindow = "";
    const server = createServer(async (req, res) => {
      if (req.url?.startsWith("/control/switchable-agents")) {
        switchableRequestCount += 1;
        if (switchableRequestCount === 2) {
          secondSwitchableRequested.resolve();
          await allowSecondSwitchableResponse.promise;
        }
        sendJson(res, {
          ok: true,
          items: [
            {
              id: "session-1",
              label: "codex",
              urgency: 0,
              activity: 0,
              recentRank: 0,
              target: { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "codex" },
              metadata: {
                kind: "agent",
                sessionId: "session-1",
                command: "codex",
                args: [],
                toolConfigKey: "codex",
                worktreePath: "/repo",
              },
            },
            {
              id: "session-2",
              label: "claude",
              urgency: 0,
              activity: 0,
              recentRank: 1,
              target: { sessionName: "aimux-test", windowId: "@2", windowIndex: 2, windowName: "claude" },
              metadata: {
                kind: "agent",
                sessionId: "session-2",
                command: "claude",
                args: [],
                toolConfigKey: "claude",
                worktreePath: "/repo",
              },
            },
          ],
        });
        return;
      }
      if (req.url?.startsWith("/control/focus-window")) {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString("utf8");
        });
        req.on("end", () => {
          focusedWindow = (JSON.parse(body) as { windowId?: string }).windowId ?? "";
          focusRequested.resolve();
          sendJson(res, { ok: true });
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(join(projectStateDir, "metadata-api.txt"), `${endpoint}\n`);
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { columns: number; rows: number };
    output.columns = 100;
    output.rows = 30;
    output.on("data", () => {});

    try {
      const result = runTmuxExpose({
        projectRoot: "/repo",
        projectStateDir,
        currentWindow: "codex",
        currentWindowId: "@1",
        currentPath: "/repo",
        input,
        output,
        manageTerminal: false,
        columns: 100,
        rows: 30,
        exposeConfig: { initialScope: "project" },
      });

      await waitForOutput(output, "claude");
      await withTimeout(secondSwitchableRequested.promise, 2500);
      const moveRedraw = readNextOutput(output);
      input.write("\x1b[C");
      await moveRedraw;
      const reloadRedraw = readNextOutput(output);
      allowSecondSwitchableResponse.resolve();
      await reloadRedraw;
      input.write("\r");

      await focusRequested.promise;
      await expect(withTimeout(result, 1000)).resolves.toBe(0);
      expect(focusedWindow).toBe("@2");
    } finally {
      server.close();
      input.destroy();
      output.destroy();
    }
  });

  it("replays queued movement and Enter after the API-backed item list resolves", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-expose-pending-test-"));
    tempRoots.push(root);
    const projectStateDir = join(root, "state");
    mkdirSync(projectStateDir);

    const switchableRequested = deferred();
    const allowSwitchableResponse = deferred();
    const server = createServer(async (req, res) => {
      if (req.url?.startsWith("/control/switchable-agents")) {
        switchableRequested.resolve();
        await allowSwitchableResponse.promise;
        sendJson(res, {
          ok: true,
          items: [
            {
              id: "session-1",
              label: "codex",
              urgency: 0,
              activity: 0,
              recentRank: 0,
              target: { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "codex" },
              metadata: {
                kind: "agent",
                sessionId: "session-1",
                command: "codex",
                args: [],
                toolConfigKey: "codex",
                worktreePath: "/repo",
              },
            },
            {
              id: "session-2",
              label: "claude",
              urgency: 0,
              activity: 0,
              recentRank: 1,
              target: { sessionName: "aimux-test", windowId: "@2", windowIndex: 2, windowName: "claude" },
              metadata: {
                kind: "agent",
                sessionId: "session-2",
                command: "claude",
                args: [],
                toolConfigKey: "claude",
                worktreePath: "/repo",
              },
            },
          ],
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(join(projectStateDir, "metadata-api.txt"), `${endpoint}\n`);
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { columns: number; rows: number };
    output.columns = 80;
    output.rows = 24;
    output.on("data", () => {});
    const selectionFile = join(root, "selected-window");

    try {
      const result = runTmuxExpose({
        projectRoot: "/repo",
        projectStateDir,
        currentWindow: "codex",
        currentWindowId: "@1",
        currentPath: "/repo",
        input,
        output,
        manageTerminal: false,
        columns: 80,
        rows: 24,
        selectionFile,
        exposeConfig: { initialScope: "project" },
      });

      await switchableRequested.promise;
      input.write("l\r");
      allowSwitchableResponse.resolve();

      await expect(withTimeout(result, 1000)).resolves.toBe(0);
      expect(readFileSync(selectionFile, "utf8")).toBe("@2\n");
    } finally {
      server.close();
      input.destroy();
      output.destroy();
    }
  });

  it("preserves the moved selection across API-backed refreshes before Enter", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-expose-selection-test-"));
    tempRoots.push(root);
    const projectStateDir = join(root, "state");
    mkdirSync(projectStateDir);

    const initialRequested = deferred();
    const refreshed = deferred();
    let requestCount = 0;
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/control/switchable-agents")) {
        requestCount += 1;
        if (requestCount === 1) initialRequested.resolve();
        if (requestCount >= 2) refreshed.resolve();
        sendJson(res, {
          ok: true,
          items: [
            {
              id: "session-1",
              label: "codex",
              urgency: 0,
              activity: 0,
              recentRank: 0,
              target: { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "codex" },
              metadata: {
                kind: "agent",
                sessionId: "session-1",
                command: "codex",
                args: [],
                toolConfigKey: "codex",
                worktreePath: "/repo",
              },
            },
            {
              id: "session-2",
              label: "claude",
              urgency: 0,
              activity: 0,
              recentRank: 1,
              target: { sessionName: "aimux-test", windowId: "@2", windowIndex: 2, windowName: "claude" },
              metadata: {
                kind: "agent",
                sessionId: "session-2",
                command: "claude",
                args: [],
                toolConfigKey: "claude",
                worktreePath: "/repo",
              },
            },
          ],
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(join(projectStateDir, "metadata-api.txt"), `${endpoint}\n`);
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { columns: number; rows: number };
    output.columns = 80;
    output.rows = 24;
    output.on("data", () => {});
    const selectionFile = join(root, "selected-window");

    try {
      const result = runTmuxExpose({
        projectRoot: "/repo",
        projectStateDir,
        currentWindow: "codex",
        currentWindowId: "@1",
        currentPath: "/repo",
        input,
        output,
        manageTerminal: false,
        columns: 80,
        rows: 24,
        selectionFile,
        exposeConfig: { initialScope: "project" },
      });

      await initialRequested.promise;
      await waitForOutput(output, "claude");
      input.write("l");
      await withTimeout(refreshed.promise, 2500);
      input.write("\r");

      await expect(withTimeout(result, 1000)).resolves.toBe(0);
      expect(readFileSync(selectionFile, "utf8")).toBe("@2\n");
    } finally {
      server.close();
      input.destroy();
      output.destroy();
    }
  });

  it("handles move and Enter when the terminal delivers them in one chunk", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-expose-coalesced-test-"));
    tempRoots.push(root);
    const projectStateDir = join(root, "state");
    mkdirSync(projectStateDir);

    const server = createServer((req, res) => {
      if (req.url?.startsWith("/control/switchable-agents")) {
        sendJson(res, {
          ok: true,
          items: [
            {
              id: "session-1",
              label: "codex",
              urgency: 0,
              activity: 0,
              recentRank: 0,
              target: { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "codex" },
              metadata: {
                kind: "agent",
                sessionId: "session-1",
                command: "codex",
                args: [],
                toolConfigKey: "codex",
                worktreePath: "/repo",
              },
            },
            {
              id: "session-2",
              label: "claude",
              urgency: 0,
              activity: 0,
              recentRank: 1,
              target: { sessionName: "aimux-test", windowId: "@2", windowIndex: 2, windowName: "claude" },
              metadata: {
                kind: "agent",
                sessionId: "session-2",
                command: "claude",
                args: [],
                toolConfigKey: "claude",
                worktreePath: "/repo",
              },
            },
          ],
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(join(projectStateDir, "metadata-api.txt"), `${endpoint}\n`);
    const input = new PassThrough();
    const output = new PassThrough() as PassThrough & { columns: number; rows: number };
    output.columns = 80;
    output.rows = 24;
    output.on("data", () => {});
    const selectionFile = join(root, "selected-window");

    try {
      const result = runTmuxExpose({
        projectRoot: "/repo",
        projectStateDir,
        currentWindow: "codex",
        currentWindowId: "@1",
        currentPath: "/repo",
        input,
        output,
        manageTerminal: false,
        columns: 80,
        rows: 24,
        selectionFile,
        exposeConfig: { initialScope: "project" },
      });

      await waitForOutput(output, "claude");
      input.write("l\r");

      await expect(withTimeout(result, 1000)).resolves.toBe(0);
      expect(readFileSync(selectionFile, "utf8")).toBe("@2\n");
    } finally {
      server.close();
      input.destroy();
      output.destroy();
    }
  });
});
