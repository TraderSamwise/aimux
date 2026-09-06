#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import prettier from "prettier";
import ts from "typescript";

const ROOT = new URL("../", import.meta.url);
const ANSI_FIXTURE_PATH = new URL("testdata/contracts/v1/ansi/sgr-spans.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const loadAppAnsiModule = async () => {
  const sourceUrl = new URL("app/lib/ansi.ts", ROOT);
  const source = await readFile(sourceUrl, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "app/lib/ansi.ts",
  }).outputText;
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(js)}#app/lib/ansi.ts`);
};

const adversarialCases = [
  { name: "plain text", input: "plain" },
  { name: "base foreground and background", input: "\u001b[31mred\u001b[44mred on blue\u001b[0mplain" },
  { name: "bright foreground and background", input: "\u001b[91mbright red\u001b[104m on bright blue" },
  { name: "dim italic underline strike", input: "\u001b[2;3;4;9mstyled\u001b[23;24mstrike dim" },
  { name: "inverse truecolor", input: "\u001b[38;2;255;0;0m\u001b[48;2;0;0;255m\u001b[7mflip" },
  { name: "reset foreground only", input: "\u001b[31mred \u001b[39mdefault fg" },
  { name: "reset background only", input: "\u001b[44mblue bg \u001b[49mdefault bg" },
  { name: "empty sgr resets", input: "\u001b[1mbold\u001b[mplain" },
  { name: "attributes carry across lines", input: "\u001b[32mgreen\nstill green\u001b[0m\nplain" },
  { name: "unsupported code ignored", input: "\u001b[999mplain\u001b[1mbold" },
  { name: "xterm cube", input: "\u001b[38;5;196mred cube \u001b[48;5;22mgreen bg" },
  { name: "xterm grayscale edges", input: "\u001b[38;5;232mblackish \u001b[38;5;255mwhiteish" },
  { name: "colon background truecolor", input: "\u001b[48:2:12:34:56mbackground" },
  { name: "malformed negative truecolor remains text", input: "\u001b[38;2;999;-5;127mnot parsed" },
];

const existing = JSON.parse(await readFile(ANSI_FIXTURE_PATH, "utf8"));
const byName = new Map();
for (const entry of [...(existing.cases ?? []), ...adversarialCases]) {
  if (!entry?.name || typeof entry.input !== "string") continue;
  byName.set(entry.name, { name: entry.name, input: entry.input });
}

const { ansiLineText, parseAnsiLines } = await loadAppAnsiModule();
const cases = [...byName.values()].map((entry, index) => {
  const lines = parseAnsiLines(entry.input);
  const input = { text: entry.input };
  return {
    id: `ansi-sgr-spans-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "app/lib/ansi.ts",
    input: entry.input,
    output: {
      lines,
      text: lines.map((line) => ansiLineText(line)).join("\n"),
    },
    inputSha256: hash(input),
  };
});

const contract = {
  ...existing,
  version: 1,
  source: "app/lib/ansi.ts",
  generatedBy: "scripts/capture-ansi-sgr-contract.mjs",
  description: "Canonical ANSI SGR span cases captured by running the TypeScript app ANSI parser.",
  cases,
};

const prettierOptions = (await prettier.resolveConfig(ANSI_FIXTURE_PATH.pathname)) ?? {};
await writeFile(
  ANSI_FIXTURE_PATH,
  await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }),
);

console.log(
  JSON.stringify(
    {
      ansiFixture: ANSI_FIXTURE_PATH.pathname,
      cases: cases.length,
    },
    null,
    2,
  ),
);
