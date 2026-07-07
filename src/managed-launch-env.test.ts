import { describe, expect, it } from "vitest";
import { buildManagedLaunchEnv, wrapCommandWithManagedLaunchEnv } from "./managed-launch-env.js";

describe("managed launch env", () => {
  it("strips tmux, transient, unbounded, and sensitive env while preserving stable launch env", () => {
    const env = buildManagedLaunchEnv(
      {
        HOME: "/Users/sam",
        PATH: "/Users/sam/.volta/bin:/usr/bin",
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        LANG: "en_US.UTF-8",
        VOLTA_HOME: "/Users/sam/.volta",
        TMUX: "/tmp/tmux-501/default,123,0",
        TMUX_PANE: "%1",
        PWD: "/repo",
        SHLVL: "3",
        _VOLTA_TOOL_RECURSION: "1",
        FOO_RECURSION_STATE: "1",
        BUNDLE_GEMFILE: "/repo/Gemfile",
        OPENAI_API_KEY: "sk-real",
        TEALSTREET_DISCORD_BOT_ADMIN_TOKEN: "real-token",
        RANDOM_PROJECT_ENV: "too much",
        CODEX_HOME: "/Users/sam/.codex",
        CLAUDE_CONFIG_DIR: "/Users/sam/.claude",
        SSH_AUTH_SOCK: "/private/tmp/ssh.sock",
      },
      { AIMUX_SESSION_ID: "codex-1", NOT_AIMUX_SECRET: "drop" },
    );

    expect(env).toMatchObject({
      HOME: "/Users/sam",
      PATH: "/Users/sam/.volta/bin:/usr/bin",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      CLICOLOR: "1",
      LANG: "en_US.UTF-8",
      VOLTA_HOME: "/Users/sam/.volta",
      CODEX_HOME: "/Users/sam/.codex",
      CLAUDE_CONFIG_DIR: "/Users/sam/.claude",
      SSH_AUTH_SOCK: "/private/tmp/ssh.sock",
      AIMUX_SESSION_ID: "codex-1",
    });
    expect(env.TMUX).toBeUndefined();
    expect(env.TMUX_PANE).toBeUndefined();
    expect(env.PWD).toBeUndefined();
    expect(env.SHLVL).toBeUndefined();
    expect(env._VOLTA_TOOL_RECURSION).toBeUndefined();
    expect(env.FOO_RECURSION_STATE).toBeUndefined();
    expect(env.BUNDLE_GEMFILE).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.TEALSTREET_DISCORD_BOT_ADMIN_TOKEN).toBeUndefined();
    expect(env.RANDOM_PROJECT_ENV).toBeUndefined();
    expect(env.NOT_AIMUX_SECRET).toBeUndefined();
  });

  it("normalizes control-process terminal env for interactive agents", () => {
    const env = buildManagedLaunchEnv({
      HOME: "/Users/sam",
      PATH: "/usr/bin",
      TERM: "dumb",
      NO_COLOR: "1",
    });

    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
    expect(env.CLICOLOR).toBe("1");
    expect(env.NO_COLOR).toBeUndefined();
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
