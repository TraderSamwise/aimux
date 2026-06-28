import { describe, expect, it } from "vitest";
import { getDashboardCommandSpec } from "./command-spec.js";

describe("getDashboardCommandSpec", () => {
  it("uses the CLI entrypoint and dashboard internal flag", () => {
    const spec = getDashboardCommandSpec("/tmp/repo");
    expect(spec.scriptPath).toMatch(/\/(dist|src)\/main\.(js|ts)$/);
    expect(spec.dashboardBuildStamp.length).toBeGreaterThan(0);
    expect(spec.dashboardCommand.command).toBe("bash");
    expect(spec.dashboardCommand.cwd).toBe("/tmp/repo");
    expect(spec.dashboardCommand.args[0]).toBe("-lc");
    expect(spec.dashboardCommand.args[1]).toContain("--tmux-dashboard-internal");
    expect(spec.dashboardCommand.args[1]).toContain(spec.scriptPath);
  });

  it("bakes allowlisted aimux environment into the dashboard process", () => {
    const spec = getDashboardCommandSpec("/tmp/repo", {
      AIMUX_HOME: "/tmp/custom'home; echo unsafe",
      AIMUX_DAEMON_PORT: "43219",
      SECRET_TOKEN: "not-for-tmux",
    } as NodeJS.ProcessEnv);
    const command = spec.dashboardCommand.args[1] ?? "";
    expect(command).toContain(`AIMUX_HOME='/tmp/custom'"'"'home; echo unsafe'`);
    expect(command).toContain("AIMUX_DAEMON_PORT='43219'");
    expect(command).not.toContain("SECRET_TOKEN");
    expect(command).not.toContain("not-for-tmux");
  });

  it("does not inherit stable-shim env when the dashboard launches from a source checkout", () => {
    const spec = getDashboardCommandSpec("/tmp/repo", {
      AIMUX_HOME: "/tmp/aimux",
      AIMUX_CLI_BIN: "/Users/sam/.local/bin/aimux",
      AIMUX_INSTALL_ROOT: "/Users/sam/.aimux/native",
    } as NodeJS.ProcessEnv);
    const command = spec.dashboardCommand.args[1] ?? "";
    expect(command).toContain("AIMUX_HOME='/tmp/aimux'");
    expect(command).toContain(spec.scriptPath);
    expect(command).toMatch(/-u '?AIMUX_CLI_BIN'?/);
    expect(command).toMatch(/-u '?AIMUX_INSTALL_ROOT'?/);
    expect(command).not.toContain("/Users/sam/.local/bin/aimux");
    expect(command).not.toContain("/Users/sam/.aimux/native");
  });

  it("changes the dashboard build stamp when the baked environment changes", () => {
    const one = getDashboardCommandSpec("/tmp/repo", { AIMUX_DAEMON_PORT: "43190" } as NodeJS.ProcessEnv);
    const two = getDashboardCommandSpec("/tmp/repo", { AIMUX_DAEMON_PORT: "43191" } as NodeJS.ProcessEnv);
    expect(one.dashboardBuildStamp).not.toBe(two.dashboardBuildStamp);
  });

  it("does not change the dashboard build stamp for explicit production defaults", () => {
    const implicit = getDashboardCommandSpec("/tmp/repo", {} as NodeJS.ProcessEnv);
    const explicit = getDashboardCommandSpec("/tmp/repo", {
      AIMUX_ENV: "production",
      AIMUX_WEB_APP_URL: "https://aimux.app",
    } as NodeJS.ProcessEnv);
    const command = explicit.dashboardCommand.args[1] ?? "";
    expect(command).toContain("AIMUX_ENV='production'");
    expect(command).toContain("AIMUX_WEB_APP_URL='https://aimux.app'");
    expect(explicit.dashboardBuildStamp).toBe(implicit.dashboardBuildStamp);
  });

  it("changes the dashboard build stamp for non-default web app env", () => {
    const production = getDashboardCommandSpec("/tmp/repo", {
      AIMUX_ENV: "production",
      AIMUX_WEB_APP_URL: "https://aimux.app",
    } as NodeJS.ProcessEnv);
    const development = getDashboardCommandSpec("/tmp/repo", {
      AIMUX_ENV: "development",
      AIMUX_WEB_APP_URL: "http://localhost:8081",
    } as NodeJS.ProcessEnv);
    expect(development.dashboardBuildStamp).not.toBe(production.dashboardBuildStamp);
  });
});
