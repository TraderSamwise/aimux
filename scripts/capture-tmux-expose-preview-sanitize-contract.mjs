#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/expose-preview-sanitize.json", ROOT);
const { sanitizeExposePreviewLine, sanitizeExposePreviewOutput } = await import(
  new URL("dist/tmux/expose-preview-sanitize.js", ROOT)
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
    id: `tmux-expose-preview-sanitize-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/expose-preview-sanitize.ts",
    api,
    input: fullInput,
    output: run(),
    inputSha256: hash(fullInput),
  });
}

record("preserves SGR color and style escapes", "sanitizeExposePreviewLine", { line: "\x1b[31;1mred\x1b[0m" }, () => ({
  line: sanitizeExposePreviewLine("\x1b[31;1mred\x1b[0m"),
}));

record("strips non-SGR CSI cursor controls", "sanitizeExposePreviewLine", { line: "a\x1b[2Kb\x1b[?25lc" }, () => ({
  line: sanitizeExposePreviewLine("a\x1b[2Kb\x1b[?25lc"),
}));

record(
  "strips OSC sequences",
  "sanitizeExposePreviewLine",
  { line: "a\x1b]8;;https://example.com\x07link\x1b]8;;\x07b" },
  () => ({
    line: sanitizeExposePreviewLine("a\x1b]8;;https://example.com\x07link\x1b]8;;\x07b"),
  }),
);

record("strips incomplete escapes at the end", "sanitizeExposePreviewLine", { line: "a\x1b[31;b\x1b[?25" }, () => ({
  line: sanitizeExposePreviewLine("a\x1b[31;b\x1b[?25"),
}));

record("turns control bytes into spaces", "sanitizeExposePreviewLine", { line: "a\x00b\tc\x7fd" }, () => ({
  line: sanitizeExposePreviewLine("a\x00b\tc\x7fd"),
}));

record(
  "normalizes carriage returns and drops trailing blank lines",
  "sanitizeExposePreviewOutput",
  { raw: "a\r\nb\n \n\t\n" },
  () => ({
    lines: sanitizeExposePreviewOutput("a\r\nb\n \n\t\n"),
  }),
);

record("keeps interior blank lines", "sanitizeExposePreviewOutput", { raw: "a\n\nb\n" }, () => ({
  lines: sanitizeExposePreviewOutput("a\n\nb\n"),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-06T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-expose-preview-sanitize-contract.mjs",
  source: "src/tmux/expose-preview-sanitize.ts",
  subject: "src/tmux/expose-preview-sanitize.ts",
  description: "Expose preview escape sanitization captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
