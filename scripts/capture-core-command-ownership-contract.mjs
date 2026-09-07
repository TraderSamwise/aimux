#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/core-command/ownership.json", ROOT);
const { isCoreCliCommand } = await import(new URL("dist/core-cli-routing.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const installedShimFastPaths = [
  { command: "input <sessionId> <text>", shimNeedle: "/core/agents/input-text" },
  { command: "ps", shimNeedle: "/core/agents/ps-text" },
  { command: "rename <sessionId>", shimNeedle: "/core/agents/rename-text" },
  { command: "migrate <sessionId>", shimNeedle: "/core/agents/migrate-text" },
  { command: "spawn", shimNeedle: "/core/lifecycle/spawn-text" },
  { command: "stop <sessionId>", shimNeedle: "/core/lifecycle/stop-text" },
  { command: "kill <sessionId>", shimNeedle: "/core/lifecycle/kill-text" },
  { command: "fork <sourceSessionId>", shimNeedle: "/core/lifecycle/fork-text" },
  { command: "loop add <sessionId>", shimNeedle: "/core/loop/add-text" },
  { command: "loop remove <sessionId>", shimNeedle: "/core/loop/remove-text" },
  { command: "loop done", shimNeedle: "/core/loop/done-text" },
  { command: "loop block", shimNeedle: "/core/loop/block-text" },
  { command: "overseer start", shimNeedle: "/core/overseer/start-text" },
  { command: "overseer clear <sessionId>", shimNeedle: "/core/overseer/clear-text" },
  { command: "team show", shimNeedle: "/core/team/show-text" },
  { command: "team init", shimNeedle: "/core/team/init-text" },
  { command: "team add <role>", shimNeedle: "/core/team/add-text" },
  { command: "team remove <role>", shimNeedle: "/core/team/remove-text" },
  { command: "team default <role>", shimNeedle: "/core/team/default-text" },
  { command: "doctor versions", shimNeedle: "/core/doctor/versions-text" },
  { command: "doctor disk", shimNeedle: "/core/doctor/disk-text" },
  { command: "doctor exchange", shimNeedle: "/core/doctor/exchange-text" },
  { command: "doctor lifecycle", shimNeedle: "/core/doctor/lifecycle-text" },
  { command: "doctor tmux", shimNeedle: "/core/doctor/tmux-text" },
  { command: "logs path", shimNeedle: "/core/logs/path-text" },
  { command: "logs tail", shimNeedle: "/core/logs/tail-text" },
  { command: "logs clear", shimNeedle: "/core/logs/clear-text" },
  { command: "metadata ...", shimNeedle: "/core/metadata-text" },
  { command: "repair", shimNeedle: "/core/repair-text" },
  { command: "dashboard-reload", shimNeedle: "/core/dashboard-reload-text" },
  { command: "restart-runtime", shimNeedle: "/core/runtime-restart-text" },
  { command: "serve", shimNeedle: "/core/project-serve-text" },
  { command: "worktree", shimNeedle: "/core/worktree/list-text" },
  { command: "worktree list", shimNeedle: "/core/worktree/list-text" },
  { command: "worktree create <name>", shimNeedle: "/core/worktree/create-text" },
  { command: "worktree cleanup-caches", shimNeedle: "/core/worktree/cache-cleanup-text" },
  { command: "worktree remove <path>", shimNeedle: "/core/worktree/remove-text" },
  { command: "worktree graveyard <path>", shimNeedle: "/core/worktree/graveyard-text" },
  { command: "worktree resurrect <path>", shimNeedle: "/core/worktree/resurrect-text" },
  { command: "worktree delete-graveyard <path>", shimNeedle: "/core/worktree/delete-graveyard-text" },
  { command: "graveyard list", shimNeedle: "/core/graveyard/list-text" },
  { command: "graveyard send <id>", shimNeedle: "/core/graveyard/send-text" },
  { command: "graveyard resurrect <id>", shimNeedle: "/core/graveyard/resurrect-text" },
  { command: "graveyard cleanup", shimNeedle: "/core/graveyard/cleanup-text" },
  { command: "threads", shimNeedle: "/core/threads/list-text" },
  { command: "thread list", shimNeedle: "/core/thread/list-text" },
  { command: "thread show <threadId>", shimNeedle: "/core/thread/show-text" },
  { command: "thread open", shimNeedle: "/core/thread/open-text" },
  { command: "thread send <threadId> <body>", shimNeedle: "/core/thread/send-text" },
  { command: "thread mark-seen <threadId>", shimNeedle: "/core/thread/mark-seen-text" },
  { command: "thread status <threadId>", shimNeedle: "/core/thread/status-text" },
  { command: "message send <body>", shimNeedle: "/core/message/send-text" },
  { command: "notify", shimNeedle: "/core/notifications/send-text" },
  { command: "list-notifications", shimNeedle: "/core/notifications/list-text" },
  { command: "read-notifications", shimNeedle: "/core/notifications/read-text" },
  { command: "clear-notifications", shimNeedle: "/core/notifications/clear-text" },
  { command: "handoff send <body>", shimNeedle: "/core/handoff/send-text" },
  { command: "handoff accept <threadId>", shimNeedle: "/core/handoff/accept-text" },
  { command: "handoff complete <threadId>", shimNeedle: "/core/handoff/complete-text" },
  { command: "task list", shimNeedle: "/core/task/list-text" },
  { command: "task show <taskId>", shimNeedle: "/core/task/show-text" },
  { command: "task assign <description>", shimNeedle: "/core/task/assign-text" },
  { command: "task accept <taskId>", shimNeedle: "/core/task/accept-text" },
  { command: "task block <taskId>", shimNeedle: "/core/task/block-text" },
  { command: "task complete <taskId>", shimNeedle: "/core/task/complete-text" },
  { command: "task reopen <taskId>", shimNeedle: "/core/task/reopen-text" },
  { command: "review approve <taskId>", shimNeedle: "/core/review/approve-text" },
  { command: "review request-changes <taskId>", shimNeedle: "/core/review/request-changes-text" },
  { command: "host agent-read <sessionId>", shimNeedle: "/core/host-agent-read-text" },
  { command: "host agent-stream <sessionId>", shimNeedle: "/core/host-agent-stream-text" },
  { command: "host stop", shimNeedle: "/core/project-stop-text" },
  { command: "host kill", shimNeedle: "/core/project-kill-text" },
  { command: "host restart", shimNeedle: "/core/project-restart-text" },
];

const coreCommandDispositions = [
  ["daemon ensure", ["daemon", "ensure"]],
  ["daemon ensure --json", ["daemon", "ensure", "--json"]],
  ["daemon status", ["daemon", "status"]],
  ["daemon status --json", ["daemon", "status", "--json"]],
  ["daemon projects", ["daemon", "projects"]],
  ["daemon projects --json", ["daemon", "projects", "--json"]],
  ["projects list", ["projects", "list"]],
  ["projects list --json", ["projects", "list", "--json"]],
  ["host status", ["host", "status"]],
  ["host status --json", ["host", "status", "--json"]],
  ["logs path", ["logs", "path"]],
  ["logs tail", ["logs", "tail", "--project", "/tmp/project", "--lines", "100"]],
  ["logs clear", ["logs", "clear", "--daemon"]],
  ["daemon project-ensure", ["daemon", "project-ensure", "--project", "/tmp/project"]],
  ["daemon project-ensure --json", ["daemon", "project-ensure", "--project", "/tmp/project", "--json"]],
  ["daemon restart", ["daemon", "restart"]],
  ["daemon restart --json", ["daemon", "restart", "--json"]],
  ["serve", ["serve"]],
  ["dashboard-reload", ["dashboard-reload"]],
  ["dashboard-reload --open", ["dashboard-reload", "--open"]],
  ["dashboard-reload --open --client-tty", ["dashboard-reload", "--open", "--client-tty", "/dev/ttys001"]],
  [
    "dashboard-reload --open --current-client-session",
    ["dashboard-reload", "--open", "--current-client-session=aimux-repo-client-1234abcd"],
  ],
  ["restart-runtime", ["restart-runtime"]],
  ["restart-runtime --json", ["restart-runtime", "--json"]],
  ["restart-runtime --open --client-tty", ["restart-runtime", "--open", "--client-tty", "/dev/ttys001"]],
  [
    "restart-runtime --project-root --current-client-session",
    ["restart-runtime", "--project-root=/tmp/project", "--current-client-session=aimux-repo-client-1234abcd"],
  ],
  ["host stop", ["host", "stop"]],
  ["host kill", ["host", "kill"]],
  ["host restart", ["host", "restart"]],
  ["host restart --serve", ["host", "restart", "--serve"]],
  ["host restart --open", ["host", "restart", "--open"]],
  ["remote status", ["remote", "status"]],
  ["remote status --json", ["remote", "status", "--json"]],
  ["remote enable", ["remote", "enable"]],
  ["remote disable", ["remote", "disable"]],
  ["whoami", ["whoami"]],
  ["whoami --json", ["whoami", "--json"]],
  ["logout", ["logout"]],
  ["login", ["login"]],
  ["security unlock", ["security", "unlock"]],
].map(([command, args]) => ({ command, args, disposition: "shim-fast-path" }));

const invalidProbes = [
  ["restart-runtime", "--open", "--json"],
  ["dashboard-reload", "--client-tty=-x"],
  ["dashboard-reload", "--current-client-session=-x"],
  ["restart-runtime", "--project-root=-x"],
  ["restart-runtime", "--client-tty=-x"],
  ["restart-runtime", "--current-client-session=-x"],
];

function record(id, name, input, output) {
  return {
    id,
    name,
    source: "src/core-command-ownership.test.ts",
    input,
    output,
    inputSha256: hash(input),
  };
}

const shim = readFileSync(join(ROOT.pathname, "scripts", "installed-aimux-shim.sh"), "utf8");
const cases = [
  record(
    "core-command-ownership-001",
    "classifies every routed core command used by the installed CLI",
    { api: "isCoreCliCommand", commands: coreCommandDispositions, invalidProbes },
    {
      commands: coreCommandDispositions.map((entry) => entry.command),
      classifications: coreCommandDispositions.map((entry) => ({
        command: entry.command,
        args: entry.args,
        isCoreCliCommand: isCoreCliCommand(entry.args),
      })),
      invalidClassifications: invalidProbes.map((args) => ({ args, isCoreCliCommand: isCoreCliCommand(args) })),
    },
  ),
  record(
    "core-command-ownership-002",
    "keeps retired installed shell routes out of the native dispatch shim",
    { api: "installedShimFastPaths", fastPaths: installedShimFastPaths },
    {
      containsAimuxNodeBin: shim.includes("AIMUX_NODE_BIN"),
      presentNeedles: installedShimFastPaths.filter((entry) => shim.includes(entry.shimNeedle)).map((entry) => entry.command),
    },
  ),
  record(
    "core-command-ownership-003",
    "keeps the core-routable Node fallback backlog explicit",
    { api: "nodeCoreFallbackBacklog", commands: coreCommandDispositions },
    {
      backlog: coreCommandDispositions
        .filter((entry) => entry.disposition === "node-core-fallback")
        .map((entry) => entry.command),
    },
  ),
];

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-core-command-ownership-contract.mjs",
  source: "src/core-command-ownership.test.ts",
  sources: ["src/core-command-ownership.test.ts", "src/core-cli-routing.ts", "scripts/installed-aimux-shim.sh"],
  description: "Core command ownership and installed-shim dispatch inventory captured by running TypeScript routing helpers.",
  caseCount: cases.length,
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
