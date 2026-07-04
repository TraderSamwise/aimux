import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCoreCliCommand } from "./core-cli-routing.js";

type Disposition = "shim-fast-path" | "node-core-fallback";

const installedShimFastPaths: Array<{ command: string; shimNeedle: string }> = [
  { command: "restart", shimNeedle: "/core/restart-text" },
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
    disposition: "node-core-fallback",
  },
  {
    command: "daemon project-ensure --json",
    args: ["daemon", "project-ensure", "--project", "/tmp/project", "--json"],
    disposition: "node-core-fallback",
  },
  { command: "remote status", args: ["remote", "status"], disposition: "node-core-fallback" },
  { command: "remote status --json", args: ["remote", "status", "--json"], disposition: "node-core-fallback" },
  { command: "remote enable", args: ["remote", "enable"], disposition: "node-core-fallback" },
  { command: "remote disable", args: ["remote", "disable"], disposition: "node-core-fallback" },
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
    ]);

    for (const entry of coreCommandDispositions) {
      expect(isCoreCliCommand(entry.args), entry.command).toBe(true);
    }
  });

  it("keeps shim-fast-path commands backed by explicit installed shell routes", () => {
    const shim = readFileSync(join(process.cwd(), "scripts", "installed-aimux-shim.sh"), "utf8");
    const fastPaths = coreCommandDispositions.filter((entry) => entry.disposition === "shim-fast-path");

    expect(fastPaths).toHaveLength(10);
    for (const entry of [...installedShimFastPaths, ...fastPaths]) {
      expect(entry.shimNeedle, entry.command).toBeTruthy();
      expect(shim, entry.command).toContain(entry.shimNeedle);
    }
  });

  it("keeps the core-routable Node fallback backlog explicit", () => {
    const backlog = coreCommandDispositions
      .filter((entry) => entry.disposition === "node-core-fallback")
      .map((entry) => entry.command);

    expect(backlog).toEqual([
      "daemon project-ensure",
      "daemon project-ensure --json",
      "remote status",
      "remote status --json",
      "remote enable",
      "remote disable",
    ]);
  });
});
