#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/terminal/line-editor.json", ROOT);

const { applyLineEdit, createLineState, renderLineWindow } = await import(new URL("dist/line-editor.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const key = (partial) => ({ char: "", name: "", shift: false, ctrl: false, alt: false, raw: "", ...partial });
const char = (value) => key({ char: value });
const named = (name, extra = {}) => key({ name, ...extra });
const ctrl = (name) => key({ name, ctrl: true });
const visibleLength = (value) => value.replace(/\x1b\[[0-9;]*m/g, "").length;

function runEdit(input) {
  const state = createLineState(input.initial ?? "");
  if (typeof input.cursor === "number") state.cursor = input.cursor;
  const consumed = [];
  for (const event of input.events ?? []) {
    consumed.push(applyLineEdit(state, event));
  }
  return { state, consumed };
}

function runRender(input) {
  const state = createLineState(input.initial ?? "");
  if (typeof input.cursor === "number") state.cursor = input.cursor;
  const rendered = renderLineWindow(state, input.maxWidth);
  return { rendered, visibleLength: visibleLength(rendered) };
}

const scenarios = [
  {
    name: "starts with the cursor at the end of the initial text",
    kind: "edit",
    input: { initial: "hello", events: [] },
  },
  {
    name: "inserts characters at the cursor",
    kind: "edit",
    input: { initial: "hi", cursor: 1, events: [char("X")] },
  },
  {
    name: "moves left/right within bounds",
    kind: "edit",
    input: {
      initial: "ab",
      events: [named("left"), named("left"), named("left"), named("right"), named("right"), named("right")],
    },
  },
  {
    name: "supports home/end and ctrl+a/ctrl+e",
    kind: "edit",
    input: { initial: "hello", events: [named("home"), named("end"), ctrl("a"), ctrl("e")] },
  },
  {
    name: "backspaces before the cursor and is a no-op at start",
    kind: "edit",
    input: { initial: "abc", cursor: 2, events: [named("backspace"), { setCursor: 0 }, named("backspace")] },
  },
  {
    name: "deletes at the cursor and is a no-op at end",
    kind: "edit",
    input: { initial: "abc", cursor: 1, events: [named("delete"), { setCursor: 2 }, named("delete")] },
  },
  {
    name: "ctrl+u kills to start",
    kind: "edit",
    input: { initial: "hello world", cursor: 6, events: [ctrl("u")] },
  },
  {
    name: "ctrl+k kills to end",
    kind: "edit",
    input: { initial: "hello world", cursor: 5, events: [ctrl("k")] },
  },
  {
    name: "ctrl+w deletes a word",
    kind: "edit",
    input: { initial: "foo bar baz", cursor: 11, events: [ctrl("w")] },
  },
  {
    name: "inserts pasted text and collapses newlines to spaces",
    kind: "edit",
    input: { initial: "", events: [key({ name: "paste", char: "a\nb" })] },
  },
  {
    name: "does not consume enter/escape/tab",
    kind: "edit",
    input: { initial: "x", events: [named("enter"), named("escape"), named("tab")] },
  },
  {
    name: "renders a reverse-video cursor over the character at the cursor",
    kind: "render",
    input: { initial: "abc", cursor: 1, maxWidth: 80 },
  },
  {
    name: "renders a trailing highlighted cell when the cursor is past the end",
    kind: "render",
    input: { initial: "ab", maxWidth: 80 },
  },
  {
    name: "horizontally scrolls so the cursor stays visible within maxWidth",
    kind: "render",
    input: { initial: "0123456789", cursor: 9, maxWidth: 5 },
  },
];

function run(input, kind) {
  const state = createLineState(input.initial ?? "");
  if (typeof input.cursor === "number") state.cursor = input.cursor;
  if (kind === "render") {
    const rendered = renderLineWindow(state, input.maxWidth);
    return { rendered, visibleLength: visibleLength(rendered) };
  }
  const consumed = [];
  for (const event of input.events ?? []) {
    if (typeof event.setCursor === "number") {
      state.cursor = event.setCursor;
      consumed.push(null);
    } else {
      consumed.push(applyLineEdit(state, event));
    }
  }
  return { state, consumed };
}

const cases = scenarios.map((scenario, index) => ({
  id: `terminal-line-editor-${String(index + 1).padStart(3, "0")}`,
  name: scenario.name,
  source: "src/line-editor.test.ts",
  sourceName: scenario.name,
  api: scenario.kind === "render" ? "renderLineWindow" : "createLineState/applyLineEdit",
  input: { kind: scenario.kind, ...scenario.input },
  output: run(scenario.input, scenario.kind),
  inputSha256: hash({ kind: scenario.kind, ...scenario.input }),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/line-editor.test.ts",
  generatedBy: "scripts/capture-line-editor-contract.mjs",
  description:
    "Single-line editor cursor movement, editing, paste normalization, key-consumption, and render-window behavior captured by running TypeScript line-editor helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
