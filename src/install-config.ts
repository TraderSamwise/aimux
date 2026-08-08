import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { quarantineCorruptFile } from "./atomic-write.js";
import { log } from "./debug.js";
import { DEFAULT_INSTALL_KEEP_RECENT, DEFAULT_INSTALL_RETENTION_DAYS } from "./install-cleanup.js";
import { getGlobalConfigPath } from "./paths.js";

/**
 * Install cleanup is configured from the GLOBAL config only.
 *
 * There is one install root per machine, shared by every project. Project
 * config is committed in repos, so letting it reach these fields would mean
 * cloning a repo could widen — or silently disable — a machine-wide sweep that
 * has nothing to do with that repo. This never joins `AimuxConfig`.
 */
export interface InstallsConfig {
  /** Whether the daemon sweeps superseded installs on a cadence. */
  cleanupEnabled: boolean;
  /** Installs younger than this are always kept. */
  retentionDays: number;
  /** How many of the newest installs are kept regardless of age. */
  keepRecent: number;
  /** How often the daemon sweeps. */
  cleanupIntervalMs: number;
}

export const DEFAULT_INSTALLS_CONFIG: InstallsConfig = {
  cleanupEnabled: true,
  retentionDays: DEFAULT_INSTALL_RETENTION_DAYS,
  keepRecent: DEFAULT_INSTALL_KEEP_RECENT,
  cleanupIntervalMs: 86_400_000,
};

/** An unattended sweep must never run hotter than this, whatever config says. */
export const MIN_INSTALL_CLEANUP_INTERVAL_MS = 3_600_000;

/**
 * A retention of zero would mean "delete everything unreferenced" on a timer
 * nobody is watching. The explicit CLI still honours zero; this path does not.
 */
export const MIN_INSTALL_RETENTION_DAYS = 1;

function boundedInt(key: string, value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    log.warn("ignoring non-numeric installs config value", "config", { key, value, using: fallback });
    return fallback;
  }
  const rounded = Math.trunc(value);
  if (rounded < min || rounded > max) {
    // Silently clamping a typo would produce a sweep nobody asked for.
    log.warn("ignoring out-of-range installs config value", "config", { key, value, min, max, using: fallback });
    return fallback;
  }
  return rounded;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeInstallsConfig(raw: unknown): InstallsConfig {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    cleanupEnabled: boolOr(value.cleanupEnabled, DEFAULT_INSTALLS_CONFIG.cleanupEnabled),
    retentionDays: boundedInt(
      "retentionDays",
      value.retentionDays,
      DEFAULT_INSTALLS_CONFIG.retentionDays,
      MIN_INSTALL_RETENTION_DAYS,
      3_650,
    ),
    keepRecent: boundedInt("keepRecent", value.keepRecent, DEFAULT_INSTALLS_CONFIG.keepRecent, 0, 10_000),
    cleanupIntervalMs: boundedInt(
      "cleanupIntervalMs",
      value.cleanupIntervalMs,
      DEFAULT_INSTALLS_CONFIG.cleanupIntervalMs,
      MIN_INSTALL_CLEANUP_INTERVAL_MS,
      30 * 86_400_000,
    ),
  };
}

/**
 * The install root is keyed to the home directory, not to AIMUX_HOME, so every
 * lane's daemon sees the same one and only the default lane may sweep it.
 *
 * The launcher sets AIMUX_HOME unconditionally (launcher-env.ts), so its presence
 * says nothing — only its value does. This mirrors resolveAimuxHome's expansion.
 */
export function isPrimaryInstallLane(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env.AIMUX_HOME?.trim();
  if (!configured) return true;
  const expanded =
    configured === "~"
      ? homedir()
      : configured.startsWith("~/")
        ? resolve(homedir(), configured.slice(2))
        : resolve(configured);
  return expanded === join(homedir(), ".aimux");
}

/** Read the `installs` block from the global config file. */
export function loadInstallsConfig(): InstallsConfig {
  const globalPath = getGlobalConfigPath();
  if (!existsSync(globalPath)) return normalizeInstallsConfig(undefined);
  try {
    const parsed = JSON.parse(readFileSync(globalPath, "utf-8")) as Record<string, unknown>;
    return normalizeInstallsConfig(parsed?.installs);
  } catch {
    quarantineCorruptFile(globalPath);
    return normalizeInstallsConfig(undefined);
  }
}
