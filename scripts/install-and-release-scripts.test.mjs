import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function createInstallArchive(root) {
  const archiveRoot = join(root, "archive");
  const packageRoot = join(archiveRoot, "aimux");
  const nativeDir = join(packageRoot, "native", platformArch());
  mkdirSync(nativeDir, { recursive: true });
  writeFileSync(join(packageRoot, "VERSION"), "local-test\n");
  writeFileSync(join(packageRoot, "BUILD_STAMP"), "test-stamp\n");
  const nativeBinary = join(nativeDir, "aimux");
  writeFileSync(
    nativeBinary,
    `#!/usr/bin/env sh
if [ "$1" = "restart" ]; then
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

function createReleaseArchive(root, stamp = "test-release-stamp") {
  const archiveRoot = join(root, "archive");
  const packageRoot = join(archiveRoot, "aimux");
  const nativeDir = join(packageRoot, "native", platformArch());
  mkdirSync(nativeDir, { recursive: true });
  writeFileSync(join(packageRoot, "BUILD_STAMP"), `${stamp}\n`);
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
mkdir -p "$CARGO_TARGET_DIR/release"
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
printf 'unexpected yarn command: %s\\n' "$*" >&2
exit 127
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
        env: installEnv(root, 37),
      });

      expect(result.status).toBe(75);
      expect(result.stderr).toContain("post-install restart failed");
      expect(result.stderr).toContain(`${join(root, "bin")}/aimux restart`);
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
      expect(result.stdout).toContain(`Built ${join(root, "release", "aimux-linux-x64.tar.gz")}`);
      const stamp = readFileSync(join(root, "release", "aimux-linux-x64.tar.gz.sha256"), "utf8");
      expect(stamp).toContain("aimux-linux-x64.tar.gz");
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
});

describe("release workflow", () => {
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
});
