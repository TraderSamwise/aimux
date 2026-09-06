#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/default-plugins/transcript-length.json", ROOT);
const AIMUX_HOME = "/tmp/aimux-transcript-length-contract-home";

process.env.AIMUX_HOME = AIMUX_HOME;

const { initPaths, getContextDir, getHistoryDir, getProjectStateDir } = await import(new URL("dist/paths.js", ROOT));
const { updateSessionMetadata } = await import(new URL("dist/metadata-store.js", ROOT));
const { createTranscriptLengthPlugin } = await import(new URL("dist/default-plugins/transcript-length.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function cleanRoot(projectRoot) {
  rmSync(projectRoot, { recursive: true, force: true });
}

function historyLine(turn) {
  return JSON.stringify(turn);
}

function checkpointLine(checkpoint) {
  return JSON.stringify(checkpoint);
}

function applySetup(setup) {
  for (const entry of setup.history ?? []) {
    const path = join(getHistoryDir(), `${entry.sessionId}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${entry.line}\n`);
  }
  for (const entry of setup.checkpoints ?? []) {
    const path = join(getContextDir(), entry.sessionId, "summary.checkpoints.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${entry.line}\n`);
  }
  for (const entry of setup.externalTranscripts ?? []) {
    mkdirSync(dirname(entry.path), { recursive: true });
    writeFileSync(entry.path, "x".repeat(entry.bytes));
    updateSessionMetadata(entry.sessionId, (current) => ({
      ...current,
      context: {
        ...(current.context ?? {}),
        transcriptPath: entry.path,
      },
    }));
  }
}

async function runCase(input) {
  cleanRoot(input.projectRoot);
  mkdirSync(join(input.projectRoot, ".git"), { recursive: true });
  await initPaths(input.projectRoot);
  applySetup(input.beforeStart ?? {});
  const writes = [];
  const clears = [];
  let sessions = [...input.initialSessions];
  const plugin = createTranscriptLengthPlugin(
    {
      projectRoot: input.projectRoot,
      projectId: "test",
      serverHost: "127.0.0.1",
      serverPort: 9999,
      metadata: {
        setStatus: () => {},
        setProgress: () => {},
        log: () => {},
        clearLog: () => {},
        setContext: () => {},
        setStatuslineSegment: (session, line, segment) => {
          writes.push({ session, line, segment });
        },
        clearStatuslineSegment: (session, segmentId) => {
          clears.push({ session, segmentId });
        },
        setServices: () => {},
        emitEvent: () => {},
        markSeen: () => {},
        setActivity: () => {},
        setAttention: () => {},
      },
      sessions: {
        list: () => sessions.map((id) => ({ id })),
      },
    },
    { line: input.line },
  );
  plugin.start?.();
  for (const step of input.afterStart ?? []) {
    applySetup(step.setup ?? {});
    if (step.sessions) sessions = [...step.sessions];
    await sleep(step.delayMs ?? 0);
  }
  plugin.stop?.();
  return {
    projectStateDir: getProjectStateDir(),
    writes,
    clears,
  };
}

const projectRootBase = "/tmp/aimux-transcript-length-contract-project";
const inputs = [
  {
    name: "resets transcript length after compaction checkpoints",
    projectRoot: `${projectRootBase}-checkpoint`,
    line: "top",
    initialSessions: ["codex-1"],
    beforeStart: {
      history: [
        {
          sessionId: "codex-1",
          line: historyLine({ ts: "2026-04-17T00:00:00.000Z", type: "prompt", content: "hello" }),
        },
      ],
    },
    afterStart: [
      {
        setup: {
          checkpoints: [
            {
              sessionId: "codex-1",
              line: checkpointLine({ lastTurnTs: "2026-04-17T00:00:00.000Z" }),
            },
          ],
        },
        delayMs: 2100,
      },
    ],
  },
  {
    name: "renders 0b when a session has no transcript history",
    projectRoot: `${projectRootBase}-empty`,
    line: "top",
    initialSessions: ["codex-empty"],
  },
  {
    name: "uses Claude transcript files when hook metadata provides a transcript path",
    projectRoot: `${projectRootBase}-external`,
    line: "top",
    initialSessions: ["claude-1"],
    beforeStart: {
      externalTranscripts: [
        {
          sessionId: "claude-1",
          path: `${projectRootBase}-external/claude-transcript.jsonl`,
          bytes: 2048,
        },
      ],
    },
  },
  {
    name: "clears stale rendered sessions when they disappear",
    projectRoot: `${projectRootBase}-stale`,
    line: "bottom",
    initialSessions: ["codex-stale"],
    beforeStart: {
      history: [
        {
          sessionId: "codex-stale",
          line: historyLine({ ts: "2026-04-17T00:00:00.000Z", type: "response", content: "still here" }),
        },
      ],
    },
    afterStart: [{ sessions: [], delayMs: 2100 }],
  },
];

const cases = [];
for (const input of inputs) {
  cases.push({
    id: `transcript-length-${String(cases.length + 1).padStart(3, "0")}`,
    name: input.name,
    source: "src/default-plugins/transcript-length.test.ts",
    api: "createTranscriptLengthPlugin",
    input: { api: "createTranscriptLengthPlugin", ...input },
    output: await runCase(input),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/default-plugins/transcript-length.test.ts",
  generatedBy: "scripts/capture-transcript-length-contract.mjs",
  description:
    "Default transcript-length plugin statusline writes, checkpoint reset, external transcript-path size, empty history, and stale-session clearing captured by running TypeScript createTranscriptLengthPlugin.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
