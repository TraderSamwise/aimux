#!/usr/bin/env node
// Caps test-runner parallelism on developer machines and enforces the repo's
// pinned Node runtime before loading Vitest/Rolldown.
// Override local parallelism with TEST_CONCURRENCY / TURBO_CONCURRENCY.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { nodeVersionGuardAction, readPinnedNodeVersion, repoRootFromScriptUrl } from "./node-version-guard.mjs";

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.error("usage: node scripts/captest.mjs <command> [args...]");
  process.exit(1);
}

const vars = process.env;
const repoRoot = repoRootFromScriptUrl(import.meta.url);
const pinnedNodeVersion = readPinnedNodeVersion(repoRoot);
const nodeVersionAction = nodeVersionGuardAction({
  currentVersion: process.version,
  pinnedVersion: pinnedNodeVersion,
  nvmDir: vars.NVM_DIR,
  ci: Boolean(vars.CI),
  alreadyRetried: vars.AIMUX_CAPTEST_NODE_REEXEC === "1",
});
if (nodeVersionAction.kind === "error") {
  console.error(nodeVersionAction.message);
  process.exit(1);
}
if (nodeVersionAction.kind === "reexec") {
  const scriptPath = fileURLToPath(import.meta.url);
  const child = spawn(
    "bash",
    [
      "-lc",
      'source "$1" && version="$2" && shift 2 && nvm exec --silent "$version" node "$@"',
      "aimux-captest-nvm",
      nodeVersionAction.nvmScript,
      nodeVersionAction.pinnedVersion,
      scriptPath,
      ...argv,
    ],
    {
      stdio: "inherit",
      env: { ...vars, AIMUX_CAPTEST_NODE_REEXEC: "1" },
    },
  );
  child.on("error", (error) => {
    console.error(`failed to re-run JS tests with Node ${nodeVersionAction.pinnedVersion}: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
} else {
  const childEnv = { ...vars };
  const args = [...argv];

  if (!vars.CI) {
    const workers = vars.TEST_CONCURRENCY || "4";
    // vitest v4 reads MAX_WORKERS; v3 reads MAX_FORKS/MAX_THREADS. Extras are ignored.
    childEnv.VITEST_MAX_WORKERS ||= workers;
    childEnv.VITEST_MAX_FORKS ||= workers;
    childEnv.VITEST_MAX_THREADS ||= workers;

    const passthrough = args.indexOf("--");
    const end = passthrough === -1 ? args.length : passthrough;
    const head = args.slice(0, end);

    if (args[0] === "turbo" && !head.some((a) => a.startsWith("--concurrency"))) {
      args.splice(end, 0, `--concurrency=${vars.TURBO_CONCURRENCY || "2"}`);
    }
    if (head.includes("--test") && !head.some((a) => a.startsWith("--test-concurrency"))) {
      args.splice(1, 0, `--test-concurrency=${workers}`);
    }
  }

  const child = spawn(args[0], args.slice(1), { stdio: "inherit", env: childEnv });
  child.on("error", (error) => {
    console.error(`failed to start JS test command "${args[0]}": ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}
