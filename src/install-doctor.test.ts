import { describe, expect, it } from "vitest";
import type { InstallCleanupPlan } from "./install-cleanup.js";
import { isInstallCleanupDryRun, renderInstallCleanupPlan, renderInstallCleanupResult } from "./install-doctor.js";

function makePlan(overrides: Partial<InstallCleanupPlan> = {}): InstallCleanupPlan {
  return {
    root: "/root/native",
    currentInstall: "current",
    retentionDays: 30,
    keepRecent: 10,
    referencesComplete: true,
    remove: [{ name: "old", path: "/root/native/old", ageDays: 70.4, sizeBytes: 19_000_000 }],
    keep: [
      { name: "current", reason: "current-install" },
      { name: "busy", reason: "in-use" },
    ],
    reclaimableBytes: 19_000_000,
    ...overrides,
  };
}

describe("install cleanup dry-run default", () => {
  // The one line standing between a report and deleting gigabytes.
  it("only leaves dry-run mode when --fix is passed explicitly", () => {
    expect(isInstallCleanupDryRun({})).toBe(true);
    expect(isInstallCleanupDryRun({ fix: undefined })).toBe(true);
    expect(isInstallCleanupDryRun({ fix: false })).toBe(true);
    expect(isInstallCleanupDryRun({ fix: true })).toBe(false);
  });

  it("stays a dry run for a flag value that is truthy but not true", () => {
    expect(isInstallCleanupDryRun({ fix: "yes" } as unknown as { fix?: boolean })).toBe(true);
  });
});

describe("install doctor report", () => {
  it("summarises the root, current install and what would be reclaimed", () => {
    const text = renderInstallCleanupPlan(makePlan());

    expect(text).toContain("root: /root/native");
    expect(text).toContain("current: current");
    expect(text).toContain("removable: 1 (19 MB)");
    expect(text).toContain("old  70d  19 MB");
  });

  it("says plainly that an incomplete reference scan removes nothing", () => {
    const text = renderInstallCleanupPlan(makePlan({ referencesComplete: false, remove: [], reclaimableBytes: 0 }));

    expect(text).toContain("Reference scan was incomplete");
    expect(text).not.toContain("Oldest removable");
  });

  it("reports an unknown current install rather than printing null", () => {
    expect(renderInstallCleanupPlan(makePlan({ currentInstall: null }))).toContain("current: unknown");
  });

  it("tells a dry run how to actually reclaim the space", () => {
    const plan = makePlan();
    const text = renderInstallCleanupResult({ dryRun: true, plan, results: [], reclaimedBytes: 0 });

    expect(text).toContain("Dry run: nothing was removed");
    expect(text).toContain("--fix");
  });

  it("reports what a real run removed, including failures", () => {
    const plan = makePlan();
    const text = renderInstallCleanupResult({
      dryRun: false,
      plan,
      results: [
        { name: "old", status: "removed", sizeBytes: 19_000_000 },
        { name: "stuck", status: "failed", sizeBytes: 0, error: "permission denied" },
      ],
      reclaimedBytes: 19_000_000,
    });

    expect(text).toContain("Removed 1 installs, reclaiming 19 MB.");
    expect(text).toContain("failed: stuck: permission denied");
  });

  it("does not offer --fix when there is nothing to remove", () => {
    const plan = makePlan({ remove: [], reclaimableBytes: 0 });
    const text = renderInstallCleanupResult({ dryRun: true, plan, results: [], reclaimedBytes: 0 });

    expect(text).toContain("Nothing to remove.");
    expect(text).not.toContain("--fix");
  });
});
