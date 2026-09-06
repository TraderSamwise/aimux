#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tui/render-box.json", ROOT);
const { renderOverlayBox } = await import(new URL("dist/tui/render/box.js", ROOT));
const { style } = await import(new URL("dist/tui/render/theme.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function run(input) {
  return renderOverlayBox(input.spec);
}

const inputs = [
  {
    name: "draws rounded blue box with title band and body separator",
    spec: { title: "Title", body: ["  body line"], cols: 80, rows: 24 },
  },
  {
    name: "uses danger tone and warning glyph for red variant",
    spec: { title: "Danger", body: [], cols: 80, rows: 24, variant: "red" },
  },
  {
    name: "preserves ANSI styling in body content",
    spec: { title: "T", body: ["\u001b[1mbold\u001b[0m plain"], cols: 80, rows: 24 },
  },
  {
    name: "centers box on wide viewport",
    spec: { title: "Pick", body: ["  one", "  two"], cols: 200, rows: 50 },
  },
  {
    name: "pads and truncates every row to a uniform box width",
    spec: { title: "short", body: ["x".repeat(300)], cols: 80, rows: 24 },
  },
  {
    name: "supports custom band icon override",
    spec: { title: "Notice", body: [style("ok", "done")], cols: 90, rows: 30, variant: "red", icon: "!" },
  },
];

const cases = inputs.map((input, index) => ({
  id: `tui-render-box-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/tui/render/box.test.ts",
  api: "renderOverlayBox",
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/tui/render/box.test.ts",
  generatedBy: "scripts/capture-tui-render-box-contract.mjs",
  description: "TUI overlay box renderer outputs captured by running TypeScript tui/render/box helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
