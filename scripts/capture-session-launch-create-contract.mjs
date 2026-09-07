#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/session-launch-create.json", ROOT);

const { initPaths } = await import(new URL("dist/paths.js", ROOT));
const { createSession, createSessionAsync } = await import(new URL("dist/multiplexer/session-launch.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function gitInit(cwd) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;
  execFileSync("git", ["init"], { cwd, stdio: "ignore", env });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalize(value, repoRoot, codexHome) {
  return JSON.parse(
    JSON.stringify(value)
      .split(repoRoot)
      .join("<REPO>")
      .split(codexHome)
      .join("<CODEX_HOME>")
      .replaceAll(/aimux-session-launch-create-[^/"\s]+/g, "aimux-session-launch-create")
      .replaceAll(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/g, "<ISO_DATE>"),
  );
}

function materialize(value, repoRoot, codexHome) {
  return JSON.parse(JSON.stringify(value).split("<REPO>").join(repoRoot).split("<CODEX_HOME>").join(codexHome));
}

function summarizeArg(arg, repoRoot, codexHome) {
  if (typeof arg !== "string") return arg;
  const normalized = arg.split(repoRoot).join("<REPO>").split(codexHome).join("<CODEX_HOME>");
  if (normalized.startsWith("PATH=")) return "<PATH>";
  if (/^[A-Z0-9_]+=/.test(normalized) && !normalized.startsWith("AIMUX_") && !normalized.startsWith("TERM=")) {
    if (!normalized.startsWith("CLAUDE_YOLO=")) return `<ENV:${normalized.split("=")[0]}>`;
  }
  if (normalized.includes("claude-settings/")) return normalized.replace(/claude-settings\/[^/\s]+\.json/g, "claude-settings/<SESSION>.json");
  return normalized;
}

function summarizeArgs(args, repoRoot, codexHome) {
  return args
    .map((arg) => summarizeArg(arg, repoRoot, codexHome))
    .filter((arg) => {
      if (typeof arg !== "string") return true;
      if (arg.startsWith("<ENV:")) return false;
      return arg !== "<PATH>";
    });
}

function sessionSummary(session) {
  if (!session || typeof session !== "object") return session;
  return {
    id: session.id ?? null,
    command: session.command ?? null,
    backendSessionId: session.backendSessionId ?? null,
    exited: session.exited ?? null,
  };
}

function targetSummary(target) {
  if (!target || typeof target !== "object") return target;
  return {
    sessionName: target.sessionName,
    windowId: target.windowId,
    windowName: target.windowName,
  };
}

function recorder(repoRoot, codexHome) {
  const calls = [];
  const push = (method, args) => calls.push({ method, args: normalize(args, repoRoot, codexHome) });
  return {
    calls,
    fn(method, impl) {
      return (...args) => {
        if (method === "tmuxRuntimeManager.createWindow" || method === "tmuxRuntimeManager.createWindowAsync") {
          push(method, [
            args[0],
            args[1],
            args[2],
            args[3],
            summarizeArgs(args[4] ?? [], repoRoot, codexHome),
            args[5],
          ]);
        } else if (method === "registerManagedSession") {
          push(method, [
            sessionSummary(args[0]),
            args[1],
            args[2],
            args[3],
            args[4],
            "<TIMESTAMP>",
            args[6] ?? null,
          ]);
        } else if (
          method === "tmuxRuntimeManager.clearTargetHistory" ||
          method === "tmuxRuntimeManager.clearTargetHistoryAsync" ||
          method === "tmuxRuntimeManager.setWindowMetadataAsync" ||
          method === "tmuxRuntimeManager.applyManagedAgentWindowPolicyAsync" ||
          method === "tmuxRuntimeManager.killWindowAsync"
        ) {
          push(method, [targetSummary(args[0]), ...(method === "tmuxRuntimeManager.setWindowMetadataAsync" ? [args[1]] : args.slice(1))]);
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

function makeHost(input, repoRoot, codexHome) {
  const rec = recorder(repoRoot, codexHome);
  const sessions = clone(input.host?.sessions ?? []);
  const targets = new Map();
  const target = input.target ?? { sessionName: "aimux-test", windowId: "@1", windowName: input.targetWindowName ?? "agent" };
  const host = {
    projectRoot: repoRoot,
    sessions,
    activeIndex: input.host?.activeIndex ?? 0,
    startedInDashboard: input.host?.startedInDashboard ?? false,
    mode: input.host?.mode ?? "session",
    sessionTmuxTargets: targets,
    sessionToolKeys: new Map(),
    sessionOriginalArgs: new Map(),
    sessionWorktreePaths: new Map(),
    sessionStartTimes: new Map(),
    sessionBootstrap: {
      buildSessionPreamble: rec.fn("sessionBootstrap.buildSessionPreamble", () => input.preamble ?? ""),
      ensurePlanFile: rec.fn("sessionBootstrap.ensurePlanFile"),
      finalizePreamble: rec.fn("sessionBootstrap.finalizePreamble"),
    },
    tmuxRuntimeManager: {
      ensureProjectSession: rec.fn("tmuxRuntimeManager.ensureProjectSession", () => ({ sessionName: "aimux-test" })),
      ensureProjectSessionAsync: rec.fn("tmuxRuntimeManager.ensureProjectSessionAsync", async () => ({
        sessionName: "aimux-test",
      })),
      createWindow: rec.fn("tmuxRuntimeManager.createWindow", () => clone(target)),
      createWindowAsync: rec.fn("tmuxRuntimeManager.createWindowAsync", async () => clone(target)),
      clearTargetHistory: rec.fn("tmuxRuntimeManager.clearTargetHistory"),
      clearTargetHistoryAsync: rec.fn("tmuxRuntimeManager.clearTargetHistoryAsync", async () => undefined),
      getTargetByWindowId: rec.fn("tmuxRuntimeManager.getTargetByWindowId", () => clone(target)),
      isWindowAlive: rec.fn("tmuxRuntimeManager.isWindowAlive", () => true),
      setWindowMetadataAsync: rec.fn("tmuxRuntimeManager.setWindowMetadataAsync", async () => {
        if (input.failAsyncMetadata) throw new Error("metadata write failed");
      }),
      applyManagedAgentWindowPolicyAsync: rec.fn(
        "tmuxRuntimeManager.applyManagedAgentWindowPolicyAsync",
        async () => undefined,
      ),
      killWindowAsync: rec.fn("tmuxRuntimeManager.killWindowAsync", async () => undefined),
    },
    buildTmuxWindowMetadata: rec.fn("buildTmuxWindowMetadata", (sessionId, command) => ({
      kind: "agent",
      sessionId,
      command,
      toolConfigKey: input.call.toolConfigKey ?? command,
      backendSessionId: input.call.backendSessionIdOverride,
      team: input.call.team,
      worktreePath: input.call.worktreePath,
    })),
    syncTmuxWindowMetadata: rec.fn("syncTmuxWindowMetadata"),
    registerManagedSession: rec.fn("registerManagedSession", (session, args, tool, worktreePath, _unused, startedAt, team) => {
      sessions.push(session);
      host.sessionToolKeys.set(session.id, tool);
      host.sessionOriginalArgs.set(session.id, args);
      host.sessionWorktreePaths.set(session.id, worktreePath);
      host.sessionStartTimes.set(session.id, startedAt);
      if (team) session.team = team;
    }),
    getSessionLabel: rec.fn("getSessionLabel", () => input.sessionLabel ?? undefined),
    invalidateDesktopStateSnapshot: rec.fn("invalidateDesktopStateSnapshot"),
    refreshLocalDashboardModel: rec.fn("refreshLocalDashboardModel"),
    updateWorktreeSessions: rec.fn("updateWorktreeSessions"),
    preferDashboardEntrySelection: rec.fn("preferDashboardEntrySelection"),
    renderCurrentDashboardView: rec.fn("renderCurrentDashboardView"),
    saveState: rec.fn("saveState"),
    updateContextWatcherSessions: rec.fn("updateContextWatcherSessions"),
  };
  return { host, calls: rec.calls };
}

async function withProject(input, runCase) {
  const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-create-"));
  const codexHome = mkdtempSync(join(tmpdir(), "aimux-codex-home-"));
  const previousCwd = process.cwd();
  const previousHome = process.env.AIMUX_HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  const aimuxHome = join(repoRoot, "home");
  try {
    gitInit(repoRoot);
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    mkdirSync(aimuxHome, { recursive: true });
    writeFileSync(join(repoRoot, ".aimux", "config.json"), `${JSON.stringify(input.config ?? {}, null, 2)}\n`);
    process.chdir(repoRoot);
    process.env.AIMUX_HOME = aimuxHome;
    process.env.CODEX_HOME = codexHome;
    await initPaths(repoRoot);
    return normalize(await runCase(repoRoot, codexHome), repoRoot, codexHome);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

async function runCase(api, input) {
  return withProject(input, async (repoRoot, codexHome) => {
    const materialized = materialize(input, repoRoot, codexHome);
    const { host, calls } = makeHost(materialized, repoRoot, codexHome);
    const call = materialized.call;
    let result = null;
    let error = null;
    try {
      const args = [
        host,
        call.command,
        call.args ?? [],
        call.preambleFlag,
        call.toolConfigKey,
        call.extraPreamble,
        call.sessionIdFlag,
        call.worktreePath,
        call.backendSessionIdOverride,
        call.sessionIdOverride,
        call.detachedInTmux ?? false,
        call.suppressStartupPreamble ?? false,
        call.team,
        call.launchEnv,
        call.persistArgs,
      ];
      const session = api === "createSessionAsync" ? await createSessionAsync(...args) : createSession(...args);
      result = sessionSummary(session);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    return {
      result,
      error,
      host: {
        activeIndex: host.activeIndex,
        sessions: host.sessions.map(sessionSummary),
        targets: [...host.sessionTmuxTargets.entries()].map(([key, value]) => [key, targetSummary(value)]),
        toolKeys: [...host.sessionToolKeys.entries()],
        originalArgs: [...host.sessionOriginalArgs.entries()],
        worktreePaths: [...host.sessionWorktreePaths.entries()],
      },
      calls,
    };
  });
}

const baseConfig = {
  defaultTool: "codex",
  runtime: { agentPreambleEnabled: true },
  tools: {
    codex: {
      command: "codex",
      args: [],
      enabled: true,
      developerInstructionsConfigKey: "developer_instructions",
    },
    claude: {
      command: "claude",
      args: [],
      enabled: true,
      preambleFlag: ["--append-system-prompt"],
      sessionIdFlag: ["--session-id", "{sessionId}"],
    },
    shell: {
      command: "bash",
      args: [],
      enabled: true,
      wrapperEnabled: false,
    },
  },
  scribe: { defaultAgent: null },
};

const casesInput = [
  {
    api: "createSession",
    name: "createSession suppresses automatic startup preamble",
    input: {
      config: baseConfig,
      call: {
        command: "codex",
        args: [],
        toolConfigKey: "codex",
        worktreePath: "<REPO>",
        backendSessionIdOverride: "codex-backend",
        sessionIdOverride: "codex-1",
        suppressStartupPreamble: true,
      },
    },
  },
  {
    api: "createSession",
    name: "createSession sends Codex preambles through developer_instructions",
    input: {
      config: baseConfig,
      preamble: "aimux preamble",
      call: {
        command: "codex",
        args: ["--dangerously-bypass-approvals-and-sandbox", "resume", "abc"],
        toolConfigKey: "codex",
        worktreePath: "<REPO>",
        backendSessionIdOverride: "codex-backend",
        sessionIdOverride: "codex-2",
      },
    },
  },
  {
    api: "createSession",
    name: "createSession keeps Claude resume ids and skips competing session-id flags",
    input: {
      config: baseConfig,
      preamble: "aimux preamble",
      call: {
        command: "claude",
        args: ["--dangerously-skip-permissions", "--resume", "backend-123"],
        preambleFlag: ["--append-system-prompt"],
        toolConfigKey: "claude",
        sessionIdFlag: ["--session-id", "{sessionId}"],
        worktreePath: "<REPO>",
        sessionIdOverride: "claude-1",
      },
    },
  },
  {
    api: "createSession",
    name: "createSession applies launchEnv but skips hooks for overridden binaries",
    input: {
      config: baseConfig,
      preamble: "PREAMBLE",
      call: {
        command: "bash",
        args: ["--login"],
        preambleFlag: ["--append-system-prompt"],
        toolConfigKey: "claude",
        sessionIdFlag: ["--session-id", "{sessionId}"],
        worktreePath: "<REPO>",
        sessionIdOverride: "bash-1",
        launchEnv: { CLAUDE_YOLO: "1" },
      },
    },
  },
  {
    api: "createSession",
    name: "createSession refreshes dashboard selection for human sessions",
    input: {
      config: baseConfig,
      host: { startedInDashboard: true, mode: "dashboard" },
      call: {
        command: "codex",
        args: [],
        toolConfigKey: "codex",
        worktreePath: "<REPO>",
        backendSessionIdOverride: "codex-backend",
        sessionIdOverride: "codex-dashboard",
        suppressStartupPreamble: true,
      },
    },
  },
  {
    api: "createSession",
    name: "createSession skips dashboard worktree selection for project-control sessions",
    input: {
      config: baseConfig,
      host: { startedInDashboard: true, mode: "dashboard" },
      call: {
        command: "codex",
        args: [],
        toolConfigKey: "codex",
        worktreePath: "<REPO>",
        backendSessionIdOverride: "codex-backend",
        sessionIdOverride: "codex-overseer",
        suppressStartupPreamble: true,
        team: { teamId: "team-1", parentSessionId: "parent-1", role: "overseer" },
      },
    },
  },
  {
    api: "createSession",
    name: "createSession rejects duplicate session ids before tmux launch",
    input: {
      config: baseConfig,
      host: { sessions: [{ id: "claude-dup123", command: "claude" }] },
      call: {
        command: "claude",
        args: [],
        toolConfigKey: "claude",
        worktreePath: "<REPO>",
        sessionIdOverride: "claude-dup123",
      },
    },
  },
  {
    api: "createSessionAsync",
    name: "createSessionAsync clears history and writes tmux metadata before policy",
    input: {
      config: baseConfig,
      call: {
        command: "codex",
        args: [],
        toolConfigKey: "codex",
        worktreePath: "<REPO>",
        backendSessionIdOverride: "codex-backend",
        sessionIdOverride: "codex-async",
        suppressStartupPreamble: true,
      },
    },
  },
  {
    api: "createSessionAsync",
    name: "createSessionAsync rolls back registered state when tmux metadata write fails",
    input: {
      config: baseConfig,
      failAsyncMetadata: true,
      call: {
        command: "codex",
        args: [],
        toolConfigKey: "codex",
        worktreePath: "<REPO>",
        backendSessionIdOverride: "codex-backend",
        sessionIdOverride: "codex-rollback",
        suppressStartupPreamble: true,
      },
    },
  },
];

const cases = [];
for (const entry of casesInput) {
  const input = clone(entry.input);
  input.call.worktreePath = input.call.worktreePath === "<REPO>" ? "<REPO>" : input.call.worktreePath;
  cases.push({
    id: `session-launch-create-${String(cases.length + 1).padStart(3, "0")}`,
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
  generatedBy: "scripts/capture-session-launch-create-contract.mjs",
  description:
    "Session launch createSession/createSessionAsync tmux launch, wrapper, registration, dashboard refresh, and rollback behavior captured by running TypeScript with deterministic fake hosts.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
