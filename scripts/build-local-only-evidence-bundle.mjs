#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const command = args.shift();

if (!command || command === "--help" || command === "-h") {
  usage(command ? 0 : 2);
}

const options = parseOptions(args);
const bundle = options.bundle ? resolve(options.bundle) : null;
if (!bundle) fail("--bundle is required");

if (command === "init") {
  initBundle();
} else if (command === "record") {
  recordGate();
} else if (command === "finish") {
  finishBundle();
} else {
  fail(`unknown command: ${command}`);
}

function usage(status) {
  console.log(`Usage:
  scripts/build-local-only-evidence-bundle.mjs init --bundle <dir> --platform-arch <value> [--mutation <name>]
  scripts/build-local-only-evidence-bundle.mjs record --bundle <dir> --id <id> --title <title> --exit-code <n> --expected-refusal <true|false>
  scripts/build-local-only-evidence-bundle.mjs finish --bundle <dir> --status <passed|failed> [--failure <message>]

This JS half is intentionally pure: it reads/writes bundle files and JSON only.
The shell launcher owns all external command execution.`);
  process.exit(status);
}

function parseOptions(rawArgs) {
  const parsed = {};
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (!arg.startsWith("--")) fail(`unexpected positional argument: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    parsed[key] = rawArgs[++i] ?? "";
  }
  return parsed;
}

function fail(message) {
  console.error(`build-local-only-evidence-bundle metadata failed: ${message}`);
  process.exit(1);
}

function readText(path, fallback = "") {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return fallback;
  }
}

function readLines(path) {
  return readText(path)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function knownLimitations() {
  return [
    "Aimux spawns agent CLIs (claude, codex, aider) that are themselves network clients to Anthropic and OpenAI. A local-only Aimux build does not make the machine offline. The claim is scoped to the Aimux binary/control plane itself.",
    "The static network-source gate is static source analysis, not a semantic proof; it is blind to deliberately hidden networking via raw libc syscalls, build scripts, or a re-export buried inside an already-audited direct dependency unless that changes the audited surface or touches the scanned socket APIs.",
    "Spawned agent CLI execution is documented as a separate user-controlled trust decision; this bundle does not constrain what those CLIs do after Aimux starts them.",
    "Runtime network observation gates sample exercised local workflows; they complement, but do not replace, the static gate.",
  ];
}

function sourceInfo() {
  const statusShort = readText(join(bundle, "git-status-short.txt"));
  const tags = readLines(join(bundle, "git-tags-at-head.txt"));
  const clean = readText(join(bundle, "working-tree-clean.txt")).trim() === "true";
  return {
    root: repoRoot,
    revision: readText(join(bundle, "source-revision.txt")).trim(),
    tags,
    tag: tags.length === 1 ? tags[0] : tags.length > 1 ? tags.join(",") : null,
    tagged: tags.length > 0,
    workingTreeClean: clean,
    gitStatusShort: statusShort,
  };
}

function manifestPath() {
  return join(bundle, "manifest.json");
}

function readManifest() {
  if (!existsSync(manifestPath())) {
    return {
      schemaVersion: "https://aimux.app/schemas/local-only-evidence-bundle.v1.json",
      status: "running",
      generatedAt: new Date().toISOString(),
      source: sourceInfo(),
      platformArch: options.platformArch || "",
      bundleDir: bundle,
      mutation: options.mutation === "none" ? null : options.mutation || null,
      gates: [],
      limitations: knownLimitations(),
    };
  }
  return JSON.parse(readFileSync(manifestPath(), "utf8"));
}

function writeManifest(manifest) {
  mkdirSync(bundle, { recursive: true });
  writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function initBundle() {
  mkdirSync(join(bundle, "logs"), { recursive: true });
  mkdirSync(join(bundle, "release"), { recursive: true });
  const manifest = readManifest();
  manifest.status = "running";
  manifest.source = sourceInfo();
  manifest.platformArch = options.platformArch || manifest.platformArch;
  manifest.mutation = options.mutation === "none" ? null : options.mutation || null;
  manifest.limitations = knownLimitations();
  writeManifest(manifest);
  writeReport(manifest);
}

function recordGate() {
  const manifest = readManifest();
  const id = options.id;
  if (!id) fail("--id is required");
  const exitCode = Number.parseInt(options.exitCode ?? "", 10);
  if (!Number.isFinite(exitCode)) fail("--exit-code must be a number");
  const expectedRefusal = options.expectedRefusal === "true";
  const gate = {
    id,
    title: options.title || id,
    exitCode,
    expectedRefusal,
    passed: expectedRefusal ? exitCode !== 0 : exitCode === 0,
    commandFile: `logs/${id}/command.txt`,
    stdout: `logs/${id}/stdout.txt`,
    stderr: `logs/${id}/stderr.txt`,
    statusFile: `logs/${id}/status.json`,
    recordedAt: new Date().toISOString(),
  };
  manifest.gates = manifest.gates.filter((existing) => existing.id !== id);
  manifest.gates.push(gate);
  writeManifest(manifest);
  writeFileSync(join(bundle, gate.statusFile), `${JSON.stringify(gate, null, 2)}\n`, "utf8");
  writeReport(manifest);
}

function finishBundle() {
  const manifest = readManifest();
  const status = options.status;
  if (!["passed", "failed"].includes(status)) fail("--status must be passed or failed");
  manifest.status = status;
  manifest.finishedAt = new Date().toISOString();
  manifest.source = sourceInfo();
  if (options.failure) {
    manifest.failure = options.failure;
  } else {
    delete manifest.failure;
  }
  manifest.releaseAssets = releaseAssets();
  writeManifest(manifest);
  writeReport(manifest);
}

function releaseAssets() {
  const releaseDir = join(bundle, "release");
  if (!existsSync(releaseDir)) return [];
  return readdirSync(releaseDir)
    .filter((name) => name.endsWith(".tar.gz"))
    .sort()
    .map((name) => ({
      name,
      sha256File: existsSync(join(releaseDir, `${name}.sha256`)) ? `release/${name}.sha256` : null,
      provenance: existsSync(join(releaseDir, `${name}.provenance.json`)) ? `release/${name}.provenance.json` : null,
      sbom: existsSync(join(releaseDir, `${name}.sbom.spdx.json`)) ? `release/${name}.sbom.spdx.json` : null,
    }));
}

function gateDisplayStatus(gate) {
  return gate.passed ? "PASS" : "FAIL";
}

function writeReport(manifest) {
  const source = manifest.source || sourceInfo();
  const lines = [];
  lines.push("# Aimux Local-Only Evidence Bundle");
  lines.push("");
  lines.push(`Status: ${manifest.status}`);
  lines.push(`Source revision: ${source.revision || "(unknown)"}`);
  lines.push(`Tag: ${source.tags?.length ? source.tags.join(", ") : "none"}`);
  lines.push(`Working tree: ${source.workingTreeClean ? "clean" : "DIRTY"}`);
  if (!source.workingTreeClean) {
    lines.push("");
    lines.push("**This bundle describes an uncommitted working copy, not a clean released artifact.**");
  }
  lines.push(`Platform: ${manifest.platformArch || "(unknown)"}`);
  lines.push("");
  lines.push("## Honest Boundary");
  lines.push("");
  lines.push(
    "Aimux SPAWNS agent CLIs (`claude`, `codex`, `aider`) that are themselves network clients talking to Anthropic and OpenAI. A local-only Aimux build does NOT make the machine offline. The claim is scoped to: the Aimux binary/control plane itself initiates no outbound network activity. Spawned agent processes are a separate, user-controlled trust decision.",
  );
  lines.push("");
  lines.push("## Limitations");
  lines.push("");
  for (const limitation of knownLimitations()) {
    lines.push(`- ${limitation}`);
  }
  lines.push("");
  lines.push("## Gate Results");
  lines.push("");
  if (!manifest.gates?.length) {
    lines.push("No gates recorded yet.");
  } else {
    for (const gate of manifest.gates) {
      const suffix = gate.expectedRefusal ? ` raw exit ${gate.exitCode}, expected refusal` : ` exit ${gate.exitCode}`;
      lines.push(`- ${gateDisplayStatus(gate)} ${gate.id}:${suffix}`);
      lines.push(`  - command: ${gate.commandFile}`);
      lines.push(`  - stdout: ${gate.stdout}`);
      lines.push(`  - stderr: ${gate.stderr}`);
    }
  }
  const assets = manifest.releaseAssets || releaseAssets();
  if (assets.length > 0) {
    lines.push("");
    lines.push("## Release Assets");
    lines.push("");
    for (const asset of assets) {
      lines.push(`- ${asset.name}`);
      if (asset.sha256File) lines.push(`  - sha256: ${asset.sha256File}`);
      if (asset.provenance) lines.push(`  - provenance: ${asset.provenance}`);
      if (asset.sbom) lines.push(`  - sbom: ${asset.sbom}`);
    }
  }
  if (manifest.failure) {
    lines.push("");
    lines.push("## Failure");
    lines.push("");
    lines.push(manifest.failure);
  }
  lines.push("");
  writeFileSync(join(bundle, "report.md"), `${lines.join("\n")}\n`, "utf8");
}
