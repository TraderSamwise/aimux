import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  prepareShellIntegration,
  wrapCommandWithShellIntegration,
  wrapInteractiveShellWithIntegration,
} from "./shell-hooks.js";
import { getProjectStateDirFor } from "./paths.js";

describe("shell hooks", () => {
  it("wraps generic tool launches through env + shell integration", () => {
    const endpointFile = `${getProjectStateDirFor("/repo/project")}/metadata-api.txt`;
    const wrapped = wrapCommandWithShellIntegration({
      projectRoot: "/repo/project",
      sessionId: "codex-123",
      tool: "codex",
      command: "codex",
      args: ["--dangerously-bypass-approvals-and-sandbox"],
      shellPath: "/bin/zsh",
    });

    expect(wrapped.command).toBe("env");
    expect(wrapped.args[0]).toBe("-i");
    expect(wrapped.args.join(" ")).toContain("AIMUX_SESSION_ID=codex-123");
    expect(wrapped.args.join(" ")).toContain("AIMUX_TOOL=codex");
    expect(wrapped.args.join(" ")).toContain(`AIMUX_METADATA_ENDPOINT_FILE=${endpointFile}`);
    expect(wrapped.args.join(" ")).not.toContain("AIMUX_NODE_BIN=");
    expect(wrapped.args.join(" ")).not.toContain("AIMUX_CLI_ENTRY=");
    expect(wrapped.args).toContain("/bin/zsh");
    expect(wrapped.args).toContain("-ic");
    expect(wrapped.args.at(-1)).toContain("'codex'");
  });

  it("lets extraEnv through but never lets it override aimux control vars", () => {
    const wrapped = wrapCommandWithShellIntegration({
      projectRoot: "/repo/project",
      sessionId: "codex-123",
      tool: "codex",
      command: "codex",
      args: [],
      shellPath: "/bin/zsh",
      extraEnv: { CLAUDE_YOLO: "1", AIMUX_SESSION_ID: "spoofed", AIMUX_TOOL: "spoofed" },
    });

    const envAssignments = wrapped.args.filter((a) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(a));
    expect(envAssignments).toContain("CLAUDE_YOLO=1");
    // env takes the last occurrence, so the real values must come after any spoofed ones.
    expect(envAssignments.lastIndexOf("AIMUX_SESSION_ID=codex-123")).toBeGreaterThan(
      envAssignments.indexOf("AIMUX_SESSION_ID=spoofed"),
    );
    expect(envAssignments.lastIndexOf("AIMUX_TOOL=codex")).toBeGreaterThan(
      envAssignments.indexOf("AIMUX_TOOL=spoofed"),
    );
  });

  it("wraps interactive shell services through env + shell integration", () => {
    const endpointFile = `${getProjectStateDirFor("/repo/project")}/metadata-api.txt`;
    const wrapped = wrapInteractiveShellWithIntegration({
      projectRoot: "/repo/project",
      sessionId: "service-123",
      tool: "service",
      shellPath: "/bin/bash",
    });

    expect(wrapped.command).toBe("env");
    expect(wrapped.args[0]).toBe("-i");
    expect(wrapped.args.join(" ")).toContain("AIMUX_SESSION_ID=service-123");
    expect(wrapped.args.join(" ")).toContain("AIMUX_TOOL=service");
    expect(wrapped.args.join(" ")).toContain(`AIMUX_METADATA_ENDPOINT_FILE=${endpointFile}`);
    expect(wrapped.args.join(" ")).not.toContain("AIMUX_NODE_BIN=");
    expect(wrapped.args.join(" ")).not.toContain("AIMUX_CLI_ENTRY=");
    expect(wrapped.args).toContain("/bin/bash");
    expect(wrapped.args).toContain("--rcfile");
    expect(wrapped.args).toContain("-i");
  });

  it("preserves zshenv by writing a shim into the temporary ZDOTDIR", () => {
    const prepared = prepareShellIntegration("/repo/project", "/bin/zsh");

    expect(prepared.zshEnvPath).toBe(join(dirname(prepared.rcPath), ".zshenv"));
    expect(readFileSync(prepared.zshEnvPath!, "utf8")).toContain('source "$HOME/.zshenv"');
    expect(readFileSync(prepared.rcPath, "utf8")).toContain('source "$HOME/.zshrc"');
  });

  it("reports the command line from shell preexec hooks", () => {
    const zsh = prepareShellIntegration("/repo/project-zsh-command", "/bin/zsh");
    const bash = prepareShellIntegration("/repo/project-bash-command", "/bin/bash");

    expect(readFileSync(zsh.integrationScriptPath, "utf8")).toContain('_aimux_report_shell_state running "$1"');
    expect(readFileSync(bash.integrationScriptPath, "utf8")).toContain(
      '_aimux_report_shell_state running "$BASH_COMMAND"',
    );
  });

  it("decrements shell-state suppression markers before reporting prompt state", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "aimux-shell-hooks-suppress-"));
    try {
      const prepared = prepareShellIntegration(projectRoot, "/bin/bash");
      const suppressFile = join(getProjectStateDirFor(projectRoot), "shell-state-suppress", "service-1");
      mkdirSync(dirname(suppressFile), { recursive: true });
      writeFileSync(suppressFile, "2");

      execFileSync(
        "/bin/bash",
        [
          "-lc",
          [
            `source ${prepared.integrationScriptPath}`,
            "AIMUX_SESSION_ID=service-1",
            "AIMUX_TOOL=service",
            `AIMUX_SHELL_STATE_SUPPRESS_FILE=${suppressFile}`,
            "_aimux_report_shell_state prompt",
            "_aimux_report_shell_state prompt",
          ].join("; "),
        ],
        { encoding: "utf8" },
      );

      expect(existsSync(suppressFile)).toBe(false);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it.skipIf(!existsSync("/bin/zsh"))("executes zsh shells with both zshenv and zshrc from the user's HOME", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "aimux-shell-hooks-home-"));
    try {
      writeFileSync(join(homeDir, ".zshenv"), 'export AIMUX_TEST_ZSHENV="from-zshenv"\n');
      writeFileSync(join(homeDir, ".zshrc"), 'export AIMUX_TEST_ZSHRC="from-zshrc"\n');

      const wrapped = wrapCommandWithShellIntegration({
        projectRoot: "/repo/project-zsh-runtime",
        sessionId: "service-zsh-runtime",
        tool: "service",
        command: "/bin/zsh",
        args: ["-lc", 'printf "%s|%s" "$AIMUX_TEST_ZSHENV" "$AIMUX_TEST_ZSHRC"'],
        shellPath: "/bin/zsh",
        env: { ...process.env, HOME: homeDir },
      });

      const output = execFileSync(wrapped.command, wrapped.args, {
        env: { ...process.env, HOME: homeDir },
        encoding: "utf8",
      }).trim();

      expect(output).toBe("from-zshenv|from-zshrc");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
