import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk.toString();
  return body;
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

describe("runTmuxExpose", () => {
  it("honors Enter received before the API-backed item list resolves", async () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-expose-render-test-"));
    tempRoots.push(root);
    const projectStateDir = join(root, "state");
    mkdirSync(projectStateDir);

    const switchableRequested = deferred();
    const allowSwitchableResponse = deferred();
    const focusRequest = deferred<unknown>();
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
      if (req.url === "/control/focus-window") {
        focusRequest.resolve(JSON.parse(await readBody(req)));
        sendJson(res, { ok: true });
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
        currentWindow: "claude",
        currentWindowId: "@2",
        currentPath: "/repo",
        input,
        output,
        manageTerminal: false,
        columns: 80,
        rows: 24,
        exposeConfig: { initialScope: "project" },
      });

      await switchableRequested.promise;
      input.write("\x1b[I\r");
      allowSwitchableResponse.resolve();

      await expect(withTimeout(result, 1000)).resolves.toBe(0);
      await expect(focusRequest.promise).resolves.toMatchObject({ windowId: "@2", focus: true });
    } finally {
      server.close();
      input.destroy();
      output.destroy();
    }
  });
});
