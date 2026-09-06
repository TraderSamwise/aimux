#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-exchange/import.json", ROOT);
const NOW = "2026-05-25T00:00:00.000Z";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const recordCase = (name, api, input, output) => ({
  id: `runtime-exchange-import-${String(cases.length + 1).padStart(3, "0")}`,
  name,
  source: "src/runtime-core/exchange-import.test.ts",
  api,
  input,
  output,
  inputSha256: hash(input),
});

const paths = await import(new URL("dist/paths.js", ROOT));
const exchangeImport = await import(new URL("dist/runtime-core/exchange-import.js", ROOT));
const exchangeStore = await import(new URL("dist/runtime-core/exchange-store.js", ROOT));

function normalize(value, repoRoot) {
  return JSON.parse(JSON.stringify(value, (_key, nested) => (typeof nested === "string" ? nested.replaceAll(repoRoot, "<repo>") : nested)));
}

async function withProject(fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), "aimux-exchange-import-"));
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  await paths.initPaths(repoRoot);
  try {
    return normalize(await fn(repoRoot), repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

const cases = [];

cases.push(
  recordCase(
    "converts legacy thread, message, task, handoff, review, wait, and inbox shapes",
    "buildRuntimeExchangeFromLegacySnapshot",
    snapshotInput("<repo>"),
    await withProject((repoRoot) => exchangeImport.buildRuntimeExchangeFromLegacySnapshot(snapshotInput(repoRoot))),
  ),
);

cases.push(
  recordCase(
    "imports legacy files without creating missing legacy directories",
    "importRuntimeExchangeFromLegacyFiles",
    { files: legacyFileInput("<repo>"), now: NOW },
    await withProject((repoRoot) => {
      writeLegacyFiles(repoRoot);
      const imported = exchangeImport.importRuntimeExchangeFromLegacyFiles({ now: NOW });
      const exchange = new exchangeStore.RuntimeExchangeStore(join(repoRoot, "runtime-exchange.yaml")).write(imported);
      return {
        threadIds: exchange.threads.map((thread) => thread.id),
        messageIds: exchange.messages.map((message) => message.id),
        taskIds: exchange.tasks.map((task) => task.id),
        waitIds: exchange.waits.map((wait) => wait.id),
        planRefIds: exchange.planRefs.map((ref) => ref.id),
        continuityKinds: exchange.continuityRefs.map((ref) => ref.kind).sort(),
        attachmentRefIds: exchange.attachmentRefs.map((ref) => ref.id),
      };
    }),
  ),
);

cases.push(
  recordCase(
    "leaves absent optional legacy directories untouched",
    "importRuntimeExchangeFromLegacyFiles",
    { removeRecordingsDir: true, now: NOW },
    await withProject((repoRoot) => {
      rmSync(paths.getRecordingsDir(), { recursive: true, force: true });
      const exchange = exchangeImport.importRuntimeExchangeFromLegacyFiles({ now: NOW });
      return { continuityRefs: exchange.continuityRefs, recordingsDirExists: existsSync(paths.getRecordingsDir()) };
    }),
  ),
);

function snapshotInput(repoRoot) {
  return {
    now: NOW,
    threads: [
      {
        id: "thread-1",
        title: "Task",
        kind: "handoff",
        status: "waiting",
        createdAt: NOW,
        updatedAt: NOW,
        createdBy: "user",
        participants: ["user", "codex-1"],
        owner: "user",
        waitingOn: ["codex-1"],
        taskId: "task-1",
        unreadBy: ["codex-1"],
      },
    ],
    messages: [
      { id: "msg-1", threadId: "thread-1", ts: NOW, from: "user", to: ["codex-1"], kind: "handoff", body: "Take this.", taskId: "task-1" },
    ],
    tasks: [
      {
        id: "task-1",
        status: "pending",
        assignedBy: "user",
        assignedTo: "codex-1",
        threadId: "thread-1",
        description: "Review changes",
        prompt: "Review changes",
        createdAt: NOW,
        updatedAt: NOW,
        type: "review",
        reviewStatus: "request-changes",
        reviewFeedback: "Needs tests",
        reviewOf: "task-root",
      },
    ],
    planPaths: [join(repoRoot, ".aimux", "plans", "codex-1.md")],
    historyPaths: [join(repoRoot, ".aimux", "history", "codex-1.jsonl")],
    contextPaths: [join(repoRoot, ".aimux", "context", "codex-1", "live.md")],
    recordingPaths: ["C:\\repo\\.aimux\\recordings\\codex-1.txt"],
    statusPaths: [join(repoRoot, ".aimux", "status", "codex-1.md")],
    attachments: [
      {
        id: "attachment-1",
        kind: "image",
        filename: "image.png",
        mimeType: "image/png",
        sizeBytes: 10,
        sha256: "abc",
        createdAt: NOW,
        source: "path",
        contentPath: join(repoRoot, ".aimux", "attachments", "image.png"),
      },
    ],
  };
}

function legacyFileInput(repoRoot) {
  return {
    thread: snapshotInput(repoRoot).threads[0],
    message: { id: "msg-1", threadId: "thread-1", ts: NOW, from: "user", kind: "request", body: "Do task." },
    task: { id: "task-1", status: "pending", assignedBy: "user", threadId: "thread-1", description: "Do task", prompt: "Do task.", createdAt: NOW, updatedAt: NOW },
    planPath: join(repoRoot, ".aimux", "plans", "codex-1.md"),
    historyPath: join(repoRoot, ".aimux", "history", "codex-1.jsonl"),
    contextPath: join(repoRoot, ".aimux", "context", "codex-1", "live.md"),
    recordingPath: join(repoRoot, ".aimux", "recordings", "codex-1.txt"),
    statusPath: join(repoRoot, ".aimux", "status", "codex-1.md"),
    attachment: snapshotInput(repoRoot).attachments[0],
  };
}

function writeLegacyFiles(repoRoot) {
  const input = legacyFileInput(repoRoot);
  mkdirSync(paths.getLegacyThreadsDir(), { recursive: true });
  mkdirSync(paths.getLegacyTasksDir(), { recursive: true });
  mkdirSync(paths.getPlansDir(), { recursive: true });
  mkdirSync(paths.getHistoryDir(), { recursive: true });
  mkdirSync(join(paths.getContextDir(), "codex-1"), { recursive: true });
  mkdirSync(paths.getRecordingsDir(), { recursive: true });
  mkdirSync(paths.getStatusDir(), { recursive: true });
  mkdirSync(paths.getAttachmentsDir(), { recursive: true });
  writeFileSync(join(paths.getLegacyThreadsDir(), "thread-1.json"), JSON.stringify(input.thread) + "\n");
  writeFileSync(join(paths.getLegacyThreadsDir(), "thread-1.jsonl"), JSON.stringify(input.message) + "\n");
  writeFileSync(join(paths.getLegacyTasksDir(), "task-1.json"), JSON.stringify(input.task) + "\n");
  writeFileSync(input.planPath, "# Plan\n");
  writeFileSync(input.historyPath, "{}\n");
  writeFileSync(input.contextPath, "live\n");
  mkdirSync(dirname(input.recordingPath), { recursive: true });
  writeFileSync(input.recordingPath, "recording\n");
  writeFileSync(input.statusPath, "status\n");
  writeFileSync(join(paths.getAttachmentsDir(), "attachment-1.json"), JSON.stringify(input.attachment) + "\n");
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/runtime-core/exchange-import.test.ts",
  generatedBy: "scripts/capture-runtime-exchange-import-contract.mjs",
  description: "Runtime exchange legacy snapshot and file import contracts captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
