import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runAudit(args = ["--json"]) {
  const result = spawnSync("node", ["scripts/audit-rust-orphans.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("audit-rust-orphans fixture dispatcher gate", () => {
  it("tracks real contract modules whose only production reference is their module declaration", () => {
    const audit = runAudit();
    const stranded = audit.fixtureDispatcherGate.stranded;

    expect(stranded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "native/crates/aimux/src/alert_display_contract.rs",
          module: "alert_display_contract",
          productionReferences: 0,
          reason: expect.stringMatching(/^DEAD TWIN:/),
        }),
      ]),
    );
    expect(stranded).toHaveLength(26);
    expect(audit.fixtureDispatcherGate.untracked).toHaveLength(0);
  });

  it("separates production, twin, and test references for stranded dispatcher modules", () => {
    const audit = runAudit();
    const cliProjectService = audit.fixtureDispatcherGate.stranded.find(
      (entry) => entry.file === "native/crates/aimux/src/cli_project_service_contract.rs",
    );
    const siblingReferencedHelper = audit.actionable.find(
      (entry) =>
        entry.file === "native/crates/aimux/src/cli_project_service_contract.rs" &&
        entry.name === "core_project_service_pid",
    );

    expect(cliProjectService).toEqual(
      expect.objectContaining({
        productionReferences: 0,
        twinReferences: 0,
      }),
    );
    expect(cliProjectService.testReferences).toBeGreaterThan(0);
    expect(siblingReferencedHelper).toEqual(
      expect.objectContaining({
        productionReferences: 0,
        twinReferences: 1,
      }),
    );
  });

  it("uses the allowlist as a typed debt register", () => {
    const audit = runAudit();
    const trackedDebt = audit.fixtureDispatcherGate.stranded.filter((entry) => entry.reason);
    const newlyTracked = trackedDebt.filter((entry) =>
      ![
        "native/crates/aimux/src/plugin_runtime_contract.rs",
        "native/crates/aimux/src/transport_security_contract.rs",
      ].includes(entry.file),
    );

    expect(trackedDebt).toHaveLength(26);
    expect(newlyTracked).toHaveLength(24);
    expect(newlyTracked.every((entry) => /^(DEAD|LIVE) TWIN:/.test(entry.reason))).toBe(true);
  });

  it("passes the enforced fixture-twin gate when tracked debt is registered", () => {
    const audit = runAudit(["--json", "--enforce-fixture-twins"]);

    expect(audit.fixtureDispatcherGate.untracked).toHaveLength(0);
    expect(audit.fixtureDispatcherGate.stale).toHaveLength(0);
  });
});
