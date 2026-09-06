#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/backend-session-ids/identity.json", ROOT);

const UUID_A = "019fd6cb-68fc-7cd3-a3bf-7137b47ea6af";
const UUID_B = "019fd6cb-68fc-7cd3-a3bf-7137b47ea6b0";
const TOPOLOGY_UUID = "0f0e2b1a-1111-2222-3333-444455556666";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const recordCase = (index, name, api, input, output) => ({
  id: `backend-session-ids-${String(index + 1).padStart(3, "0")}`,
  name,
  source: "src/runtime-core/backend-session-ids.test.ts",
  api,
  input,
  output,
  inputSha256: hash(input),
});

const paths = await import(new URL("dist/paths.js", ROOT));
const backendIds = await import(new URL("dist/runtime-core/backend-session-ids.js", ROOT));
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
  const repoRoot = mkdtempSync(join(tmpdir(), "aimux-backend-session-ids-"));
  const codexHome = mkdtempSync(join(tmpdir(), "aimux-backend-session-ids-codex-"));
  const claudeHome = mkdtempSync(join(tmpdir(), "aimux-backend-session-ids-claude-"));
  const previousCodex = process.env.CODEX_HOME;
  const previousClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.CODEX_HOME = codexHome;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  await paths.initPaths(repoRoot);
  try {
    return await fn(repoRoot, codexHome, claudeHome, { repo: repoRoot, codexHome, claudeHome });
  } finally {
    if (previousCodex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodex;
    if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaude;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(claudeHome, { recursive: true, force: true });
  }
}

function session(id, tool, worktreePath, extra = {}) {
  return {
    id,
    tool,
    toolConfigKey: tool,
    command: tool,
    args: [],
    lifecycle: extra.lifecycle ?? "live",
    ...(worktreePath ? { worktreePath } : {}),
    ...(extra.backendSessionId ? { backendSessionId: extra.backendSessionId } : {}),
    ...(extra.tmuxTarget ? { tmuxTarget: extra.tmuxTarget } : {}),
  };
}

function seedRuntimeSession(repoRoot, spec, status = spec.lifecycle === "graveyard" ? "graveyard" : spec.lifecycle === "offline" ? "offline" : "running") {
  topology.upsertTopologySession(spec, status, { projectRoot: repoRoot });
}

function writeCodexRollout(codexHome, id, cwd) {
  const dir = join(codexHome, "sessions", "2026", "08", "08");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `rollout-2026-08-08T00-00-00-${id}.jsonl`),
    `${JSON.stringify({
      timestamp: "2026-08-08T00:00:00.000Z",
      type: "session_meta",
      payload: { id, cwd, originator: "codex-tui" },
    })}\n`,
  );
}

function captureThrow(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runCase(name, api, run) {
  return withProject(async (repoRoot, codexHome, claudeHome, roots) => {
    const { input, output } = await run(repoRoot, codexHome, claudeHome);
    return recordCase(cases.length, name, api, normalize(input, roots), normalize(output, roots));
  });
}

const cases = [];

cases.push(
  await runCase("strictly records a backend id into an existing topology row", "recordTopologyBackendSessionId", (repoRoot) => {
    const seeded = session("claude-1", "claude", repoRoot, { lifecycle: "offline" });
    seedRuntimeSession(repoRoot, seeded, "offline");
    const call = { projectRoot: repoRoot, sessionId: "claude-1", backendSessionId: "backend-1" };
    const result = backendIds.recordTopologyBackendSessionId(call);
    const sessions = topology.listTopologySessionStates();
    return { input: { seeded, call }, output: { result, sessions } };
  }),
);

cases.push(
  await runCase("preserves live tmux binding metadata while latching the backend id", "recordTopologyBackendSessionId", (repoRoot) => {
    const seeded = session("claude-live", "claude", repoRoot, {
      tmuxTarget: {
        sessionName: "aimux-test",
        windowId: "@1",
        windowIndex: 1,
        windowName: "claude",
      },
    });
    seedRuntimeSession(repoRoot, seeded, "running");
    const call = { projectRoot: repoRoot, sessionId: "claude-live", backendSessionId: "backend-live" };
    const result = backendIds.recordTopologyBackendSessionId(call);
    const sessions = topology.listTopologySessionStates();
    return { input: { seeded, call }, output: { result, sessions } };
  }),
);

cases.push(
  await runCase("refuses missing rows and conflicting backend ids", "recordTopologyBackendSessionId", (repoRoot) => {
    const missingCall = { projectRoot: repoRoot, sessionId: "missing", backendSessionId: "backend-1" };
    const missing = captureThrow(() => backendIds.recordTopologyBackendSessionId(missingCall));
    const seeded = session("claude-1", "claude", undefined, {
      lifecycle: "offline",
      backendSessionId: "backend-original",
    });
    seedRuntimeSession(repoRoot, seeded, "offline");
    const conflictCall = { projectRoot: repoRoot, sessionId: "claude-1", backendSessionId: "backend-new" };
    const conflict = captureThrow(() => backendIds.recordTopologyBackendSessionId(conflictCall));
    const sessions = topology.listTopologySessionStates();
    return { input: { missingCall, seeded, conflictCall }, output: { missing, conflict, sessions } };
  }),
);

cases.push(
  await runCase("hands back the id the tool recorded at launch", "resolveBackendSessionId", (repoRoot) => {
    const seeded = session("claude-1", "claude", repoRoot);
    seedRuntimeSession(repoRoot, seeded, "running");
    backendIds.recordTopologyBackendSessionId({
      projectRoot: repoRoot,
      sessionId: "claude-1",
      backendSessionId: TOPOLOGY_UUID,
    });
    const call = { projectRoot: repoRoot, sessionId: "claude-1" };
    const result = backendIds.resolveBackendSessionId(call);
    return { input: { seeded, recordedBackendSessionId: TOPOLOGY_UUID, call }, output: { result } };
  }),
);

cases.push(
  await runCase("resolves full identity for graveyarded agents", "resolveAgentIdentity", (repoRoot) => {
    const seeded = session("claude-gone", "claude", repoRoot, {
      lifecycle: "graveyard",
      backendSessionId: TOPOLOGY_UUID,
    });
    seedRuntimeSession(repoRoot, seeded, "graveyard");
    const call = { projectRoot: repoRoot, sessionId: "claude-gone" };
    const result = backendIds.resolveAgentIdentity(call);
    return { input: { seeded, call }, output: { result } };
  }),
);

cases.push(
  await runCase("recovers an older agent's id from disk, main checkout included", "resolveBackendSessionId", (repoRoot, codexHome) => {
    const seeded = session("codex-main", "codex");
    seedRuntimeSession(repoRoot, seeded, "running");
    writeCodexRollout(codexHome, UUID_A, repoRoot);
    const call = { projectRoot: repoRoot, sessionId: "codex-main" };
    const result = backendIds.resolveBackendSessionId(call);
    return { input: { seeded, codexRollouts: [{ id: UUID_A, cwd: repoRoot }], call }, output: { result } };
  }),
);

cases.push(
  await runCase("refuses, with a reason, when the store holds nothing for it", "resolveBackendSessionId", (repoRoot) => {
    const seeded = session("codex-old", "codex", repoRoot);
    seedRuntimeSession(repoRoot, seeded, "running");
    const call = { projectRoot: repoRoot, sessionId: "codex-old" };
    const result = backendIds.resolveBackendSessionId(call);
    return { input: { seeded, call }, output: { result } };
  }),
);

cases.push(
  await runCase("refuses rather than pick between two transcripts in one worktree", "resolveBackendSessionId", (repoRoot, codexHome) => {
    const seeded = session("codex-ambiguous", "codex", repoRoot);
    seedRuntimeSession(repoRoot, seeded, "running");
    writeCodexRollout(codexHome, UUID_A, repoRoot);
    writeCodexRollout(codexHome, UUID_B, repoRoot);
    const call = { projectRoot: repoRoot, sessionId: "codex-ambiguous" };
    const result = backendIds.resolveBackendSessionId(call);
    return {
      input: { seeded, codexRollouts: [{ id: UUID_A, cwd: repoRoot }, { id: UUID_B, cwd: repoRoot }], call },
      output: { result },
    };
  }),
);

cases.push(
  await runCase("refuses for an agent topology does not manage", "resolveBackendSessionId", (repoRoot) => {
    const call = { projectRoot: repoRoot, sessionId: "ghost-1" };
    const result = backendIds.resolveBackendSessionId(call);
    return { input: { call }, output: { result } };
  }),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/runtime-core/backend-session-ids.test.ts",
  generatedBy: "scripts/capture-backend-session-ids-contract.mjs",
  description: "Backend session id recording, resolution, and refusal contracts captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
