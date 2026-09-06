#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATHS = {
  agentInput: new URL("testdata/contracts/v1/metadata-server/agent-input.json", ROOT),
  dashboardClientState: new URL("testdata/contracts/v1/metadata-server/dashboard-client-state.json", ROOT),
  exposeSocket: new URL("testdata/contracts/v1/metadata-server/expose-socket.json", ROOT),
  http: new URL("testdata/contracts/v1/metadata-server/http.json", ROOT),
  libraryDocuments: new URL("testdata/contracts/v1/metadata-server/library-documents.json", ROOT),
  lifecycleMutationQueue: new URL("testdata/contracts/v1/metadata-server/lifecycle-mutation-queue.json", ROOT),
};

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const agentInput = await import(new URL("dist/metadata-server/agent-input.js", ROOT));
const dashboardClientState = await import(new URL("dist/metadata-server/dashboard-client-state.js", ROOT));
const exposeSocket = await import(new URL("dist/metadata-server/expose-socket.js", ROOT));
const http = await import(new URL("dist/metadata-server/http.js", ROOT));
const libraryDocuments = await import(new URL("dist/metadata-server/library-documents.js", ROOT));
const lifecycle = await import(new URL("dist/metadata-server/lifecycle-mutation-queue.js", ROOT));

function recordCase(prefix, index, name, source, api, input, output) {
  return {
    id: `${prefix}-${String(index + 1).padStart(3, "0")}`,
    name,
    source,
    api,
    input,
    output,
    inputSha256: hash(input),
  };
}

function normalizeLifecycle(value) {
  const ids = new Map();
  const timestamps = new Map();
  let nextId = 1;
  let nextTs = 1;
  const visit = (node) => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== "object") return node;
    const out = {};
    for (const [key, child] of Object.entries(node)) {
      if (key === "pid" && typeof child === "number") {
        out[key] = "<pid>";
      } else if (key === "operationId" && typeof child === "string") {
        if (!ids.has(child)) ids.set(child, `<opid:${nextId++}>`);
        out[key] = ids.get(child);
      } else if ((key === "startedAt" || key === "updatedAt" || key === "lastStartedAt" || key === "lastSettledAt") && typeof child === "string") {
        if (!timestamps.has(child)) timestamps.set(child, `<ts:${nextTs++}>`);
        out[key] = timestamps.get(child);
      } else if ((key === "maxQueuedMs" || key === "maxDurationMs") && typeof child === "number") {
        out[key] = child >= 0 ? "<duration-ms>" : child;
      } else {
        out[key] = visit(child);
      }
    }
    return out;
  };
  return visit(value);
}

function normalizeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error instanceof Error ? error.message : String(error),
    status: typeof error?.status === "number" ? error.status : undefined,
  };
}

function transition(targetId, overrides = {}) {
  return {
    operation: "agent.stop",
    targetKind: "agent",
    targetId,
    ...overrides,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function captureLifecycleQueue() {
  const source = "src/metadata-server/lifecycle-mutation-queue.test.ts";
  const cases = [];

  {
    const firstBlocker = deferred();
    const queue = new lifecycle.LifecycleMutationQueue({ projectRoot: () => "/repo" });
    const events = [];
    const first = queue.enqueue(async () => {
      events.push("first:start");
      await firstBlocker.promise;
      events.push("first:end");
      return "first";
    }, transition("one"));
    const second = queue.enqueue(() => {
      events.push("second:start");
      return "second";
    }, transition("two"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const during = normalizeLifecycle(queue.diagnostics());
    firstBlocker.resolve();
    const results = [await first, await second];
    const final = normalizeLifecycle(queue.diagnostics());
    const input = { scenario: "serial-diagnostics" };
    cases.push(recordCase("metadata-lifecycle-mutation-queue", cases.length, "runs lifecycle mutations serially and tracks diagnostics", source, "LifecycleMutationQueue", input, { events, during, results, final }));
  }

  {
    const blocker = deferred();
    const queue = new lifecycle.LifecycleMutationQueue({ projectRoot: () => "/repo" });
    const first = queue.enqueue(() => blocker.promise, transition("same"));
    let error;
    try {
      queue.enqueue(() => "ignored", transition("same"));
    } catch (caught) {
      error = normalizeError(caught);
    }
    const diagnostics = normalizeLifecycle(queue.diagnostics());
    blocker.resolve();
    await first;
    const input = { scenario: "same-target-conflict" };
    cases.push(recordCase("metadata-lifecycle-mutation-queue", cases.length, "rejects concurrent mutations for the same lifecycle target", source, "LifecycleMutationQueue", input, { error, diagnostics }));
  }

  {
    const blocker = deferred();
    const queue = new lifecycle.LifecycleMutationQueue({ queueLimit: 1, projectRoot: () => "/repo" });
    const first = queue.enqueue(() => blocker.promise, transition("one"));
    let error;
    try {
      queue.enqueue(() => "ignored", transition("two"));
    } catch (caught) {
      error = normalizeError(caught);
    }
    const diagnostics = normalizeLifecycle(queue.diagnostics());
    blocker.resolve();
    await first;
    const input = { scenario: "queue-limit" };
    cases.push(recordCase("metadata-lifecycle-mutation-queue", cases.length, "rejects transition-backed work over the queue limit", source, "LifecycleMutationQueue", input, { error, diagnostics }));
  }

  {
    const queue = new lifecycle.LifecycleMutationQueue({ projectRoot: () => "/repo" });
    let error;
    try {
      await queue.enqueue(() => Promise.reject(new Error("boom")), transition("failed"));
    } catch (caught) {
      error = normalizeError(caught);
    }
    const diagnostics = normalizeLifecycle(queue.diagnostics());
    const input = { scenario: "failure-diagnostics" };
    cases.push(recordCase("metadata-lifecycle-mutation-queue", cases.length, "records failed lifecycle mutations and exposes user-facing errors", source, "LifecycleMutationQueue", input, { error, diagnostics }));
  }

  {
    const input = { scenario: "lifecycle-ok", result: { sessionId: "codex-one" }, transition: transition("codex-one") };
    const output = normalizeLifecycle(lifecycle.lifecycleOk(input.result, input.transition));
    cases.push(recordCase("metadata-lifecycle-mutation-queue", cases.length, "wraps lifecycle-ok responses with transition metadata", source, "lifecycleOk", input, output));
  }

  {
    const pending = await lifecycle.waitForEarlyLifecycleResult(new Promise(() => {}), 1);
    const input = { scenario: "early-pending" };
    cases.push(recordCase("metadata-lifecycle-mutation-queue", cases.length, "returns early when lifecycle work is still pending", source, "waitForEarlyLifecycleResult", input, pending));
  }

  {
    const resolved = await lifecycle.waitForEarlyLifecycleResult(Promise.resolve("ok"));
    const rejected = await lifecycle.waitForEarlyLifecycleResult(Promise.reject(new Error("failed")));
    const input = { scenario: "early-settled" };
    cases.push(recordCase("metadata-lifecycle-mutation-queue", cases.length, "returns early resolved and rejected lifecycle outcomes", source, "waitForEarlyLifecycleResult", input, { resolved, rejected: { kind: rejected.kind, error: normalizeError(rejected.error) } }));
  }

  return {
    version: 1,
    source,
    generatedBy: "scripts/capture-metadata-server-runtime-contract.mjs",
    description:
      "Metadata-server lifecycle mutation queue ordering, diagnostics, conflict, queue-limit, error, lifecycleOk, and early-result behavior captured by running TypeScript. Generated operation IDs, timestamps, durations, and process IDs are normalized after execution.",
    cases,
  };
}

function captureDashboardClientState() {
  const source = "src/metadata-server/dashboard-client-state.test.ts";
  const inputs = [
    { values: ["dashboard", " coordination ", "project", "library", "topology", "graveyard"] },
    { values: ["agent", undefined, "", " Dashboard "] },
  ];
  const cases = inputs.map((input, index) =>
    recordCase(
      "metadata-dashboard-client-state",
      index,
      index === 0 ? "parses supported dashboard control screens" : "ignores unsupported dashboard control screens",
      source,
      "parseDashboardControlScreen",
      input,
      input.values.map((value) => dashboardClientState.parseDashboardControlScreen(value) ?? null),
    ),
  );
  return {
    version: 1,
    source,
    generatedBy: "scripts/capture-metadata-server-runtime-contract.mjs",
    description:
      "Metadata-server dashboard client control-screen parsing behavior captured by running TypeScript parseDashboardControlScreen.",
    cases,
  };
}

function captureExposeSocket() {
  const source = "src/metadata-server/expose-socket.test.ts";
  const inputs = [
    { api: "parsePositiveHeaderInteger", values: ["80", "0", "-1", "abc", undefined, "12px"] },
    {
      api: "splitExposeHeader",
      buffer: `${Array.from({ length: 15 }, (_, index) => `line-${index + 1}`).join("\n")}\nbody\nrest`,
    },
    { api: "splitExposeHeader", buffer: "one\ntwo\n" },
  ];
  const cases = inputs.map((input, index) => {
    const output =
      input.api === "parsePositiveHeaderInteger"
        ? input.values.map((value) => exposeSocket.parsePositiveHeaderInteger(value) ?? null)
        : (() => {
            const parsed = exposeSocket.splitExposeHeader(Buffer.from(input.buffer, "utf8"));
            return parsed ? { header: parsed.header, rest: parsed.rest.toString("utf8") } : null;
          })();
    return recordCase(
      "metadata-expose-socket",
      index,
      index === 0
        ? "parses positive integer header fields only"
        : index === 1
          ? "splits exactly after the launch header and preserves the first body chunk"
          : "waits for a complete launch header",
      source,
      input.api,
      input,
      output,
    );
  });
  return {
    version: 1,
    source,
    generatedBy: "scripts/capture-metadata-server-runtime-contract.mjs",
    description:
      "Metadata-server expose socket positive-header-integer and launch-header split behavior captured by running TypeScript expose-socket helpers.",
    cases,
  };
}

function requestFromChunks(chunks, headers = {}) {
  return {
    headers,
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function responseRecorder() {
  const headers = new Map();
  return {
    statusCode: 0,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    hasHeader(name) {
      return headers.has(name.toLowerCase());
    },
    end(body) {
      this.body = body;
    },
    snapshot() {
      return {
        statusCode: this.statusCode,
        headers: Object.fromEntries([...headers.entries()].sort(([left], [right]) => left.localeCompare(right))),
        body: this.body,
      };
    },
  };
}

async function captureHttp() {
  const source = "src/metadata-server/http.test.ts";
  const cases = [];

  {
    const ok = await http.readJson(requestFromChunks(['{"ok":true}']), 32);
    const tooLargeReq = requestFromChunks(["abcdef"]);
    let tooLarge;
    try {
      await http.readJson(tooLargeReq, 3);
    } catch (error) {
      tooLarge = { ...normalizeError(error), destroyed: tooLargeReq.destroyed };
    }
    const input = { scenario: "read-json-byte-limit" };
    cases.push(recordCase("metadata-http", cases.length, "reads JSON with a streaming byte limit", source, "readJson", input, { ok, tooLarge }));
  }

  {
    const input = { headers: { one: "1", many: ["a", "b"], empty: [] } };
    const output = http.requestHeaderRecord(requestFromChunks([], input.headers));
    cases.push(recordCase("metadata-http", cases.length, "normalizes request headers", source, "requestHeaderRecord", input, output));
  }

  {
    const res = responseRecorder();
    const allowed = http.setCorsHeaders(requestFromChunks([], { origin: "http://localhost:4545" }), res);
    const input = { origin: "http://localhost:4545", checks: ["https://aimux.app", "https://evil.example"] };
    const output = {
      allowed,
      response: res.snapshot(),
      checks: input.checks.map((origin) => [origin, http.isAllowedCorsOrigin(origin)]),
    };
    cases.push(recordCase("metadata-http", cases.length, "sets CORS headers for allowed local origins", source, "setCorsHeaders/isAllowedCorsOrigin", input, output));
  }

  {
    const res = responseRecorder();
    res.setHeader("access-control-allow-origin", "http://localhost:3000");
    http.send(res, 201, { ok: true });
    const input = { status: 201, body: { ok: true }, existingCors: "http://localhost:3000" };
    cases.push(recordCase("metadata-http", cases.length, "sends JSON responses without clobbering existing CORS headers", source, "send", input, res.snapshot()));
  }

  {
    const input = {
      optional: [null, " 5 ", "", "bad", "9007199254740992"],
      integer: ["bad", 4, " -2 ", 1.5],
      positive: [0, "3"],
      bounded: ["999", null, "bad"],
    };
    const output = {
      optional: input.optional.map((value) => http.parseOptionalInteger(value, "startLine")),
      integer: input.integer.map((value) => http.parseIntegerValue(value, "rows")),
      positive: input.positive.map((value) => http.parsePositiveInteger(value, "rows")),
      bounded: input.bounded.map((value) => http.parseBoundedLimit(value, "limit", { defaultValue: 10, maxValue: 100 })),
    };
    cases.push(recordCase("metadata-http", cases.length, "parses integer inputs consistently", source, "integer parsers", input, output));
  }

  return {
    version: 1,
    source,
    generatedBy: "scripts/capture-metadata-server-runtime-contract.mjs",
    description:
      "Metadata-server HTTP JSON-read, header normalization, CORS, JSON send, and integer parser behavior captured by running TypeScript http helpers.",
    cases,
  };
}

function captureLibraryDocuments() {
  const source = "src/metadata-server/library-documents.test.ts";
  const dir = mkdtempSync(join(tmpdir(), "aimux-library-docs-contract-"));
  writeFileSync(join(dir, "AGENTS.md"), "repo instructions");
  writeFileSync(join(dir, "config.json"), "hidden");
  writeFileSync(join(dir, "README.md"), "x".repeat(40_001));
  const fixedTime = new Date("2026-01-01T00:00:00.000Z");
  utimesSync(join(dir, "AGENTS.md"), fixedTime, fixedTime);
  utimesSync(join(dir, "README.md"), fixedTime, fixedTime);
  const input = {
    files: [
      { path: "AGENTS.md", content: "repo instructions" },
      { path: "config.json", content: "hidden" },
      { path: "README.md", content: "x".repeat(40_001) },
    ],
    fixedMtime: fixedTime.toISOString(),
  };
  const cases = [
    recordCase(
      "metadata-library-documents",
      0,
      "returns the allowed project documents with bounded content",
      source,
      "listLibraryDocuments",
      input,
      libraryDocuments.listLibraryDocuments(dir),
    ),
  ];
  return {
    version: 1,
    source,
    generatedBy: "scripts/capture-metadata-server-runtime-contract.mjs",
    description:
      "Metadata-server library document allowlist, metadata, bounded content, and truncation behavior captured by running TypeScript listLibraryDocuments against a temporary project.",
    cases,
  };
}

function attachment(overrides = {}) {
  return {
    id: "att-1",
    kind: "image",
    filename: "photo.png",
    mimeType: "image/png",
    sizeBytes: 123,
    sha256: "abc",
    createdAt: "2026-01-01T00:00:00.000Z",
    source: "upload",
    contentPath: "/tmp/photo.png",
    sessionId: "codex-1",
    ...overrides,
  };
}

function captureAgentInput() {
  const source = "src/metadata-server/agent-input.test.ts";
  const inputs = [
    {
      name: "parses shared chat actors from request bodies",
      api: "bodySharedChatActor",
      values: [
        { sharedChatActor: { role: "guest", displayName: "  Sam   Wise  ", email: "sam@example.com" } },
        { sharedChatActor: { role: "admin", displayName: "Sam" } },
        { sharedChatActor: { role: "owner" } },
      ],
    },
    {
      name: "formats shared chat input with a bounded actor prefix",
      api: "sharedChatFormatting",
      values: [
        { text: "  hello  ", actor: { role: "owner", displayName: " Sam\nWise " } },
        { actor: { role: "guest", displayName: "x".repeat(100) } },
        { text: "hello", actor: { role: "guest" } },
      ],
    },
    {
      name: "formats attachment references without changing input when none exist",
      api: "formatAgentInputWithAttachments",
      values: [
        { text: "  keep spacing  ", attachments: [] },
        { text: "", attachments: [attachment()] },
        { text: "Review this", attachments: [attachment({ filename: "notes.md", mimeType: "text/markdown" })] },
      ],
    },
    {
      name: "parses hosted attachment references from request bodies",
      api: "hostedAttachmentFromBody",
      values: [
        {
          contentUrl: "https://example.com/a.png",
          expiresAt: "2026-01-01T01:00:00.000Z",
          sha256: "abc",
          sizeBytes: 123,
        },
        { contentUrl: "https://example.com/a.png" },
      ],
    },
  ];
  const cases = inputs.map((input, index) => {
    let output;
    if (input.api === "bodySharedChatActor") {
      output = input.values.map((value) => agentInput.bodySharedChatActor(value));
    } else if (input.api === "sharedChatFormatting") {
      output = [
        agentInput.formatSharedChatAgentInput(input.values[0].text, input.values[0].actor),
        agentInput.safeSharedChatActorName(input.values[1].actor).length,
        agentInput.formatSharedChatAgentInput(input.values[2].text, input.values[2].actor),
      ];
    } else if (input.api === "formatAgentInputWithAttachments") {
      output = input.values.map((value) => agentInput.formatAgentInputWithAttachments(value.text, value.attachments));
    } else {
      output = input.values.map((value) => agentInput.hostedAttachmentFromBody(value) ?? null);
    }
    return recordCase("metadata-agent-input", index, input.name, source, input.api, input, output);
  });
  return {
    version: 1,
    source,
    generatedBy: "scripts/capture-metadata-server-runtime-contract.mjs",
    description:
      "Metadata-server agent input shared-chat actor, hosted attachment, actor-prefix, and attachment-reference formatting behavior captured by running TypeScript agent-input helpers.",
    cases,
  };
}

const contracts = {
  agentInput: captureAgentInput(),
  dashboardClientState: captureDashboardClientState(),
  exposeSocket: captureExposeSocket(),
  http: await captureHttp(),
  libraryDocuments: captureLibraryDocuments(),
  lifecycleMutationQueue: await captureLifecycleQueue(),
};

for (const [name, contract] of Object.entries(contracts)) {
  await writeContractJson(FIXTURE_PATHS[name], contract);
  console.log(`${FIXTURE_PATHS[name].pathname}: ${contract.cases.length} cases`);
}
