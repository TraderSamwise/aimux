import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECORDINGS_CONFIG,
  MIN_RECORDING_RETENTION_DAYS,
  normalizeRecordingsConfig,
} from "./recording-config.js";

describe("recordings config", () => {
  it("falls back to defaults when absent or malformed", () => {
    expect(normalizeRecordingsConfig(undefined)).toEqual(DEFAULT_RECORDINGS_CONFIG);
    expect(normalizeRecordingsConfig("on")).toEqual(DEFAULT_RECORDINGS_CONFIG);
    expect(normalizeRecordingsConfig({ retentionDays: "soon" })).toEqual(DEFAULT_RECORDINGS_CONFIG);
  });

  it("gives the sweep an off switch", () => {
    expect(DEFAULT_RECORDINGS_CONFIG.cleanupEnabled).toBe(true);
    expect(normalizeRecordingsConfig({ cleanupEnabled: false }).cleanupEnabled).toBe(false);
  });

  it("refuses a retention that would delete everything unwatched", () => {
    expect(normalizeRecordingsConfig({ retentionDays: 0 }).retentionDays).toBe(DEFAULT_RECORDINGS_CONFIG.retentionDays);
    expect(normalizeRecordingsConfig({ retentionDays: -1 }).retentionDays).toBe(
      DEFAULT_RECORDINGS_CONFIG.retentionDays,
    );
    expect(normalizeRecordingsConfig({ retentionDays: MIN_RECORDING_RETENTION_DAYS }).retentionDays).toBe(
      MIN_RECORDING_RETENTION_DAYS,
    );
  });

  it("ignores an out-of-range retention rather than clamping it", () => {
    expect(normalizeRecordingsConfig({ retentionDays: 99_999 }).retentionDays).toBe(
      DEFAULT_RECORDINGS_CONFIG.retentionDays,
    );
  });
});
