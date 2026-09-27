#!/usr/bin/env node
// Claude Code PreToolUse hook for this repo. The full-suite lanes take minutes
// and agents reach for them after a one-line edit, so they get the scoped
// command instead of the wait. Exit 2 refuses and feeds stderr back to the model.

const BYPASS_ENV = "AIMUX_ALLOW_FULL_SUITE";

const SCOPED_CARGO_FLAGS = [
  "--test",
  "--lib",
  "--bin",
  "--bins",
  "--doc",
  "--example",
  "--bench",
  "--benches",
];

// A lane only counts at a command position. Naming one inside a commit message,
// a grep pattern or a heredoc is talking about it, not running it.
function commandSegments(command) {
  return command
    .split(/\n|;|&&|\|\||\|/)
    .map((segment) =>
      segment
        .trim()
        .replace(/^(?:\w+=\S*\s+)+/, "")
        .replace(/^(?:time|nice|env|timeout\s+\S+)\s+/, ""),
    )
    .filter(Boolean);
}

function cargoTestIsUnscoped(segment) {
  const call = /^cargo\s+test\b(.*)$/.exec(segment);
  if (!call) return false;
  const rest = call[1];
  if (SCOPED_CARGO_FLAGS.some((flag) => new RegExp(`\\s${flag}(?:\\s|=|$)`).test(rest))) {
    return false;
  }
  // A bare filter argument (`cargo test some_name`) is already scoped, but a
  // redirection is not an argument -- `2>&1` must not read as a test name.
  const args = rest
    .replace(/\d*>>?&?\s*\S*/g, " ")
    .replace(/\d*<\s*\S*/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["-p", "--package", "--manifest-path", "--features", "--target"].includes(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return false;
  }
  return true;
}

const LANES = [
  {
    id: "native-test",
    costs: "yarn native:test runs every Rust integration test (~330s)",
    instead: "cargo test --manifest-path native/Cargo.toml -p aimux --test <the_test_you_touched>",
    matches: (segment) =>
      /^yarn\s+(?:run\s+)?native:test\b/.test(segment) ||
      (/^(?:python3?\s+)?\S*native-test-runner\.py\b/.test(segment) &&
        !/--check-classification\b/.test(segment)),
  },
  {
    id: "verify-full",
    costs: "yarn verify:full is the CI lane -- the fast lane plus every Rust, node and app suite",
    instead: "yarn verify, the same lane minus the suites CI owns",
    matches: (segment) => /^yarn\s+(?:run\s+)?verify:full\b/.test(segment),
  },
  {
    id: "release-readiness",
    costs: "yarn release:readiness is verify:full plus the installed-runtime gates (~820s)",
    instead: "yarn verify, then yarn release:patch -- a tag no longer waits on CI",
    matches: (segment) => /^yarn\s+(?:run\s+)?release:readiness\b/.test(segment),
  },
  {
    id: "cargo-test-unscoped",
    costs: "an unscoped cargo test builds and runs the whole crate's test surface",
    instead: "cargo test --manifest-path native/Cargo.toml -p aimux --test <the_test_you_touched>",
    matches: cargoTestIsUnscoped,
  },
  {
    id: "vitest-whole-suite",
    costs: "a bare yarn test runs every vitest suite in the repo (~200s)",
    instead: "yarn test <path/to/the.test.mjs>",
    matches: (segment) => {
      const call = /^yarn\s+(?:run\s+)?test\b(.*)$/.exec(segment);
      if (!call) return false;
      return call[1].split(/\s+/).filter((arg) => arg && !arg.startsWith("-")).length === 0;
    },
  },
];

export const FULL_SUITE_LANE_IDS = LANES.map((lane) => lane.id);

export function fullSuiteRefusal(command, env = {}) {
  if (typeof command !== "string" || command.trim() === "") return null;
  if (env[BYPASS_ENV] || new RegExp(`\\b${BYPASS_ENV}=`).test(command)) return null;
  const segments = commandSegments(command);
  const lane = LANES.find((candidate) => segments.some((segment) => candidate.matches(segment)));
  if (!lane) return null;
  const asked = command.trim().split("\n")[0];
  return [
    `Refused: scope the test down. ${lane.costs}, and CI runs the full suite on every push anyway.`,
    `Instead: ${lane.instead}, then yarn verify.`,
    `Genuinely need the full suite? ${BYPASS_ENV}=1 ${asked.length > 120 ? `${asked.slice(0, 120)}...` : asked}`,
  ].join("\n");
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    process.exit(0);
  }
  const refusal = fullSuiteRefusal(payload?.tool_input?.command ?? "", process.env);
  if (!refusal) process.exit(0);
  process.stderr.write(`${refusal}\n`);
  process.exit(2);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
