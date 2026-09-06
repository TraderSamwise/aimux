#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("src/multiplexer/dashboard-session-details.contract.v1.json", ROOT);
const { renderSessionDetails } = await import(new URL("dist/multiplexer/dashboard-ops.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function runInput(input) {
  return { lines: renderSessionDetails({}, input.session, input.width, input.height) };
}

const cases = [];

function record(name, input) {
  const fullInput = { name, ...input };
  cases.push({
    id: `dashboard-session-details-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/multiplexer/dashboard-ops.ts",
    api: "renderSessionDetails",
    input: fullInput,
    output: runInput(input),
    inputSha256: hash(fullInput),
  });
}

record("empty selection renders blank fixed height", {
  width: 32,
  height: 4,
  session: null,
});

record("minimal session renders identity", {
  width: 44,
  height: 8,
  session: {
    id: "codex-1234",
    command: "codex",
  },
});

record("rich session renders all detail groups", {
  width: 56,
  height: 22,
  session: {
    id: "claude-main",
    command: "claude",
    toolConfigKey: "claude-opus",
    label: "Research lead",
    backendSessionId: "backend-abc",
    worktreeName: "feature/native",
    worktreeBranch: "feature/native",
    cwd: "/repo/.aimux/worktrees/native",
    prNumber: 42,
    prTitle: "Port dashboard details to Rust",
    prUrl: "https://github.com/example/aimux/pull/42",
    repoOwner: "example",
    repoName: "aimux",
    repoRemote: "git@github.com:example/aimux.git",
    semantic: {
      presentation: { statusLabel: "needs input" },
      user: { attention: "high" },
      notifications: { unreadCount: 3, latestText: "Review fixture deltas before commit" },
      activityNewCount: 2,
    },
    lastEvent: { message: "Waiting on tmux capture output" },
    threadName: "Dashboard rewrite",
    threadUnreadCount: 4,
    threadWaitingOnMeCount: 1,
    threadWaitingOnThemCount: 2,
    threadPendingCount: 3,
    services: [{ url: "http://localhost:3000" }, { port: 5173 }],
  },
});

record("narrow width wraps and truncates long words", {
  width: 16,
  height: 18,
  session: {
    id: "aider-very-long-session-id",
    command: "aider",
    label: "Aider with a deliberately long display label",
    toolConfigKey: "aider-pro",
    backendSessionId: "backend-with-a-very-long-unbroken-token",
    semantic: {
      presentation: { statusLabel: "working through the migration queue" },
      user: { attention: "none" },
      notifications: { unreadCount: 12, latestText: "supercalifragilisticexpialidocious" },
      activityNewCount: 9,
    },
  },
});

record("tiny width uses hard truncation", {
  width: 6,
  height: 8,
  session: {
    id: "shell-1",
    command: "shell",
    label: "Tiny Width",
  },
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-dashboard-session-details-contract.mjs",
  source: "src/multiplexer/dashboard-ops.ts",
  subject: "renderSessionDetails",
  description: "Dashboard session details rendering captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
