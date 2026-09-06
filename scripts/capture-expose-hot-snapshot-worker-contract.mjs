#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/expose-hot-snapshot-worker.json", ROOT);
const hot = await import(new URL("dist/tmux/expose-hot-snapshot.js", ROOT));
const paths = await import(new URL("dist/paths.js", ROOT));
const worker = await import(new URL("dist/expose-hot-snapshot-worker.js", ROOT));
const runtimeManager = await import(new URL("dist/tmux/runtime-manager.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const item = (id, windowId, over = {}) => ({
  id,
  label: id,
  urgency: 0,
  activity: 0,
  recentRank: 0,
  target: { sessionName: "aimux-test", windowId, windowIndex: 1, windowName: id },
  metadata: { kind: "agent", sessionId: id, command: "codex", worktreePath: "/repo" },
  previewSnapshot: {
    output: `${id} preview\n`,
    capturedAt: "2026-07-20T13:00:00.000Z",
    source: "tap",
    windowId,
    startLine: -40,
    lineCount: 40,
  },
  ...over,
});

const project = (id, path, over = {}) => ({ id, name: basename(path), path, serviceAlive: true, ...over });
const stateDir = (home, id) => join(home, "projects", id);
const normalize = (value) =>
  JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "string") return nested;
      return nested.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z/g, "<iso>");
    }),
  );

function snapshot(home, id, key) {
  return normalize(hot.readHotExposeScopeView(stateDir(home, id), key));
}

function writeProjectSnapshot(home, projectRecord, items) {
  const projectRoot = resolve(projectRecord.path);
  hot.writeHotExposeScopeView(
    stateDir(home, projectRecord.id),
    { projectRoot, scope: "project" },
    {
      scope: "project",
      scopeLabel: "all worktrees",
      sublabel: "worktree",
      items,
    },
  );
}

const managedWindow = (id, windowId, windowIndex, over = {}) => ({
  target: {
    sessionName: "aimux-test",
    windowId,
    windowIndex,
    windowName: id,
    paneDead: false,
  },
  metadata: {
    kind: "agent",
    sessionId: id,
    command: "codex",
    args: [],
    toolConfigKey: "codex",
    worktreePath: "/repo",
    ...over.metadata,
  },
});

function withMockedRuntime(managedWindows, fn) {
  const proto = runtimeManager.TmuxRuntimeManager.prototype;
  const original = {
    getProjectSession: proto.getProjectSession,
    listManagedWindows: proto.listManagedWindows,
    listProjectManagedWindows: proto.listProjectManagedWindows,
    listSessionNames: proto.listSessionNames,
    listWindows: proto.listWindows,
    isWindowAlive: proto.isWindowAlive,
    captureTarget: proto.captureTarget,
  };
  const captureCalls = [];
  proto.getProjectSession = () => ({ sessionName: "aimux-test" });
  proto.listManagedWindows = () => managedWindows;
  proto.listProjectManagedWindows = () => managedWindows;
  proto.listSessionNames = () => ["aimux-test"];
  proto.listWindows = () =>
    managedWindows.map(({ target }) => ({
      id: target.windowId,
      index: target.windowIndex,
      name: target.windowName,
      active: target.windowId === "@1" || target.windowId === "@11",
      activity: target.windowIndex,
      paneDead: target.paneDead,
    }));
  proto.isWindowAlive = (target) => target.paneDead !== true;
  proto.captureTarget = (target) => {
    captureCalls.push(target.windowId);
    return `${target.windowId} captured preview\n`;
  };
  try {
    return fn(captureCalls);
  } finally {
    Object.assign(proto, original);
  }
}

const cases = [];
function record(name, setup, action) {
  const home = mkdtempSync(join(tmpdir(), "aimux-expose-hot-snapshot-worker-contract-"));
  const previousHome = process.env.AIMUX_HOME;
  process.env.AIMUX_HOME = home;
  const projects = setup(home);
  const input = { name, projects };
  const output = action(home, projects);
  if (previousHome === undefined) delete process.env.AIMUX_HOME;
  else process.env.AIMUX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  cases.push({
    id: `tmux-expose-hot-snapshot-worker-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/expose-hot-snapshot-worker.ts",
    api: "global hot snapshot worker helpers",
    input,
    output: normalize(output),
    inputSha256: hash(input),
  });
}

function recordProject(name, setup, action) {
  const home = mkdtempSync(join(tmpdir(), "aimux-expose-hot-snapshot-worker-contract-"));
  const previousHome = process.env.AIMUX_HOME;
  process.env.AIMUX_HOME = home;
  const input = setup(home);
  const output = action(home, input);
  if (previousHome === undefined) delete process.env.AIMUX_HOME;
  else process.env.AIMUX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  const normalizedInput = normalize({ name, ...input });
  cases.push({
    id: `tmux-expose-hot-snapshot-worker-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/expose-hot-snapshot-worker.ts",
    api: "project hot snapshot worker helper",
    input: normalizedInput,
    output: normalize(output),
    inputSha256: hash(normalizedInput),
  });
}

record(
  "builds global view from project hot snapshots",
  (home) => {
    const projects = [project("proj-a", "/repo/a"), project("proj-b", "/repo/b")];
    writeProjectSnapshot(home, projects[0], [item("agent-a", "@1")]);
    return projects;
  },
  (_home, projects) => ({ view: worker.buildGlobalExposeHotSnapshotView(projects) }),
);

record(
  "mirrors active project snapshots into every active project global cache",
  (home) => {
    const projects = [
      project("proj-a", "/repo/a"),
      project("proj-b", "/repo/b", { serviceAlive: false }),
      project("proj-c", "/repo/c"),
    ];
    writeProjectSnapshot(home, projects[0], [item("agent-a", "@1")]);
    writeProjectSnapshot(home, projects[1], [item("agent-b", "@2")]);
    return projects;
  },
  (home, projects) => {
    worker.refreshGlobalExposeHotSnapshots(projects);
    return {
      projA: snapshot(home, "proj-a", { projectRoot: "/repo/a", scope: "global" }),
      projB: snapshot(home, "proj-b", { projectRoot: "/repo/b", scope: "global" }),
      projC: snapshot(home, "proj-c", { projectRoot: "/repo/c", scope: "global" }),
    };
  },
);

record(
  "clears active global caches when no project snapshots remain",
  (home) => {
    const projects = [project("proj-a", "/repo/a")];
    mkdirSync(stateDir(home, "proj-a"), { recursive: true });
    hot.writeHotExposeScopeView(
      stateDir(home, "proj-a"),
      { projectRoot: "/repo/a", scope: "global" },
      {
        scope: "global",
        scopeLabel: "all projects",
        sublabel: "project-worktree",
        items: [item("stale-agent", "@9")],
      },
    );
    return projects;
  },
  (home, projects) => {
    const beforeExists = existsSync(join(stateDir(home, "proj-a"), "expose-hot-snapshots.json"));
    worker.refreshGlobalExposeHotSnapshots(projects);
    return {
      beforeExists,
      afterExists: existsSync(join(stateDir(home, "proj-a"), "expose-hot-snapshots.json")),
      global: snapshot(home, "proj-a", { projectRoot: "/repo/a", scope: "global" }),
    };
  },
);

recordProject(
  "refreshes project and launch-context hot snapshots",
  () => {
    const projectRoot = "/repo";
    const managedWindows = [managedWindow("agent-1", "@11", 1), managedWindow("agent-2", "@12", 2)];
    hot.writeHotExposeScopeView(
      paths.getProjectStateDirFor(projectRoot),
      { projectRoot, scope: "worktree", worktreeKey: projectRoot, launchWindowId: "@99" },
      {
        scope: "worktree",
        scopeLabel: "this worktree",
        sublabel: "none",
        items: [item("stale-agent", "@99")],
      },
    );
    return { projectRoot, managedWindows };
  },
  (_home, { projectRoot, managedWindows }) =>
    withMockedRuntime(managedWindows, (captureCalls) => {
      worker.refreshProjectExposeHotSnapshots(projectRoot);
      const dir = paths.getProjectStateDirFor(projectRoot);
      return {
        project: normalize(hot.readHotExposeScopeView(dir, { projectRoot, scope: "project" })),
        worktree11: normalize(
          hot.readHotExposeScopeView(dir, {
            projectRoot,
            scope: "worktree",
            worktreeKey: projectRoot,
            launchWindowId: "@11",
          }),
        ),
        worktree12: normalize(
          hot.readHotExposeScopeView(dir, {
            projectRoot,
            scope: "worktree",
            worktreeKey: projectRoot,
            launchWindowId: "@12",
          }),
        ),
        stale99: hot.readHotExposeScopeView(dir, {
          projectRoot,
          scope: "worktree",
          worktreeKey: projectRoot,
          launchWindowId: "@99",
        }),
        captureCalls,
      };
    }),
);

recordProject(
  "keeps live worktree expose snapshots outside the refresh cap",
  () => {
    const projectRoot = "/repo";
    const managedWindows = Array.from({ length: 7 }, (_, index) => {
      const number = index + 1;
      return managedWindow(`agent-${number}`, `@${number}`, number);
    });
    const dir = paths.getProjectStateDirFor(projectRoot);
    hot.writeHotExposeScopeView(
      dir,
      { projectRoot, scope: "worktree", worktreeKey: projectRoot, launchWindowId: "@7" },
      {
        scope: "worktree",
        scopeLabel: "this worktree",
        sublabel: "none",
        items: [item("agent-7", "@7")],
      },
    );
    return { projectRoot, managedWindows };
  },
  (_home, { projectRoot, managedWindows }) =>
    withMockedRuntime(managedWindows, (captureCalls) => {
      worker.refreshProjectExposeHotSnapshots(projectRoot);
      const dir = paths.getProjectStateDirFor(projectRoot);
      return {
        worktree7: normalize(
          hot.readHotExposeScopeView(dir, {
            projectRoot,
            scope: "worktree",
            worktreeKey: projectRoot,
            launchWindowId: "@7",
          }),
        ),
        captureCalls,
      };
    }),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-06T00:00:00.000Z",
  generatedBy: "scripts/capture-expose-hot-snapshot-worker-contract.mjs",
  source: "src/expose-hot-snapshot-worker.ts",
  subject: "global expose hot snapshot worker helpers",
  description: "Global Expose hot snapshot aggregation and mirroring captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
