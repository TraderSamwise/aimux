#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/session-launch-migrate-switch.json", ROOT);

const { initPaths } = await import(new URL("dist/paths.js", ROOT));
const { migrateAgent, switchAgentTool } = await import(new URL("dist/multiplexer/session-launch.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));

function gitInit(cwd) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;
  execFileSync("git", ["init"], { cwd, stdio: "ignore", env });
}

function materialize(value, repoRoot, targetRoot, codexHome) {
  return JSON.parse(
    JSON.stringify(value)
      .split("<REPO>")
      .join(repoRoot)
      .split("<TARGET>")
      .join(targetRoot)
      .split("<CODEX_HOME>")
      .join(codexHome),
  );
}

function normalize(value, repoRoot, targetRoot, codexHome) {
  return JSON.parse(
    JSON.stringify(value)
      .split(repoRoot)
      .join("<REPO>")
      .split(targetRoot)
      .join("<TARGET>")
      .split(codexHome)
      .join("<CODEX_HOME>")
      .replaceAll(/aimux-session-migrate-switch-target-[^/"\s]+/g, "aimux-session-migrate-switch-target")
      .replaceAll(/aimux-session-migrate-switch-[^/"\s]+/g, "aimux-session-migrate-switch")
      .replaceAll(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/g, "<ISO_DATE>"),
  );
}

function summarizeArg(arg, repoRoot, targetRoot, codexHome) {
  if (typeof arg !== "string") return arg;
  const normalized = arg
    .split(repoRoot)
    .join("<REPO>")
    .split(targetRoot)
    .join("<TARGET>")
    .split(codexHome)
    .join("<CODEX_HOME>");
  const stable = normalized
    .replaceAll(/aimux-session-migrate-switch-target-[^/"\s]+/g, "aimux-session-migrate-switch-target")
    .replaceAll(/aimux-session-migrate-switch-[^/"\s]+/g, "aimux-session-migrate-switch");
  if (stable.startsWith("PATH=")) return "<PATH>";
  if (/^[A-Z0-9_]+=/.test(stable) && !stable.startsWith("AIMUX_") && !stable.startsWith("TERM=")) {
    if (!stable.startsWith("CLAUDE_YOLO=")) return `<ENV:${stable.split("=")[0]}>`;
  }
  if (stable.includes("claude-settings/")) return stable.replace(/claude-settings\/[^/\s]+\.json/g, "claude-settings/<SESSION>.json");
  return stable;
}

function summarizeArgs(args, repoRoot, targetRoot, codexHome) {
  return args
    .map((arg) => summarizeArg(arg, repoRoot, targetRoot, codexHome))
    .filter((arg) => typeof arg !== "string" || (!arg.startsWith("<ENV:") && arg !== "<PATH>"));
}

function sessionSummary(session) {
  if (!session || typeof session !== "object") return session;
  return {
    id: session.id ?? null,
    command: session.command ?? null,
    backendSessionId: session.backendSessionId ?? null,
    exited: session.exited ?? null,
    team: session.team ?? null,
  };
}

function targetSummary(target) {
  if (!target || typeof target !== "object") return target;
  return { sessionName: target.sessionName, windowId: target.windowId, windowName: target.windowName };
}

function recorder(repoRoot, targetRoot, codexHome) {
  const calls = [];
  const push = (method, args) => calls.push({ method, args: normalize(args, repoRoot, targetRoot, codexHome) });
  return {
    calls,
    fn(method, impl) {
      return (...args) => {
        if (method === "tmuxRuntimeManager.createWindow") {
          push(method, [args[0], args[1], args[2], args[3], summarizeArgs(args[4] ?? [], repoRoot, targetRoot, codexHome), args[5]]);
        } else if (method === "registerManagedSession") {
          push(method, [sessionSummary(args[0]), args[1], args[2], args[3], args[4], "<TIMESTAMP>", args[6] ?? null]);
        } else if (method === "tmuxRuntimeManager.clearTargetHistory") {
          push(method, [targetSummary(args[0])]);
        } else {
          push(method, args);
        }
        return impl?.(...args);
      };
    },
  };
}

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function makeSession(raw, sessions, rec) {
  const session = { ...clone(raw) };
  session.kill = rec.fn(`session.${session.id}.kill`, () => {
    session.exited = true;
    const index = sessions.indexOf(session);
    if (index >= 0) sessions.splice(index, 1);
  });
  session.onExit = rec.fn(`session.${session.id}.onExit`);
  return session;
}

function makeHost(input, repoRoot, targetRoot, codexHome) {
  const rec = recorder(repoRoot, targetRoot, codexHome);
  const sessions = [];
  const host = {
    projectRoot: repoRoot,
    sessions,
    activeIndex: input.host?.activeIndex ?? 0,
    startedInDashboard: false,
    mode: "session",
    sessionToolKeys: new Map(input.host?.sessionToolKeys ?? []),
    sessionOriginalArgs: new Map(input.host?.sessionOriginalArgs ?? []),
    sessionWorktreePaths: new Map(input.host?.sessionWorktreePaths ?? []),
    sessionTmuxTargets: new Map(),
    sessionStartTimes: new Map(),
    contextWatcher: { syncNow: rec.fn("contextWatcher.syncNow", async () => undefined) },
    sessionBootstrap: {
      stripToolActionArgs: rec.fn("sessionBootstrap.stripToolActionArgs", (_toolCfg, args) => clone(args ?? [])),
      canResumeWithBackendSessionId: rec.fn(
        "sessionBootstrap.canResumeWithBackendSessionId",
        () => input.canResumeWithBackendSessionId === true,
      ),
      composeToolArgs: rec.fn("sessionBootstrap.composeToolArgs", (_toolCfg, resumeArgs, originalArgs) => [
        ...(originalArgs ?? []),
        ...(resumeArgs ?? []),
      ]),
      readForkSourceSnapshot: rec.fn("sessionBootstrap.readForkSourceSnapshot", () =>
        clone(input.sourceSnapshot ?? { historyText: "", liveText: "" }),
      ),
      buildCodexMigrationContinuityPreamble: rec.fn(
        "sessionBootstrap.buildCodexMigrationContinuityPreamble",
        () => input.migrationPreamble ?? "continuity preamble",
      ),
      buildToolSwitchContinuityPreamble: rec.fn(
        "sessionBootstrap.buildToolSwitchContinuityPreamble",
        () => input.switchPreamble ?? "switch continuity",
      ),
      buildSessionPreamble: rec.fn("sessionBootstrap.buildSessionPreamble", () => input.preamble ?? ""),
      ensurePlanFile: rec.fn("sessionBootstrap.ensurePlanFile"),
      finalizePreamble: rec.fn("sessionBootstrap.finalizePreamble"),
    },
    tmuxRuntimeManager: {
      ensureProjectSession: rec.fn("tmuxRuntimeManager.ensureProjectSession", () => ({ sessionName: "aimux-test" })),
      createWindow: rec.fn("tmuxRuntimeManager.createWindow", () => ({
        sessionName: "aimux-test",
        windowId: "@1",
        windowName: "agent",
      })),
      clearTargetHistory: rec.fn("tmuxRuntimeManager.clearTargetHistory"),
      getTargetByWindowId: rec.fn("tmuxRuntimeManager.getTargetByWindowId", () => ({
        sessionName: "aimux-test",
        windowId: "@1",
        windowName: "agent",
      })),
      isWindowAlive: rec.fn("tmuxRuntimeManager.isWindowAlive", () => true),
    },
    syncTmuxWindowMetadata: rec.fn("syncTmuxWindowMetadata"),
    registerManagedSession: rec.fn("registerManagedSession", (session, args, tool, worktreePath, _unused, startedAt, team) => {
      sessions.push(session);
      host.sessionToolKeys.set(session.id, tool);
      host.sessionOriginalArgs.set(session.id, args);
      host.sessionWorktreePaths.set(session.id, worktreePath);
      host.sessionStartTimes.set(session.id, startedAt);
      if (team) session.team = team;
    }),
    getSessionLabel: rec.fn("getSessionLabel", () => "agent"),
    saveState: rec.fn("saveState"),
  };
  for (const session of input.host?.sessions ?? []) sessions.push(makeSession(materialize(session, repoRoot, targetRoot, codexHome), sessions, rec));
  return { host, calls: rec.calls };
}

async function withProject(input, runCase) {
  const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-migrate-switch-"));
  const targetRoot = mkdtempSync(join(tmpdir(), "aimux-session-migrate-switch-target-"));
  const codexHome = mkdtempSync(join(tmpdir(), "aimux-codex-home-"));
  const previousCwd = process.cwd();
  const previousHome = process.env.AIMUX_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const aimuxHome = join(repoRoot, "home");
  try {
    gitInit(repoRoot);
    gitInit(targetRoot);
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    mkdirSync(aimuxHome, { recursive: true });
    writeFileSync(join(repoRoot, ".aimux", "config.json"), `${JSON.stringify(input.config ?? {}, null, 2)}\n`);
    process.chdir(repoRoot);
    process.env.AIMUX_HOME = aimuxHome;
    process.env.CODEX_HOME = codexHome;
    await initPaths(repoRoot);
    return normalize(await runCase(repoRoot, targetRoot, codexHome), repoRoot, targetRoot, codexHome);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

async function runCase(api, input) {
  return withProject(input, async (repoRoot, targetRoot, codexHome) => {
    const materialized = materialize(input, repoRoot, targetRoot, codexHome);
    const { host, calls } = makeHost(materialized, repoRoot, targetRoot, codexHome);
    let error = null;
    try {
      if (api === "migrateAgent") {
        await migrateAgent(host, materialized.sessionId, materialized.targetWorktreePath ?? targetRoot);
      } else if (api === "switchAgentTool") {
        await switchAgentTool(
          host,
          materialized.sessionId,
          materialized.targetToolConfigKey,
          materialized.launchOverride,
          materialized.instruction,
        );
      } else {
        throw new Error(`unknown api ${api}`);
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    return {
      error,
      host: {
        activeIndex: host.activeIndex,
        sessions: host.sessions.map(sessionSummary),
        toolKeys: [...host.sessionToolKeys.entries()],
        originalArgs: [...host.sessionOriginalArgs.entries()],
        worktreePaths: [...host.sessionWorktreePaths.entries()],
        targets: [...host.sessionTmuxTargets.entries()].map(([key, value]) => [key, targetSummary(value)]),
      },
      calls,
    };
  });
}

const baseConfig = {
  runtime: { agentPreambleEnabled: true },
  tools: {
    codex: {
      command: "codex",
      args: ["--dangerously-bypass-approvals-and-sandbox"],
      enabled: true,
      resumeArgs: ["resume", "{sessionId}"],
      resumeByBackendSessionId: true,
      developerInstructionsConfigKey: "developer_instructions",
    },
    claude: {
      command: "claude",
      args: ["--dangerously-skip-permissions"],
      enabled: true,
      resumeArgs: ["--resume", "{sessionId}"],
      resumeByBackendSessionId: true,
      preambleFlag: ["--append-system-prompt"],
      sessionIdFlag: ["--session-id", "{sessionId}"],
    },
    disabled: { command: "disabled", args: [], enabled: false },
  },
  scribe: { defaultAgent: null },
};

const casesInput = [
  {
    api: "migrateAgent",
    name: "migrateAgent reports missing source sessions before side effects",
    input: { config: baseConfig, sessionId: "missing", targetWorktreePath: "<TARGET>" },
  },
  {
    api: "migrateAgent",
    name: "migrateAgent rebuilds continuity when backend resume is unavailable",
    input: {
      config: baseConfig,
      sessionId: "codex-1",
      targetWorktreePath: "<TARGET>",
      canResumeWithBackendSessionId: false,
      sourceSnapshot: { historyText: "", liveText: "" },
      migrationPreamble: "continuity preamble",
      host: {
        sessions: [
          {
            id: "codex-1",
            command: "codex",
            exited: false,
            team: { teamId: "team-1", parentSessionId: "parent-1", role: "reviewer" },
          },
        ],
        sessionToolKeys: [["codex-1", "codex"]],
        sessionOriginalArgs: [["codex-1", ["--dangerously-bypass-approvals-and-sandbox"]]],
        sessionWorktreePaths: [["codex-1", "<REPO>"]],
      },
    },
  },
  {
    api: "migrateAgent",
    name: "migrateAgent composes backend resume args when available",
    input: {
      config: baseConfig,
      sessionId: "claude-1",
      targetWorktreePath: "<TARGET>",
      canResumeWithBackendSessionId: true,
      host: {
        sessions: [{ id: "claude-1", command: "claude", backendSessionId: "claude-backend", exited: false }],
        sessionToolKeys: [["claude-1", "claude"]],
        sessionOriginalArgs: [["claude-1", ["--dangerously-skip-permissions"]]],
        sessionWorktreePaths: [["claude-1", "<REPO>"]],
      },
    },
  },
  {
    api: "switchAgentTool",
    name: "switchAgentTool returns without relaunch for same tool and no override",
    input: {
      config: baseConfig,
      sessionId: "codex-1",
      targetToolConfigKey: "codex",
      host: {
        sessions: [{ id: "codex-1", command: "codex", exited: false }],
        sessionToolKeys: [["codex-1", "codex"]],
        sessionOriginalArgs: [["codex-1", ["--dangerously-bypass-approvals-and-sandbox"]]],
      },
    },
  },
  {
    api: "switchAgentTool",
    name: "switchAgentTool rejects disabled target configs before killing",
    input: {
      config: baseConfig,
      sessionId: "codex-1",
      targetToolConfigKey: "disabled",
      host: { sessions: [{ id: "codex-1", command: "codex", exited: false }], sessionToolKeys: [["codex-1", "codex"]] },
    },
  },
  {
    api: "switchAgentTool",
    name: "switchAgentTool relaunches a live agent under the same Aimux session id",
    input: {
      config: baseConfig,
      sessionId: "claude-1",
      targetToolConfigKey: "codex",
      switchPreamble: "switch continuity",
      host: {
        sessions: [
          {
            id: "claude-1",
            command: "claude",
            backendSessionId: "claude-backend",
            exited: false,
            team: { teamId: "team-1", parentSessionId: "parent-1", role: "coder" },
          },
        ],
        sessionToolKeys: [["claude-1", "claude"]],
        sessionOriginalArgs: [["claude-1", ["--dangerously-skip-permissions"]]],
        sessionWorktreePaths: [["claude-1", "<REPO>"]],
      },
      sourceSnapshot: { historyText: "previous work", liveText: "live pane" },
    },
  },
  {
    api: "switchAgentTool",
    name: "switchAgentTool honors launch overrides while keeping the Aimux session id",
    input: {
      config: baseConfig,
      sessionId: "codex-1",
      targetToolConfigKey: "codex",
      launchOverride: { command: "bash", args: ["--login"], env: { CLAUDE_YOLO: "1" } },
      instruction: "switch now",
      switchPreamble: "override continuity",
      host: {
        sessions: [{ id: "codex-1", command: "codex", exited: false }],
        sessionToolKeys: [["codex-1", "codex"]],
        sessionOriginalArgs: [["codex-1", ["--old-action"]]],
        sessionWorktreePaths: [["codex-1", "<REPO>"]],
      },
      sourceSnapshot: { historyText: "old", liveText: "" },
    },
  },
];

const cases = [];
for (const entry of casesInput) {
  const input = clone(entry.input);
  cases.push({
    id: `session-launch-migrate-switch-${String(cases.length + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/session-launch.ts",
    api: entry.api,
    input,
    output: await runCase(entry.api, clone(input)),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/session-launch.ts",
  generatedBy: "scripts/capture-session-launch-migrate-switch-contract.mjs",
  description:
    "Session migration and tool-switch orchestration captured by running TypeScript migrateAgent/switchAgentTool with deterministic fake hosts.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
