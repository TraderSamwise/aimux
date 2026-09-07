#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/session-runtime-tmux-metadata-sync.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalize(value, repoRoot) {
  if (Array.isArray(value)) return value.map((entry) => normalize(entry, repoRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item, repoRoot)]));
  }
  return typeof value === "string" ? value.split(repoRoot).join("<REPO>") : value;
}

function objectFromMap(map) {
  return Object.fromEntries(Array.from(map.entries()));
}

async function runCase(input) {
  const root = mkdtempSync(join(tmpdir(), "aimux-session-runtime-sync-metadata-"));
  const repoRoot = join(root, "repo");
  const aimuxHome = join(root, "home");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(aimuxHome, { recursive: true });
  process.env.AIMUX_HOME = aimuxHome;

  const { initPaths, getProjectStateDir } = await import(new URL("dist/paths.js", ROOT));
  const { TmuxSessionTransport } = await import(new URL("dist/tmux/session-transport.js", ROOT));
  const { syncTmuxWindowMetadata, buildTmuxWindowMetadata } = await import(
    new URL("dist/multiplexer/session-runtime-core.js", ROOT)
  );

  await initPaths(repoRoot);
  process.chdir(repoRoot);
  const projectStateDir = getProjectStateDir();
  mkdirSync(projectStateDir, { recursive: true });
  writeFileSync(
    join(projectStateDir, "metadata.json"),
    `${JSON.stringify(input.metadata ?? { version: 1, sessions: {} })}\n`,
  );
  writeFileSync(
    join(projectStateDir, "last-used.json"),
    `${JSON.stringify(input.lastUsed ?? { version: 1, items: {}, clients: {}, projectRecentIds: [] })}\n`,
  );

  const calls = [];
  const fn = (method, impl) => (...args) => {
    calls.push({ method, args: normalize(args, repoRoot) });
    return impl?.(...args);
  };

  const previousSetInterval = global.setInterval;
  const previousClearInterval = global.clearInterval;
  global.setInterval = () => ({ unref() {} });
  global.clearInterval = () => {};

  try {
    const target = input.target ?? { sessionName: "aimux-test", windowId: "@1", windowIndex: 1 };
    let existingMetadata = input.existing ?? null;
    const manager = {
      getTargetByWindowId: fn("getTargetByWindowId", () => input.resolvedTarget ?? target),
      getWindowMetadata: fn("getWindowMetadata", () => existingMetadata),
      setWindowMetadata: fn("setWindowMetadata", (_target, metadata) => {
        existingMetadata = metadata;
      }),
      applyManagedAgentWindowPolicy: fn("applyManagedAgentWindowPolicy"),
    };
    const transport = new TmuxSessionTransport(input.sessionId, input.command ?? "codex", target, manager, 80, 24);
    const host = {
      projectRoot: repoRoot,
      sessions: [
        {
          id: input.sessionId,
          command: input.command ?? "codex",
          status: input.status ?? "running",
          backendSessionId: input.backendSessionId,
          startTime: input.startTime,
          transport,
          team: input.team,
        },
      ],
      sessionOriginalArgs: new Map(input.sessionOriginalArgs ?? []),
      sessionToolKeys: new Map(input.sessionToolKeys ?? []),
      sessionWorktreePaths: new Map((input.sessionWorktreePaths ?? []).map(([id, path]) => [id, path.replace("<REPO>", repoRoot)])),
      sessionRoles: new Map(input.sessionRoles ?? []),
      sessionLabels: new Map(input.sessionLabels ?? []),
      offlineSessions: input.offlineSessions ?? [],
      sessionTmuxTargets: new Map([[input.sessionId, target]]),
      tmuxRuntimeManager: manager,
    };
    const before = normalize(buildTmuxWindowMetadata(host, input.sessionId, input.command ?? "codex", input.existing ?? null), repoRoot);
    for (let index = 0; index < (input.syncCount ?? 1); index += 1) {
      syncTmuxWindowMetadata(host, input.sessionId);
    }
    transport.destroy();
    return {
      before,
      targetAfter: normalize(transport.tmuxTarget, repoRoot),
      sessionTmuxTargets: normalize(objectFromMap(host.sessionTmuxTargets), repoRoot),
      calls,
    };
  } finally {
    global.setInterval = previousSetInterval;
    global.clearInterval = previousClearInterval;
  }
}

const matchingMetadata = {
  kind: "agent",
  sessionId: "codex-1",
  command: "codex",
  args: ["--model", "gpt-5"],
  toolConfigKey: "codex",
  backendSessionId: "backend-1",
  overseer: false,
  scribe: false,
  projectControl: false,
  label: "Porter",
  userLabel: "ready",
  createdAt: "2026-09-05T10:00:00.000Z",
};

const casesInput = [
  {
    name: "unchanged metadata skips set but applies window policy once",
    input: {
      sessionId: "codex-1",
      command: "codex",
      backendSessionId: "backend-1",
      startTime: Date.parse("2026-09-05T10:00:00.000Z"),
      sessionOriginalArgs: [["codex-1", ["--model", "gpt-5"]]],
      sessionToolKeys: [["codex-1", "codex"]],
      sessionLabels: [["codex-1", "Porter"]],
      existing: matchingMetadata,
    },
  },
  {
    name: "changed metadata is written before policy is applied",
    input: {
      sessionId: "codex-2",
      command: "codex",
      backendSessionId: "backend-2",
      startTime: Date.parse("2026-09-05T10:00:00.000Z"),
      sessionToolKeys: [["codex-2", "codex-gpt5"]],
      sessionRoles: [["codex-2", "coder"]],
      metadata: {
        version: 1,
        sessions: {
          "codex-2": {
            derived: { activity: "waiting", attention: "needs_input", unseenCount: 2 },
            status: { text: "Waiting for input" },
          },
        },
      },
      existing: { kind: "agent", sessionId: "codex-2", command: "codex", createdAt: "2026-09-05T10:00:00.000Z" },
    },
  },
  {
    name: "two unchanged syncs on one window only apply policy once",
    input: {
      sessionId: "codex-3",
      command: "codex",
      startTime: Date.parse("2026-09-05T10:00:00.000Z"),
      target: { sessionName: "aimux-test", windowId: "@policy-once", windowIndex: 5 },
      resolvedTarget: { sessionName: "aimux-test", windowId: "@policy-once", windowIndex: 6 },
      existing: {
        kind: "agent",
        sessionId: "codex-3",
        command: "codex",
        args: [],
        toolConfigKey: "codex",
        overseer: false,
        scribe: false,
        projectControl: false,
        userLabel: "ready",
        createdAt: "2026-09-05T10:00:00.000Z",
      },
      syncCount: 2,
    },
  },
];

const cases = [];
for (const [index, entry] of casesInput.entries()) {
  const input = JSON.parse(JSON.stringify(entry.input));
  cases.push({
    id: `session-runtime-tmux-metadata-sync-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/session-runtime-core.ts",
    api: "syncTmuxWindowMetadata",
    input,
    output: await runCase(input),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/session-runtime-core.ts",
  generatedBy: "scripts/capture-session-runtime-tmux-metadata-sync-contract.mjs",
  description:
    "Session-runtime tmux metadata sync write-skipping and managed window policy behavior captured by running TypeScript syncTmuxWindowMetadata.",
  cases,
});
