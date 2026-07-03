import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";
import { getGlobalConfigPath, initPaths } from "./paths.js";

describe("config", () => {
  let repoRoot = "";
  let aimuxHome = "";
  let previousAimuxHome: string | undefined;

  beforeEach(async () => {
    previousAimuxHome = process.env.AIMUX_HOME;
    aimuxHome = mkdtempSync(join(tmpdir(), "aimux-config-home-"));
    process.env.AIMUX_HOME = aimuxHome;
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-config-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(aimuxHome, { recursive: true, force: true });
    if (previousAimuxHome === undefined) {
      delete process.env.AIMUX_HOME;
    } else {
      process.env.AIMUX_HOME = previousAimuxHome;
    }
  });

  it("normalizes exact Claude resume as backend-session resumable", () => {
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".aimux/config.json"),
      JSON.stringify(
        {
          tools: {
            claude: {
              command: "claude",
              args: ["--dangerously-skip-permissions"],
              enabled: true,
              sessionIdFlag: ["--session-id", "{sessionId}"],
              resumeArgs: ["--resume", "{sessionId}"],
              resumeByBackendSessionId: false,
            },
          },
        },
        null,
        2,
      ) + "\n",
    );

    expect(loadConfig({ includeGlobal: false }).tools.claude.resumeByBackendSessionId).toBe(true);
  });

  it("normalizes stale built-in resume args to exact backend resume while preserving fallbacks", () => {
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".aimux/config.json"),
      JSON.stringify(
        {
          tools: {
            claude: {
              command: "claude",
              args: ["--dangerously-skip-permissions"],
              enabled: true,
              preambleFlag: ["--append-system-prompt"],
              resumeArgs: ["--continue"],
            },
            codex: {
              command: "codex",
              args: [],
              enabled: true,
              resumeArgs: ["resume", "--last"],
            },
          },
        },
        null,
        2,
      ) + "\n",
    );

    const config = loadConfig({ includeGlobal: false });
    expect(config.tools.claude.resumeArgs).toEqual(["--resume", "{sessionId}"]);
    expect(config.tools.claude.resumeByBackendSessionId).toBe(true);
    expect(config.tools.claude.resumeFallback).toEqual(["--continue"]);
    expect(config.tools.codex.resumeArgs).toEqual(["resume", "{sessionId}"]);
    expect(config.tools.codex.resumeByBackendSessionId).toBe(true);
    expect(config.tools.codex.resumeFallback).toEqual(["resume", "--last"]);
  });

  it("preserves explicit built-in resumeFallback overrides when normalizing stale resume args", () => {
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".aimux/config.json"),
      JSON.stringify(
        {
          tools: {
            claude: {
              command: "claude",
              enabled: true,
              resumeArgs: ["--continue"],
              resumeFallback: ["--resume-fallback", "claude-explicit"],
            },
            codex: {
              command: "codex",
              enabled: true,
              resumeArgs: ["resume", "--last"],
              resumeFallback: ["resume", "codex-explicit"],
            },
          },
        },
        null,
        2,
      ) + "\n",
    );

    const config = loadConfig({ includeGlobal: false });
    expect(config.tools.claude.resumeArgs).toEqual(["--resume", "{sessionId}"]);
    expect(config.tools.claude.resumeFallback).toEqual(["--resume-fallback", "claude-explicit"]);
    expect(config.tools.codex.resumeArgs).toEqual(["resume", "{sessionId}"]);
    expect(config.tools.codex.resumeFallback).toEqual(["resume", "codex-explicit"]);
  });

  it("preserves explicit exact-resume opt-outs on built-in tools", () => {
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".aimux/config.json"),
      JSON.stringify(
        {
          tools: {
            claude: {
              command: "claude",
              enabled: true,
              resumeArgs: ["--continue"],
              resumeByBackendSessionId: false,
            },
            codex: {
              command: "codex",
              enabled: true,
              resumeArgs: ["resume", "--last"],
              resumeByBackendSessionId: false,
            },
          },
        },
        null,
        2,
      ) + "\n",
    );

    const config = loadConfig({ includeGlobal: false });
    expect(config.tools.claude.resumeArgs).toEqual(["--continue"]);
    expect(config.tools.claude.resumeByBackendSessionId).toBe(false);
    expect(config.tools.codex.resumeArgs).toEqual(["resume", "--last"]);
    expect(config.tools.codex.resumeByBackendSessionId).toBe(false);
  });

  it("preserves unknown built-in non-placeholder resume args", () => {
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".aimux/config.json"),
      JSON.stringify(
        {
          tools: {
            claude: {
              command: "claude",
              enabled: true,
              resumeArgs: ["--custom-continue"],
            },
            codex: {
              command: "codex",
              enabled: true,
              resumeArgs: ["resume", "custom"],
            },
          },
        },
        null,
        2,
      ) + "\n",
    );

    const config = loadConfig({ includeGlobal: false });
    expect(config.tools.claude.resumeArgs).toEqual(["--custom-continue"]);
    expect(config.tools.codex.resumeArgs).toEqual(["resume", "custom"]);
  });

  it("does not normalize stale resume args for custom tool configs", () => {
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".aimux/config.json"),
      JSON.stringify(
        {
          tools: {
            "codex-custom": {
              command: "codex",
              args: [],
              enabled: true,
              resumeArgs: ["resume", "--last"],
            },
          },
        },
        null,
        2,
      ) + "\n",
    );

    expect(loadConfig({ includeGlobal: false }).tools["codex-custom"].resumeArgs).toEqual(["resume", "--last"]);
  });

  it("ships a default claude config that assigns a backend session id at launch", () => {
    // Guards the proactive durability guarantee: aimux must launch claude with
    // its own --session-id so the backend id is known and persisted at spawn,
    // never discovered after the fact. Dropping this flag would silently
    // recreate the lost-backend-id failure mode.
    const claude = loadConfig({ includeGlobal: false }).tools.claude;
    expect(claude.sessionIdFlag).toEqual(["--session-id", "{sessionId}"]);
    expect(claude.resumeArgs?.some((a) => a.includes("{sessionId}"))).toBe(true);
    expect(claude.resumeByBackendSessionId).toBe(true);
  });

  it("defaults logging to disabled structured project logs", () => {
    expect(loadConfig({ includeGlobal: false }).logging).toEqual({
      enabled: false,
      level: "info",
      categories: ["*"],
      maxBytes: 10_000_000,
      maxFiles: 5,
    });
  });

  it("defaults notification view acknowledgement behavior", () => {
    expect(loadConfig({ includeGlobal: false }).notifications).toMatchObject({
      markReadOnView: true,
      clearNeedsInputOnView: true,
      clearFormalInteractionsOnView: false,
    });
  });

  it("reads an explicit projectRoot config without touching global path state", () => {
    const otherRepo = mkdtempSync(join(tmpdir(), "aimux-config-other-"));
    try {
      mkdirSync(join(otherRepo, ".git"), { recursive: true });
      mkdirSync(join(otherRepo, ".aimux"), { recursive: true });
      writeFileSync(
        join(otherRepo, ".aimux/config.json"),
        JSON.stringify({ worktrees: { baseDir: ".custom-worktrees" } }, null, 2) + "\n",
      );
      expect(loadConfig({ includeGlobal: false, projectRoot: otherRepo }).worktrees.baseDir).toBe(".custom-worktrees");
      expect(loadConfig({ includeGlobal: false }).worktrees.baseDir).toBe(".aimux/worktrees");
    } finally {
      rmSync(otherRepo, { recursive: true, force: true });
    }
  });

  it("defaults inbox cleanup to a 14 day retention window and a 10-item cap", () => {
    expect(loadConfig({ includeGlobal: false }).inbox).toEqual({
      cleanupEnabled: true,
      retentionDays: 14,
      cleanupIntervalMs: 86_400_000,
      maxSize: 10,
    });
  });

  it("defaults graveyard cleanup to a 14 day retention window", () => {
    expect(loadConfig({ includeGlobal: false }).graveyard).toEqual({
      cleanupEnabled: true,
      retentionDays: 14,
      cleanupIntervalMs: 86_400_000,
    });
  });

  it("allows project graveyard config to override global graveyard config", () => {
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    writeFileSync(
      getGlobalConfigPath(),
      JSON.stringify(
        {
          graveyard: {
            cleanupEnabled: false,
            retentionDays: 30,
          },
        },
        null,
        2,
      ) + "\n",
    );
    writeFileSync(
      join(repoRoot, ".aimux/config.json"),
      JSON.stringify(
        {
          graveyard: {
            retentionDays: 7,
          },
        },
        null,
        2,
      ) + "\n",
    );

    expect(loadConfig().graveyard).toEqual({
      cleanupEnabled: false,
      retentionDays: 7,
      cleanupIntervalMs: 86_400_000,
    });
  });

  it("deep merges logging config overrides", () => {
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".aimux/config.json"),
      JSON.stringify(
        {
          logging: {
            enabled: true,
            level: "debug",
            categories: ["daemon", "session"],
          },
        },
        null,
        2,
      ) + "\n",
    );

    expect(loadConfig({ includeGlobal: false }).logging).toEqual({
      enabled: true,
      level: "debug",
      categories: ["daemon", "session"],
      maxBytes: 10_000_000,
      maxFiles: 5,
    });
  });
});
