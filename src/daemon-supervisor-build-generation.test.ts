import { describe, expect, it } from "vitest";
import {
  StaleClientBuildError,
  buildStampGeneration,
  isStaleAgainstDaemon,
  shouldKeepUnresponsiveDaemon,
} from "./daemon-supervisor.js";

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

describe("shouldKeepUnresponsiveDaemon", () => {
  it("keeps a daemon whose process is alive, so a stall cannot become a restart loop", () => {
    // One slow request blocks the daemon's whole event loop, so every client
    // probing during it times out at once. Replacing on that verdict means each
    // one starts a daemon, the replacement is equally busy, and it repeats.
    expect(shouldKeepUnresponsiveDaemon({}, true)).toBe(true);
    expect(shouldKeepUnresponsiveDaemon({ adoptExisting: true }, true)).toBe(true);
  });

  it("replaces one that is actually gone", () => {
    expect(shouldKeepUnresponsiveDaemon({}, false)).toBe(false);
  });

  it("still lets an explicit restart stop a busy daemon", () => {
    // `aimux restart` passes adoptExisting: false. Were the guard to cover that
    // too, a daemon slow enough to need restarting would be the one you could not
    // restart.
    expect(shouldKeepUnresponsiveDaemon({ adoptExisting: false }, true)).toBe(false);
  });
});
