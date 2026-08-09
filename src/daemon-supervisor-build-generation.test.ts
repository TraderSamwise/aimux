import { describe, expect, it } from "vitest";
import { StaleClientBuildError, buildStampGeneration, isStaleAgainstDaemon } from "./daemon-supervisor.js";

// Real stamps, as `computeBuildStamp` emits them: two artifact mtimes then a hash.
const OLDER = "1786180016000.1786180016000-35f055a7caff";
const NEWER = "1786237306000.1786237306000-35f055a7caff";

describe("buildStampGeneration", () => {
  it("reads the leading artifact mtime", () => {
    expect(buildStampGeneration(OLDER)).toBe(1786180016000);
    expect(buildStampGeneration(NEWER)).toBe(1786237306000);
  });

  it("returns null for stamps it cannot order", () => {
    for (const stamp of [undefined, null, "", "-onlyhash", "nan.nan-abc", 0, "0.0-abc"]) {
      expect(buildStampGeneration(stamp)).toBeNull();
    }
  });
});

describe("isStaleAgainstDaemon", () => {
  it("is stale only when the daemon is strictly newer than this process", () => {
    expect(isStaleAgainstDaemon(NEWER, OLDER)).toBe(true);
    expect(isStaleAgainstDaemon(OLDER, NEWER)).toBe(false);
    expect(isStaleAgainstDaemon(NEWER, NEWER)).toBe(false);
  });

  it("never claims staleness when either side is unorderable", () => {
    // Unknown ordering must fall through to the existing mismatch handling rather
    // than block a legitimate restart.
    expect(isStaleAgainstDaemon(undefined, OLDER)).toBe(false);
    expect(isStaleAgainstDaemon(NEWER, undefined)).toBe(false);
    expect(isStaleAgainstDaemon("garbage", "garbage")).toBe(false);
  });
});

describe("StaleClientBuildError", () => {
  it("names both builds and points at reloading the client, not the daemon", () => {
    const error = new StaleClientBuildError(NEWER, OLDER);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("StaleClientBuildError");
    expect(error.daemonBuildStamp).toBe(NEWER);
    expect(error.clientBuildStamp).toBe(OLDER);
    expect(error.message).toContain(NEWER);
    expect(error.message).toContain(OLDER);
    expect(error.message).toContain("reload this client");
  });
});
