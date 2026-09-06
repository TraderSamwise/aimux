#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-migration/migration.json", ROOT);
const NOW = "2026-05-26T00:00:00.000Z";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const recordCase = (index, name, input, output) => ({
  id: `runtime-migration-${String(index + 1).padStart(3, "0")}`,
  name,
  source: "src/runtime-migration.test.ts",
  input,
  output,
  inputSha256: hash(input),
});

const paths = await import(new URL("dist/paths.js", ROOT));
const migration = await import(new URL("dist/runtime-migration.js", ROOT));
const exchange = await import(new URL("dist/runtime-core/exchange-store.js", ROOT));

function normalize(value, ctx) {
  const projectId = paths.getReadOnlyProjectPathsFor(ctx.repoRoot).projectId;
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "string") return nested;
      return nested.replaceAll(ctx.repoRoot, "<repo>").replaceAll(ctx.aimuxHome, "<home>").replaceAll(projectId, "<project-id>");
    }),
  );
}

async function withFixture(label, fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), `aimux-runtime-migration-contract-${label}-repo-`));
  const aimuxHome = mkdtempSync(join(tmpdir(), `aimux-runtime-migration-contract-${label}-home-`));
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  const previousHome = process.env.AIMUX_HOME;
  process.env.AIMUX_HOME = aimuxHome;
  try {
    const ctx = { repoRoot, aimuxHome };
    return normalize(await fn(ctx), ctx);
  } finally {
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(aimuxHome, { recursive: true, force: true });
  }
}

const cases = [];
const add = async (name, scenario, fn) => {
  const input = { scenario, now: NOW };
  cases.push(recordCase(cases.length, name, input, await withFixture(scenario, fn)));
};

await add("does not copy legacy global agent-facing dirs during path initialization", "global-history-report", async ({ repoRoot }) => {
  const projectStateDir = paths.getProjectStateDirFor(repoRoot);
  mkdirSync(join(projectStateDir, "history"), { recursive: true });
  writeFileSync(join(projectStateDir, "history", "codex-1.jsonl"), "{}\n");
  await paths.initPaths(repoRoot);
  return {
    localHistoryExists: existsSync(join(repoRoot, ".aimux", "history", "codex-1.jsonl")),
    report: migration.buildRuntimeMigrationReport({ cwd: repoRoot, now: NOW }),
  };
});

await add("reports corrupt legacy files and blocks import", "corrupt-legacy-thread", async ({ repoRoot }) => {
  await paths.initPaths(repoRoot);
  mkdirSync(join(repoRoot, ".aimux", "threads"), { recursive: true });
  writeFileSync(join(repoRoot, ".aimux", "threads", "thread-1.json"), "{bad");
  const report = migration.buildRuntimeMigrationReport({ cwd: repoRoot, now: NOW });
  let importError = null;
  try {
    migration.importRuntimeMigration({ cwd: repoRoot, now: NOW });
  } catch (error) {
    importError = error instanceof Error ? error.message : String(error);
  }
  return { report, importError };
});

await add("imports legacy exchange refs explicitly and writes a rollback manifest", "import-and-rollback", async ({ repoRoot }) => {
  await paths.initPaths(repoRoot);
  const projectStateDir = paths.getProjectStateDirFor(repoRoot);
  const originalExchange = new exchange.RuntimeExchangeStore(paths.getRuntimeExchangePath()).write(exchange.emptyRuntimeExchange(NOW));
  mkdirSync(join(repoRoot, ".aimux", "threads"), { recursive: true });
  mkdirSync(join(repoRoot, ".aimux", "tasks"), { recursive: true });
  mkdirSync(join(projectStateDir, "history"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".aimux", "threads", "thread-1.json"),
    `${JSON.stringify({
      id: "thread-1",
      title: "Task",
      kind: "task",
      status: "waiting",
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: "user",
      participants: ["user", "codex-1"],
    })}\n`,
  );
  writeFileSync(
    join(repoRoot, ".aimux", "tasks", "task-1.json"),
    `${JSON.stringify({
      id: "task-1",
      status: "pending",
      assignedBy: "user",
      threadId: "thread-1",
      description: "Do task",
      prompt: "Do task",
      createdAt: NOW,
      updatedAt: NOW,
    })}\n`,
  );
  writeFileSync(join(projectStateDir, "history", "codex-1.jsonl"), "{}\n");
  const result = migration.importRuntimeMigration({ cwd: repoRoot, now: NOW });
  const manifestPath = join(projectStateDir, "migration-backups", "2026-05-26T00-00-00-000Z", "manifest.json");
  const beforeRollback = {
    copiedHistoryExists: existsSync(join(repoRoot, ".aimux", "history", "codex-1.jsonl")),
    manifestExists: existsSync(manifestPath),
    backupContainsOriginalGeneratedAt: readFileSync(result.manifest.backups[0].backup, "utf8").includes(originalExchange.generatedAt),
  };
  writeFileSync(join(repoRoot, ".aimux", "history", "post-import.jsonl"), "{}\n");
  const rollback = migration.rollbackRuntimeMigration(manifestPath);
  return {
    import: result,
    beforeRollback,
    rollback,
    afterRollback: {
      copiedHistoryExists: existsSync(join(repoRoot, ".aimux", "history", "codex-1.jsonl")),
      postImportHistoryExists: existsSync(join(repoRoot, ".aimux", "history", "post-import.jsonl")),
      runtimeExchangeGeneratedAt: new exchange.RuntimeExchangeStore(paths.getRuntimeExchangePath()).read().generatedAt,
    },
  };
});

await add("rollback removes imported runtime exchange when no backup existed", "rollback-no-backup", async ({ repoRoot }) => {
  await paths.initPaths(repoRoot);
  mkdirSync(join(repoRoot, ".aimux", "threads"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".aimux", "threads", "thread-1.json"),
    `${JSON.stringify({
      id: "thread-1",
      title: "Task",
      kind: "task",
      status: "waiting",
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: "user",
      participants: ["user", "codex-1"],
    })}\n`,
  );
  const result = migration.importRuntimeMigration({ cwd: repoRoot, now: NOW });
  const manifestPath = join(paths.getProjectStateDirFor(repoRoot), "migration-backups", "2026-05-26T00-00-00-000Z", "manifest.json");
  const exchangeExistsBeforeRollback = existsSync(paths.getRuntimeExchangePath());
  const rollback = migration.rollbackRuntimeMigration(manifestPath);
  return {
    import: result,
    exchangeExistsBeforeRollback,
    rollback,
    exchangeExistsAfterRollback: existsSync(paths.getRuntimeExchangePath()),
  };
});

await add("blocks import when authoritative runtime exchange already has records", "blocked-existing-exchange", async ({ repoRoot }) => {
  await paths.initPaths(repoRoot);
  mkdirSync(join(repoRoot, ".aimux", "threads"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".aimux", "threads", "thread-1.json"),
    `${JSON.stringify({
      id: "thread-1",
      title: "Legacy task",
      kind: "task",
      status: "waiting",
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: "user",
      participants: ["user", "codex-1"],
    })}\n`,
  );
  new exchange.RuntimeExchangeStore(paths.getRuntimeExchangePath()).write({
    ...exchange.emptyRuntimeExchange(NOW),
    threads: [
      {
        id: "thread-existing",
        title: "Existing",
        kind: "conversation",
        status: "open",
        createdAt: NOW,
        updatedAt: NOW,
        createdBy: "user",
        participants: ["user"],
      },
    ],
  });
  const report = migration.buildRuntimeMigrationReport({ cwd: repoRoot, now: NOW });
  let importError = null;
  try {
    migration.importRuntimeMigration({ cwd: repoRoot, now: NOW });
  } catch (error) {
    importError = error instanceof Error ? error.message : String(error);
  }
  return { report, importError };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/runtime-migration.test.ts",
  generatedBy: "scripts/capture-runtime-migration-fixture-contract.mjs",
  description: "Runtime migration report, import, rollback, and blocked-import contracts captured by running TypeScript migration helpers.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
