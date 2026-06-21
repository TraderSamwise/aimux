import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { deriveAlertFromAgentEvent, ensureBundledDefaultPluginWrappers, PluginRuntime } from "./plugin-runtime.js";
import { initPaths } from "./paths.js";

let tempDir = "";
let originalAimuxHome: string | undefined;
let capturedAimuxHome = false;
let originalCwd = "";

afterEach(() => {
  if (capturedAimuxHome) {
    if (originalAimuxHome === undefined) {
      delete process.env.AIMUX_HOME;
    } else {
      process.env.AIMUX_HOME = originalAimuxHome;
    }
    capturedAimuxHome = false;
  }
  if (originalCwd) {
    process.chdir(originalCwd);
    originalCwd = "";
  }
  delete (globalThis as { __aimuxFailedPluginStopped?: number }).__aimuxFailedPluginStopped;
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
    const transcriptWrapperPath = join(tempDir, "plugins", "transcript-length.js");
    const manifestPath = join(tempDir, "plugins", ".bundled-default-plugins.json");
    expect(readFileSync(wrapperPath, "utf-8")).toContain("createGithubPrContextPlugin");
    expect(readFileSync(transcriptWrapperPath, "utf-8")).toContain("export default");
    const manifest = readFileSync(manifestPath, "utf-8");
    expect(manifest).toContain("gh-pr-context");
    expect(manifest).toContain("transcript-length");

    const custom = "export default function custom() {}\n";
    writeFileSync(wrapperPath, custom);

    ensureBundledDefaultPluginWrappers(tempDir);

    expect(readFileSync(wrapperPath, "utf-8")).toBe(custom);
  });

  it("treats deletion after initial seed as intentional", () => {
    tempDir = mkdtempSync(join(tmpdir(), "aimux-plugin-runtime-delete-"));

    ensureBundledDefaultPluginWrappers(tempDir);

    const wrapperPath = join(tempDir, "plugins", "gh-pr-context.js");
    const transcriptWrapperPath = join(tempDir, "plugins", "transcript-length.js");
    rmSync(wrapperPath, { force: true });
    rmSync(transcriptWrapperPath, { force: true });

    ensureBundledDefaultPluginWrappers(tempDir);

    expect(existsSync(wrapperPath)).toBe(false);
    expect(existsSync(transcriptWrapperPath)).toBe(false);
  });

  it("stops and reports a plugin that fails during startup with resource exhaustion", async () => {
    originalAimuxHome = process.env.AIMUX_HOME;
    capturedAimuxHome = true;
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "aimux-plugin-runtime-failed-start-"));
    const repoRoot = join(tempDir, "repo");
    const aimuxHome = join(tempDir, "home");
    const pluginDir = join(aimuxHome, "plugins");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(pluginDir, { recursive: true });
    process.env.AIMUX_HOME = aimuxHome;
    await initPaths(repoRoot);

    const pluginPath = join(pluginDir, "emfile-plugin.js");
    writeFileSync(
      pluginPath,
      [
        "export default function plugin() {",
        "  return {",
        "    start() {",
        "      const error = new Error('EMFILE: too many open files, watch');",
        "      error.code = 'EMFILE';",
        "      throw error;",
        "    },",
        "    stop() {",
        "      globalThis.__aimuxFailedPluginStopped = (globalThis.__aimuxFailedPluginStopped || 0) + 1;",
        "    }",
        "  };",
        "}",
        "",
      ].join("\n"),
    );

    const runtime = new PluginRuntime({
      host: "127.0.0.1",
      port: 43190,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    });

    await runtime.start();
    const failed = runtime.getPluginStatuses().find((status) => status.path === pluginPath);

    expect(failed).toMatchObject({
      source: "user",
      status: "failed",
      resourceFailure: true,
      stoppedAfterFailedStart: true,
    });
    expect((globalThis as { __aimuxFailedPluginStopped?: number }).__aimuxFailedPluginStopped).toBe(1);

    await runtime.stop();

    expect((globalThis as { __aimuxFailedPluginStopped?: number }).__aimuxFailedPluginStopped).toBe(1);
  });

  it("reports invalid user plugin module shapes as failed statuses", async () => {
    originalAimuxHome = process.env.AIMUX_HOME;
    capturedAimuxHome = true;
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), "aimux-plugin-runtime-invalid-shape-"));
    const repoRoot = join(tempDir, "repo");
    const aimuxHome = join(tempDir, "home");
    const pluginDir = join(aimuxHome, "plugins");
    mkdirSync(join(repoRoot, ".git"), { recursive: true });
    mkdirSync(pluginDir, { recursive: true });
    process.env.AIMUX_HOME = aimuxHome;
    await initPaths(repoRoot);

    const noDefaultPath = join(pluginDir, "no-default.js");
    const noInstancePath = join(pluginDir, "no-instance.js");
    writeFileSync(noDefaultPath, "export const plugin = true;\n");
    writeFileSync(noInstancePath, "export default function plugin() {}\n");

    const runtime = new PluginRuntime({
      host: "127.0.0.1",
      port: 43190,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    });

    await runtime.start();
    const statuses = runtime.getPluginStatuses();

    expect(statuses.find((status) => status.path === noDefaultPath)).toMatchObject({
      source: "user",
      status: "failed",
      error: "default export must be a function",
    });
    expect(statuses.find((status) => status.path === noInstancePath)).toMatchObject({
      source: "user",
      status: "failed",
      error: "plugin factory returned no instance",
    });
  });
});
