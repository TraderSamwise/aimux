#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/expose-layout.json", ROOT);
const { balancedCols, computeLayout, matchClientSize, tilePreview } = await import(
  new URL("dist/tmux/expose.js", ROOT)
);

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
    id: `tmux-expose-layout-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/expose.ts",
    api,
    input: fullInput,
    output: run(),
    inputSha256: hash(fullInput),
  });
}

for (const count of [0, 1, 3, 4, 5, 8, 9, 10, 16]) {
  record(`balanced columns for ${count} items`, "balancedCols", { count }, () => ({
    cols: balancedCols(count),
  }));
}

for (const input of [
  { itemCount: 0, cols: 80, rows: 24 },
  { itemCount: 1, cols: 80, rows: 24 },
  { itemCount: 4, cols: 80, rows: 24 },
  { itemCount: 6, cols: 100, rows: 30 },
  { itemCount: 12, cols: 80, rows: 24 },
  { itemCount: 12, cols: 60, rows: 15 },
  { itemCount: 99, cols: 40, rows: 10 },
]) {
  record(`grid layout for ${input.itemCount} items at ${input.cols}x${input.rows}`, "computeLayout", input, () =>
    computeLayout(input.itemCount, input.cols, input.rows),
  );
}

record(
  "matches client size by exact tty",
  "matchClientSize",
  { listing: "/dev/ttys001 120x40\n/dev/ttys002 80x24\n", clientTty: "/dev/ttys002" },
  () => ({
    size: matchClientSize("/dev/ttys001 120x40\n/dev/ttys002 80x24\n", "/dev/ttys002"),
  }),
);

record(
  "matches client size by basename",
  "matchClientSize",
  { listing: "/dev/ttys003 90x30\n", clientTty: "ttys003" },
  () => ({
    size: matchClientSize("/dev/ttys003 90x30\n", "ttys003"),
  }),
);

record(
  "returns empty size when no client matches",
  "matchClientSize",
  { listing: "/dev/ttys004 90x30\nmalformed\n", clientTty: "/dev/ttys005" },
  () => ({
    size: matchClientSize("/dev/ttys004 90x30\nmalformed\n", "/dev/ttys005"),
  }),
);

for (const input of [
  { raw: "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n", count: 5 },
  { raw: "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n", count: 9 },
  { raw: "red \u001b[31mline\u001b[0m\ncursor\u001b[2Kgone\n\n", count: 4 },
  { raw: "short\n", count: 3 },
  { raw: "ignored\n", count: 0 },
]) {
  record(`tile preview with ${input.count} visible rows`, "tilePreview", input, () => ({
    lines: tilePreview(input.raw, input.count),
  }));
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-06T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-expose-layout-contract.mjs",
  source: "src/tmux/expose.ts",
  subject: "src/tmux/expose.ts",
  description: "Expose layout, client-size matching, and preview row selection captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
