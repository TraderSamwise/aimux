#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/expose-render.json", ROOT);
const { buildTileHeader, computeLayout, drawTile, fitHeaderRows } = await import(new URL("dist/tmux/expose.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const cases = [];
function record(name, api, input, run) {
  const fullInput = { name, ...input };
  cases.push({
    id: `tmux-expose-render-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/expose.ts",
    api,
    input: fullInput,
    output: run(),
    inputSha256: hash(fullInput),
  });
}

record(
  "keeps compact context in the rule title",
  "buildTileHeader",
  {
    textW: 30,
    width: 40,
    titleLeft: "  1 main",
    context: "codex",
    pillStr: "",
    detail: "",
    inset: 2,
  },
  () => ({
    header: buildTileHeader(30, 40, "  1 main", "codex", "", "", 2),
  }),
);

record(
  "wraps context rows and keeps status detail",
  "buildTileHeader",
  {
    textW: 18,
    width: 28,
    titleLeft: "  2 feature",
    context: "Claude Overseer Assistant",
    pillStr: "\u001b[36;7m WORKING \u001b[0m",
    detail: "output just now · reading files",
    inset: 2,
  },
  () => ({
    header: buildTileHeader(
      18,
      28,
      "  2 feature",
      "Claude Overseer Assistant",
      "\u001b[36;7m WORKING \u001b[0m",
      "output just now · reading files",
      2,
    ),
  }),
);

record(
  "truncates header rows without a pill",
  "fitHeaderRows",
  {
    rows: ["a", "b", "c", "d"],
    capacity: 2,
    hasPill: false,
  },
  () => ({
    rows: fitHeaderRows(["a", "b", "c", "d"], 2, false),
  }),
);

record(
  "preserves the pill row under capacity pressure",
  "fitHeaderRows",
  {
    rows: ["context one", "context two", "pill"],
    capacity: 2,
    hasPill: true,
  },
  () => ({
    rows: fitHeaderRows(["context one", "context two", "pill"], 2, true),
  }),
);

const baseOptions = {
  projectRoot: "/repo",
  projectStateDir: "/repo/.aimux",
  currentWindowId: "@1",
};

const selectedLocalTile = {
  item: {
    label: "Codex",
    target: { windowId: "@1" },
    metadata: { userLabel: "ready", statusText: "Waiting\nfor input" },
  },
  preview: ["line one", "ansi \u001b[31mred\u001b[0m"],
  badge: 1,
  selected: true,
  top: 2,
  left: 3,
  width: 40,
  layout: computeLayout(1, 80, 24),
  context: { worktree: "" },
  options: baseOptions,
};
record("draws selected local tile with here marker, status pill, and preview", "drawTile", selectedLocalTile, () => {
  const data = selectedLocalTile;
  return {
    text: drawTile(
      data.item,
      data.preview,
      data.badge,
      data.selected,
      data.top,
      data.left,
      data.width,
      data.layout,
      data.context,
      data.options,
    ),
  };
});

const unselectedGlobalTile = {
  item: {
    label: "Aider",
    target: { windowId: "@2" },
    metadata: { attention: "blocked", statusText: "Blocked on review" },
  },
  preview: ["review says no", "needs patch"],
  badge: 12,
  selected: false,
  top: 4,
  left: 10,
  width: 34,
  layout: computeLayout(6, 100, 30),
  context: { project: "aimux", worktree: "rust-v1", tone: 5387754 },
  options: baseOptions,
};
record(
  "draws unselected global tile with project worktree tone and overflow badge",
  "drawTile",
  unselectedGlobalTile,
  () => {
    const data = unselectedGlobalTile;
    return {
      text: drawTile(
        data.item,
        data.preview,
        data.badge,
        data.selected,
        data.top,
        data.left,
        data.width,
        data.layout,
        data.context,
        data.options,
      ),
    };
  },
);

const narrowTile = {
  item: {
    label: "Claude Overseer Assistant",
    target: { windowId: "@3" },
    metadata: { activity: "running", statusText: "Working through tmux expose render parity" },
  },
  preview: ["first", "second", "third", "fourth"],
  badge: 2,
  selected: true,
  top: 1,
  left: 1,
  width: 30,
  layout: { ...computeLayout(12, 60, 15), tileHeight: 6, bodyLines: 3 },
  context: { worktree: "very-long-worktree-name", tone: 8339133 },
  options: baseOptions,
};
record("draws narrow tile with wrapped title context and clipped preview", "drawTile", narrowTile, () => {
  const data = narrowTile;
  return {
    text: drawTile(
      data.item,
      data.preview,
      data.badge,
      data.selected,
      data.top,
      data.left,
      data.width,
      data.layout,
      data.context,
      data.options,
    ),
  };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-06T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-expose-render-contract.mjs",
  source: "src/tmux/expose.ts",
  subject: "src/tmux/expose.ts",
  description: "Expose tile header fitting and ANSI tile rendering captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
