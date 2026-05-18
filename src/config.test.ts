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

    expect(loadConfig().tools.claude.resumeByBackendSessionId).toBe(true);
  });
});
