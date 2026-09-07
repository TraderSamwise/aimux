#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/session-launch-startup.json", ROOT);

const { initPaths } = await import(new URL("dist/paths.js", ROOT));
const { run, runProjectService, startProjectServiceHost } = await import(
  new URL("dist/multiplexer/session-launch.js", ROOT)
);

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

function normalize(value, repoRoot) {
  return JSON.parse(JSON.stringify(value).split(repoRoot).join("<REPO>"));
}

function materialize(value, repoRoot) {
  return JSON.parse(JSON.stringify(value).split("<REPO>").join(repoRoot));
}

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function recorder() {
  const calls = [];
  const fn =
    (method, impl) =>
    (...args) => {
      calls.push({ method, args: clone(args) });
      return impl?.(...args);
    };
  return { calls, fn };
}

function makeHost(input, repoRoot) {
  const rec = recorder();
  const sessions = clone(input.host?.sessions ?? []);
  const host = {
    projectRoot: repoRoot,
    mode: input.host?.mode ?? "session",
    startedInDashboard: input.host?.startedInDashboard ?? false,
    defaultCommand: input.host?.defaultCommand,
    defaultArgs: input.host?.defaultArgs,
    graveyardCleanupRunning: input.host?.graveyardCleanupRunning ?? false,
    inboxCleanupRunning: input.host?.inboxCleanupRunning ?? false,
    sessions,
    startHeartbeat: rec.fn("startHeartbeat"),
    syncSessionsFromTopology: rec.fn("syncSessionsFromTopology"),
    writeInstructionFiles: rec.fn("writeInstructionFiles"),
    createSession: rec.fn("createSession", () => {
      sessions.push({ id: `created-${sessions.length + 1}` });
    }),
    focusSession: rec.fn("focusSession"),
    startProjectServices: rec.fn("startProjectServices", async () => input.startProjectServicesResult ?? undefined),
    startStatusRefresh: rec.fn("startStatusRefresh"),
    startGraveyardCleanup: rec.fn("startGraveyardCleanup"),
    cleanupGraveyard: rec.fn("cleanupGraveyard", async () => input.cleanupGraveyardResult ?? { dryRun: false }),
    startInboxCleanup: rec.fn("startInboxCleanup"),
    cleanupInbox: rec.fn("cleanupInbox", async () => input.cleanupInboxResult ?? { deleted: 0 }),
    refreshDesktopStateSnapshot: rec.fn("refreshDesktopStateSnapshot"),
    writeStatuslineFile: rec.fn("writeStatuslineFile"),
    teardown: rec.fn("teardown"),
    tmuxRuntimeManager: {
      repairLegacyProjectSessionNames: rec.fn("tmuxRuntimeManager.repairLegacyProjectSessionNames"),
    },
  };
  return { host, calls: rec.calls };
}

async function withProject(input, runCase) {
  const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-launch-startup-"));
  const previousCwd = process.cwd();
  const previousHome = process.env.AIMUX_HOME;
  const aimuxHome = join(repoRoot, "home");
  try {
    gitInit(repoRoot);
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    mkdirSync(aimuxHome, { recursive: true });
    writeFileSync(join(repoRoot, ".aimux", "config.json"), `${JSON.stringify(input.config ?? {}, null, 2)}\n`);
    process.chdir(repoRoot);
    process.env.AIMUX_HOME = aimuxHome;
    await initPaths(repoRoot);
    return normalize(await runCase(repoRoot), repoRoot);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

async function runCase(api, input) {
  return withProject(input, async (repoRoot) => {
    const { host, calls } = makeHost(materialize(input, repoRoot), repoRoot);
    let result;
    if (api === "run") {
      result = await run(host, materialize(input.options, repoRoot));
    } else if (api === "startProjectServiceHost") {
      result = (await startProjectServiceHost(host)) ?? null;
    } else if (api === "runProjectService") {
      const pending = runProjectService(host);
      await new Promise((resolve) => setTimeout(resolve, 0));
      host.resolveRun(input.exitCode ?? 0);
      result = await pending;
    } else {
      throw new Error(`unknown api ${api}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      result,
      host: {
        mode: host.mode,
        startedInDashboard: host.startedInDashboard,
        defaultCommand: host.defaultCommand ?? null,
        defaultArgs: host.defaultArgs ?? null,
        sessionCount: host.sessions.length,
        graveyardCleanupRunning: host.graveyardCleanupRunning,
        inboxCleanupRunning: host.inboxCleanupRunning,
      },
      calls,
    };
  });
}

const baseConfig = {
  defaultTool: "codex",
  tools: {
    codex: {
      command: "codex",
      args: ["--model", "gpt-5"],
      enabled: true,
      preambleFlag: ["--append-system-prompt"],
      sessionIdFlag: ["--session-id", "{sessionId}"],
    },
  },
  scribe: { defaultAgent: null },
};

const casesInput = [
  {
    api: "run",
    name: "run initializes a normal session and focuses the created entry",
    input: {
      config: baseConfig,
      options: { command: "codex", args: ["--model", "gpt-5", "--profile", "dev"] },
    },
  },
  {
    api: "startProjectServiceHost",
    name: "startProjectServiceHost adopts topology before service exposure and starts maintenance",
    input: {
      config: baseConfig,
      host: { mode: "dashboard" },
    },
  },
  {
    api: "startProjectServiceHost",
    name: "startProjectServiceHost respects already-running cleanup jobs",
    input: {
      config: baseConfig,
      host: { mode: "dashboard", graveyardCleanupRunning: true, inboxCleanupRunning: true },
    },
  },
  {
    api: "runProjectService",
    name: "runProjectService keeps the host alive until resolveRun then tears down",
    input: {
      config: baseConfig,
      host: { mode: "dashboard" },
      exitCode: 7,
    },
  },
];

const cases = [];
for (const entry of casesInput) {
  const input = clone(entry.input);
  cases.push({
    id: `session-launch-startup-${String(cases.length + 1).padStart(3, "0")}`,
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
  generatedBy: "scripts/capture-session-launch-startup-contract.mjs",
  description:
    "Session launch startup, project-service startup, and standalone project-service lifetime behavior captured by running TypeScript with deterministic fake hosts.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
