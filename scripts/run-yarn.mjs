#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const argv = process.argv.slice(2);

if (argv.length === 0) {
  console.error("usage: node scripts/run-yarn.mjs <yarn-args...>");
  process.exit(1);
}

function pinnedYarnVersion() {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const voltaYarn = packageJson.volta?.yarn;
  if (typeof voltaYarn === "string" && voltaYarn.trim() !== "") return voltaYarn.trim();

  const packageManager = packageJson.packageManager;
  if (typeof packageManager === "string") {
    const match = packageManager.match(/^yarn@(.+)$/);
    if (match) return match[1];
  }

  return "1.22.21";
}

function pinnedNodeVersion() {
  try {
    return readFileSync(join(repoRoot, ".nvmrc"), "utf8").trim().replace(/^v/, "");
  } catch {
    return "";
  }
}

function yarnCliCandidates(version) {
  const candidates = [];
  if (process.env.AIMUX_YARN_CLI) candidates.push(process.env.AIMUX_YARN_CLI);

  const voltaHome = process.env.VOLTA_HOME || join(homedir(), ".volta");
  candidates.push(join(voltaHome, "tools", "image", "yarn", version, "lib", "cli.js"));

  return candidates;
}

function nodeBinCandidates(version) {
  const candidates = [];
  if (process.env.AIMUX_NODE_BIN) candidates.push(process.env.AIMUX_NODE_BIN);

  const voltaHome = process.env.VOLTA_HOME || join(homedir(), ".volta");
  if (version) candidates.push(join(voltaHome, "tools", "image", "node", version, "bin", "node"));
  candidates.push(process.execPath);

  return candidates;
}

function spawnAndExit(command, args) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(`failed to start ${command}: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

const version = pinnedYarnVersion();
const nodeVersion = pinnedNodeVersion();
const cli = yarnCliCandidates(version).find((candidate) => existsSync(candidate));
const nodeBin = nodeBinCandidates(nodeVersion).find((candidate) => existsSync(candidate)) ?? process.execPath;

if (cli) {
  spawnAndExit(nodeBin, [cli, ...argv]);
} else {
  spawnAndExit("corepack", ["yarn", ...argv]);
}
