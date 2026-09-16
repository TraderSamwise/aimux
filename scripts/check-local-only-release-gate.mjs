#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const failures = [];

function read(path) {
  return readFileSync(join(repoRoot, path), "utf8");
}

function requireContains(path, needle, description) {
  const text = read(path);
  if (!text.includes(needle)) {
    failures.push(`${path} is missing ${description}: ${needle}`);
  }
}

function requireRegex(path, pattern, description) {
  const text = read(path);
  if (!pattern.test(text)) {
    failures.push(`${path} is missing ${description}: ${pattern}`);
  }
}

function requireFile(path, description) {
  if (!existsSync(join(repoRoot, path))) {
    failures.push(`missing ${description}: ${path}`);
  }
}

function checkLiteBoundary() {
  const path = "scripts/check-lite-build-boundary.sh";
  for (const dependency of ["tokio-tungstenite", "tungstenite", "ureq", "reqwest", "hyper", "h2", "native-tls", "openssl", "curl"]) {
    requireContains(path, dependency, `lite remote/network dependency denylist entry ${dependency}`);
  }
  for (const identity of [
    "AIMUX_RELAY_URL",
    "relay[.]aimux[.]app",
    "wss://",
    "ws://",
    "hosted_server",
    "hosted_cli",
    "remote_login",
    "remote_security_devices",
    "maybe_host_published_attachment",
    "attachments/hosted",
  ]) {
    requireContains(path, identity, `lite remote identity denylist entry ${identity}`);
  }
  requireContains(path, "Full cargo tree is missing remote-control dependencies", "full-variant presence gate");
}

function checkReleaseProvenanceGate() {
  requireFile("scripts/write-release-provenance.mjs", "release provenance generator");
  requireFile("scripts/verify-release-provenance.mjs", "release provenance verifier");
  requireContains("scripts/build-release-asset.sh", "write-release-provenance.mjs", "per-asset provenance/SBOM generation");
  requireContains("scripts/verify-release-asset-set.sh", "verify-release-provenance.mjs", "provenance/SBOM asset-set verification");
  requireContains("scripts/verify-release-asset-set.sh", "missing release SBOM file", "distinct missing SBOM error");
  requireContains("scripts/verify-release-asset-set.sh", "missing release provenance file", "distinct missing provenance error");

  const workflow = ".github/workflows/release.yml";
  requireContains(workflow, "actions/attest-build-provenance@v2", "GitHub artifact attestation step");
  requireContains(workflow, "gh attestation verify", "artifact attestation verification step");
  requireContains(workflow, "release/${{ matrix.asset }}.tar.gz.provenance.json", "provenance asset upload");
  requireContains(workflow, "release/${{ matrix.asset }}.tar.gz.sbom.spdx.json", "SBOM asset upload");
  requireRegex(workflow, /needs:\s+release-assets/, "complete asset gate waits for all matrix artifacts");
  requireRegex(workflow, /publish-npm:[\s\S]*needs:\s+verify-release-assets/, "npm waits for verified asset set");
  requireRegex(workflow, /update-homebrew-tap:[\s\S]*needs:\s+verify-release-assets/, "Homebrew waits for verified asset set");
}

function checkSourceLocalOnlyGates() {
  requireContains("scripts/check-local-build-boundary.mjs", "attachments/", "project .aimux attachments ignore check");
  requireContains("scripts/check-local-build-boundary.mjs", "graveyard/", "project .aimux graveyard ignore check");
  requireContains("native/crates/aimux/src/config.rs", "attachments/", "project .aimux attachments ignore template");
  requireContains("native/crates/aimux/src/config.rs", "graveyard/", "project .aimux graveyard ignore template");
  requireContains("native/crates/aimux/tests/daemon_state.rs", "reject non-loopback", "daemon host loopback inverse test");
  requireContains("native/crates/aimux/src/project_service/process.rs", "StdTcpListener::bind((\"127.0.0.1\"", "project service loopback bind");
}

checkLiteBoundary();
checkReleaseProvenanceGate();
checkSourceLocalOnlyGates();

if (failures.length > 0) {
  console.error("Local-only release gate failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Local-only release gate passed");
