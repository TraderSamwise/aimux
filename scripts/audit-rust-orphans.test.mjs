import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowlistPath = resolve(repoRoot, "scripts/rust-fixture-dispatcher-allowlist.json");

function runAudit(args = ["--json"]) {
  const result = spawnSync("node", ["scripts/audit-rust-orphans.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function loadAllowlist() {
  return JSON.parse(readFileSync(allowlistPath, "utf8"));
}

describe("audit-rust-orphans fixture dispatcher gate", () => {
  it("tracks protected contract modules whose only production reference is their module declaration", () => {
    const audit = runAudit();
    const stranded = audit.fixtureDispatcherGate.stranded;

    expect(stranded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "native/crates/aimux/src/plugin_runtime_contract.rs",
          module: "plugin_runtime_contract",
          productionReferences: 0,
          reason: expect.stringMatching(/^Tracked plugin parity fixture/),
        }),
      ]),
    );
    expect(audit.fixtureDispatcherGate.untracked).toHaveLength(0);
  });

  it("separates production, twin, and test references for stranded dispatcher modules", () => {
    const audit = runAudit();
    const attachmentStore = audit.fixtureDispatcherGate.stranded.find(
      (entry) => entry.file === "native/crates/aimux/src/attachment_store_contract.rs",
    );
    const siblingReferencedHelper = audit.actionable.find(
      (entry) =>
        entry.file === "native/crates/aimux/src/attachment_store_contract.rs" &&
        entry.name === "attachment_store_contract_is_supported",
    );

    expect(attachmentStore).toEqual(
      expect.objectContaining({
        productionReferences: 0,
        twinReferences: 0,
      }),
    );
    expect(attachmentStore.testReferences).toBeGreaterThan(0);
    expect(siblingReferencedHelper).toEqual(
      expect.objectContaining({
        productionReferences: 0,
        twinReferences: 0,
      }),
    );
  });

  it("uses the allowlist as a typed debt register", () => {
    const audit = runAudit();
    const allowlist = loadAllowlist();
    const allowlistFiles = Object.keys(allowlist).sort();
    const trackedDebt = audit.fixtureDispatcherGate.stranded.filter((entry) => entry.reason);

    expect(trackedDebt.map((entry) => entry.file).sort()).toEqual(allowlistFiles);
    expect(allowlistFiles).toEqual([
      "native/crates/aimux/src/attachment_store_contract.rs",
      "native/crates/aimux/src/cli_attachment_contract.rs",
      "native/crates/aimux/src/plugin_runtime_contract.rs",
      "native/crates/aimux/src/transport_security_contract.rs",
    ]);
  });

  it("passes the enforced fixture-twin gate when tracked debt is registered", () => {
    const audit = runAudit(["--json", "--enforce-fixture-twins"]);

    expect(audit.fixtureDispatcherGate.untracked).toHaveLength(0);
    expect(audit.fixtureDispatcherGate.stale).toHaveLength(0);
  });
});
