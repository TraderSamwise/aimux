#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/operation-failures/failures.json", ROOT);

const paths = await import(new URL("dist/paths.js", ROOT));
const failures = await import(new URL("dist/dashboard/operation-failures.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function dynamicNormalizer() {
  const ids = new Map();
  const idToken = (id) => {
    if (!ids.has(id)) ids.set(id, `<id:${ids.size + 1}>`);
    return ids.get(id);
  };
  const timestampPattern = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/g;
  const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, normalize(nested)]));
    }
    if (typeof value !== "string") return value;
    return value
      .replace(timestampPattern, (timestamp) => (timestamp === "2000-01-01T00:00:00.000Z" ? timestamp : "<ts>"))
      .replace(uuidPattern, (id) => idToken(id));
  };
  return { normalize };
}

function assertDynamicStructure(value, label) {
  const failures = [];
  const visit = (node, path = "$") => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    const createdAt = typeof node.createdAt === "string" ? Date.parse(node.createdAt) : undefined;
    if (typeof node.id === "string" && node.id.trim() === "") {
      failures.push(`${path}.id: id is empty`);
    }
    if (typeof node.createdAt === "string" && !Number.isFinite(createdAt)) {
      failures.push(`${path}.createdAt: timestamp is invalid`);
    }
    for (const [key, nested] of Object.entries(node)) visit(nested, `${path}.${key}`);
  };
  visit(value);
  if (failures.length > 0) throw new Error(`${label} dynamic structure failed:\n${failures.join("\n")}`);
}

function normalize(value, base) {
  const roots = [base];
  try {
    const canonical = realpathSync(base);
    if (canonical !== base) roots.push(canonical);
  } catch {
    // Temporary directory may be gone.
  }
  const rooted = JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "string") return nested;
      return roots.reduce((text, root) => text.replaceAll(root, "<root>"), nested);
    }),
  );
  assertDynamicStructure(rooted, base);
  return dynamicNormalizer().normalize(rooted);
}

async function withProject(label, fn) {
  const base = mkdtempSync(join(tmpdir(), `aimux-operation-failures-contract-${label}-`));
  try {
    const projectRoot = join(base, "repo");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    await paths.initPaths(projectRoot);
    const output = await fn(projectRoot);
    const statePath = paths.getReadOnlyProjectPathsFor(projectRoot).dashboardOperationFailuresPath;
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    return normalize({ ...output, state }, base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const cases = [];
const add = async (name, scenario, fn) => {
  const input = { scenario };
  cases.push({
    id: `operation-failures-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/dashboard/operation-failures.test.ts",
    input,
    output: await withProject(scenario, fn),
    inputSha256: hash(input),
  });
};

await add("persists active failures and clears matching failures", "persist-and-clear-worktree", () => {
  const failure = failures.addDashboardOperationFailure({
    targetKind: "worktree",
    operation: "create",
    title: 'Failed to create worktree "demo"',
    message: "branch already exists",
    worktreePath: "/repo/.aimux/worktrees/demo",
    worktreeName: "demo",
  });
  const beforeClear = failures.listDashboardOperationFailures();
  const cleared = failures.clearDashboardOperationFailures({
    targetKind: "worktree",
    operation: "create",
    worktreePath: "/repo/.aimux/worktrees/demo",
  });
  return { failure, beforeClear, cleared, afterClear: failures.listDashboardOperationFailures() };
});

await add("clears agent-create failures by worktree when retry succeeds with a new agent id", "clear-agent-create-by-worktree", () => {
  const failure = failures.addDashboardOperationFailure({
    targetKind: "agent",
    operation: "create",
    title: "Failed to create codex agent",
    message: "tmux refused the window",
    targetId: "codex-793soe",
    worktreePath: "/repo/.aimux/worktrees/demo",
  });
  const cleared = failures.clearDashboardOperationFailures({
    targetKind: "agent",
    operation: "create",
    worktreePath: "/repo/.aimux/worktrees/demo",
  });
  return { failure, cleared, afterClear: failures.listDashboardOperationFailures() };
});

await add("keeps main-checkout and worktree failures apart", "main-vs-worktree", () => {
  const main = failures.addDashboardOperationFailure({
    targetKind: "agent",
    operation: "create",
    title: "Failed to create codex agent",
    message: "main checkout",
  });
  const worktree = failures.addDashboardOperationFailure({
    targetKind: "agent",
    operation: "create",
    title: "Failed to create codex agent",
    message: "in a worktree",
    worktreePath: "/repo/.aimux/worktrees/demo",
  });
  const cleared = failures.clearDashboardOperationFailures({ targetKind: "agent", operation: "create", worktreePath: null });
  return { main, worktree, cleared, afterClear: failures.listDashboardOperationFailures() };
});

await add("replaces active duplicate failures for the same operation target", "replace-active-duplicate", () => {
  const first = failures.addDashboardOperationFailure({
    targetKind: "service",
    operation: "start",
    title: "Failed to start service",
    message: "port busy",
    targetId: "svc-1",
  });
  const second = failures.addDashboardOperationFailure({
    targetKind: "service",
    operation: "start",
    title: "Failed to start service",
    message: "port still busy",
    targetId: "svc-1",
  });
  return { first, second, active: failures.listDashboardOperationFailures() };
});

await add("filters stale and cleared failures from active lists", "active-list-filtering", () => {
  const stale = failures.addDashboardOperationFailure({
    targetKind: "dashboard",
    operation: "load",
    title: "Old failure",
    message: "too old",
    createdAt: "2000-01-01T00:00:00.000Z",
  });
  const fresh = failures.addDashboardOperationFailure({
    targetKind: "dashboard",
    operation: "render",
    title: "Fresh failure",
    message: "visible",
  });
  const cleared = failures.clearDashboardOperationFailures({ targetKind: "dashboard", operation: "render" });
  return { stale, fresh, cleared, active: failures.listDashboardOperationFailures() };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/dashboard/operation-failures.test.ts",
  generatedBy: "scripts/capture-operation-failures-contract.mjs",
  description:
    "Dashboard operation failure add/list/clear persistence, target matching, replacement, active filtering, and side-effect state captured by running TypeScript dashboard operation-failure helpers.",
  normalization: {
    ids: "Generated UUIDs are replaced with <id:n> in first-appearance order.",
    timestamps: "Generated ISO timestamps are replaced with <ts> after structure checks.",
    projectRoots: "Temporary project roots are replaced with <root>.",
  },
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
