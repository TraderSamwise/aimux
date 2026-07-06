import { debug } from "../debug.js";

export type DashboardRepairNoticeKind = "tui-api-recovery" | "runtime-guard-repair";
export type DashboardRepairNoticePhase = "started" | "succeeded" | "failed" | "blocked" | "waiting";

export interface DashboardRepairNotice {
  kind: DashboardRepairNoticeKind;
  phase: DashboardRepairNoticePhase;
  message: string;
  at: number;
  error?: string;
}

interface RepairNoticeOptions {
  flash?: boolean;
  ticks?: number;
}

function stringifyRepairError(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  return error instanceof Error ? error.message : String(error);
}

export function recordDashboardRepairNotice(
  host: any,
  notice: Omit<DashboardRepairNotice, "at" | "error"> & { error?: unknown },
  opts: RepairNoticeOptions = {},
): DashboardRepairNotice {
  const entry: DashboardRepairNotice = {
    kind: notice.kind,
    phase: notice.phase,
    message: notice.message,
    at: Date.now(),
    error: stringifyRepairError(notice.error),
  };
  const previous = Array.isArray(host.dashboardRepairNotices) ? host.dashboardRepairNotices : [];
  host.dashboardRepairNotices = [...previous, entry].slice(-20);
  debug(`${entry.kind} ${entry.phase}: ${entry.message}${entry.error ? ` (${entry.error})` : ""}`, "runtime");
  if (opts.flash !== false && (!host.mode || host.mode === "dashboard")) {
    host.footerFlash = entry.message;
    host.footerFlashTicks = opts.ticks ?? 4;
    host.renderCurrentDashboardView?.();
  }
  return entry;
}
