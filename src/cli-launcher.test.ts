import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAimuxCliShellCommand, getAimuxCliLaunchCommand } from "./cli-launcher.js";

describe("getAimuxCliLaunchCommand", () => {
  let dir: string;
  let shim: string;
  let nativeEntry: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aimux-launcher-"));
    shim = join(dir, "bin", "aimux");
    nativeEntry = join(dir, "native", "old-build", "dist", "main.js");
    mkdirSync(join(dir, "bin"), { recursive: true });
    mkdirSync(join(dir, "native", "old-build", "dist"), { recursive: true });
    writeFileSync(shim, "#!/usr/bin/env node\n");
    writeFileSync(nativeEntry, "console.log('old');\n");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("uses the stable shim when the current entry is a native install", () => {
    const launch = getAimuxCliLaunchCommand(["daemon", "run"], {
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
    const launch = getAimuxCliLaunchCommand(["daemon", "run"], {
      env: { AIMUX_CLI_BIN: shim, AIMUX_INSTALL_ROOT: join(dir, "native") },
      currentArgvEntry: join(dir, "checkout", "dist", "main.js"),
    });
    expect(launch.command).toBe(process.execPath);
    expect(launch.args[0]).toMatch(/main\.(js|ts)$/);
    expect(launch.args.at(-1)).toBe("run");
    expect(launch.source).toBe("current-entry");
  });

  it("builds a quoted shell command from the selected launcher", () => {
    const command = buildAimuxCliShellCommand(["codex-hook", "stop"]);
    expect(command).toContain("codex-hook");
    expect(command).toContain("stop");
  });
});
