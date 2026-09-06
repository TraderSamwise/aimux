#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/expose-runner.json", ROOT);
const runtimeManager = await import(new URL("dist/tmux/runtime-manager.js", ROOT));
const expose = await import(new URL("dist/tmux/expose.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function item(id, options = {}) {
  return {
    id,
    label: options.label ?? id,
    target: {
      sessionName: "aimux-repo",
      windowId: options.windowId ?? `@${id}`,
      windowIndex: options.index ?? 1,
      windowName: id,
    },
    activity: 1,
    urgency: 0,
    recentRank: options.recentRank ?? Number.MAX_SAFE_INTEGER,
    metadata: {
      sessionId: id,
      command: options.command ?? "codex",
      args: [],
      toolConfigKey: options.toolConfigKey ?? "codex",
      worktreePath: options.worktreePath ?? "/repo",
      recencyAt: options.recencyAt,
    },
    projectRoot: options.projectRoot,
    projectName: options.projectName,
    overseer: options.overseer,
    previewSnapshot: options.previewSnapshot,
  };
}

function normalizeUrl(value) {
  const url = new URL(value, "http://127.0.0.1");
  if (url.searchParams.has("clientId")) url.searchParams.set("clientId", "tmux-expose:<pid>");
  return `${url.pathname}?${url.searchParams.toString()}`.replace(/\?$/, "");
}

function outputSummary(chunks) {
  const text = chunks.join("");
  return {
    hasTitle: text.includes("Exposé"),
    hasRecentOutput: text.includes("recent output"),
    hasDashboardExit: text.includes("^A d dashboard"),
  };
}

async function createJsonServer(responseQueue, requests) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: req.method,
        url: normalizeUrl(req.url ?? "/"),
        body: bodyText ? JSON.parse(bodyText) : null,
      });
      const response = responseQueue.shift() ?? { ok: true, items: [] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function runExposeCase(input) {
  const root = mkdtempSync(join(tmpdir(), "aimux-expose-runner-contract-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  const selectionFile = input.selectionFile ? join(root, "selected-window") : undefined;
  const requests = [];
  const server = await createJsonServer([...(input.responses ?? [])], requests);
  writeFileSync(join(stateDir, "metadata-api.txt"), `${server.endpoint}\n`);
  if (input.uiState) {
    writeFileSync(join(stateDir, "expose-ui-state.json"), JSON.stringify(input.uiState));
  }

  const captureCalls = [];
  const originalCapture = runtimeManager.TmuxRuntimeManager.prototype.captureTarget;
  runtimeManager.TmuxRuntimeManager.prototype.captureTarget = (target, options) => {
    captureCalls.push({ windowId: target.windowId, options });
    return input.captures?.[target.windowId] ?? `capture ${target.windowId}\n`;
  };

  const inputStream = new PassThrough();
  const outputChunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      outputChunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      callback();
    },
  });
  output.columns = 80;
  output.rows = 24;

  const promise = expose.runTmuxExpose({
    projectRoot: "/repo",
    projectStateDir: stateDir,
    currentPath: "/repo",
    currentWindow: input.currentWindow ?? "codex",
    currentWindowId: input.currentWindowId ?? "@1",
    currentClientSession: "aimux-repo-client-deadbeef",
    clientTty: "/dev/ttys001",
    daemonEndpoint: server.endpoint,
    exposeConfig: { initialScope: input.initialScope ?? "worktree" },
    selectionFile,
    input: inputStream,
    output,
    manageTerminal: false,
    columns: 80,
    rows: 24,
  });

  for (const action of input.actions ?? []) {
    setTimeout(() => inputStream.write(Buffer.from(action.data, "utf8")), action.delayMs);
  }
  setTimeout(() => inputStream.end(), input.endDelayMs ?? 600);

  let exitCode;
  try {
    exitCode = await Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for runTmuxExpose")), 2000)),
    ]);
  } finally {
    runtimeManager.TmuxRuntimeManager.prototype.captureTarget = originalCapture;
    await server.close();
  }

  let selected = null;
  if (selectionFile) {
    try {
      selected = readFileSync(selectionFile, "utf8");
    } catch {}
  }
  let uiState = null;
  try {
    uiState = readFileSync(join(stateDir, "expose-ui-state.json"), "utf8");
  } catch {}
  rmSync(root, { recursive: true, force: true });
  return {
    exitCode,
    requests,
    captureCalls,
    selected,
    uiState,
    output: outputSummary(outputChunks),
  };
}

const cases = [];
async function record(name, input) {
  const fullInput = { name, ...input };
  cases.push({
    id: `tmux-expose-runner-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/expose.ts",
    api: "runTmuxExpose",
    input: fullInput,
    output: await runExposeCase(fullInput),
    inputSha256: hash(fullInput),
  });
}

await record("quits after initial worktree load", {
  responses: [{ ok: true, items: [item("one", { windowId: "@1" }), item("two", { windowId: "@2" })] }],
  actions: [{ delayMs: 50, data: "q" }],
});

await record("opens dashboard on leader d", {
  responses: [{ ok: true, items: [item("one", { windowId: "@1" })] }],
  actions: [{ delayMs: 50, data: "\u0001d" }],
});

await record("writes same-project selection file for numbered tile", {
  selectionFile: true,
  responses: [{ ok: true, items: [item("one", { windowId: "@1" }), item("two", { windowId: "@2" })] }],
  actions: [{ delayMs: 50, data: "2" }],
});

await record("toggles recent-output sort before enter", {
  selectionFile: true,
  responses: [
    {
      ok: true,
      items: [
        item("older", { windowId: "@1", recencyAt: "2026-08-27T10:00:00.000Z", recentRank: 2 }),
        item("newer", { windowId: "@2", recencyAt: "2026-08-27T10:05:00.000Z", recentRank: 1 }),
      ],
    },
  ],
  actions: [
    { delayMs: 50, data: "r" },
    { delayMs: 80, data: "\r" },
  ],
});

await record("zooms to project scope and selects first tile", {
  selectionFile: true,
  responses: [
    { ok: true, items: [item("worktree", { windowId: "@1" })] },
    { ok: true, items: [item("project", { windowId: "@3", worktreePath: "/repo/.aimux/worktrees/feat" })] },
  ],
  actions: [
    { delayMs: 50, data: "g" },
    { delayMs: 100, data: "1" },
  ],
});

await record("loads overseer on O and selects it", {
  selectionFile: true,
  responses: [
    { ok: true, items: [item("agent", { windowId: "@1" })] },
    { ok: true, items: [item("agent", { windowId: "@1" }), item("overseer", { windowId: "@9", overseer: true })] },
  ],
  actions: [{ delayMs: 50, data: "O" }],
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-expose-runner-contract.mjs",
  source: "src/tmux/expose.ts",
  subject: "src/tmux/expose.ts",
  description:
    "runTmuxExpose key, scope, focus/selection, capture, and UI-state side effects captured by running TypeScript with tmux patched at the runtime-manager boundary.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
