import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeTurnState,
  codexTurnState,
  findCodexTranscriptPath,
  probeTranscript,
  readFileTail,
} from "./transcript-turn-state.js";

function jsonl(records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

describe("claudeTurnState", () => {
  it("reports complete when the last assistant entry is end_turn", () => {
    expect(claudeTurnState(jsonl([{ type: "assistant", message: { stop_reason: "end_turn" } }]))).toBe("complete");
  });

  it("reports complete even when bookkeeping records trail the assistant entry", () => {
    // Claude appends last-prompt/mode/etc after end_turn — the scan must look past them.
    const tail = jsonl([
      { type: "assistant", message: { stop_reason: "end_turn" } },
      { type: "last-prompt", leafUuid: "x" },
      { type: "ai-title", title: "t" },
      { type: "mode" },
      { type: "permission-mode" },
    ]);
    expect(claudeTurnState(tail)).toBe("complete");
  });

  it("reports in_progress when the last assistant entry is a tool_use", () => {
    const tail = jsonl([
      { type: "assistant", message: { stop_reason: "end_turn" } },
      { type: "user", message: { role: "user" } },
      { type: "assistant", message: { stop_reason: "tool_use" } },
      { type: "user", message: { content: [{ type: "tool_result" }] } },
    ]);
    expect(claudeTurnState(tail)).toBe("in_progress");
  });

  it("tolerates a partial leading line from a mid-file tail read", () => {
    const tail = '_reason":"tool_use"}}\n' + jsonl([{ type: "assistant", message: { stop_reason: "end_turn" } }]);
    expect(claudeTurnState(tail)).toBe("complete");
  });

  it("returns unknown when no assistant entry is present", () => {
    expect(claudeTurnState(jsonl([{ type: "user" }, { type: "mode" }]))).toBe("unknown");
    expect(claudeTurnState("")).toBe("unknown");
  });

  it("treats a null/absent message as unknown rather than throwing", () => {
    expect(claudeTurnState(jsonl([{ type: "assistant", message: null }]))).toBe("unknown");
    expect(claudeTurnState(jsonl([{ type: "assistant" }]))).toBe("unknown");
  });
});

describe("codexTurnState", () => {
  it("reports complete on task_complete / turn_complete / turn_aborted", () => {
    expect(codexTurnState(jsonl([{ type: "event_msg", payload: { type: "task_complete" } }]))).toBe("complete");
    expect(codexTurnState(jsonl([{ type: "event_msg", payload: { type: "turn_aborted" } }]))).toBe("complete");
  });

  it("reports in_progress when a turn started without completing", () => {
    const tail = jsonl([
      { type: "event_msg", payload: { type: "task_complete" } },
      { type: "event_msg", payload: { type: "task_started" } },
      { type: "response_item", payload: { role: "assistant" } },
    ]);
    expect(codexTurnState(tail)).toBe("in_progress");
  });

  it("ignores unrelated event_msg payloads and scans back", () => {
    const tail = jsonl([
      { type: "event_msg", payload: { type: "task_complete" } },
      { type: "event_msg", payload: { type: "agent_message_delta" } },
    ]);
    expect(codexTurnState(tail)).toBe("complete");
  });

  it("treats a null/absent payload as a skipped record", () => {
    const tail = jsonl([
      { type: "event_msg", payload: { type: "task_complete" } },
      { type: "event_msg", payload: null },
    ]);
    expect(codexTurnState(tail)).toBe("complete");
  });
});

describe("readFileTail + probeTranscript", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aimux-transcript-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads only the last bytes of a file", () => {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, "AAAA\nBBBB\nCCCC\n");
    expect(readFileTail(path, 5)).toBe("CCCC\n");
  });

  it("returns null for a missing file", () => {
    expect(readFileTail(join(dir, "nope.jsonl"))).toBeNull();
    expect(probeTranscript("claude", join(dir, "nope.jsonl"))).toBeNull();
  });

  it("probes turn state with stat metadata for the quiescence check", () => {
    const path = join(dir, "claude.jsonl");
    writeFileSync(path, jsonl([{ type: "assistant", message: { stop_reason: "end_turn" } }]));
    const probe = probeTranscript("claude", path);
    expect(probe?.turn).toBe("complete");
    expect(probe?.size).toBeGreaterThan(0);
    expect(typeof probe?.mtimeMs).toBe("number");
  });

  it("routes codex transcripts to the codex parser", () => {
    const path = join(dir, "codex.jsonl");
    writeFileSync(path, jsonl([{ type: "event_msg", payload: { type: "task_complete" } }]));
    expect(probeTranscript("codex", path)?.turn).toBe("complete");
  });

  it("returns empty string for a zero-byte file", () => {
    const path = join(dir, "empty.jsonl");
    writeFileSync(path, "");
    expect(readFileTail(path)).toBe("");
    expect(claudeTurnState(readFileTail(path)!)).toBe("unknown");
  });
});

describe("findCodexTranscriptPath", () => {
  let dir = "";
  const uuid = "11111111-2222-3333-4444-555555555555";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aimux-codex-sessions-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("locates a date-nested rollout file by uuid suffix", () => {
    const nested = join(dir, "2026", "06", "16");
    mkdirSync(nested, { recursive: true });
    const path = join(nested, `rollout-2026-06-16T00-00-00-${uuid}.jsonl`);
    writeFileSync(path, "{}\n");
    expect(findCodexTranscriptPath(uuid, dir)).toBe(path);
  });

  it("refuses a non-uuid id rather than risk a filename collision", () => {
    const nested = join(dir, "2026");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "rollout-notes.jsonl"), "{}\n");
    expect(findCodexTranscriptPath("notes", dir)).toBeNull();
  });

  it("returns null when the sessions dir is absent or has no match", () => {
    expect(findCodexTranscriptPath(uuid, join(dir, "missing"))).toBeNull();
    expect(findCodexTranscriptPath(uuid, dir)).toBeNull();
  });
});
