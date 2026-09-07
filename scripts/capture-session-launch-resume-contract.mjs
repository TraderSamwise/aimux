#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/session-launch-resume.json", ROOT);

const { initPaths } = await import(new URL("dist/paths.js", ROOT));
const { saveRuntimeTopologySessions } = await import(new URL("dist/runtime-core/topology-sessions.js", ROOT));
const { SessionBootstrapService } = await import(new URL("dist/session-bootstrap.js", ROOT));
const { resumeSessions, restoreSessions } = await import(new URL("dist/multiplexer/session-launch.js", ROOT));

const cwd = process.cwd();
const clone = (value) => JSON.parse(JSON.stringify(value));
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

function normalizeValue(value, repoRoot = "<REPO>") {
  return JSON.parse(JSON.stringify(value).split(cwd).join("<ROOT>").split(repoRoot).join("<REPO>"));
}

function materializeValue(value, repoRoot) {
  return JSON.parse(JSON.stringify(value).split("<REPO>").join(repoRoot).split("<ROOT>").join(cwd));
}

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function realArgComposition(rec) {
  const bootstrap = SessionBootstrapService.prototype;
  return {
    canResumeWithBackendSessionId(toolCfg, backendSessionId) {
      rec.calls.push({
        method: "sessionBootstrap.canResumeWithBackendSessionId",
        args: [clone(toolCfg), backendSessionId],
      });
      return bootstrap.canResumeWithBackendSessionId.call(bootstrap, toolCfg, backendSessionId);
    },
    composeToolLaunch(toolCfg, resumeArgs, originalArgs) {
      rec.calls.push({
        method: "sessionBootstrap.composeToolLaunch",
        args: [clone(toolCfg), clone(resumeArgs), clone(originalArgs)],
      });
      return bootstrap.composeToolLaunch.call(bootstrap, toolCfg, resumeArgs, originalArgs);
    },
    stripToolActionArgs(toolCfg, args) {
      rec.calls.push({
        method: "sessionBootstrap.stripToolActionArgs",
        args: [clone(toolCfg), clone(args)],
      });
      return bootstrap.stripToolActionArgs.call(bootstrap, toolCfg, args);
    },
    composeToolArgs: bootstrap.composeToolArgs.bind(bootstrap),
    toolActionArgPatterns: bootstrap.toolActionArgPatterns.bind(bootstrap),
  };
}

function recorder(repoRoot, options = {}) {
  const rec = { calls: [], stderr: [] };
  const host = {
    startHeartbeat() {
      rec.calls.push({ method: "startHeartbeat", args: [] });
    },
    syncSessionsFromTopology() {
      rec.calls.push({ method: "syncSessionsFromTopology", args: [] });
    },
    saveState() {
      rec.calls.push({ method: "saveState", args: [] });
      if (options.reconcileSessions) {
        saveRuntimeTopologySessions({
          sessions: materializeValue(options.reconcileSessions, repoRoot),
          projectRoot: repoRoot,
        });
      }
    },
    createSession(...args) {
      rec.calls.push({ method: "createSession", args: clone(args) });
    },
    openTmuxDashboardTarget() {
      rec.calls.push({ method: "openTmuxDashboardTarget", args: [] });
    },
    runDashboard() {
      rec.calls.push({ method: "runDashboard", args: [] });
      return options.runDashboardResult ?? 0;
    },
    sessionBootstrap: realArgComposition(rec),
  };
  return { host, rec };
}

async function withProject(input, run) {
  const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-resume-"));
  try {
    gitInit(repoRoot);
    await initPaths(repoRoot);
    saveRuntimeTopologySessions({
      sessions: materializeValue(input.topologySessions ?? [], repoRoot),
      projectRoot: repoRoot,
    });
    return await run(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

async function runCase(api, input) {
  return withProject(input, async (repoRoot) => {
    const { host, rec } = recorder(repoRoot, materializeValue(input.hostOptions ?? {}, repoRoot));
    const originalError = console.error;
    console.error = (...args) => {
      rec.stderr.push(args.map(String));
    };
    try {
      const result =
        api === "resumeSessions"
          ? await resumeSessions(host, input.toolFilter)
          : await restoreSessions(host, input.toolFilter);
      return normalizeValue({ result, calls: rec.calls, stderr: rec.stderr }, repoRoot);
    } finally {
      console.error = originalError;
    }
  });
}

const casesInput = [
  {
    api: "resumeSessions",
    name: "skips incomplete saved resume state",
    input: {
      topologySessions: [
        {
          id: "codex-1",
          command: "codex",
          tool: "codex",
          toolConfigKey: "codex",
          args: ["--dangerously-bypass-approvals-and-sandbox"],
          lifecycle: "offline",
          worktreePath: "<REPO>",
        },
      ],
    },
  },
  {
    api: "resumeSessions",
    name: "preserves teammate metadata and exact backend resume launch",
    input: {
      topologySessions: [
        {
          id: "codex-team",
          command: "codex",
          tool: "codex",
          toolConfigKey: "codex",
          args: [],
          lifecycle: "offline",
          backendSessionId: "backend-team",
          team: { teamId: "team-1", parentSessionId: "claude-parent", role: "reviewer" },
          worktreePath: "<REPO>",
        },
      ],
    },
  },
  {
    api: "resumeSessions",
    name: "only resumes offline topology sessions",
    input: {
      topologySessions: [
        {
          id: "codex-running",
          command: "codex",
          tool: "codex",
          toolConfigKey: "codex",
          args: [],
          lifecycle: "running",
          backendSessionId: "backend-running",
          worktreePath: "<REPO>",
        },
        {
          id: "codex-offline",
          command: "codex",
          tool: "codex",
          toolConfigKey: "codex",
          args: [],
          lifecycle: "offline",
          backendSessionId: "backend-offline",
          worktreePath: "<REPO>",
        },
      ],
    },
  },
  {
    api: "restoreSessions",
    name: "only restores offline topology sessions",
    input: {
      topologySessions: [
        {
          id: "codex-running",
          command: "codex",
          tool: "codex",
          toolConfigKey: "codex",
          args: ["running"],
          lifecycle: "running",
          worktreePath: "<REPO>",
        },
        {
          id: "codex-offline",
          command: "codex",
          tool: "codex",
          toolConfigKey: "codex",
          args: ["offline"],
          lifecycle: "offline",
          worktreePath: "<REPO>",
        },
      ],
    },
  },
  {
    api: "resumeSessions",
    name: "uses dashboard fallback when reconciliation leaves no launchable sessions",
    input: {
      topologySessions: [
        {
          id: "codex-live",
          command: "codex",
          tool: "codex",
          toolConfigKey: "codex",
          args: [],
          lifecycle: "offline",
          backendSessionId: "backend-live",
          worktreePath: "<REPO>",
        },
      ],
      hostOptions: {
        reconcileSessions: [
          {
            id: "codex-live",
            command: "codex",
            tool: "codex",
            toolConfigKey: "codex",
            args: [],
            lifecycle: "live",
            backendSessionId: "backend-live",
            worktreePath: "<REPO>",
          },
        ],
      },
    },
  },
  {
    api: "resumeSessions",
    name: "filters sessions by requested tool config key",
    input: {
      toolFilter: "claude",
      topologySessions: [
        {
          id: "codex-offline",
          command: "codex",
          tool: "codex",
          toolConfigKey: "codex",
          args: [],
          lifecycle: "offline",
          backendSessionId: "backend-codex",
          worktreePath: "<REPO>",
        },
        {
          id: "claude-offline",
          command: "claude",
          tool: "claude",
          toolConfigKey: "claude",
          args: [],
          lifecycle: "offline",
          backendSessionId: "backend-claude",
          worktreePath: "<REPO>",
        },
      ],
    },
  },
];

const cases = [];
for (const entry of casesInput) {
  const input = normalizeValue(entry.input);
  cases.push({
    id: `session-launch-resume-${String(cases.length + 1).padStart(3, "0")}`,
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
  generatedBy: "scripts/capture-session-launch-resume-contract.mjs",
  description:
    "Session launch resume and restore selection/forwarding behavior captured by running TypeScript against temp runtime topology state.",
  cases,
});
