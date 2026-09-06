#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/transcript/turn-state.json", ROOT);
const UUID = "11111111-2222-3333-4444-555555555555";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const turnState = await import(new URL("dist/transcript-turn-state.js", ROOT));
const cases = [];
const jsonl = (records) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
const record = (name, api, input, output) =>
  cases.push({
    id: `transcript-turn-state-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/transcript-turn-state.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });

for (const [name, tail] of [
  ["claude complete when last assistant entry is end_turn", jsonl([{ type: "assistant", message: { stop_reason: "end_turn" } }])],
  [
    "claude complete with trailing bookkeeping",
    jsonl([
      { type: "assistant", message: { stop_reason: "end_turn" } },
      { type: "last-prompt", leafUuid: "x" },
      { type: "ai-title", title: "t" },
      { type: "mode" },
      { type: "permission-mode" },
    ]),
  ],
  ["claude complete for max_tokens", jsonl([{ type: "assistant", message: { stop_reason: "max_tokens" } }])],
  ["claude complete for refusal", jsonl([{ type: "assistant", message: { stop_reason: "refusal" } }])],
  ["claude in_progress for pause_turn", jsonl([{ type: "assistant", message: { stop_reason: "pause_turn" } }])],
  [
    "claude in_progress when user prompt follows end_turn",
    jsonl([{ type: "assistant", message: { stop_reason: "end_turn" } }, { type: "last-prompt" }, { type: "user", message: { role: "user", content: "do more" } }]),
  ],
  [
    "claude in_progress when last assistant entry is tool_use",
    jsonl([
      { type: "assistant", message: { stop_reason: "end_turn" } },
      { type: "user", message: { role: "user" } },
      { type: "assistant", message: { stop_reason: "tool_use" } },
      { type: "user", message: { content: [{ type: "tool_result" }] } },
    ]),
  ],
  ["claude tolerates partial leading line", '_reason":"tool_use"}}\n' + jsonl([{ type: "assistant", message: { stop_reason: "end_turn" } }])],
  ["claude unknown with no assistant entry", jsonl([{ type: "user" }, { type: "mode" }])],
  ["claude unknown for empty tail", ""],
  ["claude unknown for null message", jsonl([{ type: "assistant", message: null }])],
  ["claude unknown for absent message", jsonl([{ type: "assistant" }])],
]) {
  record(name, "claudeTurnState", { tail }, turnState.claudeTurnState(tail));
}

for (const [name, tail] of [
  ["codex complete on task_complete", jsonl([{ type: "event_msg", payload: { type: "task_complete" } }])],
  ["codex complete on turn_aborted", jsonl([{ type: "event_msg", payload: { type: "turn_aborted" } }])],
  [
    "codex in_progress when a turn started without completing",
    jsonl([
      { type: "event_msg", payload: { type: "task_complete" } },
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "response_item", payload: { role: "assistant" } },
    ]),
  ],
  [
    "codex ignores unrelated event_msg payloads and scans back",
    jsonl([{ type: "event_msg", payload: { type: "task_complete" } }, { type: "event_msg", payload: { type: "agent_message_delta" } }]),
  ],
  [
    "codex treats null payload as skipped",
    jsonl([{ type: "event_msg", payload: { type: "task_complete" } }, { type: "event_msg", payload: null }]),
  ],
]) {
  record(name, "codexTurnState", { tail }, turnState.codexTurnState(tail));
}

const dir = mkdtempSync(join(tmpdir(), "aimux-transcript-turn-state-"));
try {
  const tailPath = join(dir, "t.jsonl");
  writeFileSync(tailPath, "AAAA\nBBBB\nCCCC\n");
  record("readFileTail reads only the last bytes", "readFileTail", { contents: "AAAA\nBBBB\nCCCC\n", maxBytes: 5 }, turnState.readFileTail(tailPath, 5));
  record("readFileTail missing file", "readFileTail", { missing: true }, turnState.readFileTail(join(dir, "nope.jsonl")));
  record("probeTranscript missing file", "probeTranscript", { tool: "claude", missing: true }, turnState.probeTranscript("claude", join(dir, "nope.jsonl")));
  const claudePath = join(dir, "claude.jsonl");
  writeFileSync(claudePath, jsonl([{ type: "assistant", message: { stop_reason: "end_turn" } }]));
  const claudeProbe = turnState.probeTranscript("claude", claudePath);
  record("probeTranscript claude complete with stat metadata", "probeTranscript", { tool: "claude", contents: jsonl([{ type: "assistant", message: { stop_reason: "end_turn" } }]) }, { turn: claudeProbe?.turn, sizePositive: (claudeProbe?.size ?? 0) > 0, mtimeMsType: typeof claudeProbe?.mtimeMs });
  const codexPath = join(dir, "codex.jsonl");
  writeFileSync(codexPath, jsonl([{ type: "event_msg", payload: { type: "task_complete" } }]));
  record("probeTranscript routes codex transcripts to codex parser", "probeTranscript", { tool: "codex", contents: jsonl([{ type: "event_msg", payload: { type: "task_complete" } }]) }, turnState.probeTranscript("codex", codexPath)?.turn);
  const emptyPath = join(dir, "empty.jsonl");
  writeFileSync(emptyPath, "");
  const emptyTail = turnState.readFileTail(emptyPath);
  record("zero-byte file has empty tail and unknown Claude turn state", "readFileTail+claudeTurnState", { contents: "" }, { tail: emptyTail, claudeTurnState: turnState.claudeTurnState(emptyTail) });

  const nested = join(dir, "2026", "06", "16");
  mkdirSync(nested, { recursive: true });
  const rollout = join(nested, `rollout-2026-06-16T00-00-00-${UUID}.jsonl`);
  writeFileSync(rollout, "{}\n");
  record("findCodexTranscriptPath locates date-nested rollout file by uuid suffix", "findCodexTranscriptPath", { backendSessionId: UUID, sessionsDir: "<tmp>" }, turnState.findCodexTranscriptPath(UUID, dir)?.replace(dir, "<tmp>"));
  writeFileSync(join(dir, "2026", "rollout-notes.jsonl"), "{}\n");
  record("findCodexTranscriptPath refuses non-uuid id", "findCodexTranscriptPath", { backendSessionId: "notes", sessionsDir: "<tmp>" }, turnState.findCodexTranscriptPath("notes", dir));
  record("findCodexTranscriptPath absent dir", "findCodexTranscriptPath", { backendSessionId: UUID, sessionsDir: "<tmp>/missing" }, turnState.findCodexTranscriptPath(UUID, join(dir, "missing")));
  record("findCodexTranscriptPath no match", "findCodexTranscriptPath", { backendSessionId: "22222222-3333-4444-5555-666666666666", sessionsDir: "<tmp>" }, turnState.findCodexTranscriptPath("22222222-3333-4444-5555-666666666666", dir));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/transcript-turn-state.test.ts",
  generatedBy: "scripts/capture-transcript-turn-state-contract.mjs",
  description: "Claude/Codex transcript turn-state, tail-read, probe, and Codex transcript path contracts captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
