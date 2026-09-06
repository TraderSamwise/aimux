#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const SOURCE_URL = new URL("app/lib/composer-protocol.ts", ROOT);
const FIXTURE_PATH = new URL("testdata/contracts/v1/composer/protocol.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function importTypeScriptModule(url) {
  const source = await readFile(url, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: url.pathname,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const {
  COMPOSER_SEND_TIMEOUT_MESSAGE,
  formatComposerSendFailure,
  getComposerSendText,
  normalizeComposerAckText,
  normalizeComposerDraft,
  shouldSubmitComposerKey,
  userMessageAcknowledgesComposerSend,
} = await importTypeScriptModule(SOURCE_URL);

function errorValue(input) {
  if (!input.error) return undefined;
  if (input.error.kind === "error") return new Error(input.error.message);
  if (input.error.kind === "string") return input.error.value;
  if (input.error.kind === "null") return null;
  return input.error.value;
}

function run(input) {
  if (input.api === "COMPOSER_SEND_TIMEOUT_MESSAGE") return COMPOSER_SEND_TIMEOUT_MESSAGE;
  if (input.api === "normalizeComposerDraft") return normalizeComposerDraft(input.draft);
  if (input.api === "shouldSubmitComposerKey") return shouldSubmitComposerKey(input.event);
  if (input.api === "getComposerSendText") return getComposerSendText(input.state);
  if (input.api === "formatComposerSendFailure") return formatComposerSendFailure(errorValue(input));
  if (input.api === "normalizeComposerAckText") return normalizeComposerAckText(input.value);
  if (input.api === "userMessageAcknowledgesComposerSend") return userMessageAcknowledgesComposerSend(input.messages, input.pending);
  throw new Error(`unknown api ${input.api}`);
}

const clippedPrefixText =
  "There is a lot of work here. Please audit the routing layer, summarize the historical position, " +
  "then explain which fixes are already landed and which pieces are still failing in the mobile chat view. " +
  "Do not skip the edge cases around slow scrolling, prompt focus, and long visible user messages.";
const middleFragmentText =
  "Start with the notification fanout and then continue into composer delivery. " +
  "The important point is that long prompt inputs can be visible only as one transcript fragment " +
  "while the full submitted prompt is larger than the current mobile capture window. " +
  "Finish by checking the ack state and do not leave the draft behind.";
const unrelatedLongText =
  "Investigate the long prompt delivery path across the app, metadata server, and tmux runtime. " +
  "The submitted text should clear only after the matching user echo appears in the structured chat transcript. " +
  "This sentence pads the request enough to require long-message matching behavior.";

const inputs = [
  { name: "exposes composer send timeout copy", api: "COMPOSER_SEND_TIMEOUT_MESSAGE" },
  { name: "normalizes message drafts before submit", api: "normalizeComposerDraft", draft: "  hello\n" },
  { name: "drops blank message drafts", api: "normalizeComposerDraft", draft: "  \n\t" },
  { name: "submits plain enter", api: "shouldSubmitComposerKey", event: { key: "Enter" } },
  { name: "preserves modified enter", api: "shouldSubmitComposerKey", event: { key: "Enter", shiftKey: true } },
  { name: "ignores non-enter keys", api: "shouldSubmitComposerKey", event: { key: "a" } },
  { name: "sends valid composer text", api: "getComposerSendText", state: { draft: "hello", hasServiceEndpoint: true, hasSessionId: true, sendBusy: false } },
  { name: "blocks sends without service endpoint", api: "getComposerSendText", state: { draft: "hello", hasServiceEndpoint: false, hasSessionId: true, sendBusy: false } },
  { name: "blocks sends without session id", api: "getComposerSendText", state: { draft: "hello", hasServiceEndpoint: true, hasSessionId: false, sendBusy: false } },
  { name: "blocks sends while busy", api: "getComposerSendText", state: { draft: "hello", hasServiceEndpoint: true, hasSessionId: true, sendBusy: true } },
  { name: "formats Error send failures", api: "formatComposerSendFailure", error: { kind: "error", message: "offline" } },
  { name: "formats string send failures", api: "formatComposerSendFailure", error: { kind: "string", value: "network down" } },
  { name: "formats empty send failures", api: "formatComposerSendFailure", error: { kind: "string", value: "" } },
  { name: "normalizes ack text whitespace", api: "normalizeComposerAckText", value: "  hello\n\tthere  " },
  { name: "confirms sends against projected transcript text parts", api: "userMessageAcknowledgesComposerSend", messages: [{ role: "user", parts: [{ type: "text", text: "older prompt" }] }, { role: "assistant", parts: [{ type: "text", text: "answer" }] }, { role: "user", parts: [{ type: "text", text: "Still scrolling down behind prompt box" }] }], pending: { attachmentFilenames: [], baselineUserMessageCount: 1, text: "Still scrolling down behind prompt box" } },
  { name: "confirms long sends from clipped echoed prefix", api: "userMessageAcknowledgesComposerSend", messages: [{ role: "user", parts: [{ type: "text", text: clippedPrefixText.slice(0, 150) }] }], pending: { attachmentFilenames: [], baselineUserMessageCount: 0, text: clippedPrefixText } },
  { name: "confirms long sends from visible middle fragment", api: "userMessageAcknowledgesComposerSend", messages: [{ role: "user", parts: [{ type: "text", text: "... long prompt inputs can be visible only as one transcript fragment while the full submitted prompt is larger ..." }] }], pending: { attachmentFilenames: [], baselineUserMessageCount: 0, text: middleFragmentText } },
  { name: "does not confirm short sends from partial echoed text", api: "userMessageAcknowledgesComposerSend", messages: [{ role: "user", parts: [{ type: "text", text: "please fix" }] }], pending: { attachmentFilenames: [], baselineUserMessageCount: 0, text: "please fix the app" } },
  { name: "does not confirm long sends from unrelated new user text", api: "userMessageAcknowledgesComposerSend", messages: [{ role: "user", parts: [{ type: "text", text: "This is a different message that happens after the baseline but should not match." }] }], pending: { attachmentFilenames: [], baselineUserMessageCount: 0, text: unrelatedLongText } },
  { name: "does not confirm from old user messages before baseline", api: "userMessageAcknowledgesComposerSend", messages: [{ role: "user", parts: [{ type: "text", text: "same text" }] }], pending: { attachmentFilenames: [], baselineUserMessageCount: 1, text: "same text" } },
  { name: "confirms attachment-only sends from filenames", api: "userMessageAcknowledgesComposerSend", messages: [{ role: "user", parts: [{ type: "image_reference", label: "[image #1]", filename: "IMG_0400.png" }] }], pending: { attachmentFilenames: ["IMG_0400.png"], baselineUserMessageCount: 0, text: "" } },
  { name: "confirms attachment-only sends from ids", api: "userMessageAcknowledgesComposerSend", messages: [{ role: "user", parts: [{ type: "image_reference", label: "[image #1]", attachmentId: "att_screenshot" }] }], pending: { attachmentIds: ["att_screenshot"], attachmentFilenames: ["IMG_0404.png"], baselineUserMessageCount: 0, text: "" } },
  { name: "does not confirm sparse image parts when pending metadata is known", api: "userMessageAcknowledgesComposerSend", messages: [{ role: "user", parts: [{ type: "image_reference", label: "[image #1]" }] }], pending: { attachmentFilenames: ["IMG_0404.png"], baselineUserMessageCount: 0, text: "" } },
  { name: "confirms sparse attachment-only echoes when metadata is unavailable", api: "userMessageAcknowledgesComposerSend", messages: [{ role: "user", parts: [{ type: "image_reference", label: "[image #1]" }] }], pending: { attachmentCount: 1, attachmentFilenames: [], baselineUserMessageCount: 0, text: "" } },
  { name: "does not confirm wrong attachment id", api: "userMessageAcknowledgesComposerSend", messages: [{ role: "user", parts: [{ type: "image_reference", label: "[image #1]", attachmentId: "att_other" }] }], pending: { attachmentIds: ["att_screenshot"], attachmentFilenames: [], baselineUserMessageCount: 0, text: "" } },
  { name: "does not confirm wrong attachment filename", api: "userMessageAcknowledgesComposerSend", messages: [{ role: "user", parts: [{ type: "image_reference", label: "[image #1]", filename: "IMG_other.png" }] }], pending: { attachmentFilenames: ["IMG_0404.png"], baselineUserMessageCount: 0, text: "" } },
  { name: "confirms text plus attachment sends from echoed text", api: "userMessageAcknowledgesComposerSend", messages: [{ role: "user", parts: [{ type: "text", text: "Queue up: msg echo ack needs to work" }, { type: "image_reference", label: "[image #1]", filename: "IMG_0407.png" }] }], pending: { attachmentFilenames: ["IMG_0407.png"], baselineUserMessageCount: 0, text: "Queue up: msg echo ack needs to work" } },
  { name: "confirms text plus sparse attachment sends from echoed text", api: "userMessageAcknowledgesComposerSend", messages: [{ role: "user", parts: [{ type: "text", text: "Queue up. Why didn't this echo ack?" }, { type: "image_reference", label: "[image #1]" }] }], pending: { attachmentIds: ["att_uploaded"], attachmentFilenames: ["IMG_0428.png"], baselineUserMessageCount: 0, text: "Queue up. Why didn't this echo ack?" } },
  { name: "rejects text plus attachment sends with wrong text", api: "userMessageAcknowledgesComposerSend", messages: [{ role: "user", parts: [{ type: "text", text: "Different queue item" }, { type: "image_reference", label: "[image #1]", filename: "IMG_0407.png" }] }], pending: { attachmentFilenames: ["IMG_0407.png"], baselineUserMessageCount: 0, text: "Queue up: msg echo ack needs to work" } },
];

const cases = inputs.map((input, index) => ({
  id: `composer-protocol-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "app/lib/composer-protocol.test.ts",
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "app/lib/composer-protocol.test.ts",
  generatedBy: "scripts/capture-composer-protocol-contract.mjs",
  description:
    "App composer draft normalization, key submission, send gating, failure copy, ack text normalization, long prompt fragment matching, baseline handling, and attachment acknowledgement behavior captured by running TypeScript composer-protocol helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
