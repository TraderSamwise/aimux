import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_INSTALL_KEEP_RECENT,
  DEFAULT_INSTALL_RETENTION_DAYS,
  REMOVING_SUFFIX,
  planInstallCleanup,
  runInstallCleanup,
} from "./install-cleanup.js";

const NOW = Date.UTC(2026, 7, 8);
const DAY = 24 * 60 * 60 * 1000;

describe("install cleanup", () => {
  let root: string;
  let shim: string;

  const makeInstall = (name: string, ageDays: number): string => {
    const path = join(root, name);
    mkdirSync(join(path, "dist"), { recursive: true });
    mkdirSync(join(path, "bin"), { recursive: true });
    writeFileSync(join(path, "dist", "launcher-bin.js"), "x".repeat(1024));
    // The installer writes bin/aimux last; without it an install reads as mid-install.
    writeFileSync(join(path, "bin", "aimux"), "#!/bin/sh\n");
    // Age the directory and its children, since the install's age is the newest of them.
    const seconds = (NOW - ageDays * DAY) / 1000;
    utimesSync(join(path, "bin"), seconds, seconds);
    utimesSync(join(path, "dist"), seconds, seconds);
    utimesSync(path, seconds, seconds);
    return path;
  };

  const plan = (overrides = {}) =>
    planInstallCleanup({
      root,
      now: () => NOW,
      stableShimPath: shim,
      listReferenceText: () => ({ text: [], complete: true }),
      keepRecent: 0,
      ...overrides,
    });

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "aimux-install-cleanup-"));
    root = join(base, "native");
    mkdirSync(root, { recursive: true });
    shim = join(base, "aimux");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("removes only installs that are old, unreferenced, and not recent", async () => {
    makeInstall("old-a", 90);
    makeInstall("old-b", 45);
    makeInstall("fresh", 2);

    const result = plan();

    expect(result.remove.map((entry) => entry.name).sort()).toEqual(["old-a", "old-b"]);
    expect(result.keep).toContainEqual({ name: "fresh", reason: "within-retention" });
    expect(result.reclaimableBytes).toBeGreaterThan(0);
  });

  it("never removes the install the stable shim points at, however old", () => {
    const current = makeInstall("current", 400);
    symlinkSync(join(current, "dist", "launcher-bin.js"), shim);

    const result = plan();

    expect(result.currentInstall).toBe("current");
    expect(result.remove).toEqual([]);
    expect(result.keep).toContainEqual({ name: "current", reason: "current-install" });
  });

  it("never removes an install referenced by a live process or pane", async () => {
    makeInstall("busy", 200);

    const result = plan({
      listReferenceText: () => ({
        text: [`node ${join(root, "busy")}/dist/launcher-bin.js --tmux-dashboard-internal`],
        complete: true,
      }),
    });

    expect(result.remove).toEqual([]);
    expect(result.keep).toContainEqual({ name: "busy", reason: "in-use" });
  });

  it("never removes an install pinned only by a tmux key binding", async () => {
    makeInstall("bound", 300);
    makeInstall("unbound", 300);

    // tmux bakes absolute script paths at bind time; they appear in no process argv.
    const result = plan({
      listReferenceText: () => ({
        text: [`bind-key -T root MouseDown1Pane run-shell '${join(root, "bound")}/scripts/x.sh'`],
        complete: true,
      }),
    });

    expect(result.remove.map((entry) => entry.name)).toEqual(["unbound"]);
    expect(result.keep).toContainEqual({ name: "bound", reason: "in-use" });
  });

  it("keeps the newest installs by mtime even when they are past retention", async () => {
    makeInstall("older", 300);
    makeInstall("newer", 200);

    const result = plan({ keepRecent: 1 });

    expect(result.remove.map((entry) => entry.name)).toEqual(["older"]);
    expect(result.keep).toContainEqual({ name: "newer", reason: "recent" });
  });

  it("returns an empty plan when the install root is missing", async () => {
    const result = plan({ root: join(root, "does-not-exist") });

    expect(result.remove).toEqual([]);
    expect(result.keep).toEqual([]);
    expect(result.reclaimableBytes).toBe(0);
  });

  it("removes nothing on a dry run", async () => {
    makeInstall("old", 90);
    const removed: string[] = [];

    const result = await runInstallCleanup(plan(), { removeDir: (path) => removed.push(path) }, { dryRun: true });

    expect(removed).toEqual([]);
    expect(result.reclaimedBytes).toBe(0);
    expect(result.results.map((entry) => entry.status)).toEqual(["dry-run"]);
  });

  it("removes the planned installs and reports what it reclaimed", async () => {
    makeInstall("old", 90);
    const removed: string[] = [];

    const result = await runInstallCleanup(plan(), { removeDir: (path) => removed.push(path) }, { dryRun: false });

    expect(removed).toEqual([join(root, "old")]);
    expect(result.results.map((entry) => entry.status)).toEqual(["removed"]);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
  });

  it("refuses to remove a candidate whose path escapes the install root", async () => {
    const target = plan();
    target.remove.push({ name: "escape", path: "/etc/passwd", ageDays: 999, sizeBytes: 0 });
    const removed: string[] = [];

    const result = await runInstallCleanup(target, { removeDir: (path) => removed.push(path) }, { dryRun: false });

    expect(removed).toEqual([]);
    expect(result.results).toContainEqual(expect.objectContaining({ name: "escape", status: "failed" }));
  });

  it("reports a failed removal without aborting the sweep", async () => {
    makeInstall("bad", 90);
    makeInstall("good", 91);

    const result = await runInstallCleanup(
      plan(),
      {
        removeDir: (path) => {
          if (path.endsWith("bad")) throw new Error("permission denied");
        },
      },
      { dryRun: false },
    );

    expect(result.results.filter((entry) => entry.status === "removed")).toHaveLength(1);
    expect(result.results.filter((entry) => entry.status === "failed")).toHaveLength(1);
  });

  it("ages an install by its newest content, not a stale directory timestamp", () => {
    // `mv` of an extracted tree can carry an old mtime onto the directory itself.
    const path = makeInstall("freshly-installed", 400);
    const recent = (NOW - 1 * DAY) / 1000;
    utimesSync(join(path, "dist"), recent, recent);

    const result = plan();

    expect(result.remove).toEqual([]);
    expect(result.keep).toContainEqual({ name: "freshly-installed", reason: "within-retention" });
  });

  it("removes nothing when a reference source could not be read", async () => {
    makeInstall("old-a", 400);
    makeInstall("old-b", 400);

    // An unread source means "unknown", which must never be read as "unreferenced".
    const result = plan({ listReferenceText: () => ({ text: [], complete: false }) });

    expect(result.referencesComplete).toBe(false);
    expect(result.remove).toEqual([]);
    expect(result.keep).toContainEqual({ name: "old-a", reason: "references-unverified" });
  });

  it("matches references written against the canonical form of the root", async () => {
    makeInstall("busy", 400);
    const canonicalRoot = realpathSync(root);

    const result = plan({
      listReferenceText: () => ({ text: [`node ${join(canonicalRoot, "busy")}/dist/launcher-bin.js`], complete: true }),
    });

    expect(result.remove).toEqual([]);
    expect(result.keep).toContainEqual({ name: "busy", reason: "in-use" });
  });

  it("tolerates a trailing slash on the configured install root", async () => {
    makeInstall("busy", 400);

    const result = plan({
      root: `${root}/`,
      listReferenceText: () => ({ text: [`node ${join(root, "busy")}/dist/launcher-bin.js`], complete: true }),
    });

    expect(result.keep).toContainEqual({ name: "busy", reason: "in-use" });
    expect(result.remove).toEqual([]);
  });

  it("reads the install root from AIMUX_INSTALL_ROOT when none is given", async () => {
    makeInstall("old", 400);
    const previous = process.env.AIMUX_INSTALL_ROOT;
    process.env.AIMUX_INSTALL_ROOT = root;
    try {
      const result = planInstallCleanup({
        now: () => NOW,
        stableShimPath: shim,
        listReferenceText: () => ({ text: [], complete: true }),
        keepRecent: 0,
      });
      expect(result.root).toBe(root);
      expect(result.remove.map((entry) => entry.name)).toEqual(["old"]);
    } finally {
      if (previous === undefined) delete process.env.AIMUX_INSTALL_ROOT;
      else process.env.AIMUX_INSTALL_ROOT = previous;
    }
  });

  it("does not remove anything when the caller says nothing about dry run", async () => {
    makeInstall("old", 90);
    const removed: string[] = [];

    const result = await runInstallCleanup(plan(), { removeDir: (path) => removed.push(path) });

    expect(removed).toEqual([]);
    expect(result.dryRun).toBe(true);
  });

  it("never removes a half-written install, however old it looks", () => {
    // Between the installer's mv and its bin/aimux write, the tree carries the
    // tarball's mtimes, so a freshly installed old release looks ancient.
    const path = makeInstall("mid-install", 400);
    rmSync(join(path, "bin", "aimux"), { force: true });

    const result = plan();

    expect(result.remove).toEqual([]);
    expect(result.keep).toContainEqual({ name: "mid-install", reason: "incomplete" });
  });

  it("offers the oldest installs first so a capped sweep drains predictably", () => {
    makeInstall("middle", 100);
    makeInstall("oldest", 300);
    makeInstall("newest", 40);

    expect(plan().remove.map((entry) => entry.name)).toEqual(["oldest", "middle", "newest"]);
  });

  it("removes at most the requested number of installs", async () => {
    makeInstall("a", 300);
    makeInstall("b", 200);
    makeInstall("c", 100);
    const removed: string[] = [];

    const result = await runInstallCleanup(
      plan(),
      { removeDir: (path) => removed.push(path) },
      { dryRun: false, limit: 2 },
    );

    expect(removed).toHaveLength(2);
    expect(result.results.map((entry) => entry.name)).toEqual(["a", "b"]);
  });

  it("always reclaims debris left by an interrupted delete", () => {
    // A half-deleted install loses bin/aimux first, so without the rename it
    // would read as mid-install and be protected forever.
    const stump = join(root, `abandoned${REMOVING_SUFFIX}`);
    mkdirSync(join(stump, "dist"), { recursive: true });

    const result = plan();

    expect(result.remove.map((entry) => entry.name)).toContain(`abandoned${REMOVING_SUFFIX}`);
    expect(result.keep.map((entry) => entry.name)).not.toContain(`abandoned${REMOVING_SUFFIX}`);
  });

  it("renames out of the way before deleting so a kill cannot strand a stump", async () => {
    const path = makeInstall("doomed", 90);

    await runInstallCleanup(plan(), {}, { dryRun: false });

    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}${REMOVING_SUFFIX}`)).toBe(false);
  });

  it("exposes conservative defaults", () => {
    expect(DEFAULT_INSTALL_RETENTION_DAYS).toBe(30);
    expect(DEFAULT_INSTALL_KEEP_RECENT).toBe(10);
  });
});
