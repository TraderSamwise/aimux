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
  ];

  for (const command of refused) {
    it(`refuses ${command}`, () => {
      const refusal = fullSuiteRefusal(command);
      expect(refusal, command).not.toBeNull();
      expect(refusal).toContain("Instead:");
    });
  }
});

describe("scoped work is left alone", () => {
  const allowed = [
    "yarn verify",
    "yarn verify:fast",
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

describe("the bypass is available when Sam asks for the full lane", () => {
  it("honours the prefix on the command", () => {
    expect(fullSuiteRefusal("AIMUX_ALLOW_FULL_SUITE=1 yarn native:test")).toBeNull();
  });

  it("honours the variable in the environment", () => {
    expect(fullSuiteRefusal("yarn verify:full", { AIMUX_ALLOW_FULL_SUITE: "1" })).toBeNull();
  });
});
