#!/usr/bin/env node
// The daemon's core route table is ONE fact written TWICE: Rust declares it in
// `core_command_contract.rs`, and the clients read a hand-maintained mirror in
// `src/core-command-contract.ts` -- which `app/lib/api.ts` imports, so it is
// what the phone and the browser actually call.
//
// Only the Rust half was held to anything. It has a compile-time route count
// AND `testdata/contracts/v1/core-command/routes.json`, both of which caught a
// mistake while `fleetUsageText` was being added. The TypeScript half had
// neither, and had already drifted four routes behind without failing a single
// check: agentListText, doctorCoherenceText, loopPauseText and loopUnpauseText
// existed in Rust and in the fixture but not in the mirror. Nothing was broken
// by that, which is the point -- a client simply could not name those routes,
// and no test anywhere could say why.
//
// AGENTS.md calls this shape by name: "if I render this in the app and in the
// TUI, what guarantees they match?" For a route table the answer has to be
// better than "both were edited".
//
// So the mirror is required to hold every route the shared fixture does, at
// the same path. ORDER IS NOT COMPARED, deliberately: the Rust gate compares
// `entries()` positionally because an array has an order, but the mirror is an
// object read by key, its grouping is for people, and the two already differ.
// Requiring one order would mean reshuffling a file to satisfy a check that
// protects nothing.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const MIRROR = "src/core-command-contract.ts";
const FIXTURE = "testdata/contracts/v1/core-command/routes.json";

function read(relativePath) {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

/// The `name -> path` pairs of one `export const <NAME> = { ... } as const;`
/// object. Scoped to that object's own body: the file holds several, and a
/// regex let loose over the whole file collects the command names too, which
/// is a difference that is not drift.
export function mirrorEntries(source, exportName) {
  const start = source.indexOf(`export const ${exportName} = {`);
  if (start === -1) {
    throw new Error(`${MIRROR}: ${exportName} is gone; this audit names it directly`);
  }
  const end = source.indexOf("} as const;", start);
  if (end === -1) {
    throw new Error(`${MIRROR}: ${exportName} has no \`} as const;\`; cannot bound it`);
  }
  const body = source.slice(start, end);
  const entries = new Map();
  for (const [, name, path] of body.matchAll(/(\w+):\s*"([^"]+)"/g)) {
    entries.set(name, path);
  }
  return entries;
}

/// The shared fixture's `[name, path]` tuples. This is the same file the Rust
/// gate reads, so comparing against it ties all three together rather than
/// pinning the mirror to a second opinion.
export function fixtureEntries(source, key) {
  const parsed = JSON.parse(source);
  const rows = parsed[key];
  if (!Array.isArray(rows)) {
    throw new Error(`${FIXTURE}: no "${key}" array`);
  }
  return new Map(rows.map(([name, path]) => [name, path]));
}

export function compareEntries(label, mirror, fixture, problems) {
  for (const [name, path] of fixture) {
    if (!mirror.has(name)) {
      problems.push(`${label}: ${name} (${path}) is in the fixture but not the mirror`);
      continue;
    }
    const mirrored = mirror.get(name);
    if (mirrored !== path) {
      problems.push(`${label}: ${name} is "${mirrored}" in the mirror and "${path}" in the fixture`);
    }
  }
  for (const [name, path] of mirror) {
    if (!fixture.has(name)) {
      problems.push(`${label}: ${name} (${path}) is in the mirror but not the fixture`);
    }
  }
  return problems;
}

function main() {
  const mirrorSource = read(MIRROR);
  const problems = [];

  compareEntries(
    "core routes",
    mirrorEntries(mirrorSource, "CORE_API_ROUTES"),
    fixtureEntries(read(FIXTURE), "routes"),
    problems,
  );
  compareEntries(
    "core commands",
    mirrorEntries(mirrorSource, "CORE_COMMAND_NAMES"),
    fixtureEntries(read("testdata/contracts/v1/core-command/commands.json"), "commands"),
    problems,
  );

  if (problems.length > 0) {
    console.error("the TypeScript contract and the shared fixture disagree:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      `\nA route added in Rust has to be added to ${MIRROR} too, or no client can name it.`,
    );
    process.exit(1);
  }

  console.log("core routes and command names agree between the TypeScript contract and the fixture");
}

// Importable for its own test without running the audit.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
