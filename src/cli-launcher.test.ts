import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAimuxCurrentCliIdentity,
  getAimuxDaemonLaunchCommand,
  getAimuxDashboardLaunchCommand,
} from "./cli-launcher.js";

describe("aimux launch contracts", () => {
  let dir: string;
  let shim: string;
  let nativeEntry: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aimux-launcher-"));
    shim = join(dir, "bin", "aimux");
    nativeEntry = join(dir, "native", "old-build", "dist", "launcher-bin.js");
    mkdirSync(join(dir, "bin"), { recursive: true });
    mkdirSync(join(dir, "native", "old-build", "dist"), { recursive: true });
    writeFileSync(shim, "#!/usr/bin/env node\n");
    writeFileSync(nativeEntry, "console.log('old');\n");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("uses the stable shim when the current entry is a native install", () => {
    const launch = getAimuxDaemonLaunchCommand({
      env: { AIMUX_CLI_BIN: shim, AIMUX_INSTALL_ROOT: join(dir, "native") },
      currentArgvEntry: nativeEntry,
    });
    expect(launch).toMatchObject({
      command: shim,
      args: ["daemon", "run"],
      source: "stable-shim",
    });
  });

  it("keeps source runs on the current entry when not inside a native install", () => {
    const launch = getAimuxDaemonLaunchCommand({
      env: { AIMUX_CLI_BIN: shim, AIMUX_INSTALL_ROOT: join(dir, "native") },
      currentArgvEntry: join(dir, "checkout", "dist", "launcher-bin.js"),
    });
    expect(launch.command).toBe(process.execPath);
    expect(launch.args[0]).toMatch(/launcher-bin\.(js|ts)$/);
    expect(launch.args.slice(1)).toEqual(["daemon", "run"]);
    expect(launch.source).toBe("current-entry");
  });

  it("uses a dedicated dashboard launch contract", () => {
    const launch = getAimuxDashboardLaunchCommand({
      env: { AIMUX_CLI_BIN: shim, AIMUX_INSTALL_ROOT: join(dir, "native") },
      currentArgvEntry: nativeEntry,
    });
    expect(launch).toMatchObject({
      command: shim,
      args: ["--tmux-dashboard-internal"],
      source: "stable-shim",
    });
  });

  it("exposes current CLI identity without launch arguments for diagnostics", () => {
    const launch = getAimuxCurrentCliIdentity({
      env: { AIMUX_CLI_BIN: shim, AIMUX_INSTALL_ROOT: join(dir, "native") },
      currentArgvEntry: nativeEntry,
    });
    expect(launch).toMatchObject({
      command: shim,
      args: [],
      source: "stable-shim",
    });
  });
});
