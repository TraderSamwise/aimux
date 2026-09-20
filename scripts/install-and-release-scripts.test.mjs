import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
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
  writeFileSync(join(packageRoot, "PACKAGE_PROFILE"), "full\n");
  writeFileSync(join(packageRoot, "BUILD_PROFILE"), "full\n");
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
  writeFileSync(join(packageRoot, "PACKAGE_PROFILE"), "full\n");
  writeFileSync(join(packageRoot, "BUILD_PROFILE"), "full\n");
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

function writeLauncherFixture(root) {
  const packageRoot = join(root, "package", "aimux");
  const packageBin = join(packageRoot, "bin");
  const nativeDir = join(packageRoot, "native", platformArch());
  mkdirSync(packageBin, { recursive: true });
  mkdirSync(nativeDir, { recursive: true });
  const launcher = join(packageBin, "aimux");
  writeFileSync(launcher, readFileSync(join(repoRoot, "bin/aimux")));
  chmodSync(launcher, 0o755);
  writeExecutable(
    join(nativeDir, "aimux"),
    `#!/usr/bin/env sh
printf 'native-from-package-root %s\\n' "$AIMUX_ROOT"
`,
  );
  return launcher;
}

function writeExecutable(path, body) {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function writeFakeBrew(binDir) {
  writeExecutable(
    join(binDir, "brew"),
    `#!/bin/sh
if [ -n "\${AIMUX_FAKE_BREW_LOG:-}" ]; then
  printf '%s\\n' "$*" >> "$AIMUX_FAKE_BREW_LOG"
fi
case "$1" in
  --repo)
    if [ -z "\${AIMUX_FAKE_BREW_TAP_REPO:-}" ] || [ ! -d "\${AIMUX_FAKE_BREW_TAP_REPO:-}" ]; then
      exit 1
    fi
    printf '%s\\n' "$AIMUX_FAKE_BREW_TAP_REPO"
    exit 0
    ;;
  tap-new)
    if [ -z "\${AIMUX_FAKE_BREW_TAP_REPO:-}" ]; then
      printf 'missing AIMUX_FAKE_BREW_TAP_REPO\\n' >&2
      exit 2
    fi
    mkdir -p "$AIMUX_FAKE_BREW_TAP_REPO/Formula"
    exit 0
    ;;
  tap)
    if [ -n "\${AIMUX_FAKE_BREW_TAP_REPO:-}" ] && [ -d "$AIMUX_FAKE_BREW_TAP_REPO" ]; then
      printf 'aimux/dry-run-fixture\\n'
    fi
    exit 0
    ;;
  untap)
    exit 0
    ;;
  ruby)
    exit 0
    ;;
  fetch)
    formula=""
    previous=""
    for arg in "$@"; do
      if [ "$previous" = "--formula" ]; then
        formula="$arg"
        break
      fi
      previous="$arg"
    done
    if [ -z "$formula" ]; then
      printf 'missing --formula\\n' >&2
      exit 2
    fi
    case "$formula" in
      */aimux-local) formula="$AIMUX_FAKE_BREW_TAP_REPO/Formula/aimux-local.rb" ;;
      */aimux) formula="$AIMUX_FAKE_BREW_TAP_REPO/Formula/aimux.rb" ;;
    esac
    if grep -F 'sha256 "0000000000000000000000000000000000000000000000000000000000000000"' "$formula" >/dev/null 2>&1; then
      printf 'SHA256 mismatch for %s\\n' "$formula" >&2
      exit 1
    fi
    exit 0
    ;;
  list)
    formula=""
    for arg in "$@"; do
      formula="$arg"
    done
    if [ "\${AIMUX_FAKE_BREW_INSTALLED_FORMULA:-}" = "$formula" ]; then
      printf '%s 0.0.0\\n' "$formula"
      exit 0
    fi
    exit 1
    ;;
  *)
    printf 'unexpected fake brew command: %s\\n' "$*" >&2
    exit 127
    ;;
esac
`,
  );
}

function writeLiveFakeBrew(binDir) {
  writeExecutable(
    join(binDir, "brew"),
    `#!/bin/sh
set -eu
prefix="\${AIMUX_FAKE_BREW_PREFIX:?missing AIMUX_FAKE_BREW_PREFIX}"
state="\${AIMUX_FAKE_BREW_STATE:?missing AIMUX_FAKE_BREW_STATE}"
tap_repo="\${AIMUX_FAKE_BREW_TAP_REPO:?missing AIMUX_FAKE_BREW_TAP_REPO}"
log="\${AIMUX_FAKE_BREW_LOG:-}"
if [ -n "$log" ]; then
  printf '%s\\n' "$*" >> "$log"
fi
mkdir -p "$state/installed" "$prefix/bin" "$prefix/Cellar" "$prefix/opt"
case "$1" in
  --prefix)
    if [ "$#" -eq 1 ]; then
      printf '%s\\n' "$prefix"
    else
      printf '%s/opt/%s\\n' "$prefix" "$2"
    fi
    exit 0
    ;;
  --cellar)
    printf '%s/Cellar/%s\\n' "$prefix" "$2"
    exit 0
    ;;
  --repo)
    printf '%s\\n' "$tap_repo"
    exit 0
    ;;
  tap-new)
    mkdir -p "$tap_repo/Formula"
    exit 0
    ;;
  trust)
    exit 0
    ;;
  tap)
    [ -d "$tap_repo" ] && printf 'aimux/dry-run-fixture\\n'
    exit 0
    ;;
  untap)
    exit 0
    ;;
  ruby)
    exit 0
    ;;
  fetch)
    exit 0
    ;;
  deps)
    case "$3" in
      */aimux-local)
        printf 'tmux\\n'
        ;;
      */aimux)
        printf 'tmux\\n'
        ;;
    esac
    exit 0
    ;;
  list)
    formula=""
    for arg in "$@"; do
      formula="$arg"
    done
    if [ -f "$state/installed/$formula" ]; then
      printf '%s 0.0.0\\n' "$formula"
      exit 0
    fi
    exit 1
    ;;
  upgrade|install)
    shift
    while [ "$#" -gt 0 ] && [ "$1" = "--formula" ]; do
      shift
    done
    formula="$1"
    short="\${formula##*/}"
    if [ "$short" = "aimux" ] || [ "$short" = "aimux-local" ]; then
      if [ "$short" = "aimux-local" ] && [ -f "$state/installed/aimux" ]; then
        printf 'conflict: aimux-local conflicts with aimux\\n' >&2
        exit 1
      fi
      if [ "$short" = "aimux" ] && [ -f "$state/installed/aimux-local" ]; then
        printf 'conflict: aimux conflicts with aimux-local\\n' >&2
        exit 1
      fi
      cellar="$prefix/Cellar/$short/0.0.0"
      target="$cellar/libexec/bin/aimux"
      mkdir -p "$(dirname "$target")" "$prefix/opt"
      printf '#!/usr/bin/env sh\\nprintf "aimux fake help %s\\\\n" "$1"\\n' "$short" > "$target"
      chmod 755 "$target"
      ln -sfn "$cellar" "$prefix/opt/$short"
      if [ "\${AIMUX_FAKE_BREW_BROKEN_FORMULA:-}" = "$short" ]; then
        printf '#!/bin/sh\\nexec "%s/libexec/bin/missing-aimux" "$@"\\n' "$cellar" > "$prefix/bin/aimux"
      else
        printf '#!/bin/sh\\nexec "%s" "$@"\\n' "$target" > "$prefix/bin/aimux"
      fi
      chmod 755 "$prefix/bin/aimux"
      touch "$state/installed/$short"
      exit 0
    fi
    if [ "\${AIMUX_FAKE_BREW_DEP_HARD_FAIL:-}" = "$short" ]; then
      printf 'failed to install dependency %s\\n' "$short" >&2
      exit 1
    fi
    touch "$state/installed/$short"
    if [ "\${AIMUX_FAKE_BREW_DEP_FAIL:-}" = "$short" ]; then
      printf 'The post-install step did not complete successfully\\n' >&2
      printf 'You can try again using:\\n  brew postinstall %s\\n' "$short" >&2
      exit 1
    fi
    exit 0
    ;;
  uninstall)
    shift
    [ "\${1:-}" = "--formula" ] && shift
    short="\${1##*/}"
    rm -f "$state/installed/$short"
    rm -rf "$prefix/Cellar/$short" "$prefix/opt/$short"
    if [ "$short" = "aimux" ] || [ "$short" = "aimux-local" ]; then
      rm -f "$prefix/bin/aimux"
    fi
    exit 0
    ;;
  *)
    printf 'unexpected fake brew command: %s\\n' "$*" >&2
    exit 127
    ;;
esac
`,
  );
}

function writeHomebrewGateAssets(root) {
  for (const asset of [`aimux-${platformArch()}.tar.gz`, `aimux-local-${platformArch()}.tar.gz`]) {
    writeFileSync(join(root, asset), `placeholder ${asset}\n`);
    writeFileSync(join(root, `${asset}.sha256`), `${"1".repeat(64)}  ${asset}\n`);
  }
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
    AIMUX_PACKAGE_PROFILE: "minimal",
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
  }, 120000);
});

describe("bin/aimux", () => {
  it("resolves a symlinked launcher back to the package root", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-bin-launcher-"));
    try {
      const launcher = writeLauncherFixture(root);
      const prefixBin = join(root, "prefix", "bin");
      mkdirSync(prefixBin, { recursive: true });
      const symlinkedLauncher = join(prefixBin, "aimux");
      symlinkSync(launcher, symlinkedLauncher);

      const result = run("sh", [symlinkedLauncher, "--version"]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("native-from-package-root");
      expect(result.stdout).toContain(join(root, "package", "aimux"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
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
      const extractDir = join(root, "extract-full");
      mkdirSync(extractDir);
      runOk("tar", ["-xzf", join(root, "release", "aimux-linux-x64.tar.gz"), "-C", extractDir]);
      expect(readFileSync(join(extractDir, "aimux", "PACKAGE_PROFILE"), "utf8").trim()).toBe("minimal");
      expect(readFileSync(join(extractDir, "aimux", "BUILD_PROFILE"), "utf8").trim()).toBe("local");
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
      expect(readFileSync(join(extractDir, "aimux", "PACKAGE_PROFILE"), "utf8").trim()).toBe("minimal");
      expect(readFileSync(join(extractDir, "aimux", "BUILD_PROFILE"), "utf8").trim()).toBe("local");
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
      expect(result.stdout).toContain("Package profile: minimal");
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
      writeFileSync(join(packageRoot, "PACKAGE_PROFILE"), "full\n");
      writeFileSync(join(packageRoot, "BUILD_PROFILE"), "full\n");
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

  it("rejects a release asset without a package profile stamp", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-verify-script-"));
    try {
      const archiveRoot = join(root, "archive");
      const packageRoot = join(archiveRoot, "aimux");
      const nativeDir = join(packageRoot, "native", platformArch());
      mkdirSync(nativeDir, { recursive: true });
      writeFileSync(join(packageRoot, "BUILD_STAMP"), "stamp\n");
      writeFileSync(join(packageRoot, "BUILD_VARIANT"), "full\n");
      const nativeBinary = join(nativeDir, "aimux");
      writeFileSync(nativeBinary, "#!/usr/bin/env sh\nAIMUX_EMBEDDED_BUILD_STAMP=stamp\nexit 0\n");
      chmodSync(nativeBinary, 0o755);
      const archive = join(root, "missing-package-profile.tar.gz");
      runOk("tar", ["-czf", archive, "-C", archiveRoot, "aimux"]);

      const result = run("bash", [join(repoRoot, "scripts/verify-release-asset.sh"), archive, platformArch()], {
        env: releaseScriptEnv(root),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Release archive is missing PACKAGE_PROFILE");
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
    writeFileSync(join(packageRoot, "PACKAGE_PROFILE"), "full\n");
    writeFileSync(join(packageRoot, "BUILD_PROFILE"), "full\n");
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
            packageProfile: "full",
            legacyBuildProfile: "full",
            variant,
            platformArch,
            buildStamp: `stamp-${asset}`,
          },
          artifact: {
            name: asset,
            sha256: shaValue,
            packageProfile: "full",
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
  }, 30000);

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
  }, 30000);

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

  it("per-asset provenance verification rejects stale provenance that names the old artifact digest", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-release-set-"));
    try {
      writeAssetSet(root);
      const asset = "aimux-local-linux-x64.tar.gz";
      const provenancePath = join(root, `${asset}.provenance.json`);
      const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
      provenance.artifact.sha256 = "0".repeat(64);
      writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

      const result = run("bash", [
        join(repoRoot, "scripts/verify-release-provenance.sh"),
        root,
        asset,
        "linux-x64",
        "local",
      ]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("release provenance verification failed");
      expect(result.stderr).toContain("provenance sha256 mismatch");
      expect(result.stderr).toContain(asset);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("per-asset provenance verification rejects an SBOM whose dependency set does not match the asset variant", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-release-set-"));
    try {
      writeAssetSet(root);
      const asset = "aimux-local-linux-x64.tar.gz";
      const sbomPath = join(root, `${asset}.sbom.spdx.json`);
      const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
      sbom.packages = sbom.packages.filter((entry) => entry.name === "aimux");
      writeFileSync(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);

      const result = run("bash", [
        join(repoRoot, "scripts/verify-release-provenance.sh"),
        root,
        asset,
        "linux-x64",
        "local",
      ]);

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
  }, 30000);

  it("stages Homebrew formulas, fetches them, and proves mismatched SHA refusal", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-homebrew-dry-run-"));
    try {
      writeAssetSet(root);
      const stage = join(root, "stage");
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      writeFakeBrew(bin);
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        AIMUX_FAKE_BREW_LOG: join(root, "brew.log"),
        AIMUX_FAKE_BREW_TAP_REPO: join(root, "tap-repo"),
      };

      const result = run(
        "bash",
        [
          join(repoRoot, "scripts/homebrew-release-dry-run.sh"),
          "--release-dir",
          root,
          "--staging-dir",
          stage,
          "--tag",
          "v0.0.0-test",
          "--version",
          "0.0.0",
        ],
        { env },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`Homebrew fetch for aimux ${platformArch()} passed`);
      expect(result.stdout).toContain(`Homebrew fetch for aimux-local ${platformArch()} passed`);
      expect(result.stdout).toContain("Homebrew bad-sha proof passed");
      expect(result.stdout).toContain("live install: 0");
      const localFormula = readFileSync(join(stage, "aimux-local.rb"), "utf8");
      expect(localFormula).toContain('url "file://');
      expect(localFormula).toContain("aimux-local-linux-x64.tar.gz");
      expect(localFormula).toContain('conflicts_with "aimux", because: "both install the aimux command"');
      expect(localFormula).toContain('(bin/"aimux").write_env_script libexec/"bin/aimux", {}');
      expect(localFormula).not.toContain("bin.install_symlink");
      expect(readFileSync(join(root, "brew.log"), "utf8")).toContain("fetch --formula");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("refuses live Homebrew install proof when aimux is already installed", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-homebrew-dry-run-"));
    try {
      writeAssetSet(root);
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      writeFakeBrew(bin);
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        AIMUX_FAKE_BREW_INSTALLED_FORMULA: "aimux",
        AIMUX_FAKE_BREW_TAP_REPO: join(root, "tap-repo"),
      };

      const result = run(
        "bash",
        [
          join(repoRoot, "scripts/homebrew-release-dry-run.sh"),
          "--release-dir",
          root,
          "--staging-dir",
          join(root, "stage"),
          "--live-install",
        ],
        { env },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--live-install refused: aimux is already installed by Homebrew");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("reports dependency preparation failure without failing a good formula gate", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-homebrew-live-gate-"));
    try {
      writeHomebrewGateAssets(root);
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      writeLiveFakeBrew(bin);
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        AIMUX_FAKE_BREW_DEP_FAIL: "tmux",
        AIMUX_FAKE_BREW_LOG: join(root, "brew.log"),
        AIMUX_FAKE_BREW_PREFIX: join(root, "prefix"),
        AIMUX_FAKE_BREW_STATE: join(root, "state"),
        AIMUX_FAKE_BREW_TAP_REPO: join(root, "tap-repo"),
      };

      const result = run(
        "bash",
        [
          join(repoRoot, "scripts/homebrew-release-dry-run.sh"),
          "--release-dir",
          root,
          "--staging-dir",
          join(root, "stage"),
          "--host-only",
          "--live-install",
          "--skip-asset-verification",
          "--skip-bad-sha-proof",
          "--skip-doctor-proof",
        ],
        { env },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("Homebrew dependency preparation failed for tmux");
      expect(result.stderr).toContain("not an aimux formula failure");
      expect(result.stdout).toContain("Homebrew full installed command proof passed");
      expect(result.stdout).toContain("Homebrew local installed command proof passed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("fails during dependency prep when a dependency is not installed", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-homebrew-live-gate-"));
    try {
      writeHomebrewGateAssets(root);
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      writeLiveFakeBrew(bin);
      const brewLog = join(root, "brew.log");
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        AIMUX_FAKE_BREW_DEP_HARD_FAIL: "tmux",
        AIMUX_FAKE_BREW_LOG: brewLog,
        AIMUX_FAKE_BREW_PREFIX: join(root, "prefix"),
        AIMUX_FAKE_BREW_STATE: join(root, "state"),
        AIMUX_FAKE_BREW_TAP_REPO: join(root, "tap-repo"),
      };

      const result = run(
        "bash",
        [
          join(repoRoot, "scripts/homebrew-release-dry-run.sh"),
          "--release-dir",
          root,
          "--staging-dir",
          join(root, "stage"),
          "--host-only",
          "--dependency-prep-only",
          "--skip-asset-verification",
          "--skip-bad-sha-proof",
          "--skip-doctor-proof",
        ],
        { env },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Homebrew dependency preparation failed for tmux");
      expect(result.stderr).toContain("before the dependency was installed");
      expect(result.stderr).toContain("not an aimux formula failure");
      expect(readFileSync(brewLog, "utf8")).not.toContain("install --formula aimux/");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("renders Homebrew bottle blocks from bottle metadata while preserving source assets", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-homebrew-bottle-render-"));
    try {
      const formulaDir = join(root, "Formula");
      const bottleDir = join(root, "bottles");
      mkdirSync(bottleDir, { recursive: true });
      writeFileSync(
        join(bottleDir, "aimux.bottles.tsv"),
        [
          [
            "arm64_golden_gate",
            "any_skip_relocation",
            "a".repeat(64),
            "aimux-0.1.45.arm64_golden_gate.bottle.tar.gz",
            "aimux--0.1.45.arm64_golden_gate.bottle.tar.gz",
          ].join("\t"),
          [
            "sequoia",
            "any_skip_relocation",
            "b".repeat(64),
            "aimux-0.1.45.sequoia.bottle.tar.gz",
            "aimux--0.1.45.sequoia.bottle.tar.gz",
          ].join("\t"),
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(bottleDir, "aimux-local.bottles.tsv"),
        [
          [
            "arm64_golden_gate",
            "any_skip_relocation",
            "c".repeat(64),
            "aimux-local-0.1.45.arm64_golden_gate.bottle.tar.gz",
            "aimux-local--0.1.45.arm64_golden_gate.bottle.tar.gz",
          ].join("\t"),
          "",
        ].join("\n"),
      );

      runOk("bash", [join(repoRoot, "scripts/render-homebrew-formulas.sh")], {
        env: {
          TAG: "v0.1.45",
          VERSION: "0.1.45",
          AIMUX_HOMEBREW_FORMULA_DIR: formulaDir,
          AIMUX_HOMEBREW_BASE_URL: "https://example.test/source",
          AIMUX_HOMEBREW_BOTTLE_DIR: bottleDir,
          AIMUX_HOMEBREW_BOTTLE_ROOT_URL: "https://example.test/bottles",
          DARWIN_ARM64: "1".repeat(64),
          DARWIN_X64: "2".repeat(64),
          LINUX_ARM64: "3".repeat(64),
          LINUX_X64: "4".repeat(64),
          LOCAL_DARWIN_ARM64: "5".repeat(64),
          LOCAL_DARWIN_X64: "6".repeat(64),
          LOCAL_LINUX_ARM64: "7".repeat(64),
          LOCAL_LINUX_X64: "8".repeat(64),
        },
      });

      const fullFormula = readFileSync(join(formulaDir, "aimux.rb"), "utf8");
      const localFormula = readFileSync(join(formulaDir, "aimux-local.rb"), "utf8");
      expect(fullFormula).toContain("bottle do");
      expect(fullFormula).toContain('root_url "https://example.test/bottles"');
      expect(fullFormula).toContain(`sha256 cellar: :any_skip_relocation, arm64_golden_gate: "${"a".repeat(64)}"`);
      expect(fullFormula).toContain(`sha256 cellar: :any_skip_relocation, sequoia: "${"b".repeat(64)}"`);
      expect(fullFormula).toContain('url "https://example.test/source/aimux-darwin-arm64.tar.gz"');
      expect(localFormula).toContain(`sha256 cellar: :any_skip_relocation, arm64_golden_gate: "${"c".repeat(64)}"`);
      expect(localFormula).toContain('url "https://example.test/source/aimux-local-darwin-arm64.tar.gz"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails visibly when Homebrew bottle metadata is corrupt", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-homebrew-bottle-render-"));
    try {
      const formulaDir = join(root, "Formula");
      const bottleDir = join(root, "bottles");
      mkdirSync(bottleDir, { recursive: true });
      writeFileSync(join(bottleDir, "aimux.bottles.tsv"), "arm64_golden_gate\tany_skip_relocation\tnot-a-sha\n");
      writeFileSync(join(bottleDir, "aimux-local.bottles.tsv"), `arm64_golden_gate\tany_skip_relocation\t${"c".repeat(64)}\n`);

      const result = run("bash", [join(repoRoot, "scripts/render-homebrew-formulas.sh")], {
        env: {
          TAG: "v0.1.45",
          VERSION: "0.1.45",
          AIMUX_HOMEBREW_FORMULA_DIR: formulaDir,
          AIMUX_HOMEBREW_BASE_URL: "https://example.test/source",
          AIMUX_HOMEBREW_BOTTLE_DIR: bottleDir,
          DARWIN_ARM64: "1".repeat(64),
          DARWIN_X64: "2".repeat(64),
          LINUX_ARM64: "3".repeat(64),
          LINUX_X64: "4".repeat(64),
          LOCAL_DARWIN_ARM64: "5".repeat(64),
          LOCAL_DARWIN_X64: "6".repeat(64),
          LOCAL_LINUX_ARM64: "7".repeat(64),
          LOCAL_LINUX_X64: "8".repeat(64),
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("invalid bottle sha256 for aimux arm64_golden_gate: not-a-sha");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails the formula gate when the installed aimux wrapper is broken", () => {
    const root = mkdtempSync(join(tmpdir(), "aimux-homebrew-live-gate-"));
    try {
      writeHomebrewGateAssets(root);
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      writeLiveFakeBrew(bin);
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        AIMUX_FAKE_BREW_BROKEN_FORMULA: "aimux",
        AIMUX_FAKE_BREW_PREFIX: join(root, "prefix"),
        AIMUX_FAKE_BREW_STATE: join(root, "state"),
        AIMUX_FAKE_BREW_TAP_REPO: join(root, "tap-repo"),
      };

      const result = run(
        "bash",
        [
          join(repoRoot, "scripts/homebrew-release-dry-run.sh"),
          "--release-dir",
          root,
          "--staging-dir",
          join(root, "stage"),
          "--host-only",
          "--live-install",
          "--skip-asset-verification",
          "--skip-bad-sha-proof",
          "--skip-doctor-proof",
        ],
        { env },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("aimux formula gate failed");
      expect(result.stderr).toContain("installed full command failed --help");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
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
    expect(verifyReleaseAssetSet).not.toContain('bash "$ROOT_DIR/scripts/verify-release-provenance.sh"');
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
    ).not.toMatch(
      /node\s+["']?\$?[^;\n]*scripts\/(?:check-local-only-release-gate|write-release-provenance|verify-release-provenance)\.mjs/,
    );
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
    expect(workflow).toContain("- name: Verify release provenance and SBOM");
    expect(workflow).toContain("bash scripts/verify-release-provenance.sh");
    expect(workflow).toContain("bash scripts/verify-release-asset-set.sh release-check");
    expect(workflow).toContain("release/${{ matrix.asset }}.tar.gz.provenance.json");
    expect(workflow).toContain("release/${{ matrix.asset }}.tar.gz.sbom.spdx.json");
    expect(workflow).toContain("actions/attest-build-provenance@v2");
    expect(workflow).toContain('gh attestation verify "release-check/${a}.tar.gz"');
    expect(workflow).not.toContain("--local-boundary-checker");
  });

  it("publishes both full and local Homebrew formulas while npm remains full-only", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
    const renderer = readFileSync(join(repoRoot, "scripts/render-homebrew-formulas.sh"), "utf8");
    const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

    const npmJob = workflow.slice(workflow.indexOf("  publish-npm:"), workflow.indexOf("  update-homebrew-tap:"));
    const tapJob = workflow.slice(workflow.indexOf("  update-homebrew-tap:"));
    expect(npmJob).toContain("needs: verify-release-assets");
    expect(workflow).toContain("  homebrew-bottles:");
    expect(workflow).toContain("scripts/build-homebrew-bottle.sh");
    expect(workflow).toContain("homebrew-bottles/*.bottle.tar.gz");
    expect(workflow).toContain("homebrew-bottles/*.bottles.tsv");
    expect(tapJob).toContain("- homebrew-bottles");
    expect(tapJob).toContain("AIMUX_HOMEBREW_BOTTLE_DIR: bottle-metadata");
    expect(tapJob).toContain("--pattern \"*.bottles.tsv\"");
    expect(tapJob).toContain("--bottle-dir bottle-metadata");
    expect(tapJob).toContain("--bottle-root-url \"https://github.com/TraderSamwise/aimux/releases/download/${{ steps.meta.outputs.tag }}\"");
    expect(packageJson.scripts["release:homebrew:dry-run"]).toBe("bash scripts/homebrew-release-dry-run.sh");
    expect(workflow).toContain("bash scripts/render-homebrew-formulas.sh");
    expect(workflow).toContain("- name: Prepare Homebrew formula dependencies");
    expect(workflow).toContain("--dependency-prep-only");
    expect(workflow).toContain("- name: Gate Homebrew installed command");
    expect(workflow).toContain("bash scripts/homebrew-release-dry-run.sh \\");
    expect(workflow).toContain("--live-install");
    expect(workflow).toContain("--skip-dependency-prep");
    expect(workflow).toContain("--skip-doctor-proof");
    expect(workflow).toContain("AIMUX_HOMEBREW_FORMULA_DIR: tap/Formula");
    expect(renderer).toContain('conflicts_with "aimux", because: "both install the aimux command"');
    expect(renderer.match(/depends_on "tmux"/g) ?? []).toHaveLength(2);
    expect(renderer).not.toContain('depends_on "openssl@3"');
    expect(renderer).not.toContain('depends_on "jemalloc"');
    expect(renderer).toContain("aimux-local-darwin-arm64.tar.gz");
    expect(renderer).toContain('(bin/"aimux").write_env_script libexec/"bin/aimux", {}');
    expect(renderer).not.toContain("bin.install_symlink");
    const npmStage = workflow.slice(
      workflow.indexOf("- name: Stage macOS native assets for npm package"),
      workflow.indexOf("- name: Verify npm package has no source maps"),
    );
    expect(npmStage).toContain("aimux-darwin-${arch}.tar.gz");
    expect(npmStage).not.toContain("aimux-local");
  });
});
