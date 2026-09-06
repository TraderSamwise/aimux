#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-state/last-used.json", ROOT);
const lastUsed = await import(new URL("dist/last-used.js", ROOT));
const { getLastUsedPath, loadLastUsedState, markLastUsed } = lastUsed;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const cases = [];
function record(name, api, input, output) {
  const stableInput = structuredClone(input);
  const stableOutput = structuredClone(output);
  cases.push({
    id: `runtime-state-last-used-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/last-used.test.ts",
    api,
    input: stableInput,
    output: stableOutput,
    inputSha256: hash(stableInput),
  });
}
async function withProject(callback) {
  const previousHome = process.env.AIMUX_HOME;
  const aimuxHome = mkdtempSync(join(tmpdir(), "aimux-last-used-home-contract-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "aimux-last-used-project-contract-"));
  mkdirSync(join(projectRoot, ".git"), { recursive: true });
  process.env.AIMUX_HOME = aimuxHome;
  try {
    return callback(projectRoot);
  } finally {
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(aimuxHome, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  }
}
function seededLastUsedState(entries, clientSession = "client-1") {
  const recentIds = entries.map(([itemId]) => itemId).reverse();
  return {
    version: 1,
    items: Object.fromEntries(entries),
    clients: {
      [clientSession]: {
        recentIds,
        items: Object.fromEntries(entries),
        updatedAt: entries.at(-1)?.[1].lastUsedAt ?? "",
      },
    },
    projectRecentIds: recentIds,
  };
}

const monotonicInput = {
  marks: [
    { itemId: "agent-a", clientSession: "client-1", usedAt: "2026-06-28T04:00:01.000Z" },
    { itemId: "agent-b", clientSession: "client-1", usedAt: "2026-06-28T04:00:02.000Z" },
    { itemId: "agent-a", clientSession: "client-1", usedAt: "2026-06-28T04:00:01.000Z" },
  ],
};
record("keeps recent ordering monotonic when older usage marks arrive late", "markSequence", monotonicInput, await withProject((projectRoot) => {
  for (const mark of monotonicInput.marks) markLastUsed(projectRoot, mark);
  const state = loadLastUsedState(projectRoot);
  return {
    projectRecentIdsFirst2: state.projectRecentIds.slice(0, 2),
    client1RecentIdsFirst2: state.clients["client-1"]?.recentIds.slice(0, 2),
    updatedAt: state.updatedAt,
    client1UpdatedAt: state.clients["client-1"]?.updatedAt,
  };
}));

const olderInput = {
  marks: [
    { itemId: "agent-a", usedAt: "2026-06-28T04:00:03.000Z" },
    { itemId: "agent-a", usedAt: "2026-06-28T04:00:01.000Z" },
  ],
};
record("does not let an older mark overwrite a newer item timestamp", "markSequence", olderInput, await withProject((projectRoot) => {
  for (const mark of olderInput.marks) markLastUsed(projectRoot, mark);
  return { itemLastUsedAt: loadLastUsedState(projectRoot).items["agent-a"]?.lastUsedAt };
}));

const clientsInput = {
  marks: [
    { itemId: "agent-a", clientSession: "client-1", usedAt: "2026-06-28T04:00:01.000Z" },
    { itemId: "agent-a", clientSession: "client-2", usedAt: "2026-06-28T04:00:03.000Z" },
    { itemId: "agent-b", clientSession: "client-1", usedAt: "2026-06-28T04:00:02.000Z" },
  ],
};
record("keeps each client's recency independent from other clients using the same item", "markSequence", clientsInput, await withProject((projectRoot) => {
  for (const mark of clientsInput.marks) markLastUsed(projectRoot, mark);
  const state = loadLastUsedState(projectRoot);
  return {
    projectRecentIdsFirst2: state.projectRecentIds.slice(0, 2),
    client1RecentIdsFirst2: state.clients["client-1"]?.recentIds.slice(0, 2),
    client2RecentIdsFirst1: state.clients["client-2"]?.recentIds.slice(0, 1),
  };
}));

const seededEntries = Array.from({ length: 69 }, (_, index) => [
  `agent-${index}`,
  { lastUsedAt: new Date(Date.UTC(2026, 5, 28, 4, 0, index)).toISOString() },
]);
const pruneInput = {
  seed: seededLastUsedState(seededEntries),
  mark: { itemId: "agent-69", clientSession: "client-1", usedAt: "2026-06-28T04:01:09.000Z" },
};
record("prunes per-client item timestamps to the recent id limit", "seedAndMark", pruneInput, await withProject((projectRoot) => {
  mkdirSync(join(getLastUsedPath(projectRoot), ".."), { recursive: true });
  writeFileSync(getLastUsedPath(projectRoot), JSON.stringify(pruneInput.seed));
  markLastUsed(projectRoot, pruneInput.mark);
  const client = loadLastUsedState(projectRoot).clients["client-1"];
  return {
    recentIdsCount: client?.recentIds.length,
    itemCount: Object.keys(client?.items ?? {}).length,
    agent69LastUsedAt: client?.items["agent-69"]?.lastUsedAt,
    hasAgent0: Boolean(client?.items["agent-0"]),
  };
}));

const legacyInput = {
  seed: {
    version: 1,
    items: {
      "agent-a": { lastUsedAt: "2026-06-28T04:00:01.000Z" },
      "agent-b": { lastUsedAt: "2026-06-28T04:00:02.000Z" },
    },
    clients: {
      "client-1": {
        recentIds: ["agent-a", "agent-b"],
        updatedAt: "2026-06-28T04:00:03.000Z",
      },
    },
    projectRecentIds: ["agent-b", "agent-a"],
  },
  mark: { itemId: "agent-b", clientSession: "client-1", usedAt: "2026-06-28T04:00:02.000Z" },
};
record("seeds legacy client recency timestamps from saved order", "seedAndMark", legacyInput, await withProject((projectRoot) => {
  mkdirSync(join(getLastUsedPath(projectRoot), ".."), { recursive: true });
  writeFileSync(getLastUsedPath(projectRoot), JSON.stringify(legacyInput.seed));
  markLastUsed(projectRoot, legacyInput.mark);
  return { client1RecentIdsFirst2: loadLastUsedState(projectRoot).clients["client-1"]?.recentIds.slice(0, 2) };
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/last-used.test.ts",
  generatedBy: "scripts/capture-last-used-contract.mjs",
  description: "Last-used recency ordering, monotonic timestamps, client isolation, pruning, and legacy seeding contracts captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
