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
const worker = await import(new URL("dist/expose-hot-snapshot-worker.js", ROOT));

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
