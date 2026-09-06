import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const shimPath = join(process.cwd(), "scripts", "installed-aimux-shim.sh");

describe("installed native shim", () => {
  it("delegates to AIMUX_NATIVE_BIN when it is set", () => {
    const root = tmpRoot("explicit-native");
    const nativeBin = writeNativeBin(root, "native-explicit");

    const result = spawnSync("/bin/sh", [shimPath, "daemon", "status"], {
      encoding: "utf8",
      env: { PATH: systemPath(), AIMUX_NATIVE_BIN: nativeBin },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("native-explicit daemon status\n");
    expect(result.stderr).toBe("");
  });

  it("resolves the installed native binary from AIMUX_ROOT", () => {
    const root = tmpRoot("root-native");
    const platformDir = join(root, "native", platformArch());
    mkdirSync(platformDir, { recursive: true });
    writeNativeBin(platformDir, "native-root");

    const result = spawnSync("/bin/sh", [shimPath, "--version"], {
      encoding: "utf8",
      env: { PATH: systemPath(), AIMUX_ROOT: root },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("native-root --version\n");
    expect(result.stderr).toBe("");
  });

  it("fails when no native binary is available", () => {
    const root = tmpRoot("missing-native");

    const result = spawnSync("/bin/sh", [shimPath, "daemon", "ensure"], {
      encoding: "utf8",
      env: { PATH: systemPath(), AIMUX_ROOT: root },
    });

    expect(result.status).toBe(127);
    expect(result.stderr).toContain("native binary not found or not executable");
  });
});

function tmpRoot(name: string): string {
  return join(tmpdir(), `aimux-installed-shim-${name}-${process.pid}-${Date.now()}-${Math.random()}`);
}

function writeNativeBin(root: string, label: string): string {
  mkdirSync(root, { recursive: true });
  const nativeBin = join(root, "aimux");
  writeFileSync(nativeBin, `#!/bin/sh\nprintf '${label} %s\\n' "$*"\n`);
  chmodSync(nativeBin, 0o755);
  return nativeBin;
}

function platformArch(): string {
  const platform = process.platform === "darwin" ? "darwin" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : process.arch;
  return `${platform}-${arch}`;
}

function systemPath(): string {
  return "/bin:/usr/bin";
}
