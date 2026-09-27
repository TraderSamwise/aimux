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

const LANES = [
  {
    id: "native-test",
    reason: "yarn native:test runs every Rust integration test (~330s)",
    instead:
      "CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/tmp/aimux-cargo-target-$AIMUX_SESSION_ID cargo test --manifest-path native/Cargo.toml -p aimux --test <the_test_you_touched>",
    matches: (command) =>
      /\byarn\s+(?:run\s+)?native:test\b/.test(command) ||
      /\bnative-test-runner\.py\b(?![^\n;&|]*--check-classification)/.test(command),
  },
  {
    id: "verify-full",
    reason: "yarn verify:full is the CI lane: the fast lane plus every Rust, node and app suite",
    instead: "yarn verify (the 20s fast lane), then push and let CI run the rest",
    matches: (command) => /\byarn\s+(?:run\s+)?verify:full\b/.test(command),
  },
  {
    id: "release-readiness",
    reason: "yarn release:readiness is verify:full plus the installed-runtime gates (~820s)",
    instead: "yarn verify, then yarn release:patch -- a tag builds and publishes without waiting on CI",
    matches: (command) => /\byarn\s+(?:run\s+)?release:readiness\b/.test(command),
  },
  {
    id: "cargo-test-unscoped",
    reason: "an unscoped cargo test builds and runs the whole crate's test surface",
    instead:
      "cargo test --manifest-path native/Cargo.toml -p aimux --test <the_test_you_touched>",
    matches: (command) => {
      const call = /\bcargo\s+test\b([^\n;&|]*)/.exec(command);
      if (!call) return false;
      const rest = call[1];
      if (SCOPED_CARGO_FLAGS.some((flag) => new RegExp(`\\s${flag}(?:\\s|=|$)`).test(rest))) {
        return false;
      }
      // A bare filter argument (`cargo test some_name`) is already scoped.
      const args = rest.split(/\s+/).filter(Boolean);
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
    },
  },
  {
    id: "vitest-whole-suite",
    reason: "a bare yarn test runs every vitest suite in the repo (~200s)",
    instead: "yarn test <path/to/the.test.mjs>, or vitest run <path>",
    matches: (command) => {
      const call = /\byarn\s+(?:run\s+)?test\b([^\n;&|]*)/.exec(command);
      if (!call) return false;
      return call[1].split(/\s+/).filter((arg) => arg && !arg.startsWith("-")).length === 0;
    },
  },
];

export const FULL_SUITE_LANE_IDS = LANES.map((lane) => lane.id);

export function fullSuiteRefusal(command, env = {}) {
  if (typeof command !== "string" || command.trim() === "") return null;
  if (env[BYPASS_ENV] || new RegExp(`\\b${BYPASS_ENV}=`).test(command)) return null;
  const lane = LANES.find((candidate) => candidate.matches(command));
  if (!lane) return null;
  return [
    `Refused: ${lane.reason}.`,
    "Full suites are CI's job. Run the targets covering what you changed, plus yarn verify, then push.",
    `Instead: ${lane.instead}`,
    `If Sam asked for the full lane, prefix the command with ${BYPASS_ENV}=1.`,
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
