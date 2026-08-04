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

import { appendHostedAudit, hashPrompt, pruneHostedAudit, type HostedAuditRecord } from "./hosted-audit.js";
import { getHostedAuditPath, getHostedDir } from "./paths.js";

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
    expect(written.promptText).toBeUndefined();
    // The record stays correlatable without retaining what was said.
    expect(readFileSync(getHostedAuditPath(), "utf-8")).not.toContain(text);
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

describe("pruneHostedAudit", () => {
  it("drops expired records from the live log, not just rotations", () => {
    // The gap this closes: a low-traffic deployment never rotates, so pruning
    // only rotated files would keep prompt text forever.
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    appendHostedAudit(record({ ts: old, promptText: "ancient and sensitive" }));
    appendHostedAudit(record({ ts: new Date().toISOString(), promptText: "recent" }));

    pruneHostedAudit(30);

    const written = lines();
    expect(written).toHaveLength(1);
    expect(written[0]!.promptText).toBe("recent");
    expect(readFileSync(getHostedAuditPath(), "utf-8")).not.toContain("ancient and sensitive");
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
