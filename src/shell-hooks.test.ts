import { describe, expect, it } from "vitest";
import { wrapCommandWithShellIntegration, wrapInteractiveShellWithIntegration } from "./shell-hooks.js";

describe("shell hooks", () => {
  it("wraps generic tool launches through env + shell integration", () => {
    const wrapped = wrapCommandWithShellIntegration({
      projectRoot: "/repo/project",
      sessionId: "codex-123",
      tool: "codex",
      command: "codex",
      args: ["--dangerously-bypass-approvals-and-sandbox"],
      shellPath: "/bin/zsh",
    });

    expect(wrapped.command).toBe("env");
    expect(wrapped.args.join(" ")).toContain("AIMUX_SESSION_ID=codex-123");
    expect(wrapped.args.join(" ")).toContain("AIMUX_TOOL=codex");
    expect(wrapped.args).toContain("/bin/zsh");
    expect(wrapped.args).toContain("-ic");
    expect(wrapped.args.at(-1)).toContain("'codex'");
  });

  it("wraps interactive shell services through env + shell integration", () => {
    const wrapped = wrapInteractiveShellWithIntegration({
      projectRoot: "/repo/project",
      sessionId: "service-123",
      tool: "service",
      shellPath: "/bin/bash",
    });

    expect(wrapped.command).toBe("env");
    expect(wrapped.args.join(" ")).toContain("AIMUX_SESSION_ID=service-123");
    expect(wrapped.args.join(" ")).toContain("AIMUX_TOOL=service");
    expect(wrapped.args).toContain("/bin/bash");
    expect(wrapped.args).toContain("--rcfile");
    expect(wrapped.args).toContain("-i");
  });
});
