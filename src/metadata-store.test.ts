import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { getReadOnlyProjectPathsFor, initPaths } from "./paths.js";
import {
  loadMetadataState,
  saveMetadataState,
  setSessionLoop,
  clearSessionLoop,
  setSessionOverseer,
  findOverseerSessionId,
  updateSessionMetadata,
  putStatuslineSegment,
  dropStatuslineSegment,
  segmentRejection,
  MAX_SEGMENT_DATA_BYTES,
  MAX_SEGMENT_TTL_SECONDS,
} from "./metadata-store.js";

function gitInit(cwd: string): void {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_COMMON_DIR;
  execFileSync("git", ["init"], { cwd, stdio: "ignore", env });
}

describe("metadata store", () => {
  it("loads metadata with malformed session entries while scrubbing topology-owned identity fields", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-metadata-store-load-"));
    gitInit(repoRoot);
    await initPaths(repoRoot);
    const paths = getReadOnlyProjectPathsFor(repoRoot);
    writeFileSync(
      paths.metadataPath,
      JSON.stringify({
        version: 1,
        sessions: {
          malformed: null,
          valid: {
            backendSessionId: "backend-1",
            label: "stale-label",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );

    const state = loadMetadataState(repoRoot);

    expect(state.sessions.malformed).toBeNull();
    expect(state.sessions.valid).toEqual({ updatedAt: "2026-01-01T00:00:00.000Z" });

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("saves metadata with malformed session entries while scrubbing topology-owned identity fields", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-metadata-store-save-"));
    gitInit(repoRoot);
    await initPaths(repoRoot);

    expect(() =>
      saveMetadataState(
        {
          version: 1,
          sessions: {
            malformed: null,
            valid: {
              backendSessionId: "backend-1",
              label: "stale-label",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          },
        } as any,
        repoRoot,
      ),
    ).not.toThrow();

    const state = loadMetadataState(repoRoot);

    expect(state.sessions.malformed).toBeNull();
    expect(state.sessions.valid).toEqual({ updatedAt: "2026-01-01T00:00:00.000Z" });

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("round-trips loop and overseer flags and finds the overseer", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-metadata-store-loop-"));
    gitInit(repoRoot);
    await initPaths(repoRoot);

    setSessionLoop(
      "worker-1",
      {
        active: true,
        goal: "ship the feature",
        since: "2026-06-13T00:00:00.000Z",
        source: "dashboard",
        updatedBy: "dashboard",
      },
      repoRoot,
    );
    setSessionOverseer("boss", true, repoRoot);

    let state = loadMetadataState(repoRoot);
    expect(state.sessions["worker-1"].loop).toEqual({
      active: true,
      goal: "ship the feature",
      since: "2026-06-13T00:00:00.000Z",
      source: "dashboard",
      updatedBy: "dashboard",
    });
    expect(state.sessions["worker-1"].loopLastAction).toEqual({
      action: "add",
      at: "2026-06-13T00:00:00.000Z",
      goal: "ship the feature",
      source: "dashboard",
      updatedBy: "dashboard",
    });
    expect(state.sessions.boss.overseer).toBe(true);
    expect(findOverseerSessionId(state)).toBe("boss");

    clearSessionLoop("worker-1", repoRoot, {
      action: "remove",
      at: "2026-06-13T01:00:00.000Z",
      source: "overseer",
      updatedBySessionId: "boss",
    });
    setSessionOverseer("boss", false, repoRoot);

    state = loadMetadataState(repoRoot);
    expect(state.sessions["worker-1"].loop).toBeUndefined();
    expect(state.sessions["worker-1"].loopLastAction).toMatchObject({
      action: "remove",
      at: "2026-06-13T01:00:00.000Z",
      source: "overseer",
      updatedBySessionId: "boss",
    });
    expect(state.sessions.boss.overseer).toBeUndefined();
    expect(findOverseerSessionId(state)).toBeUndefined();

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("skips writes for unchanged session metadata payloads", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-metadata-store-noop-"));
    gitInit(repoRoot);
    await initPaths(repoRoot);
    const paths = getReadOnlyProjectPathsFor(repoRoot);

    updateSessionMetadata("worker-1", (current) => ({ ...current, status: { text: "ready", tone: "info" } }), repoRoot);
    const first = readFileSync(paths.metadataPath, "utf-8");
    updateSessionMetadata("worker-1", (current) => ({ ...current, status: { text: "ready", tone: "info" } }), repoRoot);

    expect(readFileSync(paths.metadataPath, "utf-8")).toBe(first);

    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("enforces a single overseer: setting a new one clears the previous flag", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "aimux-metadata-store-overseer1-"));
    gitInit(repoRoot);
    await initPaths(repoRoot);

    setSessionOverseer("boss-1", true, repoRoot);
    setSessionOverseer("boss-2", true, repoRoot);

    const state = loadMetadataState(repoRoot);
    expect(state.sessions["boss-1"].overseer).toBeUndefined();
    expect(state.sessions["boss-2"].overseer).toBe(true);
    expect(findOverseerSessionId(state)).toBe("boss-2");

    rmSync(repoRoot, { recursive: true, force: true });
  });
});

describe("statusline segments", () => {
  async function project(name: string): Promise<string> {
    const repoRoot = mkdtempSync(join(tmpdir(), `aimux-segment-${name}-`));
    gitInit(repoRoot);
    await initPaths(repoRoot);
    return repoRoot;
  }

  it("puts a segment on a rail and replaces one with the same id", async () => {
    const root = await project("put");
    putStatuslineSegment("s1", "bottom", { id: "a", text: "first" }, root);
    putStatuslineSegment("s1", "bottom", { id: "b", text: "other" }, root);
    putStatuslineSegment("s1", "bottom", { id: "a", text: "second" }, root);

    const bottom = loadMetadataState(root).sessions.s1?.statusline?.bottom ?? [];
    expect(bottom.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(bottom.find((entry) => entry.id === "a")?.text).toBe("second");

    rmSync(root, { recursive: true, force: true });
  });

  it("carries an opaque payload back verbatim", async () => {
    const root = await project("data");
    const data = { anything: [1, { nested: true }], at: "all" };
    putStatuslineSegment("s1", "top", { id: "a", text: "x", data }, root);

    expect(loadMetadataState(root).sessions.s1?.statusline?.top?.[0]?.data).toEqual(data);

    rmSync(root, { recursive: true, force: true });
  });

  it("hides a segment once its moment has passed, and keeps the ones that have not", async () => {
    const root = await project("expiry");
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 600_000).toISOString();
    putStatuslineSegment("s1", "bottom", { id: "gone", text: "stale", expiresAt: past }, root);
    putStatuslineSegment("s1", "bottom", { id: "here", text: "live", expiresAt: future }, root);
    putStatuslineSegment("s1", "bottom", { id: "forever", text: "no ttl" }, root);

    const bottom = loadMetadataState(root).sessions.s1?.statusline?.bottom ?? [];
    expect(bottom.map((entry) => entry.id)).toEqual(["here", "forever"]);

    rmSync(root, { recursive: true, force: true });
  });

  it("removes the rail, and the statusline, when everything on it has expired", async () => {
    const root = await project("empty");
    const past = new Date(Date.now() - 1000).toISOString();
    putStatuslineSegment("s1", "top", { id: "a", text: "x", expiresAt: past }, root);

    expect(loadMetadataState(root).sessions.s1?.statusline).toBeUndefined();

    rmSync(root, { recursive: true, force: true });
  });

  it("keeps a segment whose expiry is not a date, rather than emptying the rail", async () => {
    const root = await project("malformed");
    putStatuslineSegment("s1", "top", { id: "a", text: "x", expiresAt: "not a date" }, root);

    // One publisher sending nonsense must not be able to blank a rail it
    // shares with everything else.
    expect(loadMetadataState(root).sessions.s1?.statusline?.top?.[0]?.id).toBe("a");

    rmSync(root, { recursive: true, force: true });
  });

  it("drops a segment from one rail, or from both", async () => {
    const root = await project("drop");
    putStatuslineSegment("s1", "top", { id: "a", text: "t" }, root);
    putStatuslineSegment("s1", "bottom", { id: "a", text: "b" }, root);
    putStatuslineSegment("s1", "bottom", { id: "keep", text: "k" }, root);

    dropStatuslineSegment("s1", "a", "top", root);
    let state = loadMetadataState(root).sessions.s1?.statusline;
    expect(state?.top).toBeUndefined();
    expect(state?.bottom?.map((entry) => entry.id)).toEqual(["a", "keep"]);

    dropStatuslineSegment("s1", "a", undefined, root);
    state = loadMetadataState(root).sessions.s1?.statusline;
    expect(state?.bottom?.map((entry) => entry.id)).toEqual(["keep"]);

    rmSync(root, { recursive: true, force: true });
  });

  it("refuses a segment nothing could replace, or one carrying too much", () => {
    expect(segmentRejection({ text: "no id" })).toMatch(/id/);
    expect(segmentRejection({ id: "a", text: "fine" })).toBeNull();
    expect(segmentRejection({ id: "a", text: "x", expiresAt: "soon" })).toMatch(/date/);
    expect(segmentRejection({ id: "a", text: "x", data: { big: "x".repeat(MAX_SEGMENT_DATA_BYTES) } })).toMatch(
      /limit/,
    );
    expect(segmentRejection({ id: "a", text: "x", data: { small: true } })).toBeNull();
  });

  it("caps how far ahead a publisher may claim a segment stays true", () => {
    // A day. Past that a TTL is not a lease, it is an assertion that something
    // will still hold tomorrow — which is the claim the field exists to stop
    // an absent publisher making.
    expect(MAX_SEGMENT_TTL_SECONDS).toBe(86_400);
    const soon = new Date(Date.now() + MAX_SEGMENT_TTL_SECONDS * 1000);
    expect(segmentRejection({ id: "a", text: "x", expiresAt: soon.toISOString() })).toBeNull();
  });

  it("refuses an id that is not a string", () => {
    // `!segment.id` alone lets 7 through, and a numeric id then fails to match
    // the string the caller uses to withdraw it.
    expect(segmentRejection({ id: 7 as unknown as string, text: "x" })).toMatch(/id/);
  });

  /**
   * The read path must survive a store it did not write.
   *
   * `metadata.json` is written by several processes and only has to be valid
   * JSON to reach the loader — the file already carries a test for a null
   * session. A throw in here is not one bad segment; it is `loadMetadataState`
   * failing for the whole daemon, which is every read, permanently.
   */
  it("survives a statusline that is the wrong shape all the way down", async () => {
    const root = await project("malformed-shapes");
    const paths = getReadOnlyProjectPathsFor(root);
    writeFileSync(
      paths.metadataPath,
      JSON.stringify({
        version: 1,
        sessions: {
          nullSession: null,
          stringSession: "nonsense",
          railIsAString: { statusline: { top: "x" }, updatedAt: "2026-01-01T00:00:00.000Z" },
          railHoldsNull: { statusline: { top: [null] }, updatedAt: "2026-01-01T00:00:00.000Z" },
          statuslineIsAnArray: { statusline: [], updatedAt: "2026-01-01T00:00:00.000Z" },
          fine: {
            statusline: { top: [{ id: "a", text: "keep" }] },
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        },
      }),
    );

    const state = loadMetadataState(root);
    expect(state.sessions.fine?.statusline?.top?.[0]?.id).toBe("a");

    rmSync(root, { recursive: true, force: true });
  });
});
