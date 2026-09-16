import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runOk(command, args, options = {}) {
  const result = run(command, args, options);
  expect(result.status, `${command} ${args.join(" ")}\n${result.stderr}`).toBe(0);
  return result;
}

function platformArch() {
  const platform = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `${platform}-${arch}`;
}

function createInstallArchive(root, variant = "full") {
  const archiveRoot = join(root, "archive");
  const packageRoot = join(archiveRoot, "aimux");
  const nativeDir = join(packageRoot, "native", platformArch());
  mkdirSync(nativeDir, { recursive: true });
  writeFileSync(join(packageRoot, "VERSION"), "local-test\n");
  writeFileSync(join(packageRoot, "BUILD_STAMP"), "test-stamp\n");
  writeFileSync(join(packageRoot, "BUILD_VARIANT"), `${variant}\n`);
  const nativeBinary = join(nativeDir, "aimux");
  writeFileSync(
    nativeBinary,
    `#!/usr/bin/env sh
if [ "$1" = "restart" ]; then
  if [ -n "\${AIMUX_FAKE_RESTART_ARGS_FILE:-}" ]; then
    printf '%s\\n' "$*" > "$AIMUX_FAKE_RESTART_ARGS_FILE"
  fi
  if [ -n "\${AIMUX_FAKE_RESTART_STDOUT:-}" ]; then
    printf '%s\\n' "$AIMUX_FAKE_RESTART_STDOUT"
  fi
  if [ -n "\${AIMUX_FAKE_RESTART_STDERR:-}" ]; then
    printf '%s\\n' "$AIMUX_FAKE_RESTART_STDERR" >&2
  fi
  exit "\${AIMUX_FAKE_RESTART_STATUS:-0}"
fi
exit 0
`,
  );
  chmodSync(nativeBinary, 0o755);
  const archive = join(root, "aimux-test.tar.gz");
  runOk("tar", ["-czf", archive, "-C", archiveRoot, "aimux"]);
  return archive;
}

function createReleaseArchive(root, stamp = "test-release-stamp", variant = "full") {
  const archiveRoot = join(root, "archive");
  const packageRoot = join(archiveRoot, "aimux");
  const nativeDir = join(packageRoot, "native", platformArch());
  mkdirSync(nativeDir, { recursive: true });
  writeFileSync(join(packageRoot, "BUILD_STAMP"), `${stamp}\n`);
  writeFileSync(join(packageRoot, "BUILD_VARIANT"), `${variant}\n`);
  const nativeBinary = join(nativeDir, "aimux");
  writeFileSync(nativeBinary, `#!/usr/bin/env sh\nAIMUX_EMBEDDED_BUILD_STAMP=${stamp}\nexit 0\n`);
  chmodSync(nativeBinary, 0o755);
  const archive = join(root, "aimux-release.tar.gz");
  runOk("tar", ["-czf", archive, "-C", archiveRoot, "aimux"]);
  return archive;
}

function installEnv(root, restartStatus) {
  return {
    HOME: join(root, "home"),
    AIMUX_INSTALL_ROOT: join(root, "native"),
    AIMUX_BIN_DIR: join(root, "bin"),
    AIMUX_FAKE_RESTART_STATUS: String(restartStatus),
    AIMUX_FAKE_RESTART_ARGS_FILE: join(root, "restart-args.txt"),
  };
}

function createExistingInstall(root) {
  const binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "aimux"), "#!/usr/bin/env sh\nexit 0\n");
  chmodSync(join(binDir, "aimux"), 0o755);
}

function writeExecutable(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function releaseScriptEnv(root, extra = {}) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const realTar = runOk("bash", ["-lc", "command -v tar"]).stdout.trim();
  const realCommands = {
    awk: runOk("bash", ["-lc", "command -v awk"]).stdout.trim(),
    bash: runOk("bash", ["-lc", "command -v bash"]).stdout.trim(),
    cat: runOk("bash", ["-lc", "command -v cat"]).stdout.trim(),
    chmod: runOk("bash", ["-lc", "command -v chmod"]).stdout.trim(),
    cp: runOk("bash", ["-lc", "command -v cp"]).stdout.trim(),
    date: runOk("bash", ["-lc", "command -v date"]).stdout.trim(),
    dirname: runOk("bash", ["-lc", "command -v dirname"]).stdout.trim(),
    find: runOk("bash", ["-lc", "command -v find"]).stdout.trim(),
    grep: runOk("bash", ["-lc", "command -v grep"]).stdout.trim(),
    mkdir: runOk("bash", ["-lc", "command -v mkdir"]).stdout.trim(),
    mktemp: runOk("bash", ["-lc", "command -v mktemp"]).stdout.trim(),
    node: runOk("bash", ["-lc", "command -v node"]).stdout.trim(),
    python3: runOk("bash", ["-lc", "command -v python3"]).stdout.trim(),
    rm: runOk("bash", ["-lc", "command -v rm"]).stdout.trim(),
    sed: runOk("bash", ["-lc", "command -v sed"]).stdout.trim(),
    shasum: runOk("bash", ["-lc", "command -v shasum"]).stdout.trim(),
    strings: runOk("bash", ["-lc", "command -v strings"]).stdout.trim(),
  };

  for (const [name, commandPath] of Object.entries(realCommands)) {
    writeExecutable(join(bin, name), `#!/bin/sh\nexec ${commandPath} "$@"\n`);
  }
  writeExecutable(
    join(bin, "tar"),
    `#!/bin/sh
case " $* " in
  *" -czf "*|*" -xzf "*|*" -tzf "*)
    command -v gzip >/dev/null 2>&1 || { printf 'tar (child): gzip: Cannot exec\\n' >&2; exit 127; }
    ;;
esac
exec ${realTar} "$@"
`,
  );
  writeExecutable(
    join(bin, "uname"),
    `#!/bin/sh
case "$1" in
  -s) printf 'Linux\\n' ;;
  -m) printf 'x86_64\\n' ;;
  *) printf 'Linux\\n' ;;
esac
`,
  );
  writeExecutable(
    join(bin, "git"),
    `#!/bin/sh
if [ "$1" = "-C" ]; then
  shift 2
fi
case "$1" in
  rev-parse)
    printf '1234567890abcdef1234567890abcdef12345678\\n'
    ;;
  diff)
    if [ "\${AIMUX_FAKE_GIT_DIFF_FAIL:-}" = "1" ]; then
      printf 'fake git diff failed\\n' >&2
      exit 23
    fi
    ;;
  *)
    printf 'unexpected git command: %s\\n' "$*" >&2
    exit 127
    ;;
esac
`,
  );
  writeExecutable(
    join(bin, "cargo"),
    `#!/bin/sh
if [ "$1" = "metadata" ]; then
  printf '%s\\n' '{"packages":[{"id":"path+file:///fixture#aimux@0.0.0","name":"aimux","version":"0.0.0","authors":["Aimux"],"license":"MIT"}],"workspace_members":["path+file:///fixture#aimux@0.0.0"],"resolve":{"root":"path+file:///fixture#aimux@0.0.0","nodes":[{"id":"path+file:///fixture#aimux@0.0.0","deps":[]}]}}'
  exit 0
fi
if [ "$1" = "tree" ]; then
  printf '%s\\n' 'aimux v0.0.0 (/fixture)'
  exit 0
fi
mkdir -p "$CARGO_TARGET_DIR/release"
printf '%s\\n' "$*" > "${root}/cargo-args.txt"
{
  printf '#!/usr/bin/env sh\\n'
  printf 'AIMUX_EMBEDDED_BUILD_STAMP=%s\\n' "$AIMUX_RELEASE_BUILD_STAMP"
  printf 'exit 0\\n'
} > "$CARGO_TARGET_DIR/release/aimux"
chmod +x "$CARGO_TARGET_DIR/release/aimux"
`,
  );
  writeExecutable(
    join(bin, "yarn"),
    `#!/bin/sh
case "$1" in
  release:asset)
    exec ${realCommands.bash} ${join(repoRoot, "scripts/build-release-asset.sh")}
    ;;
  build:ui:local)
    mkdir -p ${join(repoRoot, "dist-ui")}
    printf '<!doctype html>\\n' > ${join(repoRoot, "dist-ui", "index.html")}
    exit 0
    ;;
  *)
    printf 'unexpected yarn command: %s\\n' "$*" >&2
    exit 127
    ;;
esac
`,
  );
  return {
    PATH: bin,
    AIMUX_BUILD_PROFILE: "local",
    AIMUX_RELEASE_VERSION: "local-test",
    AIMUX_RELEASE_DIR: join(root, "release"),
    CARGO_TARGET_DIR: join(root, "target"),
    ...extra,
  };
}

describe("install.sh", () => {
  it("exits successfully when post-install restart repairs the control plane", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-install-script-"));
    try {
      const archive = createInstallArchive(root);
      createExistingInstall(root);
      const result = run("sh", [join(repoRoot, "scripts/install.sh"), archive], {
        cwd: root,
        env: installEnv(root, 0),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Aimux control plane repaired.");
      expect(readFileSync(join(root, "restart-args.txt"), "utf8").trim()).toBe("restart --all");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("uses a distinct nonzero exit when post-install restart fails", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-install-script-"));
    try {
      const archive = createInstallArchive(root);
      createExistingInstall(root);
      const result = run("sh", [join(repoRoot, "scripts/install.sh"), archive], {
        cwd: root,
        env: {
          ...installEnv(root, 37),
          AIMUX_FAKE_RESTART_STDOUT: [
            "Aimux Restart",
            "  daemon: retained pid=123",
            "  failures: 1",
            "",
            "Project: /Users/sam/cs/glyde-frontend",
            "  runtime: skipped",
            "  service: ensured",
            "  dashboard: failed (Timed out waiting 20000ms for tmux window @22 readiness option @aimux-dashboard-ready=stamp) aimux-glyde-client:@22",
          ].join("\n"),
        },
      });

      expect(result.status).toBe(75);
      expect(result.stderr).toContain(
        "post-install restart failed (exit 37): /Users/sam/cs/glyde-frontend dashboard failed (Timed out waiting 20000ms for tmux window @22 readiness option @aimux-dashboard-ready=stamp) aimux-glyde-client:@22",
      );
      expect(result.stderr).toContain("Project: /Users/sam/cs/glyde-frontend");
      expect(result.stderr).toContain("tmux window @22");
      expect(result.stderr).toContain(`${join(root, "bin")}/aimux restart --all`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("refuses a full archive through the local install path", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-install-script-"));
    try {
      const archive = createInstallArchive(root, "full");
      const result = run("sh", [join(repoRoot, "scripts/install.sh"), archive], {
        cwd: root,
        env: {
          ...installEnv(root, 0),
          AIMUX_INSTALL_VARIANT: "local",
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("release archive BUILD_VARIANT mismatch: expected local, got full");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("refuses a local archive through the full install path", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-install-script-"));
    try {
      const archive = createInstallArchive(root, "local");
      const result = run("sh", [join(repoRoot, "scripts/install.sh"), archive], {
        cwd: root,
        env: installEnv(root, 0),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("release archive BUILD_VARIANT mismatch: expected full, got local");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});

describe("build-release-asset.sh", () => {
  it("fails loudly when git diff cannot prove the dirty source hash", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-release-script-"));
    try {
      const result = run("bash", [join(repoRoot, "scripts/build-release-asset.sh")], {
        env: releaseScriptEnv(root, { AIMUX_FAKE_GIT_DIFF_FAIL: "1" }),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Failed to diff release source against HEAD");
      expect(result.stderr).toContain("fake git diff failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("builds a release asset when the clean-tree diff is readable", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-release-script-"));
    try {
      const result = run("bash", [join(repoRoot, "scripts/build-release-asset.sh")], {
        env: releaseScriptEnv(root),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(
        existsSync(join(root, "release", "aimux-linux-x64.tar.gz")),
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}\nrelease files:\n${existsSync(join(root, "release")) ? readdirSync(join(root, "release")).join("\n") : "(missing)"}`,
      ).toBe(true);
      expect(readFileSync(join(root, "cargo-args.txt"), "utf8")).not.toContain("--no-default-features");
      const stamp = readFileSync(join(root, "release", "aimux-linux-x64.tar.gz.sha256"), "utf8");
      expect(stamp).toContain("aimux-linux-x64.tar.gz");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("builds a local release asset with the local variant stamp and feature lane", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-release-script-"));
    try {
      const result = run("bash", [join(repoRoot, "scripts/build-release-asset.sh")], {
        env: releaseScriptEnv(root, { AIMUX_BUILD_VARIANT: "local" }),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(root, "release", "aimux-local-linux-x64.tar.gz"))).toBe(true);
      expect(readFileSync(join(root, "cargo-args.txt"), "utf8")).toContain("--no-default-features");
      const extractDir = join(root, "extract");
      mkdirSync(extractDir);
      runOk("tar", ["-xzf", join(root, "release", "aimux-local-linux-x64.tar.gz"), "-C", extractDir]);
      expect(readFileSync(join(extractDir, "aimux", "BUILD_VARIANT"), "utf8").trim()).toBe("local");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});

describe("build-release-from-source.sh", () => {
  it("builds, verifies, and install-smokes the local variant from source", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-source-release-script-"));
    try {
      const result = run("bash", [join(repoRoot, "scripts/build-local-release-from-source.sh")], {
        env: releaseScriptEnv(root, { AIMUX_RELEASE_VERSION: "source-test" }),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Building Aimux local variant from source revision");
      expect(result.stdout).toContain("aimux local build boundary check passed");
      expect(result.stdout).toContain("Install smoke passed for local variant");
      expect(result.stdout).toContain("Aimux source release build verified");
      expect(existsSync(join(root, "release", "aimux-local-linux-x64.tar.gz"))).toBe(true);
      expect(existsSync(join(root, "release", "aimux-local-linux-x64.tar.gz.sha256"))).toBe(true);
      expect(existsSync(join(root, "release", "aimux-local-linux-x64.tar.gz.provenance.json"))).toBe(true);
      expect(existsSync(join(root, "release", "aimux-local-linux-x64.tar.gz.sbom.spdx.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});

describe("verify-release-asset.sh", () => {
  it("verifies a release asset when gzip is outside the caller path", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-verify-script-"));
    try {
      const archive = createReleaseArchive(root);
      const result = run("bash", [join(repoRoot, "scripts/verify-release-asset.sh"), archive, platformArch()], {
        env: releaseScriptEnv(root),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).not.toContain("gzip: Cannot exec");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("rejects a release asset without a build variant stamp", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-verify-script-"));
    try {
      const archiveRoot = join(root, "archive");
      const packageRoot = join(archiveRoot, "aimux");
      const nativeDir = join(packageRoot, "native", platformArch());
      mkdirSync(nativeDir, { recursive: true });
      writeFileSync(join(packageRoot, "BUILD_STAMP"), "stamp\n");
      const nativeBinary = join(nativeDir, "aimux");
      writeFileSync(nativeBinary, "#!/usr/bin/env sh\nAIMUX_EMBEDDED_BUILD_STAMP=stamp\nexit 0\n");
      chmodSync(nativeBinary, 0o755);
      const archive = join(root, "missing-variant.tar.gz");
      runOk("tar", ["-czf", archive, "-C", archiveRoot, "aimux"]);

      const result = run("bash", [join(repoRoot, "scripts/verify-release-asset.sh"), archive, platformArch()], {
        env: releaseScriptEnv(root),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Release archive is missing BUILD_VARIANT");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});

describe("verify-release-asset-set.sh", () => {
  function writeReleaseSetArchive(root, asset, platformArch, variant) {
    const archiveRoot = join(root, `pkg-${asset}`);
    const packageRoot = join(archiveRoot, "aimux");
    const nativeDir = join(packageRoot, "native", platformArch);
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(join(packageRoot, "VERSION"), "0.1.34\n");
    writeFileSync(join(packageRoot, "BUILD_STAMP"), `stamp-${asset}\n`);
    writeFileSync(join(packageRoot, "BUILD_VARIANT"), `${variant}\n`);
    const nativeBinary = join(nativeDir, "aimux");
    writeFileSync(nativeBinary, `#!/usr/bin/env sh\nprintf 'fixture ${asset}\\n'\n`);
    chmodSync(nativeBinary, 0o755);
    runOk("tar", ["-czf", join(root, asset), "-C", archiveRoot, "aimux"]);
    const sha = runOk("shasum", ["-a", "256", asset], { cwd: root }).stdout;
    writeFileSync(join(root, `${asset}.sha256`), sha);
    const shaValue = sha.split(/\s+/)[0];
    writeFileSync(
      join(root, `${asset}.provenance.json`),
      `${JSON.stringify(
        {
          schemaVersion: "https://aimux.app/schemas/release-provenance.v1.json",
          package: "aimux",
          version: "0.1.34",
          source: {
            repository: "https://github.com/TraderSamwise/aimux",
            revision: "1234567890abcdef1234567890abcdef12345678",
            ref: "v0.1.34",
          },
          build: {
            profile: "full",
            variant,
            platformArch,
            buildStamp: `stamp-${asset}`,
          },
          artifact: {
            name: asset,
            sha256: shaValue,
            buildProfile: "full",
            buildVariant: variant,
            platformArch,
          },
          gates: {
            assetSet: "scripts/verify-release-asset-set.sh",
            boundary: "scripts/check-local-build-boundary.sh",
            attestation: `gh attestation verify ${asset} --repo TraderSamwise/aimux`,
          },
          generatedAt: "2026-09-16T00:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );
    runOk("python3", [
      join(repoRoot, "scripts/generate-cargo-sbom.py"),
      "--manifest-path",
      join(repoRoot, "native/Cargo.toml"),
      "--asset",
      asset,
      "--asset-sha256",
      shaValue,
      "--version",
      "0.1.34",
      "--source-revision",
      "1234567890abcdef1234567890abcdef12345678",
      "--variant",
      variant,
      "--platform-arch",
      platformArch,
      "--output",
      join(root, `${asset}.sbom.spdx.json`),
    ]);
  }

  function writeAssetSet(root, omitted = undefined) {
    for (const platform of ["darwin", "linux"]) {
      for (const arch of ["arm64", "x64"]) {
        for (const variant of ["full", "local"]) {
          const asset =
            variant === "local" ? `aimux-local-${platform}-${arch}.tar.gz` : `aimux-${platform}-${arch}.tar.gz`;
          if (asset === omitted) continue;
          writeReleaseSetArchive(root, asset, `${platform}-${arch}`, variant);
        }
      }
    }
  }

  it("accepts a complete full and local release asset set", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-release-set-"));
    try {
      writeAssetSet(root);
      const result = run("bash", [join(repoRoot, "scripts/verify-release-asset-set.sh"), root]);

      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when any local artifact is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-release-set-"));
    try {
      writeAssetSet(root, "aimux-local-darwin-arm64.tar.gz");
      const result = run("bash", [join(repoRoot, "scripts/verify-release-asset-set.sh"), root]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("missing release asset");
      expect(result.stderr).toContain("aimux-local-darwin-arm64.tar.gz");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects the reviewer probe: non-tar assets with stale zero checksums", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-release-set-"));
    try {
      writeAssetSet(root);
      for (const platform of ["darwin", "linux"]) {
        for (const arch of ["arm64", "x64"]) {
          for (const prefix of ["aimux", "aimux-local"]) {
            const asset = `${prefix}-${platform}-${arch}.tar.gz`;
            writeFileSync(join(root, asset), `not a tar archive: ${asset}\n`);
            writeFileSync(join(root, `${asset}.sha256`), `${"0".repeat(64)}  ${asset}\n`);
          }
        }
      }

      const result = run("bash", [join(repoRoot, "scripts/verify-release-asset-set.sh"), root]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("checksum mismatch for release asset: aimux-darwin-arm64.tar.gz");
      expect(result.stderr).toContain("release asset is not a readable tar.gz archive");
      expect(result.stderr).toContain("aimux-darwin-arm64.tar.gz");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("distinguishes a missing checksum file from other release asset failures", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-release-set-"));
    try {
      writeAssetSet(root);
      rmSync(join(root, "aimux-linux-x64.tar.gz.sha256"));

      const result = run("bash", [join(repoRoot, "scripts/verify-release-asset-set.sh"), root]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("missing release checksum file");
      expect(result.stderr).toContain("aimux-linux-x64.tar.gz.sha256");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("distinguishes a missing provenance file from checksum and archive failures", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-release-set-"));
    try {
      writeAssetSet(root);
      rmSync(join(root, "aimux-linux-x64.tar.gz.provenance.json"));

      const result = run("bash", [join(repoRoot, "scripts/verify-release-asset-set.sh"), root]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("missing release provenance file");
      expect(result.stderr).toContain("aimux-linux-x64.tar.gz.provenance.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects stale provenance that names the old artifact digest", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-release-set-"));
    try {
      writeAssetSet(root);
      const asset = "aimux-local-linux-x64.tar.gz";
      const provenancePath = join(root, `${asset}.provenance.json`);
      const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
      provenance.artifact.sha256 = "0".repeat(64);
      writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

      const result = run("bash", [join(repoRoot, "scripts/verify-release-asset-set.sh"), root]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("release provenance verification failed");
      expect(result.stderr).toContain("provenance sha256 mismatch");
      expect(result.stderr).toContain(asset);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an SBOM whose dependency set does not match the asset variant", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-release-set-"));
    try {
      writeAssetSet(root);
      const asset = "aimux-local-linux-x64.tar.gz";
      const sbomPath = join(root, `${asset}.sbom.spdx.json`);
      const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
      sbom.packages = sbom.packages.filter((entry) => entry.name === "aimux");
      writeFileSync(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);

      const result = run("bash", [join(repoRoot, "scripts/verify-release-asset-set.sh"), root]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("SBOM dependency set mismatch");
      expect(result.stderr).toContain(asset);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an archive whose BUILD_VARIANT does not match its asset lane", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-release-set-"));
    try {
      writeAssetSet(root);
      writeReleaseSetArchive(root, "aimux-local-darwin-arm64.tar.gz", "darwin-arm64", "full");

      const result = run("bash", [join(repoRoot, "scripts/verify-release-asset-set.sh"), root]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("release asset BUILD_VARIANT mismatch");
      expect(result.stderr).toContain("expected local, got full");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("check-local-build-boundary.sh", () => {
  it("rejects local binaries containing hosted or remote-control identities", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-local-boundary-"));
    try {
      const binary = join(root, "aimux");
      writeExecutable(
        binary,
        `#!/usr/bin/env sh
if [ "$1" = "--help" ]; then
  printf 'Usage: aimux\\n\\nCommands:\\n  init\\n'
  exit 0
fi
printf 'hosted_server\\n'
`,
      );

      const result = run("bash", [
        join(repoRoot, "scripts/check-local-build-boundary.sh"),
        "--variant",
        "local",
        "--binary",
        binary,
        "--skip-cargo-tree",
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Local binary contains remote-control strings");
      expect(result.stderr).toContain("hosted_server");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a local binary with no remote-control help or strings", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-local-boundary-"));
    try {
      const binary = join(root, "aimux");
      writeExecutable(
        binary,
        `#!/usr/bin/env sh
if [ "$1" = "--help" ]; then
  printf 'Usage: aimux\\n\\nCommands:\\n  init\\n'
  exit 0
fi
printf 'local aimux fixture\\n'
`,
      );

      const result = run("bash", [
        join(repoRoot, "scripts/check-local-build-boundary.sh"),
        "--variant",
        "local",
        "--binary",
        binary,
        "--skip-cargo-tree",
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("aimux local build boundary check passed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("release workflow", () => {
  it("keeps the local-only release gate inside the zero-Node script boundary", () => {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const buildReleaseAsset = readFileSync(join(repoRoot, "scripts/build-release-asset.sh"), "utf8");
    const verifyReleaseAssetSet = readFileSync(join(repoRoot, "scripts/verify-release-asset-set.sh"), "utf8");
    const sourceRelease = readFileSync(join(repoRoot, "scripts/build-release-from-source.sh"), "utf8");

    expect(packageJson.scripts["security:local-only:gate"]).toBe("bash scripts/check-local-only-release-gate.sh");
    expect(packageJson.scripts["release:source"]).toBe("bash scripts/build-release-from-source.sh");
    expect(packageJson.scripts["release:source:local"]).toBe("bash scripts/build-local-release-from-source.sh");
    expect(buildReleaseAsset).toContain('bash "$ROOT_DIR/scripts/write-release-provenance.sh"');
    expect(verifyReleaseAssetSet).toContain('bash "$ROOT_DIR/scripts/verify-release-provenance.sh"');
    expect(sourceRelease).toContain('bash "$ROOT_DIR/scripts/verify-release-provenance.sh"');
    expect(sourceRelease).toContain('bash "$ROOT_DIR/scripts/check-local-build-boundary.sh"');
    expect(sourceRelease).toContain("AIMUX_SKIP_POST_INSTALL_RESTART=1");
    expect(
      [
        packageJson.scripts["security:local-only:gate"],
        packageJson.scripts["release:source"],
        packageJson.scripts["release:source:local"],
        buildReleaseAsset,
        verifyReleaseAssetSet,
        sourceRelease,
      ].join("\n"),
    ).not.toMatch(/node\s+["']?\$?[^;\n]*scripts\/(?:check-local-only-release-gate|write-release-provenance|verify-release-provenance)\.mjs/);
  });

  it("repairs PATH before inline archive checks use tar gzip mode", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");

    for (const step of [
      "Verify release asset has no source maps",
      "Verify Darwin notifier helper",
      "Stage macOS native assets for npm package",
    ]) {
      const stepStart = workflow.indexOf(`- name: ${step}`);
      expect(stepStart, `${step} missing`).toBeGreaterThanOrEqual(0);
      const nextStep = workflow.indexOf("\n      - name:", stepStart + 1);
      const body = workflow.slice(stepStart, nextStep === -1 ? undefined : nextStep);
      expect(body).toContain("append_standard_path_dirs");
      const pathRepairCall = body.search(/^\s+append_standard_path_dirs$/m);
      const firstArchiveProbe = body.search(/^\s+(?:if )?tar\s+-[tx]zf/m);
      expect(pathRepairCall, `${step} does not call append_standard_path_dirs`).toBeGreaterThanOrEqual(0);
      expect(firstArchiveProbe, `${step} does not use tar gzip mode`).toBeGreaterThanOrEqual(0);
      expect(pathRepairCall, `${step} must repair PATH before tar gzip mode`).toBeLessThan(firstArchiveProbe);
      expect(body).toMatch(/for command in .*tar.*gzip/);
    }
  });

  it("runs the variant boundary check against every matrix artifact", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");

    expect(workflow).toContain("AIMUX_BUILD_VARIANT: ${{ matrix.variant }}");
    expect(workflow).toContain("- name: Verify release variant boundary");
    expect(workflow).toContain("bash scripts/check-local-build-boundary.sh");
    expect(workflow).toContain("--variant ${{ matrix.variant }}");
    expect(workflow).toContain("--archive release/${{ matrix.asset }}.tar.gz");
    expect(workflow).toContain("--platform-arch ${{ matrix.platform }}-${{ matrix.arch }}");
    expect(workflow).toContain("bash scripts/verify-release-asset-set.sh release-check");
    expect(workflow).toContain("release/${{ matrix.asset }}.tar.gz.provenance.json");
    expect(workflow).toContain("release/${{ matrix.asset }}.tar.gz.sbom.spdx.json");
    expect(workflow).toContain("actions/attest-build-provenance@v2");
    expect(workflow).toContain('gh attestation verify "release-check/${a}.tar.gz"');
    expect(workflow).not.toContain("--local-boundary-checker");
  });

  it("publishes both full and local Homebrew formulas while npm remains full-only", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");

    const npmJob = workflow.slice(workflow.indexOf("  publish-npm:"), workflow.indexOf("  update-homebrew-tap:"));
    const tapJob = workflow.slice(workflow.indexOf("  update-homebrew-tap:"));
    expect(npmJob).toContain("needs: verify-release-assets");
    expect(tapJob).toContain("needs: verify-release-assets");
    expect(workflow).toContain("tap/Formula/aimux-local.rb");
    expect(workflow).toContain('conflicts_with "aimux", because: "both install the aimux command"');
    expect(workflow).toContain("aimux-local-darwin-arm64.tar.gz");
    expect(workflow).toContain('bin.install_symlink libexec/"bin/aimux"');
    const npmStage = workflow.slice(
      workflow.indexOf("- name: Stage macOS native assets for npm package"),
      workflow.indexOf("- name: Verify npm package has no source maps"),
    );
    expect(npmStage).toContain("aimux-darwin-${arch}.tar.gz");
    expect(npmStage).not.toContain("aimux-local");
  });
});
