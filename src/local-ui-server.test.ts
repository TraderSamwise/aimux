import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startLocalUiServer, type LocalUiServerHandle } from "./local-ui-server.js";

const handles: LocalUiServerHandle[] = [];
const roots: string[] = [];

function makeUiRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aimux-ui-"));
  roots.push(root);
  writeFileSync(
    join(root, "index.html"),
    '<!doctype html><html><head><script src="/aimux-local-config.js"></script></head><body>aimux ui</body></html>',
  );
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "app.js"), "console.log('aimux');");
  return root;
}

async function startTestServer(root = makeUiRoot()): Promise<LocalUiServerHandle> {
  const handle = await startLocalUiServer({
    host: "127.0.0.1",
    port: 0,
    uiRoot: root,
    config: {
      connectionMode: "local",
      daemonUrl: "http://127.0.0.1:43191",
    },
  });
  handles.push(handle);
  return handle;
}

function rawGetStatus(url: string, path: string): Promise<number> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path,
        method: "GET",
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("local UI server", () => {
  it("serves the exported app shell", async () => {
    const server = await startTestServer();
    const res = await fetch(server.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    await expect(res.text()).resolves.toContain("aimux ui");
  });

  it("serves runtime local connection config", async () => {
    const server = await startTestServer();
    const res = await fetch(`${server.url}/aimux-local-config.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expect(res.text()).resolves.toContain('"daemonUrl":"http://127.0.0.1:43191"');
  });

  it("falls back to index for routed app paths", async () => {
    const server = await startTestServer();
    const res = await fetch(`${server.url}/topology/agent/claude-1/chat?from=map`);
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toContain("aimux ui");
  });

  it("serves static assets with immutable caching", async () => {
    const server = await startTestServer();
    const res = await fetch(`${server.url}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    await expect(res.text()).resolves.toContain("console.log");
  });

  it("rejects path traversal attempts", async () => {
    const server = await startTestServer();
    await expect(rawGetStatus(server.url, "/%2e%2e/package.json")).resolves.toBe(403);
  });

  it("rejects non-loopback hosts", async () => {
    await expect(
      startLocalUiServer({
        host: "0.0.0.0",
        port: 0,
        uiRoot: makeUiRoot(),
        config: { connectionMode: "local", daemonUrl: "http://127.0.0.1:43190" },
      }),
    ).rejects.toThrow(/loopback/);
  });
});
