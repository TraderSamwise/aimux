import { existsSync, readFileSync } from "node:fs";

import { quarantineCorruptFile } from "./atomic-write.js";
import { log } from "./debug.js";
import { getGlobalConfigPath } from "./paths.js";
import { DEFAULT_RECORDING_RETENTION_DAYS } from "./recording-cleanup.js";

/**
 * Recording cleanup is configured from the GLOBAL config only, like `installs`.
 * Recordings live under AIMUX_HOME rather than in the repo, so a project config
 * has no standing to decide how long they are kept.
 */
export interface RecordingsConfig {
  /** Whether the daemon sweeps recordings past retention. */
  cleanupEnabled: boolean;
  /** Recordings younger than this are always kept. */
  retentionDays: number;
}

export const DEFAULT_RECORDINGS_CONFIG: RecordingsConfig = {
  cleanupEnabled: true,
  retentionDays: DEFAULT_RECORDING_RETENTION_DAYS,
};

/** Deleting everything unwatched on a timer is never what a zero was meant to ask for. */
export const MIN_RECORDING_RETENTION_DAYS = 1;

export function normalizeRecordingsConfig(raw: unknown): RecordingsConfig {
  const value = (raw ?? {}) as Record<string, unknown>;
  const retention = value.retentionDays;
  let retentionDays = DEFAULT_RECORDINGS_CONFIG.retentionDays;
  if (retention !== undefined) {
    if (typeof retention !== "number" || !Number.isFinite(retention)) {
      log.warn("ignoring non-numeric recordings retention", "config", { value: retention, using: retentionDays });
    } else {
      const rounded = Math.trunc(retention);
      // Out of range falls back rather than clamping, so a typo cannot widen the sweep.
      if (rounded < MIN_RECORDING_RETENTION_DAYS || rounded > 3_650) {
        log.warn("ignoring out-of-range recordings retention", "config", { value: retention, using: retentionDays });
      } else {
        retentionDays = rounded;
      }
    }
  }
  return {
    cleanupEnabled:
      typeof value.cleanupEnabled === "boolean" ? value.cleanupEnabled : DEFAULT_RECORDINGS_CONFIG.cleanupEnabled,
    retentionDays,
  };
}

/** Read the `recordings` block from the global config file. */
export function loadRecordingsConfig(): RecordingsConfig {
  const globalPath = getGlobalConfigPath();
  if (!existsSync(globalPath)) return normalizeRecordingsConfig(undefined);
  try {
    const parsed = JSON.parse(readFileSync(globalPath, "utf-8")) as Record<string, unknown>;
    return normalizeRecordingsConfig(parsed?.recordings);
  } catch {
    quarantineCorruptFile(globalPath);
    return normalizeRecordingsConfig(undefined);
  }
}
