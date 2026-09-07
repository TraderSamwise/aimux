#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/project-catalog/registry.json", ROOT);

const home = mkdtempSync(join(tmpdir(), "aimux-project-registry-home-"));
process.env.AIMUX_HOME = join(home, ".aimux");

const paths = await import(new URL("dist/paths.js", ROOT));
const scanner = await import(new URL("dist/project-scanner.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalizeString(value, replacements, tokenReplacements) {
  let normalized = value.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\b/g, "<ts>");
  normalized = normalized.replace(/aimux-project-registry-hidden-\d+/g, "aimux-project-registry-hidden");
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

function setupProject(name) {
  const root = join(home, "work", name);
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".aimux"), { recursive: true });
  return root;
}

function writeProjectConfig(projectRoot, config) {
  mkdirSync(join(projectRoot, ".aimux"), { recursive: true });
  writeFileSync(join(projectRoot, ".aimux", "config.json"), JSON.stringify(config));
}

const projectA = setupProject("project-a");
const projectB = setupProject("project-b");
const projectC = setupProject("project-c");
await paths.initPaths(projectA);
await paths.initPaths(projectB);
await paths.initPaths(projectC);

const replacements = [
  [home, "<home>"],
  [process.env.AIMUX_HOME, "<aimuxHome>"],
  [projectA, "<projectA>"],
  [projectB, "<projectB>"],
  [projectC, "<projectC>"],
  [tmpdir(), "<tmp>"],
];
const tokenReplacements = [
  [paths.getProjectIdFor(projectA), "<projectAId>"],
  [paths.getProjectIdFor(projectB), "<projectBId>"],
  [paths.getProjectIdFor(projectC), "<projectCId>"],
];

const cases = [];
function record(name, api, input, output) {
  const normalizedInput = normalize(input, replacements, tokenReplacements);
  cases.push({
    id: `project-catalog-registry-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/project-scanner.test.ts",
    api,
    input: normalizedInput,
    output: normalize(output, replacements, tokenReplacements),
    inputSha256: hash(normalizedInput),
  });
}

record(
  "lists registered git projects with default dashboard session names",
  "listRegisteredDesktopProjects",
  { registryPath: paths.getProjectsRegistryPath() },
  scanner.listRegisteredDesktopProjects(),
);

const nonGitProject = join(home, "work", "logs");
mkdirSync(join(nonGitProject, ".aimux"), { recursive: true });
await paths.initPaths(nonGitProject);
const missingProject = join(home, "missing-project");
const tmpProject = join(tmpdir(), `aimux-project-registry-hidden-${process.pid}`);
mkdirSync(join(tmpProject, ".git"), { recursive: true });
await paths.initPaths(projectA);
const registry = paths.listProjects();
registry.push({ id: "missing-proj", name: "missing-proj", repoRoot: missingProject, lastSeen: "2026-03-28T00:00:00.000Z" });
registry.push({ id: "tmp-proj", name: "tmp-proj", repoRoot: tmpProject, lastSeen: "2026-03-28T00:00:00.000Z" });
writeFileSync(paths.getProjectsRegistryPath(), JSON.stringify({ projects: registry }, null, 2));
record(
  "hides missing tmp and non-git registry entries from desktop registry lists",
  "listRegisteredDesktopProjects",
  { missingProject, tmpProject, nonGitProject },
  scanner.listRegisteredDesktopProjects(),
);
rmSync(tmpProject, { recursive: true, force: true });

writeProjectConfig(projectA, { runtime: { tmux: { sessionPrefix: "alpha" } } });
writeProjectConfig(projectB, { runtime: { tmux: { sessionPrefix: "beta" } } });
record(
  "builds registered dashboard session names from each project config",
  "listRegisteredDesktopProjects",
  { configs: { projectA: { sessionPrefix: "alpha" }, projectB: { sessionPrefix: "beta" } } },
  scanner.listRegisteredDesktopProjects(),
);

record(
  "discovers only existing registered projects",
  "discoverProjects",
  { registryPath: paths.getProjectsRegistryPath() },
  scanner.discoverProjects(),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/project-scanner.ts",
  sources: ["src/project-scanner.test.ts", "src/project-scanner.ts"],
  generatedBy: "scripts/capture-project-catalog-registry-contract.mjs",
  description:
    "Project registry discovery, desktop filtering, and dashboard session-name contracts captured by running TypeScript project-scanner helpers with a temporary AIMUX_HOME.",
  normalization: {
    paths: "Temporary home, tmp, project roots, timestamps, and generated project ids are replaced with stable tokens.",
  },
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
rmSync(home, { recursive: true, force: true });
