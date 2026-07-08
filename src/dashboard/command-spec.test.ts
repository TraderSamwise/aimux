import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareStableCliEnv } from "../launcher-env.js";
import { getDashboardCommandSpec } from "./command-spec.js";

describe("getDashboardCommandSpec", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "aimux-dashboard-spec-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses the CLI entrypoint and dashboard internal flag", () => {
    const spec = getDashboardCommandSpec("/tmp/repo");
    expect(spec.scriptPath).toMatch(/\/(dist|src)\/launcher-bin\.(js|ts)$/);
    expect(spec.dashboardBuildStamp.length).toBeGreaterThan(0);
    expect(spec.dashboardCommand.command).toBe("bash");
    expect(spec.dashboardCommand.cwd).toBe("/tmp/repo");
    expect(spec.dashboardCommand.args[0]).toBe("-lc");
    expect(spec.dashboardCommand.args[1]).toContain("--tmux-dashboard-internal");
    expect(spec.dashboardCommand.args[1]).toContain(spec.scriptPath);
  });

  it("prints an immediate startup frame before launching Node", () => {
    const command = getDashboardCommandSpec("/tmp/repo").dashboardCommand.args[1] ?? "";
    const preludeIndex = command.indexOf("Starting Aimux dashboard...");
    const entrypointIndex = command.indexOf("--tmux-dashboard-internal");

    expect(preludeIndex).toBeGreaterThanOrEqual(0);
    expect(entrypointIndex).toBeGreaterThan(preludeIndex);
    expect(command).not.toContain("\x1b[?1049h");
  });

  it("bakes allowlisted aimux environment into the dashboard process", () => {
    const spec = getDashboardCommandSpec("/tmp/repo", {
      AIMUX_HOME: "/tmp/custom'home; echo unsafe",
      AIMUX_DAEMON_PORT: "43219",
      SECRET_TOKEN: "not-for-tmux",
    } as NodeJS.ProcessEnv);
    const command = spec.dashboardCommand.args[1] ?? "";
    expect(command).toContain(`AIMUX_HOME='/tmp/custom'"'"'home; echo unsafe'`);
    expect(command).toContain("AIMUX_DAEMON_PORT='43219'");
    expect(command).not.toContain("SECRET_TOKEN");
    expect(command).not.toContain("not-for-tmux");
  });

  it("does not inherit stable-shim env when the dashboard launches from a source checkout", () => {
    const spec = getDashboardCommandSpec("/tmp/repo", {
      AIMUX_HOME: "/tmp/aimux",
      AIMUX_CLI_BIN: "/Users/sam/.local/bin/aimux",
      AIMUX_INSTALL_ROOT: "/Users/sam/.aimux/native",
    } as NodeJS.ProcessEnv);
    const command = spec.dashboardCommand.args[1] ?? "";
    expect(command).toContain("AIMUX_HOME='/tmp/aimux'");
    expect(command).toContain(spec.scriptPath);
    expect(command).toMatch(/-u '?AIMUX_CLI_BIN'?/);
    expect(command).toMatch(/-u '?AIMUX_INSTALL_ROOT'?/);
    expect(command).not.toContain("/Users/sam/.local/bin/aimux");
    expect(command).not.toContain("/Users/sam/.aimux/native");
  });

  it("changes the dashboard build stamp when the baked environment changes", () => {
    const one = getDashboardCommandSpec("/tmp/repo", { AIMUX_DAEMON_PORT: "43190" } as NodeJS.ProcessEnv);
    const two = getDashboardCommandSpec("/tmp/repo", { AIMUX_DAEMON_PORT: "43191" } as NodeJS.ProcessEnv);
    expect(one.dashboardBuildStamp).not.toBe(two.dashboardBuildStamp);
  });

  it("does not change the dashboard build stamp for explicit production defaults", () => {
    const implicit = getDashboardCommandSpec("/tmp/repo", {} as NodeJS.ProcessEnv);
    const explicit = getDashboardCommandSpec("/tmp/repo", {
      AIMUX_ENV: "production",
      AIMUX_WEB_APP_URL: "https://aimux.app",
    } as NodeJS.ProcessEnv);
    const command = explicit.dashboardCommand.args[1] ?? "";
    expect(command).toContain("AIMUX_ENV='production'");
    expect(command).toContain("AIMUX_WEB_APP_URL='https://aimux.app'");
    expect(explicit.dashboardBuildStamp).toBe(implicit.dashboardBuildStamp);
  });

  it("does not change the dashboard build stamp after launcher default env preparation", () => {
    const implicit = getDashboardCommandSpec("/tmp/repo", {} as NodeJS.ProcessEnv);
    const prepared = {} as NodeJS.ProcessEnv;
    prepareStableCliEnv(prepared);
    expect(getDashboardCommandSpec("/tmp/repo", prepared).dashboardBuildStamp).toBe(implicit.dashboardBuildStamp);
  });

  it("changes the dashboard build stamp for non-default web app env", () => {
    const production = getDashboardCommandSpec("/tmp/repo", {
      AIMUX_ENV: "production",
      AIMUX_WEB_APP_URL: "https://aimux.app",
    } as NodeJS.ProcessEnv);
    const development = getDashboardCommandSpec("/tmp/repo", {
      AIMUX_ENV: "development",
      AIMUX_WEB_APP_URL: "http://localhost:8081",
    } as NodeJS.ProcessEnv);
    expect(development.dashboardBuildStamp).not.toBe(production.dashboardBuildStamp);
  });

  it("stamps stable-shim dashboard launches from the shim install root", () => {
    const shim = join(tempDir, "bin", "aimux");
    const firstInstall = createNativeInstall("first", 1_700_000_000);
    const secondInstall = createNativeInstall("second", 1_800_000_000);
    mkdirSync(dirname(shim), { recursive: true });
    symlinkSync(join(firstInstall, "bin", "aimux"), shim);

    const env = {
      AIMUX_CLI_BIN: shim,
      AIMUX_INSTALL_ROOT: join(process.cwd(), "src"),
    } as NodeJS.ProcessEnv;
    const first = getDashboardCommandSpec("/tmp/repo", env).dashboardBuildStamp;
    unlinkSync(shim);
    symlinkSync(join(secondInstall, "bin", "aimux"), shim);

    expect(getDashboardCommandSpec("/tmp/repo", env).dashboardBuildStamp).not.toBe(first);
  });

  it("changes stable-shim dashboard stamps when install contents change without mtime changes", () => {
    const shim = join(tempDir, "bin", "aimux");
    const mtimeMs = 1_700_000_000;
    const firstInstall = createNativeInstall("first", mtimeMs);
    const secondInstall = createNativeInstall("second", mtimeMs);
    mkdirSync(dirname(shim), { recursive: true });
    symlinkSync(join(firstInstall, "bin", "aimux"), shim);

    const env = {
      AIMUX_CLI_BIN: shim,
      AIMUX_INSTALL_ROOT: join(process.cwd(), "src"),
    } as NodeJS.ProcessEnv;
    const first = getDashboardCommandSpec("/tmp/repo", env).dashboardBuildStamp;
    unlinkSync(shim);
    symlinkSync(join(secondInstall, "bin", "aimux"), shim);

    expect(getDashboardCommandSpec("/tmp/repo", env).dashboardBuildStamp).not.toBe(first);
  });

  function createNativeInstall(label: string, mtimeMs: number): string {
    const root = join(tempDir, "native", label);
    const bin = join(root, "bin");
    const dist = join(root, "dist");
    mkdirSync(bin, { recursive: true });
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(bin, "aimux"), "#!/usr/bin/env sh\n");
    for (const file of ["launcher-bin.js", "main.js"]) {
      const path = join(dist, file);
      writeFileSync(path, `${label}:${file}`);
      const seconds = mtimeMs / 1000;
      utimesSync(path, seconds, seconds);
    }
    return root;
  }
});
