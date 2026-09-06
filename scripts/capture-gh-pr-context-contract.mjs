#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const SOURCE_URL = new URL("src/default-plugins/gh-pr-context.ts", ROOT);
const FIXTURE_PATH = new URL("testdata/contracts/v1/default-plugins/gh-pr-context.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

const source = (await readFile(SOURCE_URL, "utf8")).replace(/^import[\s\S]*?;\n/gm, "");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: SOURCE_URL.pathname,
}).outputText;

const { collectGithubPrTargets } = await import(moduleUrl(transpiled));

const inputs = [
  {
    name: "ignores stale statusline, state, and metadata-only agent sessions",
    statusline: {
      sessions: [{ id: "live-from-statusline", worktreePath: "/repo/live" }],
    },
    state: {
      sessions: [{ id: "live-from-state", worktreePath: "/repo/state" }],
      services: [{ id: "service-1", worktreePath: "/repo/service" }],
    },
    metadata: {
      sessions: {
        "metadata-only-old-agent": {
          context: { worktreePath: "/repo/stale" },
        },
      },
    },
    topologySessions: [{ id: "live-from-topology", worktreePath: "/repo/topology" }],
  },
  {
    name: "uses statusline and metadata context only to complete topology session paths",
    statusline: {
      sessions: [{ id: "statusline-missing-path" }],
    },
    state: {
      sessions: [{ id: "state-missing-path" }],
    },
    metadata: {
      sessions: {
        "statusline-missing-path": {
          context: { cwd: "/repo/statusline" },
        },
        "state-missing-path": {
          context: { worktreePath: "/repo/state" },
        },
        "topology-missing-path": {
          context: { worktreePath: "/repo/topology" },
        },
      },
    },
    topologySessions: [{ id: "statusline-missing-path" }, { id: "topology-missing-path" }],
  },
  {
    name: "keeps topology ordering and appends services that are not topology sessions",
    statusline: {
      sessions: [
        { id: "session-a", worktreePath: "/repo/statusline-a" },
        { id: "session-b", worktreePath: "/repo/statusline-b" },
      ],
    },
    state: {
      services: [
        { id: "session-b", worktreePath: "/repo/service-b" },
        { id: "service-only", worktreePath: "/repo/service-only" },
      ],
    },
    metadata: {
      sessions: {
        "session-a": { context: { worktreePath: "/repo/metadata-a" } },
      },
    },
    topologySessions: [{ id: "session-b", worktreePath: "/repo/topology-b" }, { id: "session-a" }],
  },
  {
    name: "filters topology and service candidates without any usable worktree path",
    statusline: {
      sessions: [{ id: "missing-everywhere" }, { id: "from-statusline", worktreePath: "/repo/statusline" }],
    },
    state: {
      services: [{ id: "service-no-path" }, { id: "service-with-path", worktreePath: "/repo/service" }],
    },
    metadata: {
      sessions: {
        "metadata-no-context": {},
        "from-cwd": { context: { cwd: "/repo/cwd" } },
      },
    },
    topologySessions: [
      { id: "missing-everywhere" },
      { id: "metadata-no-context" },
      { id: "from-statusline" },
      { id: "from-cwd" },
    ],
  },
];

const cases = inputs.map((input, index) => ({
  id: `gh-pr-context-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/default-plugins/gh-pr-context.test.ts",
  api: "collectGithubPrTargets",
  input: { api: "collectGithubPrTargets", ...input },
  output: collectGithubPrTargets(input.statusline, input.state, input.metadata, input.topologySessions),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/default-plugins/gh-pr-context.test.ts",
  generatedBy: "scripts/capture-gh-pr-context-contract.mjs",
  description:
    "Default GitHub PR context target selection captured by running TypeScript collectGithubPrTargets.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
