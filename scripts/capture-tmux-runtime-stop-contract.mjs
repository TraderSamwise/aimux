#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/runtime-stop.json", ROOT);
const { initPaths } = await import(new URL("dist/paths.js", ROOT));
const { listManagedProjectSessionNames, stopProjectTmuxRuntime } = await import(
  new URL("dist/tmux/runtime-stop.js", ROOT)
);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function fakeTmux(input) {
  const calls = [];
  return {
    calls,
    getProjectSession: (projectRoot) => {
      calls.push(["getProjectSession", projectRoot]);
      return { projectRoot, projectId: "repo", sessionName: input.hostSession };
    },
    listSessionNames: () => {
      calls.push(["listSessionNames"]);
      return [...input.sessions];
    },
    isAvailable: () => {
      calls.push(["isAvailable"]);
      return input.available !== false;
    },
    listProjectManagedWindows: (projectRoot) => {
      calls.push(["listProjectManagedWindows", projectRoot]);
      return [];
    },
    hasSession: (sessionName) => {
      calls.push(["hasSession", sessionName]);
      return !input.missing?.includes(sessionName);
    },
    killSession: (sessionName) => {
      calls.push(["killSession", sessionName]);
      if (input.killErrors?.includes(sessionName)) throw new Error(`kill failed: ${sessionName}`);
    },
  };
}

const cases = [];
function normalize(value, repoRoot) {
  if (typeof value === "string") return value.split(repoRoot).join("<repo>");
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, repoRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalize(entry, repoRoot)]));
  }
  return value;
}

function capture(run) {
  try {
    return { thrown: null, snapshot: run() };
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error), snapshot: null };
  }
}

async function record(name, input, run) {
  const repoRoot = mkdtempSync(join(tmpdir(), "aimux-runtime-stop-"));
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  try {
    await initPaths(repoRoot);
    const tmux = fakeTmux(input);
    const output = normalize(
      capture(() => run(tmux, repoRoot)),
      repoRoot,
    );
    const fullInput = { name, ...input };
    cases.push({
      id: `tmux-runtime-stop-${String(cases.length + 1).padStart(3, "0")}`,
      name,
      source: "src/tmux/runtime-stop.ts",
      api: "runtime-stop",
      input: fullInput,
      output,
      inputSha256: hash(fullInput),
    });
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

await record(
  "lists only host and client sessions with clients before host",
  {
    hostSession: "aimux-repo",
    sessions: [
      "user-session",
      "aimux-repo",
      "aimux-repo-client-deadbeef",
      "aimux-repo-client-1234567g",
      "aimux-other-client-deadbeef",
      "aimux-repo-client-feedface",
    ],
  },
  (tmux, repoRoot) => ({
    sessions: listManagedProjectSessionNames(tmux, repoRoot),
    calls: tmux.calls,
  }),
);

await record(
  "stop returns empty when tmux is unavailable",
  {
    available: false,
    hostSession: "aimux-repo",
    sessions: ["aimux-repo", "aimux-repo-client-deadbeef"],
  },
  (tmux, repoRoot) => ({
    killed: stopProjectTmuxRuntime(tmux, repoRoot),
    calls: tmux.calls,
  }),
);

await record(
  "persists snapshots before killing clients and host",
  {
    hostSession: "aimux-repo",
    sessions: ["aimux-repo", "aimux-repo-client-deadbeef", "aimux-repo-client-feedface"],
  },
  (tmux, repoRoot) => ({
    killed: stopProjectTmuxRuntime(tmux, repoRoot),
    calls: tmux.calls,
  }),
);

await record(
  "skips missing sessions then throws on failed kill",
  {
    hostSession: "aimux-repo",
    sessions: ["aimux-repo-client-deadbeef", "aimux-repo-client-feedface", "aimux-repo"],
    missing: ["aimux-repo-client-deadbeef"],
    killErrors: ["aimux-repo"],
  },
  (tmux, repoRoot) => ({
    killed: stopProjectTmuxRuntime(tmux, repoRoot),
    calls: tmux.calls,
  }),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-06T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-runtime-stop-contract.mjs",
  source: "src/tmux/runtime-stop.ts",
  subject: "src/tmux/runtime-stop.ts",
  description: "Runtime stop session filtering and kill ordering captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
