#!/usr/bin/env node
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/relay/client.json", ROOT);

const mockDir = mkdtempSync(join(tmpdir(), "aimux-relay-client-mock-"));
const mockNotifyPath = join(mockDir, "notify.mjs");
writeFileSync(
  mockNotifyPath,
  `export function notifyRemoteAuthLost(input = {}) { globalThis.__relayNotifications.authLost.push(input); }
export function notifyRemoteClientConnected(input) { globalThis.__relayNotifications.clientConnected.push(input); }
`,
);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../notify.js" && context.parentURL?.endsWith("/dist/full/relay-client.js")) {
      return { url: new URL(`file://${mockNotifyPath}`).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { RelayClient } = await import(new URL("dist/full/relay-client.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function resetNotifications() {
  globalThis.__relayNotifications = { authLost: [], clientConnected: [] };
}

function caseRecord(index, name, scenario, input, output) {
  return {
    id: `relay-client-${String(index + 1).padStart(3, "0")}`,
    name,
    source: "src/full/relay-client.test.ts",
    api: "RelayClient",
    input: { scenario, ...input },
    output,
    inputSha256: hash({ scenario, ...input }),
  };
}

const cases = [];
async function add(name, scenario, input, run) {
  resetNotifications();
  cases.push(caseRecord(cases.length, name, scenario, input, await run()));
}

function daemon(overrides = {}) {
  return {
    routeRequest: async () => ({ status: 204, body: { ok: true } }),
    ...overrides,
  };
}

function makeClient(daemonOverrides = {}) {
  return new RelayClient("wss://relay.aimux.app/", "token", daemon(daemonOverrides));
}

await add("fails fast when the Node runtime has no global WebSocket", "no-global-websocket", {}, async () => {
  const original = globalThis.WebSocket;
  try {
    globalThis.WebSocket = undefined;
    const client = makeClient();
    client.connect();
    return { status: client.getStatus(), notifications: globalThis.__relayNotifications };
  } finally {
    globalThis.WebSocket = original;
  }
});

await add("notifies once when relay authentication fails", "auth-close-notifies-once", { closeCode: 1008 }, async () => {
  const original = globalThis.WebSocket;
  const sockets = [];
  class FakeWebSocket extends EventTarget {
    static OPEN = 1;
    constructor() {
      super();
      sockets.push(this);
    }
    close() {}
  }
  try {
    globalThis.WebSocket = FakeWebSocket;
    const client = makeClient();
    client.connect();
    const closeEvent = new Event("close");
    Object.defineProperty(closeEvent, "code", { value: 1008 });
    sockets[0].dispatchEvent(closeEvent);
    sockets[0].dispatchEvent(closeEvent);
    return { status: client.getStatus(), notifications: globalThis.__relayNotifications };
  } finally {
    globalThis.WebSocket = original;
  }
});

const newClientEvent = {
  kind: "new_client_detected",
  deviceId: "device-1",
  title: "Remote approval needed",
  body: "iPhone from SG is waiting for approval. Code ABC-123.",
  approvalCode: "ABC-123",
  createdAt: "2026-04-01T00:00:00.000Z",
};

await add(
  "turns relay new_client_detected security events into local approval notifications",
  "security-event-new-client",
  { message: { type: "security_event", event: newClientEvent } },
  async () => {
    const client = makeClient();
    await client.handleMessage(JSON.stringify({ type: "security_event", event: newClientEvent }));
    return { notifications: globalThis.__relayNotifications };
  },
);

await add("notifies every repeated new-client security event", "security-event-repeated-new-client", {
  message: { type: "security_event", event: newClientEvent },
  count: 3,
}, async () => {
  const client = makeClient();
  const message = JSON.stringify({ type: "security_event", event: newClientEvent });
  await client.handleMessage(message);
  await client.handleMessage(message);
  await client.handleMessage(message);
  return { notifications: globalThis.__relayNotifications };
});

const sharedClientEvent = {
  kind: "shared_client_connected",
  deviceId: "shared:share-1:user-guest:device-1",
  shareId: "share-1",
  sessionId: "claude-abc",
  actorUserId: "user-guest",
  actorName: "Alex",
  title: "Shared chat participant connected",
  body: "Alex connected to claude-abc from SG.",
  createdAt: "2026-04-01T00:00:00.000Z",
};

await add(
  "turns shared participant security events into distinct local owner notifications",
  "security-event-shared-client",
  { message: { type: "security_event", event: sharedClientEvent } },
  async () => {
    const client = makeClient();
    await client.handleMessage(JSON.stringify({ type: "security_event", event: sharedClientEvent }));
    return { notifications: globalThis.__relayNotifications };
  },
);

await add("proxies project service SSE events over relay subscriptions", "project-events-subscribe", {
  message: {
    id: "sub-1",
    type: "project_events_subscribe",
    path: "/proxy/127.0.0.1/4321/events",
  },
  stream: 'event: project_update\ndata: {"type":"project_update","views":["desktop-state"],"projectId":"p1","ts":"now"}\n\n',
}, async () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const sent = [];
  const fetchCalls = [];
  try {
    globalThis.WebSocket = { OPEN: 1 };
    globalThis.fetch = async (url, init) => {
      fetchCalls.push({ url, method: init?.method });
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: project_update\ndata: {"type":"project_update","views":["desktop-state"],"projectId":"p1","ts":"now"}\n\n',
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const client = makeClient({
      resolveProjectEventStream: () => ({
        ok: true,
        url: "http://127.0.0.1:4321/events",
      }),
    });
    client.ws = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
    await client.handleMessage(
      JSON.stringify({ id: "sub-1", type: "project_events_subscribe", path: "/proxy/127.0.0.1/4321/events" }),
    );
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 1_000;
      const poll = () => {
        if (sent.some((message) => message.type === "project_events_error")) return resolve();
        if (Date.now() > deadline) return reject(new Error("timed out waiting for subscription"));
        setTimeout(poll, 10);
      };
      poll();
    });
    return { fetchCalls, sent };
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  }
});

await add(
  "rejects shared guest project event subscriptions without the authorized session id",
  "project-events-subscribe-denied",
  {
    message: {
      id: "sub-guest",
      type: "project_events_subscribe",
      path: "/proxy/127.0.0.1/4321/events",
      headers: {
        "X-Aimux-Actor-Role": "guest",
        "X-Aimux-Share-Session-Id": "shared-1",
      },
    },
  },
  async () => {
    const originalWebSocket = globalThis.WebSocket;
    const sent = [];
    try {
      globalThis.WebSocket = { OPEN: 1 };
      const client = makeClient({
        resolveProjectEventStream: () => ({
          ok: false,
          status: 403,
          error: "shared session route requires a session id",
        }),
      });
      client.ws = { readyState: 1, send: (data) => sent.push(JSON.parse(data)) };
      await client.handleMessage(
        JSON.stringify({
          id: "sub-guest",
          type: "project_events_subscribe",
          path: "/proxy/127.0.0.1/4321/events",
          headers: {
            "X-Aimux-Actor-Role": "guest",
            "X-Aimux-Share-Session-Id": "shared-1",
          },
        }),
      );
      return { sent };
    } finally {
      globalThis.WebSocket = originalWebSocket;
    }
  },
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/full/relay-client.test.ts",
  generatedBy: "scripts/capture-relay-client-contract.mjs",
  description:
    "Relay client runtime compatibility, auth-failure notification, security-event notification routing, and project-event subscription forwarding captured by running the TypeScript RelayClient with a notify-module recorder.",
  cases,
});

rmSync(mockDir, { recursive: true, force: true });
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
