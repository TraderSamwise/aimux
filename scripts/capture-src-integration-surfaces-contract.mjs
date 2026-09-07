#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/integration/src-surfaces.json", ROOT);

const previousAimuxHome = process.env.AIMUX_HOME;
const tempHome = mkdtempSync(join(tmpdir(), "aimux-src-integration-home-"));
process.env.AIMUX_HOME = tempHome;

const { runCoreCli } = await import(new URL("dist/core-cli.js", ROOT));
const { CoreProjectActor } = await import(new URL("dist/core-project-actor.js", ROOT));
const { AimuxDaemon } = await import(new URL("dist/daemon.js", ROOT));
const { startHostedServer } = await import(new URL("dist/full/hosted-server.js", ROOT));
const { DEFAULT_HOSTED_CONFIG } = await import(new URL("dist/full/hosted-config.js", ROOT));
const { MetadataServer } = await import(new URL("dist/metadata-server.js", ROOT));
const { initPaths } = await import(new URL("dist/paths.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));
const cwd = process.cwd();
const tempRoots = [tempHome];

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalizeValue(value) {
  const ids = new Map();
  let nextId = 1;
  const timestamps = new Map();
  let nextTs = 1;
  let json = JSON.stringify(value)
    .replace(new RegExp(`"pid":${process.pid}\\b`, "g"), '"pid":"<pid>"')
    .split(cwd)
    .join("<REPO>");
  for (const root of tempRoots) json = json.split(root).join("<TMP>");
  json = json.replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>");
  json = json.replace(/"port":\d+/g, '"port":"<port>"');
  json = json.replace(/[0-9]{10,}\.[0-9]{10,}-[0-9a-f]{12,}/g, "<build-stamp>");
  json = json.replace(/aimux-[A-Za-z0-9_-]+-[A-Za-z0-9]{6}-[0-9a-f]{12,}/g, (id) => {
    if (!ids.has(id)) ids.set(id, `<id:${nextId++}>`);
    return ids.get(id);
  });
  json = json.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
    if (!ids.has(id)) ids.set(id, `<id:${nextId++}>`);
    return ids.get(id);
  });
  json = json.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, (ts) => {
    if (!timestamps.has(ts)) timestamps.set(ts, `<ts:${nextTs++}>`);
    return timestamps.get(ts);
  });
  json = json.replace(/\b(?:interaction|req|request|project|actor|daemon)-[A-Za-z0-9_-]{6,}\b/g, (id) => {
    if (!ids.has(id)) ids.set(id, `<id:${nextId++}>`);
    return ids.get(id);
  });
  return JSON.parse(json);
}

async function record(cases, name, source, api, input, run) {
  const normalizedInput = normalizeValue(input);
  const output = normalizeValue(await run(clone(input)));
  cases.push({
    id: `src-integration-surfaces-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source,
    api,
    input: normalizedInput,
    output,
    inputSha256: hash(normalizedInput),
  });
}

async function readResponse(res) {
  const contentType = res.headers.get("content-type") ?? "";
  const body = contentType.includes("json") ? await res.json() : await res.text();
  return { status: res.status, contentType, body };
}

function makeProjectRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `aimux-${label}-`));
  mkdirSync(join(root, ".git"), { recursive: true });
  tempRoots.push(root);
  return root;
}

const cases = [];

await record(
  cases,
  "rejects unsupported core CLI commands without side effects",
  "src/core-cli.test.ts",
  "runCoreCli",
  { rawArgs: ["not-a-core-command", "--flag"], deps: {} },
  async (input) => {
    const stdout = [];
    const stderr = [];
    const exitCode = await runCoreCli(input.rawArgs, { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
    return { exitCode, stdout, stderr };
  },
);

await record(
  cases,
  "renders remote status through injected core CLI remote dependency",
  "src/core-cli.test.ts",
  "runCoreCli",
  {
    rawArgs: ["remote", "status"],
    remote: { credentials: { userId: "user-1", relayUrl: "wss://relay.example/ws", remoteEnabled: true } },
  },
  async (input) => {
    const stdout = [];
    const stderr = [];
    const remote = {
      credentialsForStatus: () => clone(input.remote.credentials),
      whoamiPayload: () => ({ credentials: clone(input.remote.credentials) }),
      hasCredentials: () => Boolean(input.remote.credentials),
      enableRelay: () => ({ status: "connecting", relayUrl: input.remote.credentials.relayUrl }),
      enableRelayBestEffort: () => ({ status: "off" }),
      disableRelay: () => ({ status: "off" }),
      remoteUnavailableRelayStatus: () => ({ status: "disconnected", relayUrl: "", lastConnectedAt: null, lastError: null }),
      setRemoteEnabled: async () => ({ credentials: clone(input.remote.credentials) }),
      runLoginFlow: async () => ({ userId: input.remote.credentials.userId }),
      clearCredentials: async () => ({ ok: true }),
    };
    const exitCode = await runCoreCli(input.rawArgs, { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }, { remote });
    return { exitCode, stdout, stderr };
  },
);

await record(
  cases,
  "initializes core project actor state before spawning",
  "src/core-project-actor.test.ts",
  "CoreProjectActor.getState",
  { projectRoot: makeProjectRoot("core-actor") },
  async (input) => {
    const states = [];
    const actor = new CoreProjectActor(input.projectRoot, { onStateChange: (state) => states.push(state) });
    return { initial: actor.getState(), isRunning: actor.isRunning(), publishedStates: states };
  },
);

await record(
  cases,
  "serves daemon health and loopback-only route guards through routeRequest",
  "src/daemon.test.ts",
  "AimuxDaemon.routeRequest",
  {
    requests: [
      { method: "GET", path: "/health" },
      { method: "GET", path: "/core/daemon/status.txt", headers: { origin: "http://evil.example" } },
      { method: "GET", path: "/missing" },
    ],
  },
  async (input) => {
    const daemon = new AimuxDaemon();
    const responses = [];
    for (const request of input.requests) {
      responses.push(await daemon.routeRequest(request.method, request.path, request.body, request.headers));
    }
    await daemon.stop();
    return responses;
  },
);

await record(
  cases,
  "serves hosted health and rejects unauthenticated proxy requests before routing",
  "src/full/hosted-server.test.ts",
  "startHostedServer",
  {
    config: { bindAddress: "127.0.0.1", port: 0, maxPromptBytes: 64, maxResponseBytes: 4096 },
    requests: [
      { method: "GET", path: "/health" },
      { method: "GET", path: "/proxy/127.0.0.1/43210/agents/output?sessionId=s" },
    ],
  },
  async (input) => {
    const seen = [];
    const handle = await startHostedServer({
      config: { ...DEFAULT_HOSTED_CONFIG, ...input.config, enabled: true },
      routeHostedRequest: async (actor, method, path, body) => {
        seen.push({ actor, method, path, body });
        return { status: 200, body: { ok: true } };
      },
    });
    try {
      const responses = [];
      for (const request of input.requests) {
        responses.push(await readResponse(await fetch(`http://${handle.host}:${handle.port}${request.path}`, { method: request.method })));
      }
      return { address: { host: handle.host, port: handle.port }, responses, routed: seen };
    } finally {
      await handle.close();
    }
  },
);

await record(
  cases,
  "serves metadata health and lifecycle diagnostics over HTTP",
  "src/metadata-server.test.ts",
  "MetadataServer",
  { projectRoot: makeProjectRoot("metadata-server"), requests: [{ path: "/health" }, { path: "/diagnostics/lifecycle" }] },
  async (input) => {
    await initPaths(input.projectRoot);
    const server = new MetadataServer();
    await server.start();
    try {
      const addr = server.getAddress();
      const base = `http://127.0.0.1:${addr.port}`;
      const responses = [];
      for (const request of input.requests) {
        responses.push(await readResponse(await fetch(`${base}${request.path}`)));
      }
      return { address: { port: addr.port }, responses };
    } finally {
      server.stop();
    }
  },
);

await record(
  cases,
  "registers, lists, and resolves interaction requests through project-service endpoints",
  "src/metadata-server.interaction.test.ts",
  "MetadataServer interaction endpoints",
  {
    projectRoot: makeProjectRoot("metadata-interaction"),
    register: { session: "s1", type: "permission", payload: { toolName: "Bash" }, summary: "Run ls" },
    response: { decision: "allow_once" },
  },
  async (input) => {
    await initPaths(input.projectRoot);
    const server = new MetadataServer({ desktop: { getState: () => ({ sessions: [] }) } });
    await server.start();
    try {
      const addr = server.getAddress();
      const base = `http://127.0.0.1:${addr.port}`;
      const reg = await readResponse(
        await fetch(`${base}/agents/interaction/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input.register),
        }),
      );
      const requestId = reg.body.request.id;
      const pending = await readResponse(await fetch(`${base}/agents/interaction/pending?sessionId=s1`));
      const respond = await readResponse(
        await fetch(`${base}/agents/interaction/respond`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: requestId, response: input.response }),
        }),
      );
      const after = await readResponse(await fetch(`${base}/agents/interaction/pending?sessionId=s1`));
      return { register: reg, pending, respond, after };
    } finally {
      server.stop();
    }
  },
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  sources: [
    "src/core-cli.test.ts",
    "src/core-project-actor.test.ts",
    "src/daemon.test.ts",
    "src/full/hosted-server.test.ts",
    "src/metadata-server.test.ts",
    "src/metadata-server.interaction.test.ts",
  ],
  subject: "src integration surface request/response contracts",
  generatedBy: "scripts/capture-src-integration-surfaces-contract.mjs",
  caseCount: cases.length,
  cases,
});

if (previousAimuxHome === undefined) delete process.env.AIMUX_HOME;
else process.env.AIMUX_HOME = previousAimuxHome;
rmSync(tempHome, { recursive: true, force: true });
