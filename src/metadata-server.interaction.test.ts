import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MetadataServer } from "./metadata-server.js";
import { initPaths } from "./paths.js";

async function postJson(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe("interaction endpoints", () => {
  let server: MetadataServer;
  let base: string;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "aimux-interaction-"));
    await initPaths(dir);
    server = new MetadataServer({ desktop: { getState: () => ({ sessions: [] }) } });
    await server.start();
    const addr = server.getAddress();
    if (!addr) throw new Error("server has no address");
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(() => {
    server.stop();
  });

  it("register then wait resolves when a respond lands", async () => {
    const reg = await postJson(`${base}/agents/interaction/register`, {
      session: "s1",
      type: "permission",
      payload: { toolName: "Bash" },
      summary: "Run ls",
    });
    expect(reg.json.ok).toBe(true);
    expect(reg.json.request.status).toBe("pending");
    const id = reg.json.request.id;

    const waiting = fetch(`${base}/agents/interaction/wait?id=${id}&timeoutMs=5000`).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 50));
    const resp = await postJson(`${base}/agents/interaction/respond`, { id, response: { decision: "allow_once" } });
    expect(resp.json.ok).toBe(true);

    const waited = await waiting;
    expect(waited.ok).toBe(true);
    expect(waited.request.status).toBe("resolved");
    expect(waited.request.response.decision).toBe("allow_once");
  });

  it("pending lists the request and clears after respond", async () => {
    const reg = await postJson(`${base}/agents/interaction/register`, {
      session: "s2",
      type: "question",
      payload: { question: "?" },
    });
    const id = reg.json.request.id;

    const before = await (await fetch(`${base}/agents/interaction/pending`)).json();
    expect(before.requests.map((r: { id: string }) => r.id)).toContain(id);

    await postJson(`${base}/agents/interaction/respond`, { id, response: { selection: "yes" } });

    const after = await (await fetch(`${base}/agents/interaction/pending?sessionId=s2`)).json();
    expect(after.requests).toHaveLength(0);
  });

  it("returns 409 for unknown respond and 400 for invalid register", async () => {
    const unknown = await postJson(`${base}/agents/interaction/respond`, { id: "nope", response: {} });
    expect(unknown.status).toBe(409);
    const invalid = await postJson(`${base}/agents/interaction/register`, { session: "", type: "permission", payload: {} });
    expect(invalid.status).toBe(400);
  });

  it("wait times out with a timed_out status", async () => {
    const reg = await postJson(`${base}/agents/interaction/register`, {
      session: "s3",
      type: "input",
      payload: {},
    });
    const waited = await (
      await fetch(`${base}/agents/interaction/wait?id=${reg.json.request.id}&timeoutMs=1000`)
    ).json();
    expect(waited.request.status).toBe("timed_out");
  });

  it("rejects a non-object payload or response with 400", async () => {
    const badPayload = await postJson(`${base}/agents/interaction/register`, {
      session: "s4",
      type: "input",
      payload: "nope",
    });
    expect(badPayload.status).toBe(400);

    const reg = await postJson(`${base}/agents/interaction/register`, { session: "s4", type: "input", payload: {} });
    const badResponse = await postJson(`${base}/agents/interaction/respond`, {
      id: reg.json.request.id,
      response: "nope",
    });
    expect(badResponse.status).toBe(400);
  });
});
