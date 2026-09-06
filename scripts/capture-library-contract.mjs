#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/library/entries.json", ROOT);
const library = await import(new URL("dist/library.js", ROOT));
const planAuthority = await import(new URL("dist/runtime-core/plan-authority.js", ROOT));
const { isStubPlan, loadLibraryEntries } = library;
const { getPlanAuthorityDirForLocalAimuxDir } = planAuthority;

const STUB = `---
sessionId: claude-1
tool: claude
worktree: main
updatedAt: 2026-06-17T00:00:00.000Z
---

# Goal

TBD

# Current Status

TBD

# Steps

- [ ] TBD

# Notes

- None yet.
`;

const REAL_PLAN = `---
sessionId: claude-2
tool: claude
worktree: main
updatedAt: 2026-06-17T05:00:00.000Z
---

# Goal

Ship the library screen

# Steps

- [x] write loader
`;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function normalizePath(path, repoRoot, plansDir) {
  if (path === repoRoot) return "<repoRoot>";
  if (path.startsWith(`${repoRoot}/`)) return `<repoRoot>/${path.slice(repoRoot.length + 1)}`;
  if (path === plansDir) return "<plansDir>";
  if (path.startsWith(`${plansDir}/`)) return `<plansDir>/${path.slice(plansDir.length + 1)}`;
  return path;
}

function normalizeEntries(entries, repoRoot, plansDir) {
  return entries.map((entry) => ({ ...entry, path: normalizePath(entry.path, repoRoot, plansDir) }));
}

function writeText(path, content, iso) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (iso) {
    const date = new Date(iso);
    utimesSync(path, date, date);
  }
}

async function withLibrary(callback) {
  const repoRoot = mkdtempSync(join(tmpdir(), "aimux-library-contract-"));
  const plansDir = getPlanAuthorityDirForLocalAimuxDir(join(repoRoot, ".aimux"));
  mkdirSync(plansDir, { recursive: true });
  try {
    return await callback(repoRoot, plansDir);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

const cases = [];
function record(name, api, input, output) {
  cases.push({
    id: `library-entries-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/library.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}

record("detects the untouched auto-generated stub", "isStubPlan", { content: STUB }, isStubPlan(STUB));
record("treats a filled-in plan as non-stub", "isStubPlan", { content: REAL_PLAN }, isStubPlan(REAL_PLAN));

record(
  "includes allowlisted project docs and non-stub plans, skips stubs",
  "loadLibraryEntries",
  {
    files: [
      { path: "README.md", content: "# Project\nhello", mtime: "2026-06-16T01:00:00.000Z" },
      { path: "AGENTS.md", content: "# Agents", mtime: "2026-06-16T02:00:00.000Z" },
      { path: "NOTALLOWED.md", content: "# nope", mtime: "2026-06-16T03:00:00.000Z" },
      { path: ".aimux/plans/claude-1.md", content: STUB, mtime: "2026-06-17T00:00:00.000Z" },
      { path: ".aimux/plans/claude-2.md", content: REAL_PLAN, mtime: "2026-06-17T05:00:00.000Z" },
    ],
    labels: { "claude-2": "library agent" },
  },
  await withLibrary((repoRoot, plansDir) => {
    writeText(join(repoRoot, "README.md"), "# Project\nhello", "2026-06-16T01:00:00.000Z");
    writeText(join(repoRoot, "AGENTS.md"), "# Agents", "2026-06-16T02:00:00.000Z");
    writeText(join(repoRoot, "NOTALLOWED.md"), "# nope", "2026-06-16T03:00:00.000Z");
    writeText(join(plansDir, "claude-1.md"), STUB, "2026-06-17T00:00:00.000Z");
    writeText(join(plansDir, "claude-2.md"), REAL_PLAN, "2026-06-17T05:00:00.000Z");
    return normalizeEntries(
      loadLibraryEntries({ repoRoot, plansDir, resolveLabel: (id) => (id === "claude-2" ? "library agent" : undefined) }),
      repoRoot,
      plansDir,
    );
  }),
);

record(
  "sorts entries newest-first by updatedAt",
  "loadLibraryEntries",
  {
    files: [
      { path: "README.md", content: "# old", mtime: "2026-06-16T00:00:00.000Z" },
      { path: ".aimux/plans/claude-2.md", content: REAL_PLAN, mtime: "2026-06-17T05:00:00.000Z" },
    ],
  },
  await withLibrary((repoRoot, plansDir) => {
    writeText(join(repoRoot, "README.md"), "# old", "2026-06-16T00:00:00.000Z");
    writeText(join(plansDir, "claude-2.md"), REAL_PLAN, "2026-06-17T05:00:00.000Z");
    return normalizeEntries(loadLibraryEntries({ repoRoot, plansDir }), repoRoot, plansDir);
  }),
);

record(
  "falls back to mtime when a plan has no frontmatter updatedAt",
  "loadLibraryEntries",
  { files: [{ path: ".aimux/plans/claude-3.md", content: "# Goal\n\nreal work, no frontmatter\n", mtime: "2026-06-18T00:00:00.000Z" }] },
  await withLibrary((repoRoot, plansDir) => {
    writeText(join(plansDir, "claude-3.md"), "# Goal\n\nreal work, no frontmatter\n", "2026-06-18T00:00:00.000Z");
    return normalizeEntries(loadLibraryEntries({ repoRoot, plansDir }), repoRoot, plansDir);
  }),
);

record(
  "returns empty when nothing exists",
  "loadLibraryEntries",
  { files: [] },
  await withLibrary((repoRoot, plansDir) => normalizeEntries(loadLibraryEntries({ repoRoot, plansDir }), repoRoot, plansDir)),
);

record(
  "parses CRLF-authored plan frontmatter and skips CRLF stubs",
  "loadLibraryEntries",
  {
    files: [
      { path: ".aimux/plans/claude-crlf.md", content: "<REAL_PLAN_CRLF>", mtime: "2026-06-17T05:00:00.000Z" },
      { path: ".aimux/plans/claude-crlf-stub.md", content: "<STUB_CRLF>", mtime: "2026-06-17T00:00:00.000Z" },
    ],
  },
  await withLibrary((repoRoot, plansDir) => {
    writeText(join(plansDir, "claude-crlf.md"), REAL_PLAN.replace(/\n/g, "\r\n"), "2026-06-17T05:00:00.000Z");
    writeText(join(plansDir, "claude-crlf-stub.md"), STUB.replace(/\n/g, "\r\n"), "2026-06-17T00:00:00.000Z");
    return normalizeEntries(loadLibraryEntries({ repoRoot, plansDir }), repoRoot, plansDir);
  }),
);

record(
  "ignores a malformed frontmatter updatedAt and falls back to mtime",
  "loadLibraryEntries",
  { files: [{ path: ".aimux/plans/claude-bad.md", content: "<REAL_PLAN_BAD_DATE>", mtime: "2026-06-19T00:00:00.000Z" }] },
  await withLibrary((repoRoot, plansDir) => {
    writeText(join(plansDir, "claude-bad.md"), REAL_PLAN.replace("2026-06-17T05:00:00.000Z", "not-a-date"), "2026-06-19T00:00:00.000Z");
    return normalizeEntries(loadLibraryEntries({ repoRoot, plansDir }), repoRoot, plansDir);
  }),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/library.test.ts",
  generatedBy: "scripts/capture-library-contract.mjs",
  description: "Library stub-plan detection, document allowlist, non-stub plans, label projection, recency sorting, frontmatter stripping, CRLF parsing, and mtime fallback captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
