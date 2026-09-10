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
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
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

function setupRepo() {
  const root = mkdtempSync(join(tmpdir(), "aimux-pre-commit-hook-"));
  const realGit = findCommand("git");
  const rootPackage = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const stagedFmtCommand = rootPackage.scripts["native:fmt:staged"];

  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(join(root, ".husky"), { recursive: true });
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });

  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      type: "module",
      scripts: {
        "native:fmt:staged": stagedFmtCommand,
        typecheck: "node -e \"\"",
      },
    }),
  );
  for (const scriptPath of stagedFmtCommand.match(/scripts\/\S+/g) ?? []) {
    copyFileSync(join(repoRoot, scriptPath), join(root, scriptPath));
  }
  copyFileSync(join(repoRoot, ".husky/pre-commit"), join(root, ".husky/pre-commit"));
  chmodSync(join(root, ".husky/pre-commit"), 0o755);

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

  runOk(root, "git", ["init", "-q"]);
  runOk(root, "git", ["config", "user.email", "test@example.com"]);
  runOk(root, "git", ["config", "user.name", "Aimux Test"]);
  writeFileSync(join(root, "src/lib.rs"), "pub fn committed() {\n    println!(\"ok\");\n}\n");
  writeFileSync(join(root, "src/hook.ts"), "export const hook = true;\n");
  writeFileSync(join(root, "notes.txt"), "committed\n");
  runOk(root, "git", ["add", "src/lib.rs", "src/hook.ts", "notes.txt"]);
  runOk(root, "git", ["commit", "-q", "-m", "initial"]);

  return { root, realGit };
}

function hookEnv(root, realGit, extra = {}) {
  return {
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    GIT_STASH_LOG: join(root, "stash.log"),
    LINT_STAGED_LOG: join(root, "lint-staged.log"),
    REAL_GIT_BIN: realGit,
    ...extra,
  };
}

function stashLog(root) {
  const path = join(root, "stash.log");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
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

  it("passes no-stash flags to lint-staged without hiding unstaged edits", () => {
    const { root, realGit } = setupRepo();
    try {
      writeFileSync(
        join(root, "src/lib.rs"),
        "pub fn staged_clean() {\n    println!(\"clean\");\n}\n",
      );
      writeFileSync(join(root, "src/hook.ts"), "export const hook = false;\n");
      runOk(root, "git", ["add", "src/lib.rs", "src/hook.ts"]);

      const unstagedRust = "pub fn staged_clean(){println!(\"unstaged bad\");}\n";
      const unstagedNotes = "committed\nunstaged note\n";
      writeFileSync(join(root, "src/lib.rs"), unstagedRust);
      writeFileSync(join(root, "notes.txt"), unstagedNotes);
      const beforeStash = runOk(root, "git", ["stash", "list"]).stdout;

      const result = run(root, "sh", [".husky/pre-commit"], {
        env: hookEnv(root, realGit),
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(root, "src/lib.rs"), "utf8")).toBe(unstagedRust);
      expect(readFileSync(join(root, "notes.txt"), "utf8")).toBe(unstagedNotes);
      expect(runOk(root, "git", ["stash", "list"]).stdout).toBe(beforeStash);
      expect(stashLog(root)).toBe("");

      const lintArgs = JSON.parse(readFileSync(join(root, "lint-staged.log"), "utf8"));
      expect(lintArgs).toContain("--no-stash");
      expect(lintArgs).toContain("--no-hide-partially-staged");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
