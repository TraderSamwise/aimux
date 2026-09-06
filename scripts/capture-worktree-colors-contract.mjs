#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/worktrees/colors.json", ROOT);
const colors = await import(new URL("dist/worktree-colors.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function colorDistance(a, b) {
  const left = colors.rgbFromWorktreeColorCode(a);
  const right = colors.rgbFromWorktreeColorCode(b);
  return Math.sqrt((left.r - right.r) ** 2 + (left.g - right.g) ** 2 + (left.b - right.b) ** 2);
}

function colorSummary(input) {
  const code = colors.worktreeColorCode(input);
  return {
    key: colors.worktreeColorKey(input),
    code,
    rgb: colors.rgbFromWorktreeColorCode(code),
    hex: colors.worktreeColorHex(input),
    hexForCode: colors.worktreeColorHexForCode(code),
    ansi: colors.worktreeColorAnsi(input),
    ansiForCode: colors.worktreeColorAnsiForCode(code),
  };
}

const commonNames = [
  "main",
  "context-mcp",
  "affiliates",
  "auto-api-sync",
  "data-analytics",
  "custom-modules-mcp",
  "e2e-audit",
  "okx-open-stops",
  "v2-key-sync",
];

const cases = [];
function record(name, api, input, output) {
  cases.push({
    id: `worktree-colors-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/worktree-colors.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}

record(
  "uses one deterministic truecolor value for terminal and GUI tones",
  "colorSummary",
  { path: "/repo/.aimux/worktrees/e2e-audit", projectRoot: "/repo", name: "e2e-audit" },
  colorSummary({ path: "/repo/.aimux/worktrees/e2e-audit", projectRoot: "/repo", name: "e2e-audit" }),
);

record(
  "is stable for the same identity regardless of surrounding order",
  "codeList",
  {
    before: [{ path: "/repo" }, { path: "/repo/.aimux/worktrees/custom-modules-mcp" }, { path: "/repo/.aimux/worktrees/e2e-audit" }],
    after: [{ path: "/repo/.aimux/worktrees/custom-modules-mcp" }, { path: "/repo" }],
  },
  {
    before: [{ path: "/repo" }, { path: "/repo/.aimux/worktrees/custom-modules-mcp" }, { path: "/repo/.aimux/worktrees/e2e-audit" }].map(
      (worktree) => colors.worktreeColorCode(worktree),
    ),
    after: [{ path: "/repo/.aimux/worktrees/custom-modules-mcp" }, { path: "/repo" }].map((worktree) =>
      colors.worktreeColorCode(worktree),
    ),
  },
);

record(
  "does not quantize generated identities into a tiny palette",
  "paletteSize",
  { count: 300, prefix: "/repo/.aimux/worktrees/worktree-" },
  {
    uniqueHexCount: new Set(
      Array.from({ length: 300 }, (_, index) => colors.worktreeColorHex({ path: `/repo/.aimux/worktrees/worktree-${index}` })),
    ).size,
  },
);

for (const root of ["/Users/sam/cs/aimux", "/Users/sam/cs/tealstreet-next"]) {
  const inputs = commonNames.map((name) => ({
    path: name === "main" ? root : `${root}/.aimux/worktrees/${name}`,
    name,
  }));
  const codes = inputs.map((input) => colors.worktreeColorCode(input));
  const distances = codes.flatMap((code, index) => codes.slice(index + 1).map((other) => colorDistance(code, other)));
  record(
    "keeps common project worktree names visually separated",
    "distanceSummary",
    { root, names: commonNames },
    {
      hexByName: Object.fromEntries(inputs.map((input, index) => [input.name, colors.worktreeColorHexForCode(codes[index])])),
      minimumDistance: Math.min(...distances),
    },
  );
}

record(
  "prefers path and falls back through project/name identities",
  "keyList",
  {
    inputs: [
      { path: "/repo", projectRoot: "/other", name: "main" },
      { projectRoot: "/repo", name: "main" },
      { name: "scratch" },
      { projectRoot: "/repo" },
      { projectName: "aimux" },
      {},
    ],
  },
  [
    { path: "/repo", projectRoot: "/other", name: "main" },
    { projectRoot: "/repo", name: "main" },
    { name: "scratch" },
    { projectRoot: "/repo" },
    { projectName: "aimux" },
    {},
  ].map((input) => colors.worktreeColorKey(input) ?? null),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/worktree-colors.test.ts",
  generatedBy: "scripts/capture-worktree-colors-contract.mjs",
  description:
    "Worktree color key, hash, RGB, hex, ANSI, palette spread, and known project color contracts captured by running TypeScript worktree-colors helpers.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
