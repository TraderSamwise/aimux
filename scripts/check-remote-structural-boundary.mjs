#!/usr/bin/env node
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(scriptPath, "..", "..");

const remoteDependencyPattern = /(^|[\s├─└│])(?:tokio-tungstenite|tungstenite|ureq)\s+v/m;
const oldRemoteModulePaths = [
  "hosted_audit.rs",
  "hosted_auth.rs",
  "hosted_cli.rs",
  "hosted_config.rs",
  "hosted_events.rs",
  "hosted_lock.rs",
  "hosted_lockdown.rs",
  "hosted_outbox.rs",
  "hosted_principals.rs",
  "hosted_rate_limit.rs",
  "hosted_server.rs",
  "relay_client.rs",
  "relay_runner.rs",
  "remote_credentials.rs",
  "remote_login.rs",
  "remote_security_devices.rs",
  "daemon/relay.rs",
];

function usage() {
  console.log(`Usage: scripts/check-remote-structural-boundary.mjs [options]

Mechanically checks the remote-control source boundary.

Options:
  --variant <local|full>       Boundary to check (default: local)
  --source-root <path>         Repository root to inspect
  --target-dir <path>          Cargo target dir for dep-info lookup/build output
  --dep-info-file <path>       Read compiled-source dep-info from this file instead of building
  --cargo-tree-file <path>     Read cargo tree output from this file instead of running cargo tree
  --skip-build                 Do not run cargo build; requires --dep-info-file
  --skip-cargo-tree            Do not inspect cargo tree
  -h, --help                   Show this help
`);
}

function fail(message) {
  console.error(`remote structural boundary check failed: ${message}`);
  process.exit(1);
}

function run(args, { cwd, env, timeout = 900 } = {}) {
  console.log(`$ ${args.join(" ")}`);
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    env,
    encoding: "utf8",
    timeout: timeout * 1000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  console.log(`exit=${result.status ?? 124}`);
  if (result.error) {
    fail(`${args[0]} could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`command failed with exit ${result.status}: ${args.join(" ")}`);
  }
  return result.stdout;
}

function walkFiles(root) {
  const files = [];
  function walk(path) {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) walk(join(path, name));
      return;
    }
    files.push(path);
  }
  walk(root);
  return files;
}

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    fail(`could not read ${path}: ${error.message}`);
  }
}

function normalizePathForMatch(path) {
  return path.split(sep).join("/");
}

function assertSingleGatedRemoteModule(sourceRoot) {
  const libPath = join(sourceRoot, "native/crates/aimux/src/lib.rs");
  const lib = read(libPath);
  const lines = lib.split(/\r?\n/);
  const remoteDecls = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*pub\s+mod\s+remote\s*;\s*$/.test(lines[index])) {
      let previous = index - 1;
      while (previous >= 0 && lines[previous].trim() === "") previous -= 1;
      remoteDecls.push({
        line: index + 1,
        gated: lines[previous]?.trim() === '#[cfg(feature = "remote-control")]',
      });
    }
  }
  if (remoteDecls.length !== 1 || !remoteDecls[0].gated) {
    fail(
      `expected exactly one #[cfg(feature = "remote-control")] pub mod remote; declaration in ${relative(
        sourceRoot,
        libPath,
      )}, got ${JSON.stringify(remoteDecls)}`,
    );
  }
  const srcRoot = join(sourceRoot, "native/crates/aimux/src");
  const remoteRoot = join(srcRoot, "remote");
  const remoteFiles = walkFiles(remoteRoot).filter((path) => path.endsWith(".rs"));
  if (remoteFiles.length === 0) {
    fail(`expected remote source tree with Rust files at ${relative(sourceRoot, remoteRoot)}`);
  }
  const oldPaths = oldRemoteModulePaths.filter((path) => {
    try {
      return statSync(join(srcRoot, path)).isFile();
    } catch {
      return false;
    }
  });
  if (oldPaths.length > 0) {
    fail(`remote-control source files remain outside src/remote: ${oldPaths.join(", ")}`);
  }
  return remoteFiles;
}

function buildAndCollectDepInfo({ sourceRoot, targetDir, variant }) {
  const env = { ...process.env, CARGO_INCREMENTAL: process.env.CARGO_INCREMENTAL ?? "0" };
  const args = ["cargo", "build", "--manifest-path", "native/Cargo.toml", "-p", "aimux", "--release"];
  if (variant === "local") {
    args.push("--no-default-features");
    env.AIMUX_BUILD_VARIANT = env.AIMUX_BUILD_VARIANT ?? "local";
  } else {
    env.AIMUX_BUILD_VARIANT = env.AIMUX_BUILD_VARIANT ?? "full";
  }
  if (!targetDir) {
    targetDir = mkdtempSync(join(tmpdir(), `aimux-remote-structural-${variant}-`));
  }
  env.CARGO_TARGET_DIR = targetDir;
  run(args, { cwd: sourceRoot, env });
  return walkFiles(targetDir)
    .filter((path) => path.endsWith(".d"))
    .map((path) => read(path))
    .join("\n");
}

function depInfoText({ sourceRoot, targetDir, depInfoFile, skipBuild, variant }) {
  if (depInfoFile) return read(depInfoFile);
  if (skipBuild) fail("--skip-build requires --dep-info-file");
  return buildAndCollectDepInfo({ sourceRoot, targetDir, variant });
}

function assertCompiledUnitBoundary({ variant, sourceRoot, remoteFiles, depInfo }) {
  const normalizedDepInfo = normalizePathForMatch(depInfo);
  const remoteHits = remoteFiles
    .map((path) => normalizePathForMatch(relative(sourceRoot, path)))
    .filter((relativePath) => normalizedDepInfo.includes(relativePath));
  if (variant === "local" && remoteHits.length > 0) {
    fail(`local build compiled remote source files: ${remoteHits.join(", ")}`);
  }
  if (variant === "full" && remoteHits.length === 0) {
    fail("full build dep-info did not include any src/remote Rust files");
  }
  console.log(
    `remote compiled-unit boundary ${variant}: remote_source_files=${remoteFiles.length} compiled_remote_hits=${remoteHits.length}`,
  );
}

function cargoTreeText({ sourceRoot, cargoTreeFile, skipCargoTree, variant }) {
  if (skipCargoTree) return "";
  if (cargoTreeFile) return read(cargoTreeFile);
  const args = ["cargo", "tree", "--manifest-path", "native/Cargo.toml", "-p", "aimux"];
  if (variant === "local") args.push("--no-default-features");
  return run(args, { cwd: sourceRoot, timeout: 120 });
}

function assertDependencyBoundary({ variant, tree }) {
  if (!tree) return;
  const hasRemoteDependency = remoteDependencyPattern.test(tree);
  if (variant === "local" && hasRemoteDependency) {
    fail("local cargo tree contains remote-control dependencies");
  }
  if (variant === "full" && !hasRemoteDependency) {
    fail("full cargo tree is missing remote-control dependencies");
  }
  console.log(`remote dependency boundary ${variant}: remote_dependency_present=${hasRemoteDependency}`);
}

function parseArgs(argv) {
  const args = {
    variant: "local",
    sourceRoot: repoRoot,
    targetDir: "",
    depInfoFile: "",
    cargoTreeFile: "",
    skipBuild: false,
    skipCargoTree: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--variant":
        args.variant = argv[++index] ?? "";
        break;
      case "--source-root":
        args.sourceRoot = resolve(argv[++index] ?? "");
        break;
      case "--target-dir":
        args.targetDir = resolve(argv[++index] ?? "");
        break;
      case "--dep-info-file":
        args.depInfoFile = resolve(argv[++index] ?? "");
        break;
      case "--cargo-tree-file":
        args.cargoTreeFile = resolve(argv[++index] ?? "");
        break;
      case "--skip-build":
        args.skipBuild = true;
        break;
      case "--skip-cargo-tree":
        args.skipCargoTree = true;
        break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${arg}`);
    }
  }
  if (!["local", "full"].includes(args.variant)) {
    fail(`unsupported variant: ${args.variant}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const remoteFiles = assertSingleGatedRemoteModule(args.sourceRoot);
const depInfo = depInfoText(args);
assertCompiledUnitBoundary({ ...args, remoteFiles, depInfo });
const tree = cargoTreeText(args);
assertDependencyBoundary({ ...args, tree });
console.log(`remote structural boundary check passed for ${args.variant}`);
