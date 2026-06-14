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

  it("defaults exposé scope to per-worktree (forceGlobalScope disabled)", () => {
    expect(loadConfig({ includeGlobal: false }).expose).toEqual({ forceGlobalScope: false });
  });

  it("merges an exposé forceGlobalScope override", () => {
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    writeFileSync(
      join(repoRoot, ".aimux/config.json"),
      JSON.stringify({ expose: { forceGlobalScope: true } }, null, 2) + "\n",
    );

    expect(loadConfig({ includeGlobal: false }).expose.forceGlobalScope).toBe(true);
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
