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
      AIMUX_CLI_BIN: "/tmp/bin/aimux smoke",
      SECRET_TOKEN: "not-for-tmux",
    } as NodeJS.ProcessEnv);
    const command = spec.dashboardCommand.args[1] ?? "";
    expect(command).toContain(`env AIMUX_HOME='/tmp/custom'"'"'home; echo unsafe'`);
    expect(command).toContain("AIMUX_DAEMON_PORT='43219'");
    expect(command).toContain("AIMUX_CLI_BIN='/tmp/bin/aimux smoke'");
    expect(command).not.toContain("SECRET_TOKEN");
    expect(command).not.toContain("not-for-tmux");
  });

  it("changes the dashboard build stamp when the baked environment changes", () => {
    const one = getDashboardCommandSpec("/tmp/repo", { AIMUX_DAEMON_PORT: "43190" } as NodeJS.ProcessEnv);
    const two = getDashboardCommandSpec("/tmp/repo", { AIMUX_DAEMON_PORT: "43191" } as NodeJS.ProcessEnv);
    expect(one.dashboardBuildStamp).not.toBe(two.dashboardBuildStamp);
  });
});
