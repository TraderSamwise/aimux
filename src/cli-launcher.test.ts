import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAimuxCurrentCliIdentity,
  getAimuxDaemonLaunchCommand,
  getAimuxDashboardLaunchCommand,
  getAimuxProjectServiceLaunchCommand,
} from "./cli-launcher.js";

describe("aimux launch contracts", () => {
  let dir: string;
  let shim: string;
  let nativeEntry: string;
  let nativeBinary: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aimux-launcher-"));
    shim = join(dir, "bin", "aimux");
    const installRoot = join(dir, "native", "old-build");
    nativeEntry = join(installRoot, "dist", "launcher-bin.js");
    nativeBinary = join(installRoot, "native", `${process.platform}-${process.arch}`, "aimux");
    mkdirSync(join(dir, "bin"), { recursive: true });
    mkdirSync(join(installRoot, "bin"), { recursive: true });
    mkdirSync(join(installRoot, "dist"), { recursive: true });
    mkdirSync(join(installRoot, "native", `${process.platform}-${process.arch}`), { recursive: true });
    writeFileSync(join(installRoot, "bin", "aimux"), "#!/usr/bin/env sh\n");
    writeFileSync(nativeEntry, "console.log('old');\n");
    writeFileSync(nativeBinary, "#!/usr/bin/env sh\n");
    symlinkSync(join(installRoot, "bin", "aimux"), shim);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("uses the installed native binary for daemon launch when the current entry is a native install", () => {
    const launch = getAimuxDaemonLaunchCommand({
      env: { AIMUX_CLI_BIN: shim, AIMUX_INSTALL_ROOT: join(dir, "native") },
      currentArgvEntry: nativeEntry,
    });
    expect(launch).toMatchObject({
      command: realpathSync(nativeBinary),
      args: ["daemon", "run"],
      source: "native-binary",
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

  it("uses the installed native binary for native dashboard launch", () => {
    const launch = getAimuxDashboardLaunchCommand({
      env: {
        AIMUX_CLI_BIN: shim,
        AIMUX_INSTALL_ROOT: join(dir, "native"),
        AIMUX_DASHBOARD_IMPLEMENTATION: "native",
      },
      currentArgvEntry: nativeEntry,
    });
    expect(launch).toMatchObject({
      command: realpathSync(nativeBinary),
      args: ["__dashboard-internal-native"],
      source: "native-binary",
    });
  });

  it("uses the installed native binary for project service launch", () => {
    const launch = getAimuxProjectServiceLaunchCommand("project-1", "/repo/alpha", {
      env: { AIMUX_CLI_BIN: shim, AIMUX_INSTALL_ROOT: join(dir, "native") },
      currentArgvEntry: nativeEntry,
    });
    expect(launch).toMatchObject({
      command: realpathSync(nativeBinary),
      args: ["__project-service-internal", "--project-id", "project-1", "--project-root", "/repo/alpha"],
      source: "native-binary",
    });
  });

  it("uses the installed native binary when native install paths resolve through symlink aliases", () => {
    const realRoot = join(dir, "real");
    const aliasRoot = join(dir, "alias");
    const realInstall = join(realRoot, "native", "old-build");
    const aliasEntry = join(aliasRoot, "native", "old-build", "dist", "launcher-bin.js");
    const realShim = join(realInstall, "bin", "aimux");
    const realNative = join(realInstall, "native", `${process.platform}-${process.arch}`, "aimux");
    rmSync(shim, { force: true });
    mkdirSync(join(realRoot, "native", "old-build", "dist"), { recursive: true });
    mkdirSync(join(realInstall, "bin"), { recursive: true });
    mkdirSync(join(realInstall, "native", `${process.platform}-${process.arch}`), { recursive: true });
    writeFileSync(join(realRoot, "native", "old-build", "dist", "launcher-bin.js"), "console.log('old');\n");
    writeFileSync(realShim, "#!/usr/bin/env sh\n");
    writeFileSync(realNative, "#!/usr/bin/env sh\n");
    symlinkSync(realRoot, aliasRoot, "dir");
    symlinkSync(realShim, shim);

    const launch = getAimuxDashboardLaunchCommand({
      env: {
        AIMUX_CLI_BIN: shim,
        AIMUX_INSTALL_ROOT: join(realRoot, "native"),
        AIMUX_DASHBOARD_IMPLEMENTATION: "native",
      },
      currentArgvEntry: aliasEntry,
    });

    expect(launch).toMatchObject({
      command: realpathSync(realNative),
      args: ["__dashboard-internal-native"],
      source: "native-binary",
    });
  });

  it("exposes current CLI identity without launch arguments for diagnostics", () => {
    const launch = getAimuxCurrentCliIdentity({
      env: { AIMUX_CLI_BIN: shim, AIMUX_INSTALL_ROOT: join(dir, "native") },
      currentArgvEntry: nativeEntry,
    });
    expect(launch).toMatchObject({
      command: realpathSync(nativeBinary),
      args: [],
      source: "native-binary",
    });
  });
});
