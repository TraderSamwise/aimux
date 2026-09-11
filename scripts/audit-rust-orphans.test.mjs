import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function runAudit() {
  const result = spawnSync("node", ["scripts/audit-rust-orphans.mjs", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("audit-rust-orphans fixture dispatcher gate", () => {
  it("reports real contract modules whose only production reference is their module declaration", () => {
    const audit = runAudit();
    const untracked = audit.fixtureDispatcherGate.untracked;

    expect(untracked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "native/crates/aimux/src/alert_display_contract.rs",
          module: "alert_display_contract",
          productionReferences: 0,
        }),
      ]),
    );
    expect(audit.fixtureDispatcherGate.stranded).toHaveLength(26);
    expect(untracked).toHaveLength(24);
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
});
