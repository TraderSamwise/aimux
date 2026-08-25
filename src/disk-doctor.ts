import { formatWorktreeCacheBytes } from "./worktree-cache-cleanup.js";

export interface DiskDoctorProjectReport {
  projectRoot: string;
  inactiveReclaimableBytes: number;
  inactiveTargetCount: number;
  protectedActiveBytes: number;
  protectedActiveTargetCount: number;
  protectedActiveMeasured: boolean;
  skippedActiveWorktrees: number;
  error?: string;
}

export interface DiskDoctorReport {
  generatedAt: string;
  projects: DiskDoctorProjectReport[];
  skippedStaleProjectRoots: string[];
  totals: {
    inactiveReclaimableBytes: number;
    inactiveTargetCount: number;
    protectedActiveBytes: number;
    protectedActiveTargetCount: number;
    protectedActiveMeasuredProjects: number;
    protectedActiveUnmeasuredProjects: number;
    skippedActiveWorktrees: number;
    failures: number;
  };
}

export function buildDiskDoctorReport(input: {
  generatedAt: string;
  projects: DiskDoctorProjectReport[];
  skippedStaleProjectRoots?: string[];
}): DiskDoctorReport {
  return {
    generatedAt: input.generatedAt,
    projects: input.projects,
    skippedStaleProjectRoots: input.skippedStaleProjectRoots ?? [],
    totals: input.projects.reduce(
      (totals, project) => ({
        inactiveReclaimableBytes: totals.inactiveReclaimableBytes + project.inactiveReclaimableBytes,
        inactiveTargetCount: totals.inactiveTargetCount + project.inactiveTargetCount,
        protectedActiveBytes: totals.protectedActiveBytes + project.protectedActiveBytes,
        protectedActiveTargetCount: totals.protectedActiveTargetCount + project.protectedActiveTargetCount,
        protectedActiveMeasuredProjects:
          totals.protectedActiveMeasuredProjects + (project.protectedActiveMeasured ? 1 : 0),
        protectedActiveUnmeasuredProjects:
          totals.protectedActiveUnmeasuredProjects +
          (!project.protectedActiveMeasured && !project.error && project.skippedActiveWorktrees > 0 ? 1 : 0),
        skippedActiveWorktrees: totals.skippedActiveWorktrees + project.skippedActiveWorktrees,
        failures: totals.failures + (project.error ? 1 : 0),
      }),
      {
        inactiveReclaimableBytes: 0,
        inactiveTargetCount: 0,
        protectedActiveBytes: 0,
        protectedActiveTargetCount: 0,
        protectedActiveMeasuredProjects: 0,
        protectedActiveUnmeasuredProjects: 0,
        skippedActiveWorktrees: 0,
        failures: 0,
      },
    ),
  };
}

export function renderDiskDoctorReport(report: DiskDoctorReport): string {
  const skippedStaleProjectRoots = Array.isArray(report.skippedStaleProjectRoots)
    ? report.skippedStaleProjectRoots
    : [];
  const lines = [
    "Aimux Disk",
    `  inactive generated caches: ${formatWorktreeCacheBytes(
      report.totals.inactiveReclaimableBytes,
    )} (${report.totals.inactiveTargetCount} item(s))`,
    report.totals.protectedActiveUnmeasuredProjects > 0
      ? `  protected active caches: not measured (${report.totals.skippedActiveWorktrees} active worktree(s)); pass --include-active to measure`
      : `  protected active caches: ${formatWorktreeCacheBytes(report.totals.protectedActiveBytes)} (${
          report.totals.protectedActiveTargetCount
        } item(s), ${report.totals.skippedActiveWorktrees} active worktree(s))`,
    `  failures: ${report.totals.failures}`,
  ];
  if (skippedStaleProjectRoots.length > 0) {
    lines.push(`  skipped stale projects: ${skippedStaleProjectRoots.length}`);
  }
  const sorted = [...report.projects].sort((left, right) => {
    const leftBytes = left.inactiveReclaimableBytes + left.protectedActiveBytes;
    const rightBytes = right.inactiveReclaimableBytes + right.protectedActiveBytes;
    return rightBytes - leftBytes;
  });
  for (const project of sorted) {
    if (
      !project.error &&
      project.inactiveReclaimableBytes === 0 &&
      project.protectedActiveBytes === 0 &&
      project.skippedActiveWorktrees === 0
    ) {
      continue;
    }
    lines.push(
      `  ${project.projectRoot}`,
      `    inactive: ${formatWorktreeCacheBytes(project.inactiveReclaimableBytes)} (${
        project.inactiveTargetCount
      } item(s))`,
      project.protectedActiveMeasured
        ? `    protected: ${formatWorktreeCacheBytes(project.protectedActiveBytes)} (${
            project.protectedActiveTargetCount
          } item(s), ${project.skippedActiveWorktrees} active worktree(s))`
        : `    protected: not measured (${project.skippedActiveWorktrees} active worktree(s)); pass --include-active to measure`,
    );
    if (project.error) lines.push(`    error: ${project.error}`);
  }
  if (
    sorted.every(
      (project) =>
        !project.error &&
        project.inactiveReclaimableBytes === 0 &&
        project.protectedActiveBytes === 0 &&
        project.skippedActiveWorktrees === 0,
    )
  ) {
    lines.push("  no generated worktree caches found");
  }
  return lines.join("\n");
}
