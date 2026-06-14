import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";
import { initPaths } from "./paths.js";

describe("config", () => {
  let repoRoot = "";

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "aimux-config-"));
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    await initPaths(repoRoot);
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
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
