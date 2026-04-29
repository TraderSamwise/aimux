import { describe, expect, it } from "vitest";
import { buildManagedLaunchEnv, wrapCommandWithManagedLaunchEnv } from "./managed-launch-env.js";

describe("managed launch env", () => {
  it("strips tmux and transient control state while preserving stable user env", () => {
    const env = buildManagedLaunchEnv(
      {
        HOME: "/Users/sam",
        PATH: "/Users/sam/.volta/bin:/usr/bin",
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        VOLTA_HOME: "/Users/sam/.volta",
        TMUX: "/tmp/tmux-501/default,123,0",
        TMUX_PANE: "%1",
        PWD: "/repo",
        SHLVL: "3",
        _VOLTA_TOOL_RECURSION: "1",
        FOO_RECURSION_STATE: "1",
        BUNDLE_GEMFILE: "/repo/Gemfile",
      },
      { AIMUX_SESSION_ID: "codex-1" },
    );

    expect(env).toMatchObject({
      HOME: "/Users/sam",
      PATH: "/Users/sam/.volta/bin:/usr/bin",
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      VOLTA_HOME: "/Users/sam/.volta",
      BUNDLE_GEMFILE: "/repo/Gemfile",
      AIMUX_SESSION_ID: "codex-1",
    });
    expect(env.TMUX).toBeUndefined();
    expect(env.TMUX_PANE).toBeUndefined();
    expect(env.PWD).toBeUndefined();
    expect(env.SHLVL).toBeUndefined();
    expect(env._VOLTA_TOOL_RECURSION).toBeUndefined();
    expect(env.FOO_RECURSION_STATE).toBeUndefined();
  });

  it("wraps managed launches through env -i", () => {
    const wrapped = wrapCommandWithManagedLaunchEnv({
      command: "claude",
      args: ["--print"],
      env: { HOME: "/Users/sam", PATH: "/usr/bin", TMUX: "bad" },
      extraEnv: { AIMUX_SESSION_ID: "claude-1" },
    });

    expect(wrapped.command).toBe("env");
    expect(wrapped.args[0]).toBe("-i");
    expect(wrapped.args).toContain("HOME=/Users/sam");
    expect(wrapped.args).toContain("PATH=/usr/bin");
    expect(wrapped.args).toContain("AIMUX_SESSION_ID=claude-1");
    expect(wrapped.args).not.toContain("TMUX=bad");
    expect(wrapped.args.at(-2)).toBe("claude");
    expect(wrapped.args.at(-1)).toBe("--print");
  });
});
