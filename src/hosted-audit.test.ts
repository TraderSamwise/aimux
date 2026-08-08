import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendHostedAudit,
  appendHostedPrompt,
  hashPrompt,
  pruneHostedAudit,
  tailHostedAudit,
  tailHostedPrompts,
  type HostedAuditRecord,
} from "./hosted-audit.js";
import { getHostedAuditPath, getHostedAuditPromptsPath, getHostedDir } from "./paths.js";

let previousAimuxHome: string | undefined;
let aimuxHome = "";

function record(overrides: Partial<HostedAuditRecord> = {}): HostedAuditRecord {
  return {
    ts: new Date().toISOString(),
    principalId: "prn_a",
    label: "grand",
    method: "POST",
    path: "/proxy/127.0.0.1/43210/agents/input",
    sessionId: "assistant",
    status: 200,
    requestBytes: 42,
    responseBytes: 128,
    ...overrides,
  };
}

function lines(): HostedAuditRecord[] {
  return readFileSync(getHostedAuditPath(), "utf-8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as HostedAuditRecord);
}

beforeEach(() => {
  previousAimuxHome = process.env.AIMUX_HOME;
  aimuxHome = mkdtempSync(join(tmpdir(), "aimux-hosted-audit-"));
  process.env.AIMUX_HOME = aimuxHome;
});

afterEach(() => {
  if (previousAimuxHome === undefined) delete process.env.AIMUX_HOME;
  else process.env.AIMUX_HOME = previousAimuxHome;
  rmSync(aimuxHome, { recursive: true, force: true });
});

describe("appendHostedAudit", () => {
  it("writes one JSONL record per call, 0600", () => {
    appendHostedAudit(record());
    appendHostedAudit(record({ status: 403 }));

    const written = lines();
    expect(written).toHaveLength(2);
    expect(written[0]!.principalId).toBe("prn_a");
    expect(written[1]!.status).toBe(403);
    expect(statSync(getHostedAuditPath()).mode & 0o777).toBe(0o600);
  });

  it("keeps the prompt hash and omits the text when bodies are not audited", () => {
    const text = "how much did we take on Friday";
    appendHostedAudit(record({ promptHash: hashPrompt(text) }));

    const written = lines()[0]!;
    expect(written.promptHash).toBe(hashPrompt(text));
    expect(written.promptRef).toBeUndefined();
    // The record stays correlatable without retaining what was said.
    expect(readFileSync(getHostedAuditPath(), "utf-8")).not.toContain(text);
  });

  it("keeps bodies in their own file, so a flood cannot rotate out the records", () => {
    // The bug this closes: bodies shared the size-rotated record file, so any
    // token holder — including one with no grants, whose every request is a 403
    // — could push every other operator's history out of it.
    appendHostedAudit(record({ promptHash: hashPrompt("x"), promptRef: "ref_1" }));
    appendHostedPrompt({
      ts: new Date().toISOString(),
      promptRef: "ref_1",
      principalId: "prn_a",
      promptHash: hashPrompt("x"),
      promptText: "what did we take on Friday",
    });

    expect(readFileSync(getHostedAuditPath(), "utf-8")).not.toContain("what did we take");
    expect(tailHostedPrompts(["ref_1"]).get("ref_1")?.promptText).toBe("what did we take on Friday");
    expect(statSync(getHostedAuditPromptsPath()).mode & 0o777).toBe(0o600);
  });

  it("never throws when the log cannot be written", () => {
    mkdirSync(getHostedDir(), { recursive: true });
    writeFileSync(getHostedAuditPath(), "");
    chmodSync(getHostedAuditPath(), 0o000);
    try {
      // An audit failure must never fail the request it describes.
      expect(() => appendHostedAudit(record())).not.toThrow();
    } finally {
      chmodSync(getHostedAuditPath(), 0o600);
    }
  });
});

describe("the pending sidecar", () => {
  const pendingPath = () => `${getHostedAuditPath()}.pending`;
  const stagedPath = () => `${getHostedAuditPath()}.pending.merging`;

  function writePending(...records: HostedAuditRecord[]): void {
    mkdirSync(getHostedDir(), { recursive: true, mode: 0o700 });
    writeFileSync(pendingPath(), records.map((entry) => `${JSON.stringify(entry)}\n`).join(""), { mode: 0o600 });
  }

  it("is visible to a tail before the prune folds it in", () => {
    appendHostedAudit(record({ detail: "in the live file" }));
    writePending(record({ detail: "arrived during a prune" }));

    const details = tailHostedAudit(10).map((entry) => entry.detail);
    expect(details).toContain("in the live file");
    expect(details).toContain("arrived during a prune");
  });

  it("folds pending records into the live file and then removes the sidecar", () => {
    appendHostedAudit(record({ detail: "live" }));
    writePending(record({ detail: "pending" }));

    pruneHostedAudit(30);

    const raw = readFileSync(getHostedAuditPath(), "utf-8");
    expect(raw).toContain("pending");
    expect(raw).toContain("live");
    expect(existsSync(pendingPath())).toBe(false);
    expect(existsSync(stagedPath())).toBe(false);
  });

  it("recovers records staged by a prune that died before writing them", () => {
    // The staged file is the ONLY copy between the rename and the write, so a
    // crash there must leave it on disk rather than destroy it.
    mkdirSync(getHostedDir(), { recursive: true, mode: 0o700 });
    writeFileSync(stagedPath(), `${JSON.stringify(record({ detail: "survived a crash" }))}\n`, { mode: 0o600 });

    pruneHostedAudit(30);

    expect(readFileSync(getHostedAuditPath(), "utf-8")).toContain("survived a crash");
    expect(existsSync(stagedPath())).toBe(false);
  });

  it("leaves a fresh sidecar alone while recovering a staged one", () => {
    mkdirSync(getHostedDir(), { recursive: true, mode: 0o700 });
    writeFileSync(stagedPath(), `${JSON.stringify(record({ detail: "staged" }))}\n`, { mode: 0o600 });
    writePending(record({ detail: "newly pending" }));

    pruneHostedAudit(30);

    // Clobbering the survivor to stage the newcomer would lose the survivor.
    expect(readFileSync(getHostedAuditPath(), "utf-8")).toContain("staged");
    expect(existsSync(pendingPath())).toBe(true);

    pruneHostedAudit(30);
    expect(readFileSync(getHostedAuditPath(), "utf-8")).toContain("newly pending");
  });

  it("is never rotated, because nothing would ever read a rotated sidecar back", () => {
    // Rotation renames to `.N`, and neither the tail nor the prune looks at
    // `.pending.N` — so rotating here would take records out of every view and
    // out of retention, which for prompt bodies means keeping them forever.
    mkdirSync(getHostedDir(), { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify(record({ detail: "x".repeat(4096) }))}\n`;
    writeFileSync(pendingPath(), line.repeat(2_500), { mode: 0o600 });
    expect(statSync(pendingPath()).size).toBeGreaterThan(8 * 1024 * 1024);

    appendHostedAudit(record({ detail: "after the sidecar grew past the rotation threshold" }));

    expect(existsSync(`${pendingPath()}.1`)).toBe(false);
  });

  it("drops expired pending records on the retention window", () => {
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    writePending(record({ ts: old, detail: "expired in the sidecar" }));

    pruneHostedAudit(30);

    expect(readFileSync(getHostedAuditPath(), "utf-8")).not.toContain("expired in the sidecar");
  });
});

describe("pruneHostedAudit", () => {
  it("drops expired records from the live log, not just rotations", () => {
    // The gap this closes: a low-traffic deployment never rotates, so pruning
    // only rotated files would keep prompt text forever.
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    appendHostedAudit(record({ ts: old, detail: "ancient and sensitive" }));
    appendHostedAudit(record({ ts: new Date().toISOString(), detail: "recent" }));

    pruneHostedAudit(30);

    const written = lines();
    expect(written).toHaveLength(1);
    expect(written[0]!.detail).toBe("recent");
    expect(readFileSync(getHostedAuditPath(), "utf-8")).not.toContain("ancient and sensitive");
  });

  it("prunes prompt bodies on the same window as the records", () => {
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    appendHostedPrompt({
      ts: old,
      promptRef: "ref_old",
      principalId: "prn_a",
      promptHash: hashPrompt("ancient"),
      promptText: "ancient and sensitive",
    });
    appendHostedPrompt({
      ts: new Date().toISOString(),
      promptRef: "ref_new",
      principalId: "prn_a",
      promptHash: hashPrompt("recent"),
      promptText: "recent",
    });

    pruneHostedAudit(30);

    const found = tailHostedPrompts(["ref_old", "ref_new"]);
    expect(found.has("ref_old")).toBe(false);
    expect(found.get("ref_new")?.promptText).toBe("recent");
    expect(readFileSync(getHostedAuditPromptsPath(), "utf-8")).not.toContain("ancient and sensitive");
  });

  it("removes rotated files past the retention window and keeps fresh ones", () => {
    appendHostedAudit(record());
    const rotatedOld = `${getHostedAuditPath()}.2`;
    const rotatedNew = `${getHostedAuditPath()}.1`;
    writeFileSync(rotatedOld, "{}\n");
    writeFileSync(rotatedNew, "{}\n");
    const ancient = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    utimesSync(rotatedOld, ancient, ancient);

    pruneHostedAudit(30);

    expect(existsSync(rotatedOld)).toBe(false);
    expect(existsSync(rotatedNew)).toBe(true);
    // The live log is never pruned out from under an active listener.
    expect(existsSync(getHostedAuditPath())).toBe(true);
  });
});
