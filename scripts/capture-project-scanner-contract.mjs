#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/project-catalog/scanner.json", ROOT);

const home = mkdtempSync(join(tmpdir(), "aimux-project-scanner-home-"));
process.env.AIMUX_HOME = join(home, ".aimux");

const paths = await import(new URL("dist/paths.js", ROOT));
const { RuntimeTopologyStore, emptyRuntimeTopology } = await import(
  new URL("dist/runtime-core/topology-store.js", ROOT)
);
const scanner = await import(new URL("dist/project-scanner.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalizeString(value, replacements, tokenReplacements) {
  let normalized = value.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/g, "<ts>");
  normalized = normalized.replace(/aimux-project-scanner-hidden-\d+/g, "aimux-project-scanner-hidden");
  for (const [needle, token] of tokenReplacements) {
    normalized = normalized.split(needle).join(token);
  }
  for (const [prefix, token] of replacements) {
    if (normalized === prefix) return token;
    if (normalized.startsWith(`${prefix}/`)) return `${token}/${normalized.slice(prefix.length + 1)}`;
  }
  return normalized;
}

function normalize(value, replacements, tokenReplacements) {
  if (Array.isArray(value)) return value.map((item) => normalize(item, replacements, tokenReplacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, normalize(nested, replacements, tokenReplacements)]),
    );
  }
  return typeof value === "string" ? normalizeString(value, replacements, tokenReplacements) : value;
}

function writeTopologySession(projectRoot, session) {
  const projectId = paths.getProjectIdFor(projectRoot);
  const projectStateDir = paths.getProjectStateDirById(projectId);
  const now = "2026-05-25T00:00:00.000Z";
  mkdirSync(projectStateDir, { recursive: true });
  new RuntimeTopologyStore(join(projectStateDir, "runtime-topology.yaml")).write({
    ...emptyRuntimeTopology(now),
    rigs: [{ id: `rig-${projectId}`, name: projectId, projectRoot, createdAt: now, updatedAt: now }],
    nodes: [
      {
        id: `node-${session.id}`,
        rigId: `rig-${projectId}`,
        logicalId: session.id,
        toolConfigKey: session.tool,
        cwd: projectRoot,
        label: session.nodeLabel,
        createdAt: now,
      },
    ],
    sessions: [
      {
        id: session.id,
        nodeId: `node-${session.id}`,
        status: session.status ?? "running",
        tool: session.tool,
        command: session.tool,
        args: [],
        worktreePath: projectRoot,
        label: session.label,
        headline: session.headline,
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
}

function writeProjectConfig(projectRoot, config) {
  mkdirSync(join(projectRoot, ".aimux"), { recursive: true });
  writeFileSync(join(projectRoot, ".aimux", "config.json"), JSON.stringify(config));
}

function projectStateDir(projectRoot) {
  return paths.getProjectStateDirById(paths.getProjectIdFor(projectRoot));
}

function setupProject(name) {
  const root = join(home, "work", name);
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".aimux"), { recursive: true });
  return root;
}

function fakeTmux() {
  return {
    getProjectSession(projectRoot) {
      return { sessionName: `tmux-${paths.getProjectIdFor(projectRoot)}` };
    },
  };
}

const projectA = setupProject("project-a");
const projectB = setupProject("project-b");
await paths.initPaths(projectA);
await paths.initPaths(projectB);

writeTopologySession(projectA, { id: "session-a", tool: "codex" });
writeTopologySession(projectB, { id: "session-b", tool: "claude" });
mkdirSync(join(projectStateDir(projectA), "status"), { recursive: true });
mkdirSync(join(projectStateDir(projectB), "status"), { recursive: true });
writeFileSync(join(projectStateDir(projectA), "status", "session-a.md"), "Alpha headline\n");
writeFileSync(join(projectStateDir(projectB), "status", "session-b.md"), "Beta headline\n");

const replacements = [
  [home, "<home>"],
  [process.env.AIMUX_HOME, "<aimuxHome>"],
  [projectA, "<projectA>"],
  [projectB, "<projectB>"],
  [tmpdir(), "<tmp>"],
];
const projectIds = new Map([
  ["projectA", paths.getProjectIdFor(projectA)],
  ["projectB", paths.getProjectIdFor(projectB)],
]);
let tokenReplacements = [
  [projectIds.get("projectA"), "<projectAId>"],
  [projectIds.get("projectB"), "<projectBId>"],
];

const cases = [];
function record(name, api, scenario, input, output) {
  const normalizedInput = normalize(input, replacements, tokenReplacements);
  cases.push({
    id: `project-scanner-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/project-scanner.test.ts",
    api,
    input: normalizedInput,
    output: normalize(output, replacements, tokenReplacements),
    inputSha256: hash(normalizedInput),
  });
}

record(
  "reads status headlines from each registered project state directory",
  "scanProject",
  "status-headlines",
  { projects: [projectA, projectB] },
  { projectA: scanner.scanProject(projectA), projectB: scanner.scanProject(projectB) },
);

writeFileSync(
  join(projectStateDir(projectA), "statusline.json"),
  JSON.stringify({
    sessions: [
      {
        id: "session-a",
        tool: "codex",
        label: "chart-fix",
        headline: "auditing session routing",
        status: "waiting",
        role: "coder",
      },
    ],
  }),
);
record(
  "enriches topology sessions from fresh global statusline data without overriding topology status",
  "scanProject",
  "statusline-enrichment",
  { project: projectA, statuslinePath: join(projectStateDir(projectA), "statusline.json") },
  scanner.scanProject(projectA),
);

writeFileSync(
  join(projectA, ".aimux", "statusline.json"),
  JSON.stringify({
    sessions: [
      {
        id: "session-a",
        tool: "codex",
        label: "local-stale-label",
        headline: "local stale headline",
      },
    ],
  }),
);
rmSync(join(projectStateDir(projectA), "statusline.json"), { force: true });
record(
  "ignores legacy local statusline projection files",
  "scanProject",
  "local-statusline-ignored",
  { project: projectA, localStatuslinePath: join(projectA, ".aimux", "statusline.json") },
  scanner.scanProject(projectA),
);

const projectC = setupProject("project-c");
await paths.initPaths(projectC);
projectIds.set("projectC", paths.getProjectIdFor(projectC));
tokenReplacements = [
  [projectIds.get("projectA"), "<projectAId>"],
  [projectIds.get("projectB"), "<projectBId>"],
  [projectIds.get("projectC"), "<projectCId>"],
];
mkdirSync(projectStateDir(projectC), { recursive: true });
writeFileSync(
  join(projectStateDir(projectC), "instances.json"),
  JSON.stringify([{ instanceId: "server-c", pid: process.pid, sessions: [{ id: "session-c", tool: "codex" }] }]),
);
record(
  "does not mint project sessions from instances-only data",
  "scanProject",
  "instances-only",
  { project: projectC, instancesPath: join(projectStateDir(projectC), "instances.json") },
  scanner.scanProject(projectC),
);

record(
  "builds desktop project summaries with supplied tmux session names",
  "listDesktopProjects",
  "desktop-projects",
  { projects: [projectA, projectB], tmux: "fake getProjectSession" },
  scanner.listDesktopProjects(fakeTmux()),
);

const nonGitProject = join(home, "work", "logs");
mkdirSync(join(nonGitProject, ".aimux"), { recursive: true });
const missingProject = join(home, "missing-project");
const tmpProject = join(tmpdir(), `aimux-project-scanner-hidden-${process.pid}`);
mkdirSync(join(tmpProject, ".git"), { recursive: true });
await paths.initPaths(nonGitProject);
await paths.initPaths(projectA);
const registry = paths.listProjects();
registry.push({ id: "missing-proj", name: "missing-proj", repoRoot: missingProject, lastSeen: "2026-03-28T00:00:00.000Z" });
registry.push({ id: "tmp-proj", name: "tmp-proj", repoRoot: tmpProject, lastSeen: "2026-03-28T00:00:00.000Z" });
writeFileSync(paths.getProjectsRegistryPath(), JSON.stringify({ projects: registry }, null, 2));
record(
  "hides missing tmp and non-git registry entries from desktop lists",
  "listRegisteredDesktopProjects",
  "hidden-projects",
  { missingProject, tmpProject, nonGitProject },
  scanner.listRegisteredDesktopProjects(),
);
rmSync(tmpProject, { recursive: true, force: true });

writeProjectConfig(projectA, { runtime: { tmux: { sessionPrefix: "alpha" } } });
writeProjectConfig(projectB, { runtime: { tmux: { sessionPrefix: "beta" } } });
record(
  "builds registered dashboard session names from each project config",
  "listRegisteredDesktopProjects",
  "configured-prefix",
  { configs: { projectA: { sessionPrefix: "alpha" }, projectB: { sessionPrefix: "beta" } } },
  scanner.listRegisteredDesktopProjects(),
);

record(
  "discovers only registered projects that still exist",
  "discoverProjects",
  "discover-existing",
  { registryPath: paths.getProjectsRegistryPath() },
  scanner.discoverProjects().filter((project) => existsSync(project)),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/project-scanner.test.ts",
  generatedBy: "scripts/capture-project-scanner-contract.mjs",
  description:
    "Project scanner status headline, statusline enrichment, desktop project filtering, session-name, and discovery contracts captured by running TypeScript project-scanner helpers with a temporary AIMUX_HOME.",
  normalization: {
    paths: "Temporary home and project roots are replaced with <home>, <aimuxHome>, <projectA>, and <projectB> tokens.",
  },
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);

rmSync(home, { recursive: true, force: true });
