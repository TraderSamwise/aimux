#!/usr/bin/env node
import { createHash } from "node:crypto";
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
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/install-cleanup/cleanup.json", ROOT);
const NOW = Date.UTC(2026, 7, 8);
const DAY = 24 * 60 * 60 * 1000;

const installCleanup = await import(new URL("dist/install-cleanup.js", ROOT));
const {
  DEFAULT_INSTALL_KEEP_RECENT,
  DEFAULT_INSTALL_RETENTION_DAYS,
  REMOVING_SUFFIX,
  planInstallCleanup,
  runInstallCleanup,
} = installCleanup;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const recordCase = (index, name, scenario, output) => ({
  id: `install-cleanup-${String(index + 1).padStart(3, "0")}`,
  name,
  source: "src/install-cleanup.test.ts",
  input: { scenario },
  output,
  inputSha256: hash({ scenario }),
});

function normalize(value, base) {
  const roots = [base];
  try {
    const canonical = realpathSync(base);
    if (canonical !== base) roots.push(canonical);
  } catch {
    // A scenario may intentionally remove its temp root.
  }
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "string") return nested;
      return roots.reduce((text, root) => text.replaceAll(root, "<root>"), nested);
    }),
  );
}

function makeInstall(root, name, ageDays) {
  const path = join(root, name);
  mkdirSync(join(path, "dist"), { recursive: true });
  mkdirSync(join(path, "bin"), { recursive: true });
  writeFileSync(join(path, "dist", "launcher-bin.js"), "x".repeat(1024));
  writeFileSync(join(path, "bin", "aimux"), "#!/bin/sh\n");
  setAge(path, ageDays);
  setAge(join(path, "dist"), ageDays);
  setAge(join(path, "bin"), ageDays);
  return path;
}

function setAge(path, ageDays) {
  const seconds = (NOW - ageDays * DAY) / 1000;
  utimesSync(path, seconds, seconds);
}

function plan(root, shim, overrides = {}) {
  return planInstallCleanup({
    root,
    now: () => NOW,
    stableShimPath: shim,
    listReferenceText: () => ({ text: [], complete: true }),
    keepRecent: 0,
    ...overrides,
  });
}

async function withInstallRoot(label, fn) {
  const base = mkdtempSync(join(tmpdir(), `aimux-install-cleanup-contract-${label}-`));
  try {
    const root = join(base, "native");
    const shim = join(base, "aimux");
    mkdirSync(root, { recursive: true });
    return normalize(await fn({ base, root, shim }), base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const cases = [];
const add = async (name, scenario, fn) => {
  cases.push(recordCase(cases.length, name, scenario, await withInstallRoot(scenario, fn)));
};

await add("removes only installs that are old, unreferenced, and not recent", "old-unreferenced", ({ root, shim }) => {
  makeInstall(root, "old-a", 90);
  makeInstall(root, "old-b", 45);
  makeInstall(root, "fresh", 2);
  return plan(root, shim);
});

await add("never removes the install the stable shim points at, however old", "current-install", ({ root, shim }) => {
  const current = makeInstall(root, "current", 400);
  symlinkSync(join(current, "dist", "launcher-bin.js"), shim);
  return plan(root, shim);
});

await add("never removes an install referenced by a live process or pane", "live-reference", ({ root, shim }) => {
  makeInstall(root, "busy", 200);
  return plan(root, shim, {
    listReferenceText: () => ({
      text: [`node ${join(root, "busy")}/dist/launcher-bin.js --tmux-dashboard-internal`],
      complete: true,
    }),
  });
});

await add("never removes an install pinned only by a tmux key binding", "tmux-binding-reference", ({ root, shim }) => {
  makeInstall(root, "bound", 300);
  makeInstall(root, "unbound", 300);
  return plan(root, shim, {
    listReferenceText: () => ({
      text: [`bind-key -T root MouseDown1Pane run-shell '${join(root, "bound")}/scripts/x.sh'`],
      complete: true,
    }),
  });
});

await add("keeps the newest installs by mtime even when they are past retention", "keep-newest", ({ root, shim }) => {
  makeInstall(root, "older", 300);
  makeInstall(root, "newer", 200);
  return plan(root, shim, { keepRecent: 1 });
});

await add("returns an empty plan when the install root is missing", "missing-root", ({ root, shim }) =>
  plan(join(root, "does-not-exist"), shim),
);

await add("removes nothing on a dry run", "dry-run", async ({ root, shim }) => {
  makeInstall(root, "old", 90);
  const removed = [];
  const result = await runInstallCleanup(
    plan(root, shim),
    { removeDir: (path) => removed.push(path) },
    { dryRun: true },
  );
  return { result, removed };
});

await add("removes the planned installs and reports what it reclaimed", "remove-planned", async ({ root, shim }) => {
  makeInstall(root, "old", 90);
  const removed = [];
  const result = await runInstallCleanup(
    plan(root, shim),
    { removeDir: (path) => removed.push(path) },
    { dryRun: false },
  );
  return { result, removed };
});

await add("refuses to remove a candidate whose path escapes the install root", "escape-candidate", async ({ root, shim }) => {
  const target = plan(root, shim);
  target.remove.push({ name: "escape", path: "/etc/passwd", ageDays: 999, sizeBytes: 0 });
  const removed = [];
  const result = await runInstallCleanup(target, { removeDir: (path) => removed.push(path) }, { dryRun: false });
  return { result, removed };
});

await add("reports a failed removal without aborting the sweep", "failed-removal", async ({ root, shim }) => {
  makeInstall(root, "bad", 90);
  makeInstall(root, "good", 91);
  const result = await runInstallCleanup(
    plan(root, shim),
    {
      removeDir: (path) => {
        if (path.endsWith("bad")) throw new Error("permission denied");
      },
    },
    { dryRun: false },
  );
  return result;
});

await add("ages an install by its newest content, not a stale directory timestamp", "newest-content-age", ({ root, shim }) => {
  const path = makeInstall(root, "freshly-installed", 400);
  const recent = (NOW - DAY) / 1000;
  utimesSync(join(path, "dist"), recent, recent);
  return plan(root, shim);
});

await add("removes nothing when a reference source could not be read", "incomplete-references", ({ root, shim }) => {
  makeInstall(root, "old-a", 400);
  makeInstall(root, "old-b", 400);
  return plan(root, shim, { listReferenceText: () => ({ text: [], complete: false }) });
});

await add("matches references written against the canonical form of the root", "canonical-reference", ({ root, shim }) => {
  makeInstall(root, "busy", 400);
  const canonicalRoot = realpathSync(root);
  return plan(root, shim, {
    listReferenceText: () => ({ text: [`node ${join(canonicalRoot, "busy")}/dist/launcher-bin.js`], complete: true }),
  });
});

await add("tolerates a trailing slash on the configured install root", "trailing-slash-root", ({ root, shim }) => {
  makeInstall(root, "busy", 400);
  return plan(`${root}/`, shim, {
    listReferenceText: () => ({ text: [`node ${join(root, "busy")}/dist/launcher-bin.js`], complete: true }),
  });
});

await add("reads the install root from AIMUX_INSTALL_ROOT when none is given", "env-root", ({ root, shim }) => {
  makeInstall(root, "old", 400);
  const previous = process.env.AIMUX_INSTALL_ROOT;
  process.env.AIMUX_INSTALL_ROOT = root;
  try {
    return planInstallCleanup({
      now: () => NOW,
      stableShimPath: shim,
      listReferenceText: () => ({ text: [], complete: true }),
      keepRecent: 0,
    });
  } finally {
    if (previous === undefined) delete process.env.AIMUX_INSTALL_ROOT;
    else process.env.AIMUX_INSTALL_ROOT = previous;
  }
});

await add("does not remove anything when the caller says nothing about dry run", "default-dry-run", async ({ root, shim }) => {
  makeInstall(root, "old", 90);
  const removed = [];
  const result = await runInstallCleanup(plan(root, shim), { removeDir: (path) => removed.push(path) });
  return { result, removed };
});

await add("never removes a half-written install, however old it looks", "half-written-install", ({ root, shim }) => {
  const path = makeInstall(root, "mid-install", 400);
  rmSync(join(path, "bin", "aimux"), { force: true });
  return plan(root, shim);
});

await add("offers the oldest installs first so a capped sweep drains predictably", "oldest-first", ({ root, shim }) => {
  makeInstall(root, "middle", 100);
  makeInstall(root, "oldest", 300);
  makeInstall(root, "newest", 40);
  return plan(root, shim);
});

await add("removes at most the requested number of installs", "limit-removals", async ({ root, shim }) => {
  makeInstall(root, "a", 300);
  makeInstall(root, "b", 200);
  makeInstall(root, "c", 100);
  const removed = [];
  const result = await runInstallCleanup(
    plan(root, shim),
    { removeDir: (path) => removed.push(path) },
    { dryRun: false, limit: 2 },
  );
  return { result, removed };
});

await add("always reclaims debris left by an interrupted delete", "debris", ({ root, shim }) => {
  mkdirSync(join(root, `abandoned${REMOVING_SUFFIX}`, "dist"), { recursive: true });
  return plan(root, shim);
});

await add("renames out of the way before deleting so a kill cannot strand a stump", "rename-before-delete", async ({
  root,
  shim,
}) => {
  const path = makeInstall(root, "doomed", 90);
  const result = await runInstallCleanup(plan(root, shim), {}, { dryRun: false });
  return { result, exists: existsSync(path), removingExists: existsSync(`${path}${REMOVING_SUFFIX}`) };
});

await add("exposes conservative defaults", "defaults", () => ({
  defaultRetentionDays: DEFAULT_INSTALL_RETENTION_DAYS,
  defaultKeepRecent: DEFAULT_INSTALL_KEEP_RECENT,
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/install-cleanup.test.ts",
  generatedBy: "scripts/capture-install-cleanup-contract.mjs",
  description: "Install cleanup planning, reference detection, deletion, dry-run, debris, and default contracts captured by running TypeScript install-cleanup helpers.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
