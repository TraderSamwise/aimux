#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/paths/behavior.json", ROOT);
const paths = await import(new URL("dist/paths.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const BASE = "/tmp/aimux-contract-paths";
const HOME = "/tmp/aimux-contract-paths-home";
const DEFAULT_HOME = homedir();

function reset() {
  for (const path of [BASE, HOME]) rmSync(path, { recursive: true, force: true });
  mkdirSync(BASE, { recursive: true });
}

function normalize(value) {
  const seenTimestamps = new Map();
  let nextTimestamp = 1;
  const visit = (entry) => {
    if (typeof entry === "string") {
      const replaced = entry
        .split(DEFAULT_HOME).join("<home>")
        .split(BASE).join("<base>")
        .split(HOME).join("<aimuxHome>");
      if (/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d\d\dZ$/.test(replaced)) {
        if (!seenTimestamps.has(replaced)) seenTimestamps.set(replaced, `<ts:${nextTimestamp++}>`);
        return seenTimestamps.get(replaced);
      }
      return replaced;
    }
    if (Array.isArray(entry)) return entry.map(visit);
    if (entry && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, visit(item)]));
    }
    return entry;
  };
  return visit(value);
}

async function withEnv(aimuxHome, fn) {
  const previous = process.env.AIMUX_HOME;
  try {
    if (aimuxHome === null) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = aimuxHome;
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previous;
  }
}

const cases = [];
async function record(name, api, input, run) {
  let output;
  try {
    output = { ok: true, value: normalize(await run()) };
  } catch (error) {
    output = { ok: false, error: normalize(String(error instanceof Error ? error.message : error)) };
  }
  cases.push({
    id: `paths-behavior-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/paths.test.ts",
    api,
    input: normalize(input),
    output,
    inputSha256: hash(input),
  });
}

reset();
await record("resolves aimux-managed worktrees to the parent project", "getProjectIdFor", {
  repoRoot: join(BASE, "repo"),
  worktreePath: join(BASE, "repo", ".aimux", "worktrees", "feature-a"),
}, async () => {
  const repoRoot = join(BASE, "repo");
  const worktreePath = join(repoRoot, ".aimux", "worktrees", "feature-a");
  return {
    rootId: paths.getProjectIdFor(repoRoot),
    worktreeId: paths.getProjectIdFor(worktreePath),
    equal: paths.getProjectIdFor(repoRoot) === paths.getProjectIdFor(worktreePath),
  };
});

reset();
await record("resolves persistent log paths", "logPaths", {
  aimuxHome: null,
  repoRoot: join(BASE, "aimux-log-paths-contract"),
}, () => withEnv(null, () => ({
  daemonLogPath: paths.getDaemonLogPath(),
  daemonStdioLogPath: paths.getDaemonStdioLogPath(),
  projectLogPath: paths.getProjectLogPathFor(join(BASE, "aimux-log-paths-contract")),
})));

reset();
await record("uses AIMUX_HOME for runtime-private global state", "aimuxHomeOverride", {
  aimuxHome: HOME,
}, () => withEnv(HOME, () => ({
  globalAimuxDir: paths.getGlobalAimuxDir(),
  daemonLogPath: paths.getDaemonLogPath(),
})));

reset();
await record("does not register ephemeral tmp aimux roots as desktop projects", "initPathsRegistry", {
  aimuxHome: HOME,
  repoRoot: "/tmp/aimux-transient-project-contract",
  git: false,
}, () => withEnv(HOME, async () => {
  rmSync("/tmp/aimux-transient-project-contract", { recursive: true, force: true });
  mkdirSync("/tmp/aimux-transient-project-contract", { recursive: true });
  await paths.initPaths("/tmp/aimux-transient-project-contract");
  const projects = paths.listProjects();
  rmSync("/tmp/aimux-transient-project-contract", { recursive: true, force: true });
  return projects;
}));

reset();
await record("prunes claude temp aimux roots before enforcing the registry cap", "initPathsRegistry", {
  aimuxHome: HOME,
  repoRoot: join(BASE, "real-project"),
  existingProjects: 600,
}, () => withEnv(HOME, async () => {
  const repoRoot = join(BASE, "real-project");
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  const projects = Array.from({ length: 600 }, (_, index) => {
    const prefix = index % 2 === 0 ? "/tmp/claude-501" : "/private/tmp/claude-501";
    const root = `${prefix}/aimux-metadata-server-${index}`;
    return {
      id: `${basename(root)}-${index}`,
      name: basename(root),
      repoRoot: root,
      lastSeen: new Date(0).toISOString(),
    };
  });
  mkdirSync(HOME, { recursive: true });
  writeFileSync(paths.getProjectsRegistryPath(), JSON.stringify({ version: 1, projects }, null, 2));
  await paths.initPaths(repoRoot);
  return paths.listProjects();
}));

reset();
await record("hard-fails instead of growing an over-cap project registry", "initPathsRegistry", {
  aimuxHome: HOME,
  repoRoot: join(BASE, "real-project"),
  existingProjects: 500,
}, () => withEnv(HOME, async () => {
  const repoRoot = join(BASE, "real-project");
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  const projects = Array.from({ length: 500 }, (_, index) => {
    const root = join(HOME, "valid-projects", `project-${index}`);
    mkdirSync(join(root, ".git"), { recursive: true });
    return {
      id: `${basename(root)}-${index}`,
      name: basename(root),
      repoRoot: root,
      lastSeen: new Date(0).toISOString(),
    };
  });
  mkdirSync(dirname(paths.getProjectsRegistryPath()), { recursive: true });
  writeFileSync(paths.getProjectsRegistryPath(), JSON.stringify({ version: 1, projects }, null, 2));
  await paths.initPaths(repoRoot);
  return paths.listProjects();
}));

reset();
await record("does not register non-git roots as desktop projects", "initPathsRegistry", {
  aimuxHome: HOME,
  repoRoot: join(BASE, "plain-project"),
  git: false,
}, () => withEnv(HOME, async () => {
  const repoRoot = join(BASE, "plain-project");
  mkdirSync(repoRoot, { recursive: true });
  await paths.initPaths(repoRoot);
  return paths.listProjects();
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/paths.test.ts",
  generatedBy: "scripts/capture-paths-contract.mjs",
  description: "Path identity, runtime-private location, and project registry mutation behavior captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
