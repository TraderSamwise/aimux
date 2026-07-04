import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCoreCliCommand } from "./core-cli-routing.js";

type Disposition = "shim-fast-path" | "node-core-fallback";

const installedShimFastPaths: Array<{ command: string; shimNeedle: string }> = [
  { command: "spawn", shimNeedle: "/core/lifecycle/spawn-text" },
  { command: "stop <sessionId>", shimNeedle: "/core/lifecycle/stop-text" },
  { command: "kill <sessionId>", shimNeedle: "/core/lifecycle/kill-text" },
  { command: "fork <sourceSessionId>", shimNeedle: "/core/lifecycle/fork-text" },
  { command: "restart", shimNeedle: "/core/restart-text" },
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
      "daemon project-ensure",
      "daemon project-ensure --json",
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

    expect(fastPaths).toHaveLength(21);
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
