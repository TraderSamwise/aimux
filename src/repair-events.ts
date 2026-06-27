import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sendDesktopNotification } from "./desktop-notifier.js";
import { getProjectRepairLogPathFor } from "./paths.js";

export type RepairEventAction =
  | "control-plane-restart"
  | "project-service-ensure"
  | "tmux-runtime-repair"
  | "dashboard-reload";

export interface RepairEvent {
  ts: string;
  projectRoot: string;
  action: RepairEventAction;
  reason: string;
  status: "started" | "repaired" | "skipped" | "failed";
  details?: Record<string, unknown>;
}

export interface RepairNotifier {
  record(event: RepairEvent): void;
  notify(title: string, message: string): void;
}

export const defaultRepairNotifier: RepairNotifier = {
  record: recordRepairEvent,
  notify: notifyRepair,
};

export function recordRepairEvent(event: RepairEvent): void {
  try {
    const path = getProjectRepairLogPathFor(event.projectRoot);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`);
  } catch {
    // Repair diagnostics must never break the repair itself.
  }
}

export function notifyRepair(title: string, message: string): void {
  try {
    sendDesktopNotification({ title, message, sound: false });
  } catch {
    // Desktop notification delivery is best-effort.
  }
}
