#!/usr/bin/env node
// How many places a reader has to verify to trust the local build's boundary.
//
// The point is not the number. The point is that the local/remote boundary
// should be one dependency edge a security reviewer reads in ten seconds,
// rather than N `#[cfg(feature = "remote-control")]` sites each of which has
// to be checked individually for a leak. This gate ratchets N down and refuses
// to let it climb back.
//
// `src/remote/` is the far side and is not counted: gates inside it would be
// gating remote code against itself, and there are none.
// The edge files are the boundary rather than holes in it: `remote_control_edge.rs`
// is the crate-level one and `daemon/remote_control.rs` is the daemon's, which
// docs/security/local-only-boundary-extraction.md designates. Their gates are
// the two-sided switch a reviewer is meant to read; everything else counted
// here is a place that switch has not reached yet.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const sourceRoot = join(repoRoot, "native", "crates", "aimux", "src");
const GATE = /#\[cfg\((?:not\()?feature = "remote-control"\)?\)\]/g;
const EDGE = ["remote_control_edge.rs", "daemon/remote_control.rs"];
const FAR_SIDE = ["remote"];

// Lowered as the split proceeds; it may never rise. The end state is 0, with
// the boundary expressed as one dependency edge in one Cargo.toml.
//
// It started at 72. It counts both spellings: a
// `cfg(not(feature = ..))` branch is a second implementation compiled into the
// local build, which a reviewer has to read for exactly the same reason.
const BUDGET = 3;

function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (entry.endsWith(".rs")) {
      found.push(path);
    }
  }
  return found;
}

function isExcluded(relativePath) {
  const parts = relativePath.split(sep);
  return FAR_SIDE.includes(parts[0]) || EDGE.includes(parts.join("/"));
}

const counts = new Map();
for (const file of sourceFiles(sourceRoot)) {
  const relativePath = relative(sourceRoot, file);
  if (isExcluded(relativePath)) continue;
  const matches = readFileSync(file, "utf8").match(GATE);
  if (matches?.length) counts.set(relativePath, matches.length);
}

const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
for (const [file, count] of ranked) {
  console.log(`  ${String(count).padStart(3)}  ${file}`);
}
console.log(
  `remote-control gates outside src/remote/ and the ${EDGE.join(", ")} edge: ${total} in ${counts.size} file(s)`,
);

if (total > BUDGET) {
  console.error(
    `FAIL: ${total} gates exceeds the budget of ${BUDGET}. Each one is a place a ` +
      `source reviewer has to verify by hand; move the call behind the ` +
      `daemon/remote_control.rs edge instead of adding another.`,
  );
  process.exit(1);
}
if (total < BUDGET) {
  console.error(
    `FAIL: ${total} gates is below the budget of ${BUDGET}. Lower BUDGET in ` +
      `this script to ${total} so the ratchet holds.`,
  );
  process.exit(1);
}
console.log(`PASS: at the budget of ${BUDGET}`);
