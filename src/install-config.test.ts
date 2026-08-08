import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_INSTALLS_CONFIG,
  MIN_INSTALL_CLEANUP_INTERVAL_MS,
  MIN_INSTALL_RETENTION_DAYS,
  loadInstallsConfig,
  normalizeInstallsConfig,
} from "./install-config.js";

describe("loadInstallsConfig", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "aimux-install-config-"));
    previousHome = process.env.AIMUX_HOME;
    process.env.AIMUX_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("returns defaults when no global config exists", () => {
    expect(loadInstallsConfig()).toEqual(DEFAULT_INSTALLS_CONFIG);
  });

  it("returns defaults when the config exists but declares no installs block", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ defaultTool: "claude" }));

    expect(loadInstallsConfig()).toEqual(DEFAULT_INSTALLS_CONFIG);
  });

  it("reads the installs block from the global config", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ installs: { cleanupEnabled: false, keepRecent: 3 } }));

    const config = loadInstallsConfig();

    expect(config.cleanupEnabled).toBe(false);
    expect(config.keepRecent).toBe(3);
    expect(config.retentionDays).toBe(DEFAULT_INSTALLS_CONFIG.retentionDays);
  });

  it("quarantines a corrupt global config rather than throwing", () => {
    const path = join(home, "config.json");
    writeFileSync(path, "{ not json");

    expect(loadInstallsConfig()).toEqual(DEFAULT_INSTALLS_CONFIG);
    expect(existsSync(path)).toBe(false);
  });
});

describe("installs config", () => {
  it("falls back to the defaults when the block is absent or malformed", () => {
    expect(normalizeInstallsConfig(undefined)).toEqual(DEFAULT_INSTALLS_CONFIG);
    expect(normalizeInstallsConfig(null)).toEqual(DEFAULT_INSTALLS_CONFIG);
    expect(normalizeInstallsConfig({ retentionDays: "soon", keepRecent: null })).toEqual(DEFAULT_INSTALLS_CONFIG);
  });

  it("sweeps by default, because accumulating installs is the normal case", () => {
    expect(DEFAULT_INSTALLS_CONFIG.cleanupEnabled).toBe(true);
  });

  it("lets the sweep be turned off", () => {
    expect(normalizeInstallsConfig({ cleanupEnabled: false }).cleanupEnabled).toBe(false);
  });

  it("refuses a retention of zero, which would delete everything unreferenced", () => {
    expect(normalizeInstallsConfig({ retentionDays: 0 }).retentionDays).toBe(DEFAULT_INSTALLS_CONFIG.retentionDays);
    expect(normalizeInstallsConfig({ retentionDays: -5 }).retentionDays).toBe(DEFAULT_INSTALLS_CONFIG.retentionDays);
    expect(normalizeInstallsConfig({ retentionDays: MIN_INSTALL_RETENTION_DAYS }).retentionDays).toBe(
      MIN_INSTALL_RETENTION_DAYS,
    );
  });

  it("refuses a sweep interval faster than the floor", () => {
    expect(normalizeInstallsConfig({ cleanupIntervalMs: 1_000 }).cleanupIntervalMs).toBe(
      DEFAULT_INSTALLS_CONFIG.cleanupIntervalMs,
    );
    expect(normalizeInstallsConfig({ cleanupIntervalMs: MIN_INSTALL_CLEANUP_INTERVAL_MS }).cleanupIntervalMs).toBe(
      MIN_INSTALL_CLEANUP_INTERVAL_MS,
    );
  });

  it("accepts a keepRecent of zero, since age still protects", () => {
    expect(normalizeInstallsConfig({ keepRecent: 0 }).keepRecent).toBe(0);
    expect(normalizeInstallsConfig({ keepRecent: -1 }).keepRecent).toBe(DEFAULT_INSTALLS_CONFIG.keepRecent);
  });

  it("truncates rather than accepting fractional values", () => {
    expect(normalizeInstallsConfig({ retentionDays: 45.9 }).retentionDays).toBe(45);
  });

  it("treats a non-object block as absent rather than throwing", () => {
    expect(normalizeInstallsConfig("enabled")).toEqual(DEFAULT_INSTALLS_CONFIG);
    expect(normalizeInstallsConfig([1, 2, 3])).toEqual(DEFAULT_INSTALLS_CONFIG);
    expect(normalizeInstallsConfig(42)).toEqual(DEFAULT_INSTALLS_CONFIG);
  });

  it("ignores an out-of-range value instead of clamping it", () => {
    // Clamping a typo would silently produce a far more aggressive sweep.
    expect(normalizeInstallsConfig({ cleanupIntervalMs: 1_000 }).cleanupIntervalMs).toBe(
      DEFAULT_INSTALLS_CONFIG.cleanupIntervalMs,
    );
    expect(normalizeInstallsConfig({ retentionDays: 99_999 }).retentionDays).toBe(
      DEFAULT_INSTALLS_CONFIG.retentionDays,
    );
  });
});
