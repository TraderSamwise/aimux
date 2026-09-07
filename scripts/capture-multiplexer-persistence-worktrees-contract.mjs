#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/persistence-worktrees.json", ROOT);
const FIXED_NOW = "2026-06-01T00:00:00.000Z";
const RealDate = Date;

globalThis.Date = class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) return new RealDate(FIXED_NOW);
    return new RealDate(...args);
  }

  static now() {
    return new RealDate(FIXED_NOW).getTime();
  }

  static parse(value) {
    return RealDate.parse(value);
  }

  static UTC(...args) {
    return RealDate.UTC(...args);
  }
};

const { persistenceMethods } = await import(new URL("dist/multiplexer/persistence-methods.js", ROOT));
const paths = await import(new URL("dist/paths.js", ROOT));
const topologySessions = await import(new URL("dist/runtime-core/topology-sessions.js", ROOT));
const topologyServices = await import(new URL("dist/runtime-core/topology-services.js", ROOT));
const topologyWorktrees = await import(new URL("dist/runtime-core/topology-worktrees.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function gitInit(projectRoot) {
  mkdirSync(projectRoot, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: projectRoot });
  execFileSync("git", ["config", "user.email", "fixture@example.test"], { cwd: projectRoot });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: projectRoot });
  writeFileSync(join(projectRoot, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: projectRoot });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: projectRoot });
}

function normalize(value, ctx) {
  return normalizeGeneratedIds(
    JSON.parse(
      JSON.stringify(value, (_key, nested) => {
        if (typeof nested !== "string") return nested;
        return nested.replaceAll(ctx.projectRoot, "<repo>").replaceAll(ctx.tmpRoot, "<tmp>");
      }),
    ),
  );
}

function normalizeGeneratedIds(value) {
  const generatedIds = new Map();
  const collect = (nested) => {
    if (Array.isArray(nested)) {
      for (const item of nested) collect(item);
      return;
    }
    if (!nested || typeof nested !== "object") return;
    if (typeof nested.id === "string" && typeof nested.path === "string") {
      if (nested.id.startsWith("worktree-graveyard:")) {
        generatedIds.set(nested.id, `<worktree-graveyard-id:${nested.path}>`);
      } else if (nested.id.startsWith("worktree:")) {
        generatedIds.set(nested.id, `<worktree-id:${nested.path}>`);
      }
    }
    if (typeof nested.worktreeId === "string" && typeof nested.path === "string") {
      generatedIds.set(nested.worktreeId, `<worktree-id:${nested.path}>`);
    }
    for (const item of Object.values(nested)) collect(item);
  };
  const visit = (nested) => {
    if (Array.isArray(nested)) return nested.map(visit);
    if (nested && typeof nested === "object") {
      return Object.fromEntries(Object.entries(nested).map(([key, item]) => [key, visit(item)]));
    }
    if (typeof nested !== "string") return nested;
    if (generatedIds.has(nested)) return generatedIds.get(nested);
    if (nested.startsWith("worktree-graveyard:")) return "<worktree-graveyard-id:unknown>";
    if (nested.startsWith("worktree:")) return "<worktree-id:unknown>";
    return nested;
  };
  collect(value);
  return visit(value);
}

function denormalize(value, ctx) {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "string") return nested;
      return nested.replaceAll("<repo>", ctx.projectRoot).replaceAll("<tmp>", ctx.tmpRoot);
    }),
  );
}

function callRecorder(calls, name, impl = () => undefined) {
  return (...args) => {
    calls.push({ method: name, args: clone(args) });
    return impl(...args);
  };
}

function hostFor(input) {
  const calls = [];
  const host = {
    projectRoot: input.projectRoot,
    mode: input.mode ?? "project-service",
    sessions: clone(input.sessions ?? []),
    offlineSessions: clone(input.offlineSessions ?? []),
    offlineServices: clone(input.offlineServices ?? []),
    sessionWorktreePaths: new Map(input.sessionWorktreePaths ?? []),
    listDesktopWorktrees: callRecorder(calls, "listDesktopWorktrees", () => clone(input.worktrees ?? [])),
    isSessionRuntimeLive: callRecorder(calls, "isSessionRuntimeLive", (session) => input.liveSessionIds?.includes(session.id) ?? false),
    saveState: callRecorder(calls, "saveState"),
    invalidateDesktopStateSnapshot: callRecorder(calls, "invalidateDesktopStateSnapshot"),
    refreshLocalDashboardModel: callRecorder(calls, "refreshLocalDashboardModel"),
    renderDashboard: callRecorder(calls, "renderDashboard"),
    refreshDashboardWorktreeProjection: callRecorder(calls, "refreshDashboardWorktreeProjection"),
    noteLastUsedItem: callRecorder(calls, "noteLastUsedItem"),
    metadataServer: { notifyChange: callRecorder(calls, "metadataServer.notifyChange") },
    tmuxRuntimeManager: {
      listProjectManagedWindows: callRecorder(calls, "tmuxRuntimeManager.listProjectManagedWindows", () =>
        clone(input.managedWindows ?? []),
      ),
      killWindow: callRecorder(calls, "tmuxRuntimeManager.killWindow"),
    },
  };
  return { host, calls };
}

function snapshotTopology() {
  return {
    worktrees: topologyWorktrees.listTopologyWorktreeStates(),
    visibleGraveyard: topologyWorktrees.listTopologyWorktreeGraveyard(),
    allGraveyard: topologyWorktrees.listTopologyWorktreeGraveyard({ includeDeleted: true }),
    sessions: topologySessions.listTopologySessionStates(),
    services: topologyServices.listTopologyServiceStates(),
  };
}

function snapshotHost(host, calls) {
  return {
    offlineSessions: clone(host.offlineSessions ?? []),
    offlineServices: clone(host.offlineServices ?? []),
    footerFlash: host.footerFlash ?? null,
    footerFlashTicks: host.footerFlashTicks ?? null,
    calls,
  };
}

async function withFixture(label, fn) {
  const tmpRoot = mkdtempSync(join(tmpdir(), `aimux-persistence-worktrees-${label}-`));
  mkdirSync(join(tmpRoot, "repo"), { recursive: true });
  const projectRoot = realpathSync(join(tmpRoot, "repo"));
  const previousHome = process.env.AIMUX_HOME;
  process.env.AIMUX_HOME = join(tmpRoot, "home");
  try {
    gitInit(projectRoot);
    await paths.initPaths(projectRoot);
    return await fn({ tmpRoot, projectRoot, worktreeRoot: join(projectRoot, ".aimux", "worktrees") });
  } finally {
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function invoke(api, ctx, input) {
  const actualInput = denormalize(input, ctx);
  const { host, calls } = hostFor(actualInput);
  try {
    const returned = await persistenceMethods[api].call(host, actualInput.path);
    return normalize({ ok: true, returned, host: snapshotHost(host, calls), topology: snapshotTopology() }, ctx);
  } catch (error) {
    return normalize(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        host: snapshotHost(host, calls),
        topology: snapshotTopology(),
      },
      ctx,
    );
  }
}

async function record(cases, name, api, label, prepare) {
  await withFixture(label, async (ctx) => {
    const rawInput = await prepare(ctx);
    rawInput.initialTopology = snapshotTopology();
    rawInput.checkoutExists = existsSync(rawInput.path);
    const input = normalize(rawInput, ctx);
    const output = await invoke(api, ctx, input);
    cases.push({
      id: `multiplexer-persistence-worktrees-${String(cases.length + 1).padStart(3, "0")}`,
      name,
      source: "src/multiplexer/persistence-methods.test.ts",
      api,
      input,
      output,
      inputSha256: hash(input),
    });
  });
}

const cases = [];

await record(cases, "graveyards a worktree into topology", "graveyardDesktopWorktree", "graveyard", ({ projectRoot, worktreeRoot }) => {
  const worktreePath = join(worktreeRoot, "demo");
  topologySessions.upsertTopologySession({ id: "codex-demo", tool: "codex", command: "codex", args: [], worktreePath }, "offline");
  topologyServices.upsertTopologyService({ id: "service-demo", command: "zsh", worktreePath }, "stopped");
  return {
    projectRoot,
    path: worktreePath,
    worktrees: [{ name: "demo", branch: "demo", path: worktreePath, createdAt: "2026-05-01T00:00:00.000Z" }],
    sessions: [],
    sessionWorktreePaths: [],
    managedWindows: [],
  };
});

await record(
  cases,
  "stops live worktree services without deleting their topology records when graveyarding",
  "graveyardDesktopWorktree",
  "graveyard-services",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "demo");
    const target = { sessionName: "aimux-test", windowId: "@service", windowIndex: 1, windowName: "shell" };
    return {
      projectRoot,
      path: worktreePath,
      worktrees: [{ name: "demo", branch: "demo", path: worktreePath }],
      sessions: [],
      sessionWorktreePaths: [],
      offlineServices: [],
      managedWindows: [
        {
          target,
          metadata: {
            kind: "service",
            sessionId: "service-demo",
            command: "zsh",
            args: ["-l"],
            toolConfigKey: "service",
            createdAt: "2026-05-01T00:00:00.000Z",
            worktreePath,
            label: "shell",
            launchCommandLine: "yarn web",
          },
        },
      ],
    };
  },
);

await record(
  cases,
  "blocks graveyarding while a live agent is attached",
  "graveyardDesktopWorktree",
  "graveyard-live-agent",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "demo");
    return {
      projectRoot,
      path: worktreePath,
      worktrees: [{ name: "demo", branch: "demo", path: worktreePath }],
      sessions: [{ id: "codex-live", label: "Codex Live" }],
      liveSessionIds: ["codex-live"],
      sessionWorktreePaths: [["codex-live", worktreePath]],
      managedWindows: [],
    };
  },
);

await record(
  cases,
  "resurrects topology worktree graveyard entries",
  "resurrectGraveyardWorktree",
  "resurrect",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "demo");
    mkdirSync(worktreePath, { recursive: true });
    topologyWorktrees.upsertTopologyWorktree({ path: worktreePath, name: "demo", branch: "demo" }, "active");
    topologyWorktrees.moveTopologyWorktreeToGraveyard(worktreePath);
    return { projectRoot, path: worktreePath };
  },
);

await record(
  cases,
  "does not resurrect graveyarded worktrees when the checkout is missing",
  "resurrectGraveyardWorktree",
  "resurrect-missing",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "missing");
    topologyWorktrees.upsertTopologyWorktree({ path: worktreePath, name: "missing", branch: "missing" }, "active");
    topologyWorktrees.moveTopologyWorktreeToGraveyard(worktreePath);
    return { projectRoot, path: worktreePath };
  },
);

await record(
  cases,
  "deletes missing graveyarded worktree topology and dependent assets",
  "deleteGraveyardWorktree",
  "delete-missing",
  ({ projectRoot, worktreeRoot }) => {
    const worktreePath = join(worktreeRoot, "gone");
    topologyWorktrees.upsertTopologyWorktree({ path: worktreePath, name: "gone", branch: "gone" }, "active");
    topologySessions.upsertTopologySession({ id: "codex-gone", tool: "codex", command: "codex", args: [], worktreePath }, "offline");
    topologyServices.upsertTopologyService({ id: "service-gone", command: "zsh", worktreePath }, "stopped");
    topologyWorktrees.moveTopologyWorktreeToGraveyard(worktreePath);
    return {
      projectRoot,
      path: worktreePath,
      offlineSessions: [{ id: "codex-gone", worktreePath }],
      offlineServices: [{ id: "service-gone", worktreePath }],
    };
  },
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/persistence-methods.test.ts",
  generatedBy: "scripts/capture-multiplexer-persistence-worktrees-contract.mjs",
  description:
    "Multiplexer persistence worktree graveyard, resurrection, deletion, host side effects, and topology transitions captured by running TypeScript persistenceMethods against temp git repos and topology state.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
