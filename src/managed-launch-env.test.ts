import { describe, expect, it } from "vitest";
import { buildManagedLaunchEnv, wrapCommandWithManagedLaunchEnv } from "./managed-launch-env.js";

describe("managed launch env", () => {
  it("preserves only the launch allowlist plus aimux-owned extras", () => {
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
        DATABASE_URL: "postgres://localhost/app",
        AWS_PROFILE: "prod",
        RANDOM_PROJECT_ENV: "project-value",
        LC_ALL: "C.UTF-8",
        CODEX_HOME: "/Users/sam/.codex",
        CLAUDE_CONFIG_DIR: "/Users/sam/.claude",
        SSH_AUTH_SOCK: "/private/tmp/ssh.sock",
      },
      { AIMUX_SESSION_ID: "codex-1", NOT_AIMUX_SECRET: "extra-secret" },
    );

    expect(env).toMatchObject({
      HOME: "/Users/sam",
      PATH: "/Users/sam/.volta/bin:/usr/bin",
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      CLICOLOR: "1",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      VOLTA_HOME: "/Users/sam/.volta",
      CODEX_HOME: "/Users/sam/.codex",
      CLAUDE_CONFIG_DIR: "/Users/sam/.claude",
      SSH_AUTH_SOCK: "/private/tmp/ssh.sock",
      AIMUX_SESSION_ID: "codex-1",
      NOT_AIMUX_SECRET: "extra-secret",
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
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.RANDOM_PROJECT_ENV).toBeUndefined();
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

  it("passes proxy settings through, in both spellings", () => {
    // A host that forces agent traffic through an allowlisting proxy has no
    // other way to tell the agent where it is: the launch is `env -i`, so a
    // variable missing from the allowlist reaches the daemon and stops there.
    const env = buildManagedLaunchEnv({
      HOME: "/Users/sam",
      PATH: "/usr/bin",
      HTTPS_PROXY: "http://127.0.0.1:8888",
      https_proxy: "http://127.0.0.1:8888",
      HTTP_PROXY: "http://127.0.0.1:8888",
      http_proxy: "http://127.0.0.1:8888",
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    });

    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:8888");
    expect(env.https_proxy).toBe("http://127.0.0.1:8888");
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:8888");
    expect(env.http_proxy).toBe("http://127.0.0.1:8888");
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost");
    expect(env.no_proxy).toBe("127.0.0.1,localhost");
  });

  it("carries the proxy into the env -i argv the tool actually launches with", () => {
    // buildManagedLaunchEnv returning the key is not the same as the child
    // process receiving it — the wrap is what puts it on the command line.
    const wrapped = wrapCommandWithManagedLaunchEnv({
      command: "codex",
      args: [],
      env: { HOME: "/home/aimux", PATH: "/usr/bin", HTTPS_PROXY: "http://127.0.0.1:8888" },
    });

    expect(wrapped.args).toContain("HTTPS_PROXY=http://127.0.0.1:8888");
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
