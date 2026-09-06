#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tui/render-theme.json", ROOT);
const text = await import(new URL("dist/tui/render/text.js", ROOT));
const theme = await import(new URL("dist/tui/render/theme.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function run(input) {
  switch (input.api) {
    case "style":
      return theme.style(input.text, input.tone);
    case "statusDot":
      return theme.statusDot(input.kind);
    case "statusTone":
      return theme.statusTone(input.kind);
    case "visibleWidth":
      return theme.visibleWidth(input.text);
    case "pill":
      return theme.pill(input.label, input.tone);
    case "chip":
      return theme.chip(input.label, input.tone);
    case "keycap":
      return theme.keycap(input.key, input.tone);
    case "keycapHint":
      return theme.keycapHint(input.key, input.label, input.tone);
    case "keycapHints":
      return theme.keycapHints(input.line);
    case "footerHints":
      return theme.footerHints(input.line);
    case "keycapHintLines":
      return theme.keycapHintLines(input.line, input.width);
    case "renderFooterHints":
      return theme.renderFooterHints(input.hints, input.width);
    case "padVisible":
      return theme.padVisible(input.text, input.width);
    case "cols":
      return theme.cols(input.columns);
    case "divider":
      return theme.divider(input.width, input.tone);
    case "recede":
      return theme.recede(input.text);
    case "tmuxStyle":
      return theme.tmuxStyle(input.text, input.tone);
    case "tmuxInvert":
      return theme.tmuxInvert(input.text, input.tone);
    case "card":
      return theme.card(input.spec);
    case "stripAnsi":
      return text.stripAnsi(input.text);
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const styledWork = theme.style("ab", "work");
const tones = ["text", "muted", "strong", "accent", "work", "attn", "done", "danger", "blocked", "info", "ready", "idle"];
const statusKinds = ["working", "ready", "idle", "offline", "needs", "error", "done", "blocked", "service", "serviceOff"];
const inputs = [
  { name: "style wraps danger tone", api: "style", text: "hi", tone: "danger" },
  { name: "style wraps accent tone", api: "style", text: "hi", tone: "accent" },
  { name: "style passes text tone through", api: "style", text: "hi", tone: "text" },
  { name: "status dot working", api: "statusDot", kind: "working" },
  { name: "status dot offline", api: "statusDot", kind: "offline" },
  { name: "status tone ready", api: "statusTone", kind: "ready" },
  { name: "visible width ignores styled work text", api: "visibleWidth", text: theme.style("hello", "work") },
  { name: "pill renders reverse video", api: "pill", label: "OK", tone: "done" },
  { name: "text pill falls back to bare reverse video", api: "pill", label: "X", tone: "text" },
  { name: "chip renders info count", api: "chip", label: "22 unseen", tone: "info" },
  { name: "keycap renders default key", api: "keycap", key: "q" },
  { name: "keycap renders danger key", api: "keycap", key: "x", tone: "danger" },
  { name: "pad visible pads styled content", api: "padVisible", text: styledWork, width: 6 },
  { name: "pad visible truncates styled content", api: "padVisible", text: theme.style("abcdef", "work"), width: 4 },
  {
    name: "columns align mixed content",
    api: "cols",
    columns: [
      { content: theme.statusDot("working"), width: 2 },
      { content: theme.style("codex", "strong"), width: 10 },
      { content: theme.pill("WORKING", "work"), width: 14 },
    ],
  },
  { name: "divider renders exact width", api: "divider", width: 5 },
  { name: "keycap hint with label", api: "keycapHint", key: "q", label: "quit" },
  { name: "keycap hint without label", api: "keycapHint", key: "Esc" },
  { name: "keycap hints parse bracket and bare key groups", api: "keycapHints", line: "[↑↓] select  q quit" },
  { name: "footer hints render box free", api: "footerHints", line: "[↑↓] select  q quit" },
  { name: "keycap hint lines wrap groups", api: "keycapHintLines", line: "[a] alpha  [b] bravo  [c] charlie", width: 14 },
  { name: "recede plain text", api: "recede", text: "plain" },
  { name: "recede after embedded reset", api: "recede", text: `${theme.style("hi", "danger")}bye` },
  { name: "recede shorthand reset", api: "recede", text: "a\u001b[mb" },
  { name: "recede reset-led bold", api: "recede", text: "x\u001b[0;1my" },
  { name: "render footer hints one line", api: "renderFooterHints", hints: [["u", "attention"], ["n", "agent"], ["q", "quit"]], width: 200 },
  { name: "render footer hints danger tone", api: "renderFooterHints", hints: [["x", "kill", "danger"]], width: 200 },
  { name: "render footer hints wraps long list", api: "renderFooterHints", hints: [["a", "alpha"], ["b", "bravo"], ["c", "charlie"], ["d", "delta"]], width: 16 },
  {
    name: "card with title summary and row",
    api: "card",
    spec: {
      tone: "accent",
      title: theme.style("[1] main", "strong"),
      summary: theme.style("1 offline", "muted"),
      rows: [theme.style("agent row", "text")],
      width: 40,
    },
  },
  {
    name: "titles only card",
    api: "card",
    spec: {
      tone: "muted",
      title: theme.style("[2] wt", "accent"),
      summary: theme.style("no agents", "muted"),
      width: 30,
    },
  },
  {
    name: "card clamps tiny width",
    api: "card",
    spec: { tone: "muted", title: theme.style("x", "text"), width: 3 },
  },
  { name: "all tones preserve visible width", api: "visibleWidthsForStyles", tones, text: "abc" },
  { name: "all status kinds preserve dot width", api: "visibleWidthsForStatusDots", statusKinds },
  { name: "tmux style work", api: "tmuxStyle", text: "x", tone: "work" },
  { name: "tmux style text passthrough", api: "tmuxStyle", text: "x", tone: "text" },
  { name: "tmux invert attention", api: "tmuxInvert", text: " x ", tone: "attn" },
].map((input) => {
  if (input.api === "visibleWidthsForStyles") {
    return {
      ...input,
      output: Object.fromEntries(input.tones.map((tone) => [tone, theme.visibleWidth(theme.style(input.text, tone))])),
    };
  }
  if (input.api === "visibleWidthsForStatusDots") {
    return {
      ...input,
      output: Object.fromEntries(input.statusKinds.map((kind) => [kind, theme.visibleWidth(theme.statusDot(kind))])),
    };
  }
  return input;
});

const cases = inputs.map((input, index) => {
  const { output, ...contractInput } = input;
  return {
    id: `tui-render-theme-${String(index + 1).padStart(3, "0")}`,
    name: input.name,
    source: "src/tui/render/theme.test.ts",
    api: input.api,
    input: contractInput,
    output: output ?? run(contractInput),
    inputSha256: hash(contractInput),
  };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/tui/render/theme.test.ts",
  generatedBy: "scripts/capture-tui-render-theme-contract.mjs",
  description: "TUI theme primitive outputs captured by running TypeScript tui/render/theme helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
