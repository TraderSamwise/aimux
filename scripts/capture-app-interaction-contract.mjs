#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/app-interaction/lifecycle-scroll.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function importTypeScriptModule(path) {
  const url = new URL(path, ROOT);
  const source = await readFile(url, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: url.pathname,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const { canResumeSession } = await importTypeScriptModule("app/lib/agent-lifecycle.ts");
const {
  CHAT_SCROLL_END_THRESHOLD,
  chatCommandForContentChange,
  chatCommandForInitialLayout,
  chatCommandForKeyboardChange,
  chatCommandForNavigationFocus,
  chatDistanceFromEnd,
  chatPolicyAfterNavigationFocus,
  chatPolicyAfterUserScroll,
  createChatScrollPolicy,
  isChatPinnedToEnd,
} = await importTypeScriptModule("app/lib/chat-scroll-policy.ts");

function run(input) {
  if (input.api === "canResumeSession") return canResumeSession(input.session);
  if (input.api === "createChatScrollPolicy") return createChatScrollPolicy();
  if (input.api === "chatDistanceFromEnd") return chatDistanceFromEnd(input.metrics);
  if (input.api === "isChatPinnedToEnd") return isChatPinnedToEnd(input.metrics, input.threshold);
  if (input.api === "chatPolicyAfterUserScroll") return chatPolicyAfterUserScroll(input.policy, input.metrics);
  if (input.api === "chatPolicyAfterNavigationFocus") return chatPolicyAfterNavigationFocus();
  if (input.api === "chatCommandForContentChange") return chatCommandForContentChange(input.policy);
  if (input.api === "chatCommandForKeyboardChange") return chatCommandForKeyboardChange(input.policy);
  if (input.api === "chatCommandForNavigationFocus") return chatCommandForNavigationFocus();
  if (input.api === "chatCommandForInitialLayout") return chatCommandForInitialLayout();
  if (input.api === "CHAT_SCROLL_END_THRESHOLD") return CHAT_SCROLL_END_THRESHOLD;
  throw new Error(`unknown api ${input.api}`);
}

const inputs = [
  { name: "allows offline sessions unless restore is blocked", source: "app/lib/agent-lifecycle.test.ts", api: "canResumeSession", session: { status: "offline" } },
  { name: "allows exited sessions with ready restore state", source: "app/lib/agent-lifecycle.test.ts", api: "canResumeSession", session: { status: "exited", restoreState: "ready" } },
  { name: "blocks resume when restore state is blocked", source: "app/lib/agent-lifecycle.test.ts", api: "canResumeSession", session: { status: "offline", restoreState: "blocked" } },
  { name: "does not offer resume for running sessions", source: "app/lib/agent-lifecycle.test.ts", api: "canResumeSession", session: { status: "running", restoreState: "ready" } },
  { name: "exposes chat scroll end threshold", source: "app/lib/chat-scroll-policy.test.ts", api: "CHAT_SCROLL_END_THRESHOLD" },
  { name: "starts pinned to newest content", source: "app/lib/chat-scroll-policy.test.ts", api: "createChatScrollPolicy" },
  { name: "computes distance from bottom", source: "app/lib/chat-scroll-policy.test.ts", api: "chatDistanceFromEnd", metrics: { contentHeight: 1000, offsetY: 600, viewportHeight: 300 } },
  { name: "clamps short transcript distance to zero", source: "app/lib/chat-scroll-policy.test.ts", api: "chatDistanceFromEnd", metrics: { contentHeight: 200, offsetY: 0, viewportHeight: 300 } },
  { name: "treats threshold offsets as pinned", source: "app/lib/chat-scroll-policy.test.ts", api: "isChatPinnedToEnd", metrics: { contentHeight: 1000, offsetY: 1000 - 300 - CHAT_SCROLL_END_THRESHOLD, viewportHeight: 300 } },
  { name: "treats offsets beyond threshold as reading", source: "app/lib/chat-scroll-policy.test.ts", api: "isChatPinnedToEnd", metrics: { contentHeight: 1000, offsetY: 1000 - 300 - CHAT_SCROLL_END_THRESHOLD - 1, viewportHeight: 300 } },
  { name: "freezes when user scrolls away", source: "app/lib/chat-scroll-policy.test.ts", api: "chatPolicyAfterUserScroll", policy: { intent: "pinned" }, metrics: { contentHeight: 1600, offsetY: 500, viewportHeight: 400 } },
  { name: "returns to pinned at newest content", source: "app/lib/chat-scroll-policy.test.ts", api: "chatPolicyAfterUserScroll", policy: { intent: "reading" }, metrics: { contentHeight: 1600, offsetY: 1200, viewportHeight: 400 } },
  { name: "content changes scroll only while pinned", source: "app/lib/chat-scroll-policy.test.ts", api: "chatCommandForContentChange", policy: { intent: "pinned" } },
  { name: "content changes do nothing while reading", source: "app/lib/chat-scroll-policy.test.ts", api: "chatCommandForContentChange", policy: { intent: "reading" } },
  { name: "keyboard changes scroll only while pinned", source: "app/lib/chat-scroll-policy.test.ts", api: "chatCommandForKeyboardChange", policy: { intent: "pinned" } },
  { name: "keyboard changes do nothing while reading", source: "app/lib/chat-scroll-policy.test.ts", api: "chatCommandForKeyboardChange", policy: { intent: "reading" } },
  { name: "navigation focus resets policy", source: "app/lib/chat-scroll-policy.test.ts", api: "chatPolicyAfterNavigationFocus" },
  { name: "navigation focus scroll command", source: "app/lib/chat-scroll-policy.test.ts", api: "chatCommandForNavigationFocus" },
  { name: "initial layout scroll command", source: "app/lib/chat-scroll-policy.test.ts", api: "chatCommandForInitialLayout" },
];

const cases = inputs.map((input, index) => ({
  id: `app-interaction-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: input.source,
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: ["app/lib/agent-lifecycle.test.ts", "app/lib/chat-scroll-policy.test.ts"],
  generatedBy: "scripts/capture-app-interaction-contract.mjs",
  description:
    "App session resume affordance and chat scroll policy thresholds, distance math, user-scroll intent, and auto-scroll command behavior captured by running TypeScript app helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
