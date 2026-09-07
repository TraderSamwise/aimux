#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/session-launch-default-scribe.json", ROOT);
const FIXED_NOW = "2026-06-01T00:00:00.000Z";

const { initPaths } = await import(new URL("dist/paths.js", ROOT));
const { loadMetadataState, saveMetadataState } = await import(new URL("dist/metadata-store.js", ROOT));
const { ensureDefaultScribeAgent } = await import(new URL("dist/multiplexer/session-launch.js", ROOT));
const { saveRuntimeTopologySessions } = await import(new URL("dist/runtime-core/topology-sessions.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function gitInit(cwd) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;
  execFileSync("git", ["init"], { cwd, env, stdio: "ignore" });
}

function materialize(value, repoRoot) {
  return JSON.parse(JSON.stringify(value).split("<REPO>").join(repoRoot));
}

function normalize(value, repoRoot) {
  return JSON.parse(
    JSON.stringify(value)
      .split(`/private${repoRoot}`)
      .join("<REPO>")
      .split(repoRoot)
      .join("<REPO>")
      .replaceAll(/aimux-default-scribe-[^/"\s]+/g, "aimux-default-scribe")
      .replaceAll(/AIMUX_DAEMON_PORT=\d+/g, "AIMUX_DAEMON_PORT=<PORT>")
      .replaceAll(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/g, "<ISO_DATE>"),
  );
}

function summarizeLaunchArgs(args) {
  if (!Array.isArray(args)) return args;
  return args.filter((arg) => {
    if (arg === "env" || arg === "-i" || arg === "/bin/zsh" || arg === "-ic" || arg === "'aider'") return true;
    if (typeof arg !== "string") return false;
    return arg.startsWith("AIMUX_") || arg.startsWith("ZDOTDIR=");
  });
}

function recorder(repoRoot) {
  const calls = [];
  return {
    calls,
    fn(method, impl) {
      return (...args) => {
        let recordedArgs = args;
        if (method === "registerManagedSession") {
          recordedArgs = [
            { id: args[0]?.id, command: args[0]?.command, backendSessionId: args[0]?.backendSessionId },
            args[1],
            args[2],
            args[3],
            args[4],
            "<TIMESTAMP>",
            args[6] ?? null,
          ];
        } else if (method === "tmuxRuntimeManager.createWindowAsync") {
          recordedArgs = [args[0], args[1], args[2], args[3], summarizeLaunchArgs(args[4]), args[5]];
        }
        calls.push({ method, args: normalize(recordedArgs, repoRoot) });
        return impl?.(...args);
      };
    },
  };
}

async function withProject(input, runCase) {
  const repoRoot = join(tmpdir(), `aimux-default-scribe-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const aimuxHome = join(repoRoot, "home");
  mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
  mkdirSync(aimuxHome, { recursive: true });
  gitInit(repoRoot);
  if (input.config) {
    writeFileSync(join(repoRoot, ".aimux", "config.json"), JSON.stringify(input.config));
  }
  const previousHome = process.env.AIMUX_HOME;
  const previousCwd = process.cwd();
  const realDate = Date;
  try {
    process.env.AIMUX_HOME = aimuxHome;
    process.chdir(repoRoot);
    globalThis.Date = class FixedDate extends realDate {
      constructor(...args) {
        super(...(args.length ? args : [FIXED_NOW]));
      }
      static now() {
        return realDate.parse(FIXED_NOW);
      }
      static parse(value) {
        return realDate.parse(value);
      }
      static UTC(...args) {
        return realDate.UTC(...args);
      }
    };
    await initPaths(repoRoot);
    saveMetadataState(materialize(input.metadata ?? { version: 1, sessions: {} }, repoRoot));
    if (input.topologySessions) {
      saveRuntimeTopologySessions({
        projectRoot: repoRoot,
        now: FIXED_NOW,
        sessions: materialize(input.topologySessions, repoRoot),
      });
    }
    return normalize(await runCase(repoRoot), repoRoot);
  } finally {
    globalThis.Date = realDate;
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

async function runCase(input) {
  return withProject(input, async (repoRoot) => {
    const rec = recorder(repoRoot);
    const host = {
      projectRoot: repoRoot,
      sessions: materialize(input.sessions ?? [], repoRoot),
      sessionTmuxTargets: new Map(),
      sessionToolKeys: new Map(),
      sessionOriginalArgs: new Map(),
      sessionWorktreePaths: new Map(),
      sessionStartTimes: new Map(),
      activeIndex: 0,
      startedInDashboard: false,
      mode: "project-service",
      sessionBootstrap: {
        buildSessionPreamble: rec.fn("sessionBootstrap.buildSessionPreamble", () => ""),
        ensurePlanFile: rec.fn("sessionBootstrap.ensurePlanFile"),
        finalizePreamble: rec.fn("sessionBootstrap.finalizePreamble"),
      },
      tmuxRuntimeManager: {
        ensureProjectSessionAsync: rec.fn("tmuxRuntimeManager.ensureProjectSessionAsync", async () => ({
          sessionName: "aimux-default-scribe",
        })),
        createWindowAsync: rec.fn("tmuxRuntimeManager.createWindowAsync", async () => ({
          sessionName: "aimux-default-scribe",
          windowId: "@1",
          windowName: "scribe",
        })),
        clearTargetHistoryAsync: rec.fn("tmuxRuntimeManager.clearTargetHistoryAsync"),
        setWindowMetadataAsync: rec.fn("tmuxRuntimeManager.setWindowMetadataAsync"),
        applyManagedAgentWindowPolicyAsync: rec.fn("tmuxRuntimeManager.applyManagedAgentWindowPolicyAsync"),
      },
      getSessionLabel: rec.fn("getSessionLabel"),
      buildTmuxWindowMetadata: rec.fn("buildTmuxWindowMetadata", (sessionId, command) => ({
        kind: "agent",
        sessionId,
        command,
      })),
      registerManagedSession: rec.fn(
        "registerManagedSession",
        (transport, args, toolConfigKey, worktreePath, _role, startTime, team) => {
          host.sessions.push({
            id: transport.id,
            command: transport.command,
            backendSessionId: transport.backendSessionId,
            team,
          });
          host.sessionToolKeys.set(transport.id, toolConfigKey);
          host.sessionOriginalArgs.set(transport.id, args);
          host.sessionWorktreePaths.set(transport.id, worktreePath);
          host.sessionStartTimes.set(transport.id, startTime);
        },
      ),
      saveState: rec.fn("saveState"),
    };
    const result = await ensureDefaultScribeAgent(host);
    return {
      result,
      calls: rec.calls,
      sessions: host.sessions.map((session) => ({
        id: session.id,
        command: session.command,
        backendSessionId: session.backendSessionId,
        team: session.team,
      })),
      metadata: loadMetadataState(repoRoot),
    };
  });
}

const scribeEnabledConfig = { scribe: { defaultAgent: "aider" } };
const cases = [
  {
    name: "returns disabled when no default scribe agent is configured",
    input: {},
  },
  {
    name: "returns unknown-tool when configured default scribe tool is missing",
    input: { config: { scribe: { defaultAgent: "ghost" } } },
  },
  {
    name: "returns disabled-tool when configured default scribe tool is disabled",
    input: { config: { scribe: { defaultAgent: "aider" }, tools: { aider: { enabled: false } } } },
  },
  {
    name: "uses metadata scribe id when a matching runtime is live",
    input: {
      config: scribeEnabledConfig,
      metadata: { version: 1, sessions: { "scribe-1": { updatedAt: FIXED_NOW, scribe: true } } },
      sessions: [{ id: "scribe-1", command: "aider", exited: false }],
    },
  },
  {
    name: "marks a live runtime scribe team in metadata",
    input: {
      config: scribeEnabledConfig,
      sessions: [
        {
          id: "scribe-1",
          command: "aider",
          exited: false,
          team: { teamId: "scribe", parentSessionId: "", role: "scribe" },
        },
      ],
    },
  },
  {
    name: "creates default scribe when metadata scribe exists only in topology",
    input: {
      config: scribeEnabledConfig,
      metadata: { version: 1, sessions: { "scribe-topology": { updatedAt: FIXED_NOW, scribe: true } } },
      topologySessions: [
        {
          id: "scribe-topology",
          tool: "aider",
          toolConfigKey: "aider",
          command: "aider",
          args: [],
          lifecycle: "live",
          status: "running",
          team: { teamId: "scribe", parentSessionId: "", role: "scribe" },
        },
      ],
    },
  },
  {
    name: "creates default scribe when topology scribe team has no host session",
    input: {
      config: scribeEnabledConfig,
      topologySessions: [
        {
          id: "scribe-topology",
          tool: "aider",
          toolConfigKey: "aider",
          command: "aider",
          args: [],
          lifecycle: "live",
          status: "idle",
          team: { teamId: "scribe", parentSessionId: "", role: "scribe" },
        },
      ],
    },
  },
];

const outputCases = [];
for (const [index, entry] of cases.entries()) {
  const input = clone(entry.input);
  outputCases.push({
    id: `session-launch-default-scribe-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/session-launch.ts",
    api: "ensureDefaultScribeAgent",
    input,
    output: await runCase(input),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/session-launch.ts",
  generatedBy: "scripts/capture-session-launch-default-scribe-contract.mjs",
  description:
    "Default scribe ensure early-return, existing-session discovery, and create-path orchestration captured by running TypeScript with fake tmux adapters.",
  cases: outputCases,
});

console.log(`${FIXTURE_PATH.pathname}: ${outputCases.length} cases`);
