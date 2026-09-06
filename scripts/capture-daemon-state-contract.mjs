#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/daemon-state/state.json", ROOT);

const daemonState = await import(new URL("dist/daemon-state.js", ROOT));
const paths = await import(new URL("dist/paths.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalizeString(value, replacements) {
  let normalized = value;
  for (const [needle, token] of replacements) {
    normalized = normalized.split(needle).join(token);
  }
  return normalized;
}

function normalize(value, replacements) {
  if (Array.isArray(value)) return value.map((item) => normalize(item, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, normalize(nested, replacements)]));
  }
  return typeof value === "string" ? normalizeString(value, replacements) : value;
}

function captureResult(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const cases = [];
function record(name, api, input, output) {
  cases.push({
    id: `daemon-state-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/daemon-state.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}

function withDaemonHome(rawState, fn) {
  const tempRoot = mkdtempSync(join(tmpdir(), "aimux-daemon-state-contract-"));
  const aimuxHome = join(tempRoot, ".aimux");
  const gitProject = join(tempRoot, "git-project");
  const nonGitProject = join(tempRoot, "non-git-project");
  mkdirSync(join(gitProject, ".git"), { recursive: true });
  mkdirSync(nonGitProject, { recursive: true });

  const previousHome = process.env.AIMUX_HOME;
  process.env.AIMUX_HOME = aimuxHome;
  const replacements = [
    [aimuxHome, "<aimuxHome>"],
    [gitProject, "<gitProject>"],
    [nonGitProject, "<nonGitProject>"],
    [tempRoot, "<tempRoot>"],
  ];

  try {
    mkdirSync(join(aimuxHome, "daemon"), { recursive: true });
    if (rawState !== undefined) {
      const stateForDisk = normalize(
        rawState,
        [
          ["<aimuxHome>", aimuxHome],
          ["<gitProject>", gitProject],
          ["<nonGitProject>", nonGitProject],
          ["<tempRoot>", tempRoot],
        ],
      );
      writeFileSync(paths.getDaemonStatePath(), typeof stateForDisk === "string" ? stateForDisk : JSON.stringify(stateForDisk));
    }
    return {
      replacements,
      value: fn(),
    };
  } finally {
    if (previousHome === undefined) {
      delete process.env.AIMUX_HOME;
    } else {
      process.env.AIMUX_HOME = previousHome;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function recordLoadDaemonState(name, rawState) {
  const captured = withDaemonHome(rawState, () => daemonState.loadDaemonState());
  const normalizedInput = normalize({ rawState }, captured.replacements);
  record(name, "loadDaemonState", normalizedInput, normalize(captured.value, captured.replacements));
}

const timestamp = "2026-08-25T00:00:00.000Z";

recordLoadDaemonState("ignores non-git project service records", {
  version: 1,
  updatedAt: timestamp,
  projects: {
    git: {
      projectId: "git",
      projectRoot: "<gitProject>",
      pid: 123,
      startedAt: timestamp,
      updatedAt: timestamp,
      status: "running",
      futureSupervisorField: true,
    },
    stale: {
      projectId: "stale",
      projectRoot: "<nonGitProject>",
      pid: 456,
      startedAt: timestamp,
      updatedAt: timestamp,
    },
  },
});

recordLoadDaemonState("ignores malformed project service records", {
  version: 1,
  updatedAt: timestamp,
  projects: {
    missingRoot: {
      projectId: "missingRoot",
      pid: 456,
      startedAt: timestamp,
      updatedAt: timestamp,
    },
    numericRoot: {
      projectId: "numericRoot",
      projectRoot: 123,
      pid: 789,
      startedAt: timestamp,
      updatedAt: timestamp,
    },
  },
});

recordLoadDaemonState("returns epoch state for missing daemon state file", undefined);
recordLoadDaemonState("returns epoch state for malformed daemon state JSON", "{not-json");

for (const value of [undefined, "", " localhost ", "0.0.0.0"]) {
  const previous = process.env.AIMUX_DAEMON_HOST;
  if (value === undefined) {
    delete process.env.AIMUX_DAEMON_HOST;
  } else {
    process.env.AIMUX_DAEMON_HOST = value;
  }
  record("resolves daemon host environment", "getDaemonHost", { env: value ?? null }, captureResult(daemonState.getDaemonHost));
  if (previous === undefined) {
    delete process.env.AIMUX_DAEMON_HOST;
  } else {
    process.env.AIMUX_DAEMON_HOST = previous;
  }
}

for (const value of [undefined, "", " 44191 ", "0x10", "1e2", "1.5", "65536", "-0x10"]) {
  const previous = process.env.AIMUX_DAEMON_PORT;
  if (value === undefined) {
    delete process.env.AIMUX_DAEMON_PORT;
  } else {
    process.env.AIMUX_DAEMON_PORT = value;
  }
  record("resolves daemon port environment", "getDaemonPort", { env: value ?? null }, captureResult(daemonState.getDaemonPort));
  if (previous === undefined) {
    delete process.env.AIMUX_DAEMON_PORT;
  } else {
    process.env.AIMUX_DAEMON_PORT = previous;
  }
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/daemon-state.test.ts",
  generatedBy: "scripts/capture-daemon-state-contract.mjs",
  description:
    "Daemon state loading, malformed-record filtering, missing/corrupt fallback, and daemon host/port environment contracts captured by running TypeScript daemon-state helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
