#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/expose-model.json", ROOT);
const exposeModel = await import(new URL("dist/tmux/expose-model.js", ROOT));
const exposeUiState = await import(new URL("dist/tmux/expose-ui-state.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalizeUrl(value) {
  const url = new URL(value);
  if (url.searchParams.has("clientId")) url.searchParams.set("clientId", "tmux-expose:<pid>");
  return url.toString();
}

function normalizeRequest(call) {
  const [url, request] = call;
  return {
    url: normalizeUrl(url),
    method: request?.method ?? "GET",
    body: request?.body ?? null,
    timeoutMs: request?.timeoutMs ?? null,
  };
}

function normalizeView(view) {
  return {
    scope: view.scope,
    scopeLabel: view.scopeLabel,
    sublabel: view.sublabel,
    itemIds: view.items.map((item) => item.id),
    items: view.items,
  };
}

function createProjectStateDir(endpoint = "http://127.0.0.1:43191") {
  const root = mkdtempSync(join(tmpdir(), "aimux-expose-model-contract-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "metadata-api.txt"), `${endpoint}\n`);
  return { root, stateDir };
}

async function withStateDir(input, run) {
  const { root, stateDir } = createProjectStateDir(input.metadataEndpointFile ?? "http://127.0.0.1:43191");
  try {
    if (input.stateFile !== undefined) {
      writeFileSync(join(stateDir, "expose-ui-state.json"), input.stateFile);
    }
    const result = await run(stateDir);
    const stateFilePath = join(stateDir, "expose-ui-state.json");
    let stateFile = null;
    try {
      stateFile = readFileSync(stateFilePath, "utf8");
    } catch {}
    return { ...result, stateFile };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const context = {
  projectRoot: "/repo",
  currentPath: "/repo/worktree",
  currentWindow: "codex",
  currentWindowId: "@2",
  currentClientSession: "aimux-test-client-12345678",
  clientTty: "/dev/ttys001",
};

const cases = [];
function record(name, api, input, run) {
  const fullInput = { name, ...input };
  cases.push({
    id: `tmux-expose-model-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/expose-model.ts",
    api,
    input: fullInput,
    output: run(fullInput),
    inputSha256: hash(fullInput),
  });
}

async function recordAsync(name, api, input, run) {
  const fullInput = { name, ...input };
  cases.push({
    id: `tmux-expose-model-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/expose-model.ts",
    api,
    input: fullInput,
    output: await run(fullInput),
    inputSha256: hash(fullInput),
  });
}

record(
  "walks and clamps expose scope ladder",
  "nextExposeScope",
  { scopes: ["worktree", "project", "global"] },
  (input) => ({
    values: input.scopes.map((scope) => exposeModel.nextExposeScope(scope)),
  }),
);

record(
  "derives initial scope from launch context and config",
  "initialExposeScope",
  {
    cases: [
      { crossProject: true, context, config: { initialScope: "worktree" } },
      { crossProject: false, context, config: { initialScope: "worktree" } },
      {
        crossProject: false,
        context: { ...context, currentWindow: "dashboard", currentWindowId: "@9" },
        config: { initialScope: "worktree" },
      },
      { crossProject: false, context, config: { initialScope: "project" } },
      { crossProject: false, context: { ...context, currentWindowId: "" }, config: { initialScope: "worktree" } },
      { crossProject: false, context: { ...context, currentWindowId: undefined }, config: {} },
    ],
  },
  (input) => ({
    values: input.cases.map((entry) => exposeModel.initialExposeScope(entry.crossProject, entry.context, entry.config)),
  }),
);

await recordAsync(
  "loads worktree project and global scope items with expose lease params",
  "loadExposeScopeItems",
  {
    responses: [
      { ok: true, items: [{ id: "wt-agent", target: { windowId: "@1" }, previewSnapshot: { output: "warm\n" } }] },
      { ok: false, items: [{ id: "ignored", target: { windowId: "@2" } }] },
      { ok: true, items: [{ id: "global-agent", projectRoot: "/other", target: { windowId: "@9" } }] },
    ],
  },
  async (input) => {
    const requests = [];
    const requestJsonFn = async (...call) => {
      requests.push(normalizeRequest(call));
      return { status: 200, json: input.responses[requests.length - 1] };
    };
    const result = await withStateDir(input, async (stateDir) => ({
      views: [
        normalizeView(await exposeModel.loadExposeScopeItems("worktree", context, stateDir, { requestJsonFn })),
        normalizeView(await exposeModel.loadExposeScopeItems("project", context, stateDir, { requestJsonFn })),
        normalizeView(
          await exposeModel.loadExposeScopeItems("global", context, stateDir, {
            daemonEndpoint: "http://127.0.0.1:43190",
            requestJsonFn,
          }),
        ),
      ],
      requests,
    }));
    return { views: result.views, requests: result.requests };
  },
);

await recordAsync(
  "loads overseer through opt in project query",
  "loadOverseerExposeItem",
  {
    responses: [
      {
        ok: true,
        items: [
          { id: "agent", target: { windowId: "@1" } },
          { id: "boss", overseer: true },
        ],
      },
    ],
  },
  async (input) => {
    const requests = [];
    const requestJsonFn = async (...call) => {
      requests.push(normalizeRequest(call));
      return { status: 200, json: input.responses[requests.length - 1] };
    };
    return withStateDir(input, async (stateDir) => ({
      item: await exposeModel.loadOverseerExposeItem(context, stateDir, { requestJsonFn }),
      requests,
    }));
  },
);

await recordAsync(
  "focuses local and global expose items through correct routes",
  "focusExposeItem",
  {
    responses: [{ ok: true }, { ok: false }],
  },
  async (input) => {
    const requests = [];
    const requestJsonFn = async (...call) => {
      requests.push(normalizeRequest(call));
      return { status: 200, json: input.responses[requests.length - 1] };
    };
    const result = await withStateDir(input, async (stateDir) => ({
      results: [
        await exposeModel.focusExposeItem({ id: "local", target: { windowId: "@1" } }, context, stateDir, {
          requestJsonFn,
        }),
        await exposeModel.focusExposeItem(
          { id: "global", projectRoot: "/other", target: { windowId: "@9" } },
          context,
          stateDir,
          { daemonEndpoint: "http://127.0.0.1:43190", requestJsonFn },
        ),
      ],
      requests,
    }));
    return { results: result.results, requests: result.requests };
  },
);

await recordAsync(
  "reads default ui state for missing invalid or unknown sort mode",
  "readExposeUiState",
  { stateFile: '{"version":1,"sortMode":"unknown"}' },
  async (input) =>
    withStateDir(input, async (stateDir) => ({
      states: [exposeUiState.readExposeUiState(join(stateDir, "missing")), exposeUiState.readExposeUiState(stateDir)],
    })),
);

await recordAsync("writes and reads recent output ui state", "writeExposeUiState", {}, async (input) =>
  withStateDir(input, async (stateDir) => {
    exposeUiState.writeExposeUiState(stateDir, { sortMode: "recent-output" });
    return { state: exposeUiState.readExposeUiState(stateDir) };
  }),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-expose-model-contract.mjs",
  source: "src/tmux/expose-ui-state.test.ts",
  sources: [
    "src/tmux/expose-model.test.ts",
    "src/tmux/expose-ui-state.test.ts",
    "src/tmux/expose-model.ts",
    "src/tmux/expose-ui-state.ts",
  ],
  subject: "src/tmux/expose-model.ts + src/tmux/expose-ui-state.ts",
  description: "Expose scope, HTTP request, focus, overseer, and UI-state behavior captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
