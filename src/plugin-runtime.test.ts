import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { deriveAlertFromAgentEvent, ensureBundledDefaultPluginWrappers } from "./plugin-runtime.js";

let tempDir = "";

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("deriveAlertFromAgentEvent", () => {
  it("maps direct-chat needs_input into a semantic alert", () => {
    const alert = deriveAlertFromAgentEvent("claude-1", {
      kind: "needs_input",
      message: "Ready for input",
      source: "claude",
      tone: "warn",
    });

    expect(alert).toMatchObject({
      kind: "needs_input",
      sessionId: "claude-1",
      title: "claude-1 needs input",
      message: "Ready for input",
      dedupeKey: "needs_input:claude-1",
    });
  });

  it("does not alert on plain response events", () => {
    expect(
      deriveAlertFromAgentEvent("claude-1", {
        kind: "response",
        message: "Here is the answer",
      }),
    ).toBeUndefined();
  });

  it("maps error notifications to task_failed alerts", () => {
    const alert = deriveAlertFromAgentEvent("claude-1", {
      kind: "notify",
      message: "Tool error",
      tone: "error",
    });

    expect(alert).toMatchObject({
      kind: "task_failed",
      title: "claude-1 failed",
      message: "Tool error",
    });
  });

  it("maps generic notifications to notification alerts", () => {
    const alert = deriveAlertFromAgentEvent("codex-1", {
      kind: "notify",
      message: "Build complete",
      tone: "info",
    });

    expect(alert).toMatchObject({
      kind: "notification",
      title: "codex-1",
      message: "Build complete",
    });
  });

  it("seeds the bundled gh-pr-context wrapper once without overwriting user files", () => {
    tempDir = mkdtempSync(join(tmpdir(), "aimux-plugin-runtime-"));

    ensureBundledDefaultPluginWrappers(tempDir);

    const wrapperPath = join(tempDir, "plugins", "gh-pr-context.js");
    const manifestPath = join(tempDir, "plugins", ".bundled-default-plugins.json");
    expect(readFileSync(wrapperPath, "utf-8")).toContain("createGithubPrContextPlugin");
    expect(readFileSync(manifestPath, "utf-8")).toContain("gh-pr-context");

    const custom = "export default function custom() {}\n";
    writeFileSync(wrapperPath, custom);

    ensureBundledDefaultPluginWrappers(tempDir);

    expect(readFileSync(wrapperPath, "utf-8")).toBe(custom);
  });

  it("treats deletion after initial seed as intentional", () => {
    tempDir = mkdtempSync(join(tmpdir(), "aimux-plugin-runtime-delete-"));

    ensureBundledDefaultPluginWrappers(tempDir);

    const wrapperPath = join(tempDir, "plugins", "gh-pr-context.js");
    rmSync(wrapperPath, { force: true });

    ensureBundledDefaultPluginWrappers(tempDir);

    expect(existsSync(wrapperPath)).toBe(false);
  });
});
