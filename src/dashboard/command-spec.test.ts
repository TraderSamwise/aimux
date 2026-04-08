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
});
