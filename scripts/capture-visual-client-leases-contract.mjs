#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/visual-client-leases/leases.json", ROOT);

const { VisualClientLeaseRegistry, parseVisualClientKind } = await import(
  new URL("dist/visual-client-leases.js", ROOT)
);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const cases = [];
function record(name, api, input, output) {
  cases.push({
    id: `visual-client-leases-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/visual-client-leases.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}

for (const value of ["tui", "web", "mobile", "expose", "api", "dashboard", "", null, undefined]) {
  record("parses visual client kind", "parseVisualClientKind", { value: value ?? null }, parseVisualClientKind(value));
}

function runRegistry(initialNow, steps) {
  let nowMs = Date.parse(initialNow);
  const registry = new VisualClientLeaseRegistry({ now: () => new Date(nowMs) });
  const outputs = [];
  for (const step of steps) {
    if (step.advanceMs) nowMs += step.advanceMs;
    if (step.op === "touch") {
      outputs.push({ op: "touch", lease: registry.touch(step.input) });
    } else if (step.op === "snapshot") {
      outputs.push({ op: "snapshot", snapshot: registry.snapshot() });
    } else if (step.op === "hasActivePreviewClients") {
      outputs.push({ op: "hasActivePreviewClients", value: registry.hasActivePreviewClients() });
    }
  }
  return outputs;
}

record(
  "tracks active visual clients by kind and prunes expired leases",
  "VisualClientLeaseRegistry",
  {
    initialNow: "2026-08-25T00:00:00.000Z",
    steps: [
      {
        op: "touch",
        input: {
          id: "dashboard:1",
          kind: "tui",
          surface: "desktop-state",
          requestedPreview: true,
          ttlMs: 5000,
        },
      },
      {
        op: "touch",
        input: {
          id: "app-expose",
          kind: "web",
          surface: "expose",
          requestedPreview: true,
          requestedChatPreview: true,
        },
      },
      { op: "snapshot" },
      { op: "hasActivePreviewClients" },
      { op: "snapshot", advanceMs: 6000 },
    ],
  },
  runRegistry("2026-08-25T00:00:00.000Z", [
    {
      op: "touch",
      input: {
        id: "dashboard:1",
        kind: "tui",
        surface: "desktop-state",
        requestedPreview: true,
        ttlMs: 5000,
      },
    },
    {
      op: "touch",
      input: {
        id: "app-expose",
        kind: "web",
        surface: "expose",
        requestedPreview: true,
        requestedChatPreview: true,
      },
    },
    { op: "snapshot" },
    { op: "hasActivePreviewClients" },
    { op: "snapshot", advanceMs: 6000 },
  ]),
);

record(
  "renews matching lease without changing startedAt",
  "VisualClientLeaseRegistry",
  {
    initialNow: "2026-08-25T00:00:00.000Z",
    steps: [
      {
        op: "touch",
        input: {
          id: "client",
          kind: "expose",
          surface: "expose",
          requestedPreview: true,
          ttlMs: 1000,
        },
      },
      {
        op: "touch",
        advanceMs: 500,
        input: {
          id: "client",
          kind: "expose",
          surface: "expose",
          requestedPreview: true,
          ttlMs: 2000,
        },
      },
      { op: "snapshot" },
    ],
  },
  runRegistry("2026-08-25T00:00:00.000Z", [
    {
      op: "touch",
      input: {
        id: "client",
        kind: "expose",
        surface: "expose",
        requestedPreview: true,
        ttlMs: 1000,
      },
    },
    {
      op: "touch",
      advanceMs: 500,
      input: {
        id: "client",
        kind: "expose",
        surface: "expose",
        requestedPreview: true,
        ttlMs: 2000,
      },
    },
    { op: "snapshot" },
  ]),
);

record(
  "sanitizes anonymous lease identity and clamps ttl",
  "VisualClientLeaseRegistry",
  {
    initialNow: "2026-08-25T00:00:00.000Z",
    steps: [
      { op: "touch", input: { id: "  bad id!*  ", kind: "dashboard", surface: " chat/view!* ", ttlMs: 1.9 } },
      { op: "touch", input: { id: "", kind: null, surface: "", ttlMs: "999999" } },
      { op: "touch", input: { id: "nan", kind: "mobile", surface: "preview", ttlMs: "nope" } },
      { op: "snapshot" },
    ],
  },
  runRegistry("2026-08-25T00:00:00.000Z", [
    { op: "touch", input: { id: "  bad id!*  ", kind: "dashboard", surface: " chat/view!* ", ttlMs: 1.9 } },
    { op: "touch", input: { id: "", kind: null, surface: "", ttlMs: "999999" } },
    { op: "touch", input: { id: "nan", kind: "mobile", surface: "preview", ttlMs: "nope" } },
    { op: "snapshot" },
  ]),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/visual-client-leases.test.ts",
  generatedBy: "scripts/capture-visual-client-leases-contract.mjs",
  description:
    "Visual client lease kind parsing, sanitization, TTL clamping, renewal, pruning, preview counts, and sorted snapshot contracts captured by running TypeScript visual-client-leases helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
