import { describe, expect, it } from "vitest";

import { formatLabeledRecency, formatRelativeRecency, parseRecencyTimestamp } from "@/lib/recency";

const NOW = Date.parse("2026-09-06T04:00:00.000Z");

describe("app recency formatting", () => {
  it("formats relative timestamps with the dashboard buckets", () => {
    expect(formatRelativeRecency("2026-09-06T03:59:50.000Z", NOW)).toBe("just now");
    expect(formatRelativeRecency("2026-09-06T03:59:20.000Z", NOW)).toBe("40s ago");
    expect(formatRelativeRecency("2026-09-06T03:17:00.000Z", NOW)).toBe("43m ago");
    expect(formatRelativeRecency("2026-09-06T01:00:00.000Z", NOW)).toBe("3h ago");
    expect(formatRelativeRecency("2026-09-04T04:00:00.000Z", NOW)).toBe("2d ago");
    expect(formatRelativeRecency("2026-08-16T04:00:00.000Z", NOW)).toBe("3w ago");
    expect(formatRelativeRecency("2026-05-06T04:00:00.000Z", NOW)).toBe("4mo ago");
    expect(formatRelativeRecency("2024-09-06T04:00:00.000Z", NOW)).toBe("2y ago");
  });

  it("labels recency when the server supplies a semantic anchor", () => {
    expect(formatLabeledRecency("output", "2026-09-06T03:57:00.000Z", NOW)).toBe("output 3m ago");
    expect(formatLabeledRecency("prompted", "2026-09-06T02:00:00.000Z", NOW)).toBe(
      "prompted 2h ago",
    );
    expect(formatLabeledRecency(null, "2026-09-06T03:59:50.000Z", NOW)).toBe("just now");
  });

  it("ignores missing or invalid timestamps", () => {
    expect(parseRecencyTimestamp("wat")).toBeNull();
    expect(formatRelativeRecency("wat", NOW)).toBeNull();
    expect(formatLabeledRecency("output", undefined, NOW)).toBeNull();
  });
});
