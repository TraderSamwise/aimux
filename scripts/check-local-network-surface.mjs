#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const AUDITED_LOCAL_PACKAGE_IDENTITIES = [
  "path#aimux@0.1.0",
  "registry+https://github.com/rust-lang/crates.io-index#anstream@1.0.0",
  "registry+https://github.com/rust-lang/crates.io-index#anstyle-parse@1.0.0",
  "registry+https://github.com/rust-lang/crates.io-index#anstyle-query@1.1.5",
  "registry+https://github.com/rust-lang/crates.io-index#anstyle-wincon@3.0.11",
  "registry+https://github.com/rust-lang/crates.io-index#anstyle@1.0.14",
  "registry+https://github.com/rust-lang/crates.io-index#anyhow@1.0.104",
  "registry+https://github.com/rust-lang/crates.io-index#block-buffer@0.10.4",
  "registry+https://github.com/rust-lang/crates.io-index#bytes@1.12.1",
  "registry+https://github.com/rust-lang/crates.io-index#cfg-if@1.0.4",
  "registry+https://github.com/rust-lang/crates.io-index#clap@4.6.6",
  "registry+https://github.com/rust-lang/crates.io-index#clap_builder@4.6.6",
  "registry+https://github.com/rust-lang/crates.io-index#clap_derive@4.6.4",
  "registry+https://github.com/rust-lang/crates.io-index#clap_lex@1.1.0",
  "registry+https://github.com/rust-lang/crates.io-index#colorchoice@1.0.5",
  "registry+https://github.com/rust-lang/crates.io-index#cpufeatures@0.2.17",
  "registry+https://github.com/rust-lang/crates.io-index#crypto-common@0.1.7",
  "registry+https://github.com/rust-lang/crates.io-index#deranged@0.5.8",
  "registry+https://github.com/rust-lang/crates.io-index#digest@0.10.7",
  "registry+https://github.com/rust-lang/crates.io-index#equivalent@1.0.2",
  "registry+https://github.com/rust-lang/crates.io-index#errno@0.3.14",
  "registry+https://github.com/rust-lang/crates.io-index#generic-array@0.14.7",
  "registry+https://github.com/rust-lang/crates.io-index#hashbrown@0.17.1",
  "registry+https://github.com/rust-lang/crates.io-index#heck@0.5.0",
  "registry+https://github.com/rust-lang/crates.io-index#indexmap@2.14.0",
  "registry+https://github.com/rust-lang/crates.io-index#is_terminal_polyfill@1.70.2",
  "registry+https://github.com/rust-lang/crates.io-index#itoa@1.0.18",
  "registry+https://github.com/rust-lang/crates.io-index#libc@0.2.189",
  "registry+https://github.com/rust-lang/crates.io-index#memchr@2.8.3",
  "registry+https://github.com/rust-lang/crates.io-index#mio@1.2.3",
  "registry+https://github.com/rust-lang/crates.io-index#num-conv@0.2.2",
  "registry+https://github.com/rust-lang/crates.io-index#once_cell_polyfill@1.70.2",
  "registry+https://github.com/rust-lang/crates.io-index#pin-project-lite@0.2.17",
  "registry+https://github.com/rust-lang/crates.io-index#powerfmt@0.2.0",
  "registry+https://github.com/rust-lang/crates.io-index#proc-macro2@1.0.107",
  "registry+https://github.com/rust-lang/crates.io-index#quote@1.0.47",
  "registry+https://github.com/rust-lang/crates.io-index#ryu@1.0.23",
  "registry+https://github.com/rust-lang/crates.io-index#serde@1.0.229",
  "registry+https://github.com/rust-lang/crates.io-index#serde_core@1.0.229",
  "registry+https://github.com/rust-lang/crates.io-index#serde_derive@1.0.229",
  "registry+https://github.com/rust-lang/crates.io-index#serde_json@1.0.151",
  "registry+https://github.com/rust-lang/crates.io-index#serde_yaml@0.9.34+deprecated",
  "registry+https://github.com/rust-lang/crates.io-index#sha1@0.10.7",
  "registry+https://github.com/rust-lang/crates.io-index#sha2@0.10.9",
  "registry+https://github.com/rust-lang/crates.io-index#signal-hook-registry@1.4.8",
  "registry+https://github.com/rust-lang/crates.io-index#socket2@0.6.5",
  "registry+https://github.com/rust-lang/crates.io-index#strsim@0.11.1",
  "registry+https://github.com/rust-lang/crates.io-index#syn@3.0.5",
  "registry+https://github.com/rust-lang/crates.io-index#time-core@0.1.9",
  "registry+https://github.com/rust-lang/crates.io-index#time-macros@0.2.32",
  "registry+https://github.com/rust-lang/crates.io-index#time@0.3.55",
  "registry+https://github.com/rust-lang/crates.io-index#tokio-macros@2.7.2",
  "registry+https://github.com/rust-lang/crates.io-index#tokio@1.53.1",
  "registry+https://github.com/rust-lang/crates.io-index#typenum@1.20.1",
  "registry+https://github.com/rust-lang/crates.io-index#unicode-ident@1.0.24",
  "registry+https://github.com/rust-lang/crates.io-index#unsafe-libyaml@0.2.11",
  "registry+https://github.com/rust-lang/crates.io-index#utf8parse@0.2.2",
  "registry+https://github.com/rust-lang/crates.io-index#version_check@0.9.5",
  "registry+https://github.com/rust-lang/crates.io-index#wasi@0.11.1+wasi-snapshot-preview1",
  "registry+https://github.com/rust-lang/crates.io-index#windows-link@0.2.1",
  "registry+https://github.com/rust-lang/crates.io-index#windows-sys@0.61.2",
  "registry+https://github.com/rust-lang/crates.io-index#zmij@1.0.23",
];

const AUDITED_LOCAL_ROOT_DEPENDENCY_EDGES = [
  "anyhow->registry+https://github.com/rust-lang/crates.io-index#anyhow@1.0.104",
  "clap->registry+https://github.com/rust-lang/crates.io-index#clap@4.6.6",
  "libc->registry+https://github.com/rust-lang/crates.io-index#libc@0.2.189",
  "serde->registry+https://github.com/rust-lang/crates.io-index#serde@1.0.229",
  "serde_json->registry+https://github.com/rust-lang/crates.io-index#serde_json@1.0.151",
  "serde_yaml->registry+https://github.com/rust-lang/crates.io-index#serde_yaml@0.9.34+deprecated",
  "sha1->registry+https://github.com/rust-lang/crates.io-index#sha1@0.10.7",
  "sha2->registry+https://github.com/rust-lang/crates.io-index#sha2@0.10.9",
  "time->registry+https://github.com/rust-lang/crates.io-index#time@0.3.55",
  "tokio->registry+https://github.com/rust-lang/crates.io-index#tokio@1.53.1",
];

const args = process.argv.slice(2);
let sourceRoot = repoRoot;
let manifestPath = join(repoRoot, "native/Cargo.toml");
let packageIdentitiesFile = null;
let expectedPackageIdentitiesFile = null;
let rootDependencyEdgesFile = null;
let expectedRootDependencyEdgesFile = null;
let skipPackageIdentityCheck = false;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--source-root") {
    sourceRoot = resolve(args[++i]);
  } else if (arg === "--manifest-path") {
    manifestPath = resolve(args[++i]);
  } else if (arg === "--package-identities-file") {
    packageIdentitiesFile = resolve(args[++i]);
  } else if (arg === "--expected-package-identities-file") {
    expectedPackageIdentitiesFile = resolve(args[++i]);
  } else if (arg === "--root-dependency-edges-file") {
    rootDependencyEdgesFile = resolve(args[++i]);
  } else if (arg === "--expected-root-dependency-edges-file") {
    expectedRootDependencyEdgesFile = resolve(args[++i]);
  } else if (arg === "--skip-package-identity-check") {
    skipPackageIdentityCheck = true;
  } else if (arg === "--write-current-package-identities") {
    const output = resolve(args[++i]);
    const identities = collectCurrentPackageSurface().packages;
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${identities.join("\n")}\n`, "utf8");
    process.exit(0);
  } else {
    console.error(`Unknown check-local-network-surface argument: ${arg}`);
    process.exit(2);
  }
}

const failures = [];
let allRustSourceText = null;

function fail(message) {
  failures.push(message);
}

function walk(dir, visit) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, visit);
    } else {
      visit(path);
    }
  }
}

function readLines(path) {
  return readFileSync(path, "utf8").split(/\r?\n/);
}

function allRustSource() {
  if (allRustSourceText !== null) return allRustSourceText;
  const srcDir = join(sourceRoot, "native/crates/aimux/src");
  const chunks = [];
  walk(srcDir, (path) => {
    if (path.endsWith(".rs")) chunks.push(readFileSync(path, "utf8"));
  });
  allRustSourceText = chunks.join("\n");
  return allRustSourceText;
}

function normalizePackageIdentity(pkg) {
  if (pkg.source === null) return `path#${pkg.name}@${pkg.version}`;
  return `${pkg.source}#${pkg.name}@${pkg.version}`;
}

function readList(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

function collectCurrentPackageSurface() {
  if (packageIdentitiesFile) {
    return {
      packages: readList(packageIdentitiesFile),
      rootEdges: rootDependencyEdgesFile ? readList(rootDependencyEdgesFile) : [],
    };
  }

  const metadata = spawnSync(
    "cargo",
    ["metadata", "--manifest-path", manifestPath, "--no-default-features", "--format-version=1"],
    { cwd: sourceRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (metadata.status !== 0) {
    throw new Error(`cargo metadata failed while checking local dependency identity:\n${metadata.stderr}`);
  }
  const parsed = JSON.parse(metadata.stdout);
  const aimuxPackage = parsed.packages.find((pkg) => pkg.name === "aimux");
  if (!aimuxPackage) {
    throw new Error("cargo metadata did not include the aimux package");
  }
  const nodes = new Map(parsed.resolve.nodes.map((node) => [node.id, node]));
  const packages = new Map(parsed.packages.map((pkg) => [pkg.id, pkg]));
  const aimuxNode = nodes.get(aimuxPackage.id);
  const visited = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      visit(dep.pkg);
    }
  }
  visit(aimuxPackage.id);
  return {
    packages: [...visited].map((id) => normalizePackageIdentity(packages.get(id))).sort(),
    rootEdges: (aimuxNode?.deps ?? [])
      .map((dep) => `${dep.name}->${normalizePackageIdentity(packages.get(dep.pkg))}`)
      .sort(),
  };
}

function expectedPackageIdentities() {
  if (!expectedPackageIdentitiesFile) return [...AUDITED_LOCAL_PACKAGE_IDENTITIES].sort();
  return readList(expectedPackageIdentitiesFile);
}

function expectedRootDependencyEdges() {
  if (!expectedRootDependencyEdgesFile) return [...AUDITED_LOCAL_ROOT_DEPENDENCY_EDGES].sort();
  return readList(expectedRootDependencyEdgesFile);
}

function compareAuditedList({ label, current, expected, consequence }) {
  const currentSet = new Set(current);
  const expectedSet = new Set(expected);
  const added = current.filter((identity) => !expectedSet.has(identity));
  const removed = expected.filter((identity) => !currentSet.has(identity));
  if (added.length === 0 && removed.length === 0) return;
  fail(
    [
      `${label} changed from the audited identities`,
      consequence,
      added.length > 0 ? `added identities:\n${added.map((value) => `  + ${value}`).join("\n")}` : "",
      removed.length > 0 ? `removed identities:\n${removed.map((value) => `  - ${value}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function checkPackageIdentitySurface() {
  if (skipPackageIdentityCheck) return;
  const current = collectCurrentPackageSurface();
  compareAuditedList({
    label: "local no-default-features dependency graph",
    current: current.packages,
    expected: expectedPackageIdentities(),
    consequence:
      "This gate keys on Cargo package identity, so a renamed, aliased, or wrapped network client dependency cannot enter the local build without review.",
  });
  compareAuditedList({
    label: "local no-default-features root dependency edge set",
    current: current.rootEdges,
    expected: expectedRootDependencyEdges(),
    consequence:
      "This also freezes which audited transitive crates are directly usable from aimux source, so making an already-present network-capable transitive crate a direct dependency still requires review.",
  });
}

function hasRemoteControlCfgMacro(text) {
  return /cfg!\s*\([^)]*feature\s*=\s*"remote-control"/s.test(text);
}

function escapeRegex(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function socketTypeNames(text) {
  const names = new Set(["TcpStream", "TcpListener", "UdpSocket"]);
  const directAliasPattern = /use\s+(?:std|tokio)::net::(TcpStream|TcpListener|UdpSocket)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  for (const match of text.matchAll(directAliasPattern)) names.add(match[2]);
  const braceUsePattern = /use\s+(?:std|tokio)::net::\{([^}]+)\}/g;
  for (const match of text.matchAll(braceUsePattern)) {
    for (const rawPart of match[1].split(",")) {
      const part = rawPart.trim();
      const alias = /^(TcpStream|TcpListener|UdpSocket)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/.exec(part);
      const direct = /^(TcpStream|TcpListener|UdpSocket)$/.exec(part);
      if (alias) names.add(alias[2]);
      if (direct) names.add(direct[1]);
    }
  }
  const typeAliasPattern = /type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:std|tokio)::net::(TcpStream|TcpListener|UdpSocket)\s*;/g;
  for (const match of text.matchAll(typeAliasPattern)) names.add(match[1]);
  return [...names].sort((a, b) => b.length - a.length);
}

function networkCallPatternFor(text) {
  const socketTypes = socketTypeNames(text).map(escapeRegex).join("|");
  return new RegExp(
    `\\b(?:(?:std|tokio)::net::)?(?:${socketTypes})::(?:connect|connect_timeout|bind)\\s*\\(|\\btokio::net::lookup_host\\s*\\(|\\.to_socket_addrs\\s*\\(`,
    "g",
  );
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function statementAround(text, start) {
  const end = text.indexOf(";", start);
  return text.slice(start, end === -1 ? Math.min(text.length, start + 500) : end + 1);
}

function surroundingWindow(lines, lineIndex) {
  const start = Math.max(0, lineIndex - 60);
  const end = Math.min(lines.length, lineIndex + 20);
  return lines.slice(start, end).join("\n");
}

function containsNonLoopbackLiteral(text) {
  const ipv4Matches = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? [];
  if (ipv4Matches.some((ip) => !ip.startsWith("127."))) return true;
  return /https?:\/\/(?!localhost(?:[:/"]|$)|127\.|(?:\[)?::1(?:\])?(?:[:/"]|$))[A-Za-z0-9.-]+/i.test(text);
}

function containsLoopbackEvidence(text) {
  return (
    /\b127\./.test(text) ||
    /\blocalhost\b/.test(text) ||
    /(?<![A-Za-z0-9])::1(?![A-Za-z0-9])/.test(text) ||
    /\.is_loopback\s*\(\s*\)/.test(text) ||
    /\bis_loopback_host\s*\(/.test(text) ||
    /must use loopback|must be loopback|no loopback address resolved/.test(text)
  );
}

function containsTypeBackedLoopbackEvidence(statement, window) {
  const source = allRustSource();
  return (
    /\bconfig\.host\.as_str\(\)/.test(statement) &&
    /\bDaemonListenConfig\b/.test(window) &&
    /AIMUX_DAEMON_HOST must be loopback/.test(source) &&
    /\bDaemonListenConfig\s*\{\s*host,\s*port\s*\}/.test(source)
  );
}

function checkSourceNetworkSurface() {
  const srcDir = join(sourceRoot, "native/crates/aimux/src");
  walk(srcDir, (path) => {
    if (!path.endsWith(".rs")) return;
    const rel = relative(sourceRoot, path).split("\\").join("/");
    const text = readFileSync(path, "utf8");
    if (hasRemoteControlCfgMacro(text)) {
      fail(
        `${rel} uses cfg!(feature = "remote-control"). Use a #[cfg(...)] attribute instead: #[cfg] removes code from the local build, while cfg! compiles both branches and can leave remote-control code inside the local binary even when other absence checks are green.`,
      );
    }

    if (rel.startsWith("native/crates/aimux/src/remote/")) return;
    const lines = readLines(path);
    for (const match of text.matchAll(networkCallPatternFor(text))) {
      const start = match.index ?? 0;
      const line = lineNumberAt(text, start);
      const statement = statementAround(text, start);
      const window = surroundingWindow(lines, line - 1);
      const evidence = `${statement}\n${window}`;
      if (containsNonLoopbackLiteral(statement)) {
        fail(`${rel}:${line} contains a non-loopback network target in a local-source socket call: ${statement.trim()}`);
        continue;
      }
      if (!containsLoopbackEvidence(evidence)) {
        if (containsTypeBackedLoopbackEvidence(statement, window)) {
          continue;
        }
        fail(
          `${rel}:${line} has a network socket/DNS call without auditable loopback evidence near the call. Make the address loopback literal or keep an explicit is_loopback/127.0.0.1/localhost guard adjacent to the call.`,
        );
      }
    }
  });
}

try {
  checkPackageIdentitySurface();
  checkSourceNetworkSurface();
} catch (error) {
  fail(error.message);
}

if (failures.length > 0) {
  console.error("Local network surface gate failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Local network surface gate passed");
console.log("checked: audited local Cargo package identities/root dependency edges, remote-control cfg! macro absence, and loopback-only local socket/DNS call evidence");
