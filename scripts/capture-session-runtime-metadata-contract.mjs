#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/session-runtime-metadata.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalize(value, repoRoot) {
  return JSON.parse(JSON.stringify(value).split(repoRoot).join("<REPO>"));
}

function mapFromObject(value = {}) {
  return new Map(Object.entries(value));
}

async function runCase(input) {
  const root = mkdtempSync(join(tmpdir(), "aimux-session-runtime-metadata-"));
  const repoRoot = join(root, "repo");
  const aimuxHome = join(root, "home");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(aimuxHome, { recursive: true });
  process.env.AIMUX_HOME = aimuxHome;

  const { initPaths, getProjectStateDir } = await import(new URL("dist/paths.js", ROOT));
  const { addNotification } = await import(new URL("dist/notifications.js", ROOT));
  const { buildTmuxWindowMetadata } = await import(new URL("dist/multiplexer/session-runtime-core.js", ROOT));

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
  for (const notification of input.notifications ?? []) {
    addNotification({ ...notification, projectRoot: repoRoot });
  }

  const host = {
    projectRoot: repoRoot,
    sessions: input.host.sessions ?? [],
    offlineSessions: input.host.offlineSessions ?? [],
    sessionOriginalArgs: mapFromObject(input.host.sessionOriginalArgs),
    sessionToolKeys: mapFromObject(input.host.sessionToolKeys),
    sessionWorktreePaths: mapFromObject(
      Object.fromEntries(
        Object.entries(input.host.sessionWorktreePaths ?? {}).map(([key, value]) => [
          key,
          typeof value === "string" ? value.replace("<REPO>", repoRoot) : value,
        ]),
      ),
    ),
    sessionRoles: mapFromObject(input.host.sessionRoles),
    sessionLabels: mapFromObject(input.host.sessionLabels),
  };

  return normalize(buildTmuxWindowMetadata(host, input.sessionId, input.command, input.existing ?? null), repoRoot);
}

const inputs = [
  {
    name: "projects live runtime metadata from host maps and derived output",
    input: {
      sessionId: "codex-1",
      command: "codex",
      host: {
        sessions: [{ id: "codex-1", command: "codex", status: "running", backendSessionId: "backend-1" }],
        sessionOriginalArgs: { "codex-1": ["--model", "gpt-5"] },
        sessionToolKeys: { "codex-1": "codex-gpt5" },
        sessionWorktreePaths: { "codex-1": "<REPO>/.aimux/worktrees/rust" },
        sessionRoles: { "codex-1": "coder" },
        sessionLabels: { "codex-1": "Porter" },
      },
      metadata: {
        version: 1,
        sessions: {
          "codex-1": {
            status: { text: "Editing files" },
            derived: {
              activity: "running",
              attention: "normal",
              unseenCount: 3,
              lastOutputAt: "2026-09-05T10:00:00.000Z",
            },
          },
        },
      },
    },
  },
  {
    name: "anchors needs-input recency to latest unread notification",
    input: {
      sessionId: "claude-1",
      command: "claude",
      host: {
        sessions: [{ id: "claude-1", command: "claude", status: "idle" }],
        offlineSessions: [{ id: "claude-1", label: "Offline fallback" }],
      },
      metadata: {
        version: 1,
        sessions: {
          "claude-1": {
            derived: {
              activity: "waiting",
              attention: "needs_input",
              unseenCount: 2,
              becameIdleAt: "2026-09-05T09:00:00.000Z",
              lastOutputAt: "2026-09-05T09:30:00.000Z",
            },
          },
        },
      },
      lastUsed: {
        version: 1,
        items: { "claude-1": { lastUsedAt: "2026-09-05T08:00:00.000Z" } },
        clients: {},
        projectRecentIds: ["claude-1"],
      },
      notifications: [
        {
          title: "Older prompt",
          body: "old",
          sessionId: "claude-1",
          kind: "needs_input",
          createdAt: "2026-09-05T09:45:00.000Z",
        },
        {
          title: "New prompt",
          body: "new",
          sessionId: "claude-1",
          kind: "needs_input",
          createdAt: "2026-09-05T10:15:00.000Z",
        },
      ],
    },
  },
  {
    name: "uses existing team and offline label when runtime is absent",
    input: {
      sessionId: "scribe-1",
      command: "claude",
      existing: { team: { teamId: "scribe", parentSessionId: "", role: "scribe" } },
      host: {
        sessions: [],
        offlineSessions: [{ id: "scribe-1", label: "Scribe" }],
      },
      metadata: {
        version: 1,
        sessions: {
          "scribe-1": {
            derived: {
              activity: "idle",
              attention: "normal",
              becameIdleAt: "2026-09-05T07:00:00.000Z",
            },
          },
        },
      },
      lastUsed: {
        version: 1,
        items: { "scribe-1": { lastUsedAt: "2026-09-05T06:30:00.000Z" } },
        clients: {},
        projectRecentIds: ["scribe-1"],
      },
    },
  },
  {
    name: "explicit scribe false disables project-control despite scribe team",
    input: {
      sessionId: "manual-1",
      command: "codex",
      existing: { team: { teamId: "scribe", parentSessionId: "", role: "scribe" } },
      host: {
        sessions: [],
        offlineSessions: [],
        sessionToolKeys: { "manual-1": "codex" },
      },
      metadata: {
        version: 1,
        sessions: {
          "manual-1": {
            scribe: false,
            derived: {
              activity: "done",
              attention: "normal",
              becameIdleAt: "2026-09-05T11:00:00.000Z",
            },
          },
        },
      },
    },
  },
];

const cases = [];
for (const [index, entry] of inputs.entries()) {
  const output = await runCase(entry.input);
  cases.push({
    id: `session-runtime-metadata-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/session-runtime-core.ts",
    api: "buildTmuxWindowMetadata",
    input: entry.input,
    output,
    inputSha256: hash(entry.input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/session-runtime-core.ts",
  generatedBy: "scripts/capture-session-runtime-metadata-contract.mjs",
  description: "buildTmuxWindowMetadata parity captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
