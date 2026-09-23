import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { scanSource } from "./audit-test-runtime-env.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowlistPath = resolve(repoRoot, "scripts/test-runtime-env-allowlist.json");

function runGate() {
  return spawnSync("node", ["scripts/audit-test-runtime-env.mjs", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("test runtime env gate", () => {
  it("reports a fixture that exports AIMUX_HOME into the process", () => {
    const offending = `
fn with_contract_env(run: impl FnOnce()) {
    unsafe {
        std::env::set_var("AIMUX_HOME", "/tmp/aimux-contract-home");
    }
    run();
}
`;
    const hits = scanSource("native/crates/aimux/tests/fixtures/fixture_new.rs", offending);

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ function: "with_contract_env", variables: ["AIMUX_HOME"] });
  });

  // `set_var(key, value)` names no variable on its own line, which is how the
  // guard structs in this repo are written.
  it("follows a guard that mutates through a key variable", () => {
    const offending = `
impl EnvVarGuard {
    fn set(value: &str) -> Self {
        let key = "AIMUX_DAEMON_PORT";
        unsafe {
            std::env::set_var(key, value);
        }
        Self {}
    }
}
`;
    const hits = scanSource("native/crates/aimux/tests/fixtures/fixture_new.rs", offending);

    expect(hits).toHaveLength(1);
    expect(hits[0].variables).toContain("AIMUX_DAEMON_PORT");
  });

  it("ignores a variable that does not decide which runtime is addressed", () => {
    const unrelated = `
fn set_path(value: &str) {
    unsafe {
        std::env::set_var("PATH", value);
    }
}
`;
    expect(scanSource("native/crates/aimux/tests/some_test.rs", unrelated)).toHaveLength(0);
  });

  it("requires every allowlist entry to name a function and a reason", () => {
    const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));

    expect(allowlist.entries.length).toBeGreaterThan(0);
    for (const entry of allowlist.entries) {
      expect(entry.file, JSON.stringify(entry)).toBeTruthy();
      expect(entry.function, entry.file).toBeTruthy();
      expect(entry.reason ?? "", entry.file).not.toHaveLength(0);
    }
  });

  it("passes on the repository as it stands, and lists no stale allowlist entry", () => {
    const result = runGate();
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);

    expect(report.unclassified).toEqual([]);
    expect(report.staleAllowlist).toEqual([]);
  });
});
