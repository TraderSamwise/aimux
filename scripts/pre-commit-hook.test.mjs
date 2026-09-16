import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(cwd, command, args, options = {}) {
  return spawnSync(command, args, {
    cwd,
    encoding: options.encoding ?? "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
    input: options.input,
    stdio: options.stdio ?? ["pipe", "pipe", "pipe"],
  });
}

function runOk(cwd, command, args, options = {}) {
  const result = run(cwd, command, args, options);
  expect(result.status, `${command} ${args.join(" ")}\n${result.stderr}`).toBe(0);
  return result;
}

function findCommand(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

const copiedScripts = [
  "scripts/check-commit-hook-attestations.sh",
  "scripts/check-index-native-clippy.sh",
  "scripts/check-index-typecheck.sh",
  "scripts/check-staged-rustfmt.sh",
  "scripts/commit-msg-hook.sh",
  "scripts/post-commit-hook.sh",
  "scripts/pre-commit.sh",
  "scripts/pre-push-hook.sh",
];

const copiedHooks = [".husky/commit-msg", ".husky/post-commit", ".husky/pre-commit", ".husky/pre-push"];
const copiedHookShims = [
  ".husky/_/commit-msg",
  ".husky/_/h",
  ".husky/_/post-commit",
  ".husky/_/pre-commit",
  ".husky/_/pre-push",
];

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), "aimux-pre-commit-hook-"));
  const realGit = findCommand("git");
  const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const stagedFmtCommand = rootPackage.scripts["native:fmt:staged"];
  const hookAttestCommand = rootPackage.scripts["hook:attest"];

  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, ".husky/_"), { recursive: true });
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: {
        "native:fmt:staged": stagedFmtCommand,
        "hook:attest": hookAttestCommand,
        typecheck: "node -e \"\"",
        "verify:push": "yarn typecheck && yarn hook:attest",
      },
    }),
  );

  for (const scriptPath of copiedScripts) {
    copyFileSync(join(repoRoot, scriptPath), join(root, scriptPath));
    chmodSync(join(root, scriptPath), 0o755);
  }
  for (const hookPath of copiedHooks) {
    copyFileSync(join(repoRoot, hookPath), join(root, hookPath));
    chmodSync(join(root, hookPath), 0o755);
  }
  for (const hookPath of copiedHookShims) {
    copyFileSync(join(repoRoot, hookPath), join(root, hookPath));
    chmodSync(join(root, hookPath), 0o755);
  }

  const lintShim = join(root, "node_modules/.bin/lint-staged");
  writeFileSync(
    lintShim,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
appendFileSync(process.env.LINT_STAGED_LOG, JSON.stringify(args) + "\\n");
if (!args.includes("--no-stash")) {
  spawnSync("git", ["stash", "push", "-u", "-k", "-m", "aimux hook fixture backup"], { stdio: "ignore" });
  spawnSync("git", ["stash", "pop", "--quiet"], { stdio: "ignore" });
}
process.exit(0);
`,
  );
  chmodSync(lintShim, 0o755);

  const gitWrapper = join(root, "bin/git");
  writeFileSync(
    gitWrapper,
    `#!/bin/sh
if [ "$1" = "stash" ]; then
  printf '%s\\n' "$*" >> "$GIT_STASH_LOG"
fi
exec "$REAL_GIT_BIN" "$@"
`,
  );
  chmodSync(gitWrapper, 0o755);

  const npxWrapper = join(root, "bin/npx");
  writeFileSync(
    npxWrapper,
    `#!/bin/sh
if [ "$1" = "lint-staged" ]; then
  shift
  exec "$PWD/node_modules/.bin/lint-staged" "$@"
fi
printf 'unexpected npx command: %s\\n' "$*" >&2
exit 127
`,
  );
  chmodSync(npxWrapper, 0o755);

  const rustfmtWrapper = join(root, "bin/rustfmt");
  writeFileSync(
    rustfmtWrapper,
    `#!/bin/sh
last=""
for arg in "$@"; do
  last="$arg"
done
if grep -q 'bad(){' "$last"; then
  printf 'fixture rustfmt rejected %s\\n' "$last" >&2
  exit 1
fi
exit 0
`,
  );
  chmodSync(rustfmtWrapper, 0o755);

  const yarnWrapper = join(root, "bin/yarn");
  writeFileSync(
    yarnWrapper,
    `#!/bin/sh
printf '%s|%s\\n' "$PWD" "$*" >> "$YARN_LOG"
case "$1" in
  native:fmt:staged)
    exec bash scripts/check-staged-rustfmt.sh
    ;;
  typecheck)
    if [ -f src/foreign.ts ] && grep -q 'UNSTAGED_TYPE_ERROR' src/foreign.ts; then
      printf 'typecheck saw foreign unstaged file in %s\\n' "$PWD" >&2
      exit 42
    fi
    exit 0
    ;;
  hook:attest)
    exec bash scripts/check-commit-hook-attestations.sh
    ;;
  verify:push)
    exec bash scripts/check-commit-hook-attestations.sh "$AIMUX_HOOK_ATTESTATION_RANGE"
    ;;
esac
printf 'unexpected yarn command: %s\\n' "$*" >&2
exit 127
`,
  );
  chmodSync(yarnWrapper, 0o755);

  const cargoWrapper = join(root, "bin/cargo");
  writeFileSync(
    cargoWrapper,
    `#!/bin/sh
printf '%s|%s\\n' "$PWD" "$*" >> "$CARGO_LOG"
if [ "$1" = "clippy" ]; then
  if grep -R "CLIPPY_FAIL" native/crates/aimux/tests >/dev/null 2>&1; then
    printf 'fixture clippy rejected staged Rust\\n' >&2
    exit 101
  fi
  exit 0
fi
printf 'unexpected cargo command: %s\\n' "$*" >&2
exit 127
`,
  );
  chmodSync(cargoWrapper, 0o755);

  mkdirSync(join(root, "native/crates/aimux/src"), { recursive: true });
  mkdirSync(join(root, "native/crates/aimux/tests"), { recursive: true });
  writeFileSync(join(root, "native/Cargo.toml"), "[workspace]\nmembers = [\"crates/aimux\"]\n");
  writeFileSync(join(root, "native/crates/aimux/Cargo.toml"), "[package]\nname = \"aimux\"\nversion = \"0.1.0\"\nedition = \"2024\"\n");
  writeFileSync(join(root, "native/crates/aimux/src/lib.rs"), "pub fn native() {}\n");

  runOk(root, "git", ["init", "-q"]);
  runOk(root, "git", ["config", "user.email", "test@example.com"]);
  runOk(root, "git", ["config", "user.name", "Aimux Test"]);
  writeFileSync(join(root, "src/lib.rs"), "pub fn committed() {\n    println!(\"ok\");\n}\n");
  writeFileSync(join(root, "src/hook.ts"), "export const hook = true;\n");
  writeFileSync(join(root, "notes.txt"), "committed\n");
  runOk(root, "git", ["add", ".husky/_/commit-msg", ".husky/_/h", ".husky/_/post-commit"]);
  runOk(root, "git", ["add", ".husky/_/pre-commit", ".husky/_/pre-push"]);
  runOk(root, "git", ["add", ".husky/commit-msg", ".husky/post-commit", ".husky/pre-commit"]);
  runOk(root, "git", ["add", ".husky/pre-push", "package.json", "scripts", "src/lib.rs"]);
  runOk(root, "git", ["add", "native"]);
  runOk(root, "git", ["add", "src/hook.ts", "notes.txt"]);
  runOk(root, "git", ["commit", "-q", "-m", "initial hook baseline"]);
  runOk(root, "git", ["config", "core.hooksPath", ".husky/_"]);

  return { root, realGit };
}

function hookEnv(root, realGit, extra = {}) {
  return {
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    GIT_STASH_LOG: join(root, "stash.log"),
    LINT_STAGED_LOG: join(root, "lint-staged.log"),
    REAL_GIT_BIN: realGit,
    YARN_LOG: join(root, "yarn.log"),
    CARGO_LOG: join(root, "cargo.log"),
    ...extra,
  };
}

function stashLog(root) {
  const path = join(root, "stash.log");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function commitBody(root) {
  return runOk(root, "git", ["show", "-s", "--format=%B", "HEAD"]).stdout;
}

function commitTree(root) {
  return runOk(root, "git", ["show", "-s", "--format=%T", "HEAD"]).stdout.trim();
}

function makeBypassedCommit(root) {
  const parent = runOk(root, "git", ["rev-parse", "HEAD"]).stdout.trim();
  writeFileSync(join(root, "src/hook.ts"), "export const hook = 'bypassed';\n");
  runOk(root, "git", ["add", "src/hook.ts"]);
  const tree = runOk(root, "git", ["write-tree"]).stdout.trim();
  const commit = runOk(root, "git", ["commit-tree", tree, "-p", parent, "-m", "bypassed commit"]).stdout.trim();
  runOk(root, "git", ["update-ref", "refs/heads/master", commit]);
  return { parent, commit };
}

describe("pre-commit hook", () => {
  it("checks staged Rust blobs and preserves unrelated unstaged edits", () => {
    const { root, realGit } = setupRepo();
    try {
      writeFileSync(join(root, "src/lib.rs"), "pub fn bad(){println!(\"staged\");}\n");
      runOk(root, "git", ["add", "src/lib.rs"]);
      const unstagedNotes = "committed\nunstaged note\n";
      writeFileSync(join(root, "notes.txt"), unstagedNotes);
      const beforeStash = runOk(root, "git", ["stash", "list"]).stdout;

      const result = run(root, "sh", [".husky/pre-commit"], {
        env: hookEnv(root, realGit),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("staged Rust file is not rustfmt-clean: src/lib.rs");
      expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe(unstagedNotes);
      expect(runOk(root, "git", ["stash", "list"]).stdout).toBe(beforeStash);
      expect(stashLog(root)).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("commits staged paths with dirty foreign edits, runs hooks, and records an attestation", () => {
    const { root, realGit } = setupRepo();
    try {
      writeFileSync(join(root, "src/hook.ts"), "export const hook = false;\n");
      runOk(root, "git", ["add", "src/hook.ts"]);

      const foreignBytes = "export const broken: number = 'UNSTAGED_TYPE_ERROR';\n";
      writeFileSync(join(root, "src/foreign.ts"), foreignBytes);
      const beforeStash = runOk(root, "git", ["stash", "list"]).stdout;

      const result = run(root, "git", ["commit", "-m", "stage own change"], {
        env: hookEnv(root, realGit),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(root, "src/foreign.ts"), "utf8")).toBe(foreignBytes);
      expect(runOk(root, "git", ["stash", "list"]).stdout).toBe(beforeStash);
      expect(stashLog(root)).toBe("");

      const lintArgs = JSON.parse(readFileSync(join(root, "lint-staged.log"), "utf8"));
      expect(lintArgs).toContain("--no-stash");
      expect(lintArgs).toContain("--no-hide-partially-staged");

      const yarnLog = readFileSync(join(root, "yarn.log"), "utf8");
      expect(yarnLog).toContain("native:fmt:staged");
      expect(yarnLog).toContain("typecheck");
      expect(yarnLog).not.toContain(`${root}|typecheck`);
      expect(yarnLog).toMatch(/aimux-index-typecheck-[^|]+\|typecheck/);

      const tree = commitTree(root);
      expect(commitBody(root)).toContain(`Aimux-Pre-Commit: ${tree}`);
      const attest = run(root, "bash", ["scripts/check-commit-hook-attestations.sh", "HEAD^..HEAD"]);
      expect(attest.status, attest.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects delivery when staged Rust fails the all-target clippy gate", () => {
    const { root, realGit } = setupRepo();
    try {
      writeFileSync(join(root, "native/crates/aimux/tests/clippy_fail.rs"), "const CLIPPY_FAIL: bool = true;\n");
      runOk(root, "git", ["add", "native/crates/aimux/tests/clippy_fail.rs"]);

      const result = run(root, "git", ["commit", "-m", "bad rust"], {
        env: hookEnv(root, realGit),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("fixture clippy rejected staged Rust");
      expect(readFileSync(join(root, "cargo.log"), "utf8")).toContain(
        "clippy --manifest-path native/Cargo.toml -p aimux --all-targets -- -D warnings",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows delivery after the staged Rust clippy violation is fixed", () => {
    const { root, realGit } = setupRepo();
    try {
      writeFileSync(join(root, "native/crates/aimux/tests/clippy_pass.rs"), "const CLIPPY_PASS: bool = true;\n");
      runOk(root, "git", ["add", "native/crates/aimux/tests/clippy_pass.rs"]);

      const result = run(root, "git", ["commit", "-m", "good rust"], {
        env: hookEnv(root, realGit),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(root, "cargo.log"), "utf8")).toContain(
        "clippy --manifest-path native/Cargo.toml -p aimux --all-targets -- -D warnings",
      );
      const tree = commitTree(root);
      expect(commitBody(root)).toContain(`Aimux-Pre-Commit: ${tree}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a commit that bypassed the hooks and has no attestation", () => {
    const { root, realGit } = setupRepo();
    try {
      const { parent } = makeBypassedCommit(root);

      const result = run(root, "bash", ["scripts/check-commit-hook-attestations.sh", `${parent}..HEAD`], {
        env: hookEnv(root, realGit),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("is missing Aimux-Pre-Commit");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pre-push rejects an update containing an unattested commit", () => {
    const { root, realGit } = setupRepo();
    try {
      const { parent, commit } = makeBypassedCommit(root);
      const input = `refs/heads/master ${commit} refs/heads/master ${parent}\n`;

      const result = run(root, "bash", ["scripts/pre-push-hook.sh"], {
        env: hookEnv(root, realGit, {
          AIMUX_HOOK_ATTESTATION_RANGE: `${parent}..${commit}`,
        }),
        input,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("is missing Aimux-Pre-Commit");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows merge commits without requiring a local hook attestation", () => {
    const { root, realGit } = setupRepo();
    try {
      runOk(root, "git", ["checkout", "-q", "-b", "side"]);
      writeFileSync(join(root, "notes.txt"), "committed\nside branch\n");
      runOk(root, "git", ["add", "notes.txt"]);
      runOk(root, "git", ["commit", "-m", "side change"], {
        env: hookEnv(root, realGit),
      });

      runOk(root, "git", ["checkout", "-q", "master"]);
      writeFileSync(join(root, "src/hook.ts"), "export const hook = 'master';\n");
      runOk(root, "git", ["add", "src/hook.ts"]);
      runOk(root, "git", ["commit", "-m", "master change"], {
        env: hookEnv(root, realGit),
      });

      const result = run(root, "git", ["merge", "--no-ff", "-m", "merge side", "side"], {
        env: hookEnv(root, realGit),
      });

      expect(result.status, result.stderr).toBe(0);
      const attest = run(root, "bash", ["scripts/check-commit-hook-attestations.sh", "HEAD^..HEAD"]);
      expect(attest.status, attest.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
