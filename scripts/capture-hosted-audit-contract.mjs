#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/hosted/audit.json", ROOT);
const NOW = Date.parse("2026-04-01T00:00:00.000Z");
const RECENT = "2026-04-01T00:00:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const audit = await import(new URL("dist/full/hosted-audit.js", ROOT));
const paths = await import(new URL("dist/paths.js", ROOT));

function record(overrides = {}) {
  return {
    ts: RECENT,
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

function lines() {
  return readFileSync(paths.getHostedAuditPath(), "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function withHome(run) {
  const previous = process.env.AIMUX_HOME;
  const home = mkdtempSync(join(tmpdir(), "aimux-hosted-audit-contract-"));
  process.env.AIMUX_HOME = home;
  try {
    return run(home);
  } finally {
    if (previous === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

function recordCase(index, name, scenario, output) {
  const input = { scenario };
  return {
    id: `hosted-audit-${String(index + 1).padStart(3, "0")}`,
    name,
    source: "src/full/hosted-audit.test.ts",
    api: "hosted-audit",
    input,
    output,
    inputSha256: hash(input),
  };
}

function pendingPath() {
  return `${paths.getHostedAuditPath()}.pending`;
}

function stagedPath() {
  return `${paths.getHostedAuditPath()}.pending.merging`;
}

function writePending(...records) {
  mkdirSync(paths.getHostedDir(), { recursive: true, mode: 0o700 });
  writeFileSync(pendingPath(), records.map((entry) => `${JSON.stringify(entry)}\n`).join(""), { mode: 0o600 });
}

const cases = [];
const add = (name, scenario, run) => cases.push(recordCase(cases.length, name, scenario, withHome(run)));

add("writes one JSONL record per call, 0600", "append-jsonl-mode", () => {
  audit.appendHostedAudit(record());
  audit.appendHostedAudit(record({ status: 403 }));
  const written = lines();
  return { count: written.length, firstPrincipalId: written[0].principalId, secondStatus: written[1].status, mode: statSync(paths.getHostedAuditPath()).mode & 0o777 };
});
add("keeps the prompt hash and omits the text when bodies are not audited", "prompt-hash-no-text", () => {
  const text = "how much did we take on Friday";
  audit.appendHostedAudit(record({ promptHash: audit.hashPrompt(text) }));
  const written = lines()[0];
  return { promptHash: written.promptHash, expectedHash: audit.hashPrompt(text), promptRef: written.promptRef ?? null, rawContainsText: readFileSync(paths.getHostedAuditPath(), "utf-8").includes(text) };
});
add("keeps bodies in their own file, so a flood cannot rotate out the records", "prompt-body-side-file", () => {
  audit.appendHostedAudit(record({ promptHash: audit.hashPrompt("x"), promptRef: "ref_1" }));
  audit.appendHostedPrompt({
    ts: RECENT,
    promptRef: "ref_1",
    principalId: "prn_a",
    promptHash: audit.hashPrompt("x"),
    promptText: "what did we take on Friday",
  });
  return {
    auditContainsText: readFileSync(paths.getHostedAuditPath(), "utf-8").includes("what did we take"),
    promptText: audit.tailHostedPrompts(["ref_1"]).get("ref_1")?.promptText,
    promptMode: statSync(paths.getHostedAuditPromptsPath()).mode & 0o777,
  };
});
add("never throws when the log cannot be written", "append-never-throws", () => {
  mkdirSync(paths.getHostedDir(), { recursive: true });
  writeFileSync(paths.getHostedAuditPath(), "");
  chmodSync(paths.getHostedAuditPath(), 0o000);
  let threw = false;
  try {
    audit.appendHostedAudit(record());
  } catch {
    threw = true;
  } finally {
    chmodSync(paths.getHostedAuditPath(), 0o600);
  }
  return { threw };
});
add("is visible to a tail before the prune folds it in", "pending-visible-to-tail", () => {
  audit.appendHostedAudit(record({ detail: "in the live file" }));
  writePending(record({ detail: "arrived during a prune" }));
  return audit.tailHostedAudit(10).map((entry) => entry.detail);
});
add("folds pending records into the live file and then removes the sidecar", "fold-pending", () => {
  audit.appendHostedAudit(record({ detail: "live" }));
  writePending(record({ detail: "pending" }));
  audit.pruneHostedAudit(30, NOW);
  const raw = readFileSync(paths.getHostedAuditPath(), "utf-8");
  return { containsPending: raw.includes("pending"), containsLive: raw.includes("live"), pendingExists: existsSync(pendingPath()), stagedExists: existsSync(stagedPath()) };
});
add("recovers records staged by a prune that died before writing them", "recover-staged", () => {
  mkdirSync(paths.getHostedDir(), { recursive: true, mode: 0o700 });
  writeFileSync(stagedPath(), `${JSON.stringify(record({ detail: "survived a crash" }))}\n`, { mode: 0o600 });
  audit.pruneHostedAudit(30, NOW);
  return { rawContains: readFileSync(paths.getHostedAuditPath(), "utf-8").includes("survived a crash"), stagedExists: existsSync(stagedPath()) };
});
add("leaves a fresh sidecar alone while recovering a staged one", "staged-and-fresh-pending", () => {
  mkdirSync(paths.getHostedDir(), { recursive: true, mode: 0o700 });
  writeFileSync(stagedPath(), `${JSON.stringify(record({ detail: "staged" }))}\n`, { mode: 0o600 });
  writePending(record({ detail: "newly pending" }));
  audit.pruneHostedAudit(30, NOW);
  const afterFirst = { rawContainsStaged: readFileSync(paths.getHostedAuditPath(), "utf-8").includes("staged"), pendingExists: existsSync(pendingPath()) };
  audit.pruneHostedAudit(30, NOW);
  return { afterFirst, rawContainsNewPending: readFileSync(paths.getHostedAuditPath(), "utf-8").includes("newly pending") };
});
add("is never rotated, because nothing would ever read a rotated sidecar back", "pending-not-rotated", () => {
  mkdirSync(paths.getHostedDir(), { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify(record({ detail: "x".repeat(4096) }))}\n`;
  writeFileSync(pendingPath(), line.repeat(2_500), { mode: 0o600 });
  const sizeGreaterThanLimit = statSync(pendingPath()).size > 8 * 1024 * 1024;
  audit.appendHostedAudit(record({ detail: "after the sidecar grew past the rotation threshold" }));
  return { sizeGreaterThanLimit, rotatedSidecarExists: existsSync(`${pendingPath()}.1`) };
});
add("drops expired pending records on the retention window", "drop-expired-pending", () => {
  writePending(record({ ts: OLD, detail: "expired in the sidecar" }));
  audit.pruneHostedAudit(30, NOW);
  return { rawContainsExpired: existsSync(paths.getHostedAuditPath()) ? readFileSync(paths.getHostedAuditPath(), "utf-8").includes("expired in the sidecar") : false };
});
add("drops expired records from the live log, not just rotations", "drop-expired-live", () => {
  audit.appendHostedAudit(record({ ts: OLD, detail: "ancient and sensitive" }));
  audit.appendHostedAudit(record({ ts: RECENT, detail: "recent" }));
  audit.pruneHostedAudit(30, NOW);
  const written = lines();
  return { count: written.length, detail: written[0].detail, rawContainsAncient: readFileSync(paths.getHostedAuditPath(), "utf-8").includes("ancient and sensitive") };
});
add("prunes prompt bodies on the same window as the records", "prune-prompts", () => {
  audit.appendHostedPrompt({ ts: OLD, promptRef: "ref_old", principalId: "prn_a", promptHash: audit.hashPrompt("ancient"), promptText: "ancient and sensitive" });
  audit.appendHostedPrompt({ ts: RECENT, promptRef: "ref_new", principalId: "prn_a", promptHash: audit.hashPrompt("recent"), promptText: "recent" });
  audit.pruneHostedAudit(30, NOW);
  const found = audit.tailHostedPrompts(["ref_old", "ref_new"]);
  return { hasOld: found.has("ref_old"), newText: found.get("ref_new")?.promptText, rawContainsAncient: readFileSync(paths.getHostedAuditPromptsPath(), "utf-8").includes("ancient and sensitive") };
});
add("removes rotated files past the retention window and keeps fresh ones", "rotated-retention", () => {
  audit.appendHostedAudit(record());
  const rotatedOld = `${paths.getHostedAuditPath()}.2`;
  const rotatedNew = `${paths.getHostedAuditPath()}.1`;
  writeFileSync(rotatedOld, "{}\n");
  writeFileSync(rotatedNew, "{}\n");
  const ancient = new Date(Date.parse(OLD));
  utimesSync(rotatedOld, ancient, ancient);
  audit.pruneHostedAudit(30, NOW);
  return { oldExists: existsSync(rotatedOld), newExists: existsSync(rotatedNew), liveExists: existsSync(paths.getHostedAuditPath()) };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/full/hosted-audit.test.ts",
  generatedBy: "scripts/capture-hosted-audit-contract.mjs",
  description:
    "Hosted audit JSONL append, prompt-body side file, pending sidecar visibility/recovery, retention pruning, and rotated-file pruning behavior captured by running TypeScript hosted-audit helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
