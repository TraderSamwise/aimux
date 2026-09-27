import { describe, expect, it } from "vitest";
import { fullSuiteRefusal } from "./block-full-suite-hook.mjs";

describe("the full-suite lanes are refused", () => {
  const refused = [
    "yarn native:test",
    "yarn run native:test",
    "python3 scripts/native-test-runner.py",
    "yarn verify:full",
    "yarn release:readiness",
    "cargo test",
    "cargo test -p aimux",
    "cargo test --manifest-path native/Cargo.toml -p aimux",
    "yarn test",
    "cd native && cargo test -p aimux",
    "CARGO_INCREMENTAL=0 cargo test -p aimux",
    // A redirect is not a test-name filter. Agents write these on every command,
    // so reading `2>&1` as scoping is a hole through the whole guard.
    "cargo test -p aimux 2>&1 | tail -20",
    "cargo test -p aimux --help 2>&1",
    "cargo test -p aimux > /tmp/out.log",
  ];

  for (const command of refused) {
    it(`refuses ${command}`, () => {
      const refusal = fullSuiteRefusal(command);
      expect(refusal, command).not.toBeNull();
      expect(refusal, "the refusal must show the bypass applied to what was asked").toContain(
        `AIMUX_ALLOW_FULL_SUITE=1 ${command}`,
      );
      expect(refusal.split("\n"), "keep the refusal to three lines").toHaveLength(3);
    });
  }
});

describe("scoped work is left alone", () => {
  const allowed = [
    "yarn verify",
    "cargo test --manifest-path native/Cargo.toml -p aimux --test daemon_status",
    "cargo test -p aimux --lib",
    "cargo test -p aimux daemon_status_payload",
    "yarn test scripts/block-full-suite-hook.test.mjs",
    "vitest run scripts/block-full-suite-hook.test.mjs",
    "python3 scripts/native-test-runner.py --check-classification",
    "yarn audit:test-classification",
    "",
  ];

  for (const command of allowed) {
    it(`allows ${command || "(empty)"}`, () => {
      expect(fullSuiteRefusal(command), command).toBeNull();
    });
  }
});

describe("naming a lane is not running it", () => {
  // The guard fired on its own commit message, which is the same class of bug as
  // grepping for a command or documenting one.
  const mentions = [
    `git commit -m "Close the hole where cargo test -p aimux slipped through"`,
    "grep -rn 'yarn native:test' docs/",
    "echo 'run yarn verify:full in CI' >> notes.md",
    "printf '%s\\n' 'cargo test -p aimux' > /tmp/note.txt",
    // A pipe inside a quoted pattern is not a command separator.
    "grep -n 'yarn verify|yarn native:test' .github/workflows/ci.yml",
    'grep -rn "yarn native:test" scripts/',
    // A heredoc body is data being written, not commands being run.
    "python3 - <<'PY'\nprint('yarn native:test')\nPY",
    "cat > notes.md <<EOF\nrun yarn verify:full in CI\nEOF",
  ];

  for (const command of mentions) {
    it(`allows ${command.slice(0, 48)}`, () => {
      expect(fullSuiteRefusal(command), command).toBeNull();
    });
  }
});

describe("the bypass is available when the full lane is warranted", () => {
  it("honours the prefix on the command", () => {
    expect(fullSuiteRefusal("AIMUX_ALLOW_FULL_SUITE=1 yarn native:test")).toBeNull();
  });

  it("honours the variable in the environment", () => {
    expect(fullSuiteRefusal("yarn verify:full", { AIMUX_ALLOW_FULL_SUITE: "1" })).toBeNull();
  });
});
