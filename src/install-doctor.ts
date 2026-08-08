import type { InstallCleanupPlan, InstallCleanupRunResult, InstallKeepReason } from "./install-cleanup.js";

const KEEP_REASON_LABELS: Record<InstallKeepReason, string> = {
  "current-install": "current install",
  "in-use": "still referenced",
  recent: "among the newest",
  "within-retention": "inside retention",
  "references-unverified": "reference scan incomplete",
  incomplete: "mid-install or broken",
};

/**
 * Removal has to be typed out in full. Every other invocation, including a missing
 * or falsy flag, stays a dry run.
 */
export function isInstallCleanupDryRun(options: { fix?: boolean }): boolean {
  return options.fix !== true;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${bytes} B`;
}

function countByReason(plan: InstallCleanupPlan): Array<[InstallKeepReason, number]> {
  const counts = new Map<InstallKeepReason, number>();
  for (const entry of plan.keep) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export function renderInstallCleanupPlan(plan: InstallCleanupPlan): string {
  const lines = [
    "Aimux Installs",
    `  root: ${plan.root}`,
    `  current: ${plan.currentInstall ?? "unknown"}`,
    `  kept: ${plan.keep.length}`,
  ];
  for (const [reason, count] of countByReason(plan)) {
    lines.push(`    ${KEEP_REASON_LABELS[reason]}: ${count}`);
  }
  lines.push(`  removable: ${plan.remove.length} (${formatBytes(plan.reclaimableBytes)})`);
  lines.push(`  policy: keep ${plan.keepRecent} newest, retain ${plan.retentionDays} days`);

  if (!plan.referencesComplete) {
    lines.push(
      "",
      "  Reference scan was incomplete, so nothing can be removed.",
      "  An install that could not be checked is treated as still in use.",
    );
    return lines.join("\n");
  }

  if (plan.remove.length === 0) {
    lines.push("", "  Nothing to remove.");
    return lines.join("\n");
  }

  lines.push("", "  Oldest removable:");
  for (const candidate of [...plan.remove].sort((a, b) => b.ageDays - a.ageDays).slice(0, 5)) {
    lines.push(`    ${candidate.name}  ${Math.round(candidate.ageDays)}d  ${formatBytes(candidate.sizeBytes)}`);
  }
  if (plan.remove.length > 5) lines.push(`    ... and ${plan.remove.length - 5} more`);
  return lines.join("\n");
}

export function renderInstallCleanupResult(result: InstallCleanupRunResult): string {
  const lines = [renderInstallCleanupPlan(result.plan)];
  if (result.plan.remove.length === 0) return lines.join("\n");

  if (result.dryRun) {
    lines.push(
      "",
      `  Dry run: nothing was removed. Pass --fix to reclaim ${formatBytes(result.plan.reclaimableBytes)}.`,
    );
    return lines.join("\n");
  }

  const removed = result.results.filter((entry) => entry.status === "removed").length;
  const failed = result.results.filter((entry) => entry.status === "failed");
  lines.push("", `  Removed ${removed} installs, reclaiming ${formatBytes(result.reclaimedBytes)}.`);
  for (const failure of failed) {
    lines.push(`    failed: ${failure.name}: ${failure.error ?? "unknown error"}`);
  }
  return lines.join("\n");
}
