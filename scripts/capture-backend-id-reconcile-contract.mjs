#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/backend-id-reconcile/reconcile.json", ROOT);
const UUID = "0710a963-a473-430f-9f9a-e27dd4546328";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const recordCase = (index, name, input, output) => ({
  id: `backend-id-reconcile-${String(index + 1).padStart(3, "0")}`,
  name,
  source: "src/runtime-core/backend-id-reconcile.test.ts",
  api: "reconcileOfflineBackendSessionIds",
  input,
  output,
  inputSha256: hash(input),
});

const paths = await import(new URL("dist/paths.js", ROOT));
const reconcile = await import(new URL("dist/runtime-core/backend-id-reconcile.js", ROOT));
const topology = await import(new URL("dist/runtime-core/topology-sessions.js", ROOT));

function normalize(value, roots) {
  return JSON.parse(
    JSON.stringify(value, (key, nested) => {
      if (typeof nested !== "string") return nested;
      if (key === "createdAt" || key === "updatedAt" || key === "generatedAt") return `<${key}>`;
      let text = nested;
      for (const [label, root] of Object.entries(roots)) text = text.replaceAll(root, `<${label}>`);
      return text;
    }),
  );
}

async function withProject(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), "aimux-reconcile-"));
  const claudeHome = mkdtempSync(join(tmpdir(), "aimux-claude-home-"));
  const codexHome = mkdtempSync(join(tmpdir(), "aimux-codex-home-"));
  const previousClaude = process.env.CLAUDE_CONFIG_DIR;
  const previousCodex = process.env.CODEX_HOME;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.CODEX_HOME = codexHome;
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  await paths.initPaths(repoRoot);
  try {
    return await fn(repoRoot, claudeHome, codexHome, { repo: repoRoot, claudeHome, codexHome });
  } finally {
    if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaude;
    if (previousCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodex;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  }
}

function session(toolConfigKey, id, cwd, backendSessionId, command = toolConfigKey) {
  return { id, tool: toolConfigKey, toolConfigKey, command, args: [], lifecycle: "offline", worktreePath: cwd, backendSessionId };
}

function claudeProjectDir(claudeHome, cwd) {
  return join(claudeHome, "projects", cwd.replace(/[/.]/g, "-"));
}

function writeClaudeTranscript(claudeHome, cwd, uuid) {
  const dir = claudeProjectDir(claudeHome, cwd);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${uuid}.jsonl`), "{}\n");
}

function writeCodexTranscript(codexHome, cwd, uuid) {
  const dir = join(codexHome, "sessions", "2026", "06", "14");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-2026-06-14T00-00-00-${uuid}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: uuid, cwd } })}\n`);
}

async function runCase(name, setup) {
  return withProject((repoRoot, claudeHome, codexHome, roots) => {
    const input = { scenario: name, ...setup(repoRoot, claudeHome, codexHome) };
    topology.saveRuntimeTopologySessions({ projectRoot: repoRoot, sessions: input.sessions });
    const first = reconcile.reconcileOfflineBackendSessionIds(repoRoot);
    const second = input.runTwice ? reconcile.reconcileOfflineBackendSessionIds(repoRoot) : undefined;
    const offline = topology.listTopologySessionStates({ statuses: ["offline"] });
    return recordCase(cases.length, name, normalize(input, roots), normalize({ first, second, offline }, roots));
  });
}

const cases = [];
cases.push(await runCase("backfills a missing backend id from the on-disk transcript into topology", (repoRoot, claudeHome) => {
  const cwd = join(repoRoot, "wt", "feature");
  writeClaudeTranscript(claudeHome, cwd, UUID);
  return { sessions: [session("claude", "claude-1", cwd)] };
}));
cases.push(await runCase("backfills a custom Claude tool config from Claude transcripts", (repoRoot, claudeHome) => {
  const cwd = join(repoRoot, "wt", "custom-claude");
  writeClaudeTranscript(claudeHome, cwd, UUID);
  return { sessions: [session("claude-custom", "claude-custom-1", cwd, undefined, "claude")] };
}));
cases.push(await runCase("leaves sessions that already have a backend id untouched", (repoRoot, claudeHome) => {
  const cwd = join(repoRoot, "wt", "feature");
  writeClaudeTranscript(claudeHome, cwd, UUID);
  return { sessions: [session("claude", "claude-1", cwd, "existing-id")] };
}));
cases.push(await runCase("backfills a missing codex backend id from the on-disk transcript into topology", (repoRoot, _claudeHome, codexHome) => {
  const cwd = join(repoRoot, "wt", "codex-feature");
  writeCodexTranscript(codexHome, cwd, UUID);
  return { sessions: [session("codex", "codex-1", cwd)] };
}));
cases.push(await runCase("backfills a custom Codex tool config from Codex transcripts", (repoRoot, _claudeHome, codexHome) => {
  const cwd = join(repoRoot, "wt", "custom-codex");
  writeCodexTranscript(codexHome, cwd, UUID);
  return { sessions: [session("codex-gpt5", "codex-custom-1", cwd, undefined, "codex")] };
}));
cases.push(await runCase("uses the project root as the discovery cwd for main-checkout sessions", (repoRoot, claudeHome) => {
  writeClaudeTranscript(claudeHome, repoRoot, UUID);
  return { sessions: [session("claude", "claude-main")] };
}));
cases.push(await runCase("skips sessions with no discoverable transcript", (repoRoot) => {
  const cwd = join(repoRoot, "wt", "feature");
  return { sessions: [session("claude", "claude-1", cwd)] };
}));
cases.push(await runCase("refuses to bind when the worktree dir is ambiguous", (repoRoot, claudeHome) => {
  const cwd = join(repoRoot, "wt", "shared");
  writeClaudeTranscript(claudeHome, cwd, UUID);
  writeClaudeTranscript(claudeHome, cwd, "99999999-8888-7777-6666-555555555555");
  return { sessions: [session("claude", "claude-1", cwd)] };
}));
cases.push(await runCase("is idempotent: a second run reconciles nothing", (repoRoot, claudeHome) => {
  const cwd = join(repoRoot, "wt", "feature");
  writeClaudeTranscript(claudeHome, cwd, UUID);
  return { sessions: [session("claude", "claude-1", cwd)], runTwice: true };
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/runtime-core/backend-id-reconcile.test.ts",
  generatedBy: "scripts/capture-backend-id-reconcile-contract.mjs",
  description: "Offline backend session id reconciliation and topology side-effect contracts captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
