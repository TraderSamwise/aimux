import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCoreCliCommand } from "./core-cli-routing.js";

type Disposition = "shim-fast-path" | "node-core-fallback";

const inventoryPath = join(process.cwd(), "docs", "command-ownership-inventory.md");
const allowedInventoryStatuses = new Set(["CUT", "SIDECAR", "BOOTSTRAP", "TMUX", "INTERNAL"]);

const installedShimFastPaths: Array<{ command: string; shimNeedle: string }> = [
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
  { command: "doctor tmux", shimNeedle: "/core/doctor/tmux-text" },
  { command: "logs path", shimNeedle: "/core/logs/path-text" },
  { command: "logs tail", shimNeedle: "/core/logs/tail-text" },
  { command: "logs clear", shimNeedle: "/core/logs/clear-text" },
  { command: "metadata ...", shimNeedle: "/core/metadata-text" },
  { command: "repair", shimNeedle: "/core/repair-text" },
  { command: "restart", shimNeedle: "/core/restart-text" },
  { command: "serve", shimNeedle: "/core/project-serve-text" },
  { command: "worktree", shimNeedle: "/core/worktree/list-text" },
  { command: "worktree list", shimNeedle: "/core/worktree/list-text" },
  { command: "worktree create <name>", shimNeedle: "/core/worktree/create-text" },
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

const coreCommandDispositions: Array<{
  command: string;
  args: string[];
  disposition: Disposition;
  shimNeedle?: string;
}> = [
  {
    command: "daemon ensure",
    args: ["daemon", "ensure"],
    disposition: "shim-fast-path",
    shimNeedle: "aimux_try_daemon_ensure",
  },
  {
    command: "daemon ensure --json",
    args: ["daemon", "ensure", "--json"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/daemon-ensure-text?json=1",
  },
  {
    command: "daemon status",
    args: ["daemon", "status"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/daemon-status-text",
  },
  {
    command: "daemon status --json",
    args: ["daemon", "status", "--json"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/daemon-status-text?json=1",
  },
  {
    command: "daemon projects",
    args: ["daemon", "projects"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/daemon-projects-text",
  },
  {
    command: "daemon projects --json",
    args: ["daemon", "projects", "--json"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/daemon-projects-text?json=1",
  },
  {
    command: "projects list",
    args: ["projects", "list"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/projects-list-text",
  },
  {
    command: "projects list --json",
    args: ["projects", "list", "--json"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/projects-list-text?json=1",
  },
  {
    command: "host status",
    args: ["host", "status"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/host-status-text",
  },
  {
    command: "host status --json",
    args: ["host", "status", "--json"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/host-status-text?json=1",
  },
  {
    command: "logs path",
    args: ["logs", "path"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/logs/path-text",
  },
  {
    command: "logs tail",
    args: ["logs", "tail", "--project", "/tmp/project", "--lines", "100"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/logs/tail-text",
  },
  {
    command: "logs clear",
    args: ["logs", "clear", "--daemon"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/logs/clear-text",
  },
  {
    command: "daemon project-ensure",
    args: ["daemon", "project-ensure", "--project", "/tmp/project"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/project-ensure-text",
  },
  {
    command: "daemon project-ensure --json",
    args: ["daemon", "project-ensure", "--project", "/tmp/project", "--json"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/project-ensure-text?json=1",
  },
  {
    command: "daemon restart",
    args: ["daemon", "restart"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/restart-text",
  },
  {
    command: "daemon restart --json",
    args: ["daemon", "restart", "--json"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/restart-text?json=1",
  },
  {
    command: "serve",
    args: ["serve"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/project-serve-text",
  },
  {
    command: "host stop",
    args: ["host", "stop"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/project-stop-text",
  },
  {
    command: "host kill",
    args: ["host", "kill"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/project-kill-text",
  },
  {
    command: "host restart",
    args: ["host", "restart"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/project-restart-text",
  },
  {
    command: "host restart --serve",
    args: ["host", "restart", "--serve"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/project-restart-text",
  },
  {
    command: "host restart --open",
    args: ["host", "restart", "--open"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/project-restart-text",
  },
  {
    command: "remote status",
    args: ["remote", "status"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/remote-status-text",
  },
  {
    command: "remote status --json",
    args: ["remote", "status", "--json"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/remote-status-text?json=1",
  },
  {
    command: "remote enable",
    args: ["remote", "enable"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/remote-enable-text",
  },
  {
    command: "remote disable",
    args: ["remote", "disable"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/remote-disable-text",
  },
  {
    command: "whoami",
    args: ["whoami"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/whoami-text",
  },
  {
    command: "whoami --json",
    args: ["whoami", "--json"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/whoami-text?json=1",
  },
  {
    command: "logout",
    args: ["logout"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/logout-text",
  },
  {
    command: "login",
    args: ["login"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/login-start-text",
  },
  {
    command: "security unlock",
    args: ["security", "unlock"],
    disposition: "shim-fast-path",
    shimNeedle: "/core/security-unlock-start-text",
  },
];

describe("core command ownership inventory", () => {
  it("keeps command inventory status labels canonical and non-legacy", () => {
    const inventory = readFileSync(inventoryPath, "utf8");
    const statusLabels = inventory
      .split("\n")
      .filter((line) => line.startsWith("|"))
      .map((line) => line.split("|").map((part) => part.trim()))
      .map((columns) => columns[2]?.match(/^`([^`]+)`$/)?.[1])
      .filter((status): status is string => Boolean(status));

    expect(inventory).not.toContain("SIDEcar");
    expect(inventory).not.toContain("`LEGACY`");
    expect(new Set(statusLabels)).toEqual(new Set(["CUT", "BOOTSTRAP", "INTERNAL"]));
    expect(statusLabels.every((status) => allowedInventoryStatuses.has(status))).toBe(true);
  });

  it("classifies every routed core command used by the installed CLI", () => {
    expect(coreCommandDispositions.map((entry) => entry.command)).toEqual([
      "daemon ensure",
      "daemon ensure --json",
      "daemon status",
      "daemon status --json",
      "daemon projects",
      "daemon projects --json",
      "projects list",
      "projects list --json",
      "host status",
      "host status --json",
      "logs path",
      "logs tail",
      "logs clear",
      "daemon project-ensure",
      "daemon project-ensure --json",
      "daemon restart",
      "daemon restart --json",
      "serve",
      "host stop",
      "host kill",
      "host restart",
      "host restart --serve",
      "host restart --open",
      "remote status",
      "remote status --json",
      "remote enable",
      "remote disable",
      "whoami",
      "whoami --json",
      "logout",
      "login",
      "security unlock",
    ]);

    for (const entry of coreCommandDispositions) {
      expect(isCoreCliCommand(entry.args), entry.command).toBe(true);
    }
  });

  it("keeps shim-fast-path commands backed by explicit installed shell routes", () => {
    const shim = readFileSync(join(process.cwd(), "scripts", "installed-aimux-shim.sh"), "utf8");
    const fastPaths = coreCommandDispositions.filter((entry) => entry.disposition === "shim-fast-path");

    expect(fastPaths).toHaveLength(32);
    for (const entry of [...installedShimFastPaths, ...fastPaths]) {
      expect(entry.shimNeedle, entry.command).toBeTruthy();
      expect(shim, entry.command).toContain(entry.shimNeedle);
    }
  });

  it("keeps the core-routable Node fallback backlog explicit", () => {
    const backlog = coreCommandDispositions
      .filter((entry) => entry.disposition === "node-core-fallback")
      .map((entry) => entry.command);

    expect(backlog).toEqual([]);
  });
});
