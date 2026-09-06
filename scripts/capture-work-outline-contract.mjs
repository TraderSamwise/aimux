#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/work-outline/outline.json", ROOT);

const paths = await import(new URL("dist/paths.js", ROOT));
const outline = await import(new URL("dist/work-outline.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function gitInit(cwd) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;
  execFileSync("git", ["init"], { cwd, stdio: "ignore", env });
}

function normalize(value) {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "string") return nested;
      return nested.replace(/work-outline\.json\.corrupt-\d+/g, "work-outline.json.corrupt-<ts>");
    }),
  );
}

async function withProject(label, fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), `aimux-work-outline-contract-${label}-`));
  let stateDir;
  try {
    gitInit(repoRoot);
    await paths.initPaths(repoRoot);
    stateDir = paths.getProjectStateDirFor(repoRoot);
    return normalize(await fn(repoRoot));
  } finally {
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function stateSummary(repoRoot) {
  const state = outline.readWorkOutlineState(repoRoot);
  return {
    count: state.entries.length,
    first: state.entries[0],
    last: state.entries[state.entries.length - 1],
  };
}

const cases = [];
const add = async (name, scenario, fn) => {
  const input = { scenario };
  cases.push({
    id: `work-outline-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/work-outline.test.ts",
    input,
    output: await withProject(scenario, fn),
    inputSha256: hash(input),
  });
};

await add("upserts by topic and worktree while merging session ids", "upsert-merge", (repoRoot) => {
  const first = outline.updateWorkOutlineEntry(
    {
      topicKey: "Release Train",
      title: "Release train",
      summary: "Prepare the release.",
      sessionId: "codex-a",
      worktreePath: "/repo/main",
      evidence: { source: "tail", startLine: 5, endLine: 9 },
    },
    { projectRoot: repoRoot, now: "2026-08-30T00:00:00.000Z" },
  );
  const second = outline.updateWorkOutlineEntry(
    {
      topicKey: "release train",
      title: "Release train",
      summary: "Release is ready to cut.",
      sessionIds: ["claude-b", "codex-a"],
      worktreePath: "/repo/main",
    },
    { projectRoot: repoRoot, now: "2026-08-30T00:01:00.000Z" },
  );
  return { first, second, state: outline.readWorkOutlineState(repoRoot) };
});

await add("filters by status, session, worktree, and search text", "filters", (repoRoot) => {
  const alpha = outline.updateWorkOutlineEntry(
    {
      topicKey: "alpha",
      title: "Alpha cleanup",
      summary: "Remove stale paths.",
      sessionId: "codex-a",
      status: "done",
      worktreePath: "/repo/alpha",
    },
    { projectRoot: repoRoot, now: "2026-08-30T00:00:00.000Z" },
  );
  const beta = outline.updateWorkOutlineEntry(
    {
      topicKey: "beta",
      title: "Beta scheduler",
      summary: "Scan changed agents.",
      sessionId: "claude-b",
      status: "active",
      worktreePath: "/repo/beta",
    },
    { projectRoot: repoRoot, now: "2026-08-30T00:01:00.000Z" },
  );
  return {
    alpha,
    beta,
    done: outline.listWorkOutlineEntries({ status: "done" }, repoRoot),
    session: outline.listWorkOutlineEntries({ sessionId: "codex-a" }, repoRoot),
    worktree: outline.listWorkOutlineEntries({ worktreePath: "/repo/alpha" }, repoRoot),
    search: outline.listWorkOutlineEntries({ q: "stale" }, repoRoot),
  };
});

await add("bounds stored entries and truncates large text", "bounds-text", (repoRoot) => {
  const title = "t".repeat(outline.WORK_OUTLINE_TITLE_MAX_CHARS + 20);
  const summary = "s".repeat(outline.WORK_OUTLINE_SUMMARY_MAX_CHARS + 20);
  for (let index = 0; index < outline.WORK_OUTLINE_MAX_ENTRIES + 5; index += 1) {
    const now = new Date(Date.UTC(2026, 7, 30, 0, 0, index)).toISOString();
    outline.updateWorkOutlineEntry({ topicKey: `topic-${index}`, title, summary }, { projectRoot: repoRoot, now });
  }
  return {
    summary: stateSummary(repoRoot),
    missing: outline.getWorkOutlineEntry("outline-missing", repoRoot) ?? null,
  };
});

await add("bounds and truncates session ids on new and existing entries", "bounds-session-ids", (repoRoot) => {
  const longId = `codex-${"x".repeat(outline.WORK_OUTLINE_SESSION_ID_MAX_CHARS + 20)}`;
  const manyIds = Array.from({ length: outline.WORK_OUTLINE_MAX_SESSION_IDS + 20 }, (_, index) => `codex-${index}`);
  const first = outline.updateWorkOutlineEntry(
    {
      topicKey: "session bound",
      title: "Session bound",
      summary: "Keep persisted session id arrays bounded.",
      sessionIds: [longId, ...manyIds],
    },
    { projectRoot: repoRoot, now: "2026-08-30T00:00:00.000Z" },
  );
  const second = outline.updateWorkOutlineEntry(
    {
      topicKey: "session bound",
      title: "Session bound",
      summary: "Keep persisted session id arrays bounded after updates.",
      sessionIds: Array.from({ length: 20 }, (_, index) => `claude-${index}`),
    },
    { projectRoot: repoRoot, now: "2026-08-30T00:01:00.000Z" },
  );
  return { first, second, state: outline.readWorkOutlineState(repoRoot) };
});

await add("quarantines corrupt JSON instead of throwing or reparsing forever", "corrupt-json", (repoRoot) => {
  const path = join(paths.getProjectStateDirFor(repoRoot), "work-outline.json");
  writeFileSync(path, "{not json");
  const state = outline.readWorkOutlineState(repoRoot);
  const files = readdirSync(paths.getProjectStateDirFor(repoRoot))
    .filter((file) => file.startsWith("work-outline.json"))
    .sort();
  return {
    state,
    exists: existsSync(path),
    files,
  };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/work-outline.test.ts",
  generatedBy: "scripts/capture-work-outline-contract.mjs",
  description:
    "Work outline upsert, filtering, bounds, session-id truncation, and corrupt-state quarantine contracts captured by running TypeScript work-outline helpers.",
  normalization: {
    corruptFiles: "Time-derived corrupt quarantine suffixes are replaced with work-outline.json.corrupt-<ts>.",
  },
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
