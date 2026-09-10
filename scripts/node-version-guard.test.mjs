import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeVersionGuardAction, normalizeNodeVersion } from "./node-version-guard.mjs";

describe("nodeVersionGuardAction", () => {
  it("accepts the pinned Node version", () => {
    expect(
      nodeVersionGuardAction({
        currentVersion: "v24.16.0",
        pinnedVersion: "24.16.0",
      }),
    ).toEqual({ kind: "ok" });
  });

  it("re-execs local test runs through nvm when the shell uses a different Node", () => {
    const nvmDir = mkdtempSync(join(tmpdir(), "aimux-nvm-"));
    try {
      const nvmScript = join(nvmDir, "nvm.sh");
      writeFileSync(nvmScript, "");

      expect(
        nodeVersionGuardAction({
          currentVersion: "v25.8.1",
          pinnedVersion: "24.16.0",
          nvmDir,
        }),
      ).toEqual({
        kind: "reexec",
        pinnedVersion: "24.16.0",
        nvmScript,
      });
    } finally {
      rmSync(nvmDir, { recursive: true, force: true });
    }
  });

  it("fails loudly in CI instead of silently running the wrong interpreter", () => {
    expect(
      nodeVersionGuardAction({
        currentVersion: "25.8.1",
        pinnedVersion: "24.16.0",
        ci: true,
      }),
    ).toEqual({
      kind: "error",
      message:
        "Aimux JS tests require Node 24.16.0 from .nvmrc, but this shell is running Node 25.8.1. Configure CI to use .nvmrc.",
    });
  });

  it("fails loudly when nvm cannot provide the pinned runtime", () => {
    const action = nodeVersionGuardAction({
      currentVersion: "25.8.1",
      pinnedVersion: "24.16.0",
      nvmDir: join(tmpdir(), "aimux-missing-nvm"),
    });

    expect(action.kind).toBe("error");
    expect(action.message).toContain("nvm was not found");
    expect(action.message).toContain("nvm install 24.16.0 && nvm use 24.16.0");
  });
});

describe("normalizeNodeVersion", () => {
  it("normalizes v-prefixed versions", () => {
    expect(normalizeNodeVersion("v24.16.0")).toBe("24.16.0");
  });
});
