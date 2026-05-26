import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getReadOnlyProjectPathsFor, type ReadOnlyProjectPaths } from "./paths.js";
import { RuntimeExchangeStore, type RuntimeExchange } from "./runtime-core/exchange-store.js";
import { importRuntimeExchangeFromLegacyFiles } from "./runtime-core/exchange-import.js";
import { RuntimeTopologyStore } from "./runtime-core/topology-store.js";

export type RuntimeMigrationDiagnosticSeverity = "info" | "warning" | "error";
export type RuntimeMigrationSourceKind =
  | "legacy-context"
  | "legacy-history"
  | "legacy-status"
  | "legacy-thread"
  | "legacy-message-log"
  | "legacy-task"
  | "legacy-plan"
  | "legacy-recording"
  | "legacy-attachment"
  | "runtime-topology"
  | "runtime-exchange"
  | "saved-state"
  | "metadata";

export interface RuntimeMigrationDiagnostic {
  severity: RuntimeMigrationDiagnosticSeverity;
  kind: RuntimeMigrationSourceKind;
  path: string;
  message: string;
}

export interface RuntimeMigrationReport {
  version: 1;
  generatedAt: string;
  status: "clean" | "needs_import" | "blocked";
  project: {
    repoRoot: string;
    projectId: string;
    projectStateDir: string;
    localAimuxDir: string;
  };
  authority: {
    runtimeTopologyPath: string;
    runtimeExchangePath: string;
    note: string;
  };
  legacy: Record<RuntimeMigrationSourceKind, number>;
  diagnostics: RuntimeMigrationDiagnostic[];
}

export interface RuntimeMigrationManifest {
  version: 1;
  generatedAt: string;
  report: RuntimeMigrationReport;
  backups: Array<{ kind: RuntimeMigrationSourceKind; source: string; backup: string }>;
  copiedDirs: Array<{ kind: RuntimeMigrationSourceKind; source: string; target: string }>;
  copiedFiles: Array<{ kind: RuntimeMigrationSourceKind; source: string; target: string }>;
  wrote: Array<{ kind: RuntimeMigrationSourceKind; path: string }>;
}

function emptyLegacyCounts(): Record<RuntimeMigrationSourceKind, number> {
  return {
    "legacy-context": 0,
    "legacy-history": 0,
    "legacy-status": 0,
    "legacy-thread": 0,
    "legacy-message-log": 0,
    "legacy-task": 0,
    "legacy-plan": 0,
    "legacy-recording": 0,
    "legacy-attachment": 0,
    "runtime-topology": 0,
    "runtime-exchange": 0,
    "saved-state": 0,
    metadata: 0,
  };
}

function listFiles(dir: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(predicate)
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

function listNestedFiles(dir: string, predicate: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const paths: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        paths.push(...listNestedFiles(path, predicate));
      } else if (predicate(entry.name)) {
        paths.push(path);
      }
    }
  } catch {
    return [];
  }
  return paths;
}

function hasEntries(path: string): boolean {
  try {
    return existsSync(path) && readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

function pushJsonDiagnostic(
  diagnostics: RuntimeMigrationDiagnostic[],
  kind: RuntimeMigrationSourceKind,
  path: string,
): void {
  try {
    JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    diagnostics.push({
      severity: "error",
      kind,
      path,
      message: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

function pushJsonlDiagnostics(
  diagnostics: RuntimeMigrationDiagnostic[],
  kind: RuntimeMigrationSourceKind,
  path: string,
): void {
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n");
  } catch (err) {
    diagnostics.push({
      severity: "error",
      kind,
      path,
      message: `unreadable JSONL: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      JSON.parse(line);
    } catch (err) {
      diagnostics.push({
        severity: "error",
        kind,
        path,
        message: `invalid JSONL on line ${index + 1}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });
}

function validateRuntimeYaml(diagnostics: RuntimeMigrationDiagnostic[], paths: ReadOnlyProjectPaths): void {
  if (existsSync(paths.runtimeTopologyPath)) {
    try {
      new RuntimeTopologyStore(paths.runtimeTopologyPath).read();
    } catch (err) {
      diagnostics.push({
        severity: "error",
        kind: "runtime-topology",
        path: paths.runtimeTopologyPath,
        message: `invalid runtime topology: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  if (existsSync(paths.runtimeExchangePath)) {
    try {
      new RuntimeExchangeStore(paths.runtimeExchangePath).read();
    } catch (err) {
      diagnostics.push({
        severity: "error",
        kind: "runtime-exchange",
        path: paths.runtimeExchangePath,
        message: `invalid runtime exchange: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
}

function runtimeExchangeHasRecords(path: string): boolean {
  const exchange = new RuntimeExchangeStore(path).read();
  return [
    exchange.threads,
    exchange.messages,
    exchange.tasks,
    exchange.handoffs,
    exchange.reviews,
    exchange.waits,
    exchange.inbox,
    exchange.planRefs,
    exchange.continuityRefs,
    exchange.attachmentRefs,
  ].some((entries) => entries.length > 0);
}

function timestampForPath(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function backupFile(
  manifest: RuntimeMigrationManifest,
  kind: RuntimeMigrationSourceKind,
  source: string,
  backupDir: string,
): void {
  if (!existsSync(source)) return;
  const backup = join(backupDir, basename(source));
  copyFileSync(source, backup);
  manifest.backups.push({ kind, source, backup });
}

function copiedFileEntries(
  kind: RuntimeMigrationSourceKind,
  source: string,
  target: string,
): Array<{ kind: RuntimeMigrationSourceKind; source: string; target: string }> {
  return listNestedFiles(source, () => true).map((path) => ({
    kind,
    source: path,
    target: join(target, path.slice(source.length + 1)),
  }));
}

function copyLegacyDir(
  manifest: RuntimeMigrationManifest,
  kind: RuntimeMigrationSourceKind,
  source: string,
  target: string,
): void {
  if (!existsSync(source)) return;
  if (hasEntries(target)) return;
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, force: false });
  manifest.copiedDirs.push({ kind, source, target });
  manifest.copiedFiles.push(...copiedFileEntries(kind, source, target));
}

function legacyGlobalFiles(paths: ReadOnlyProjectPaths): {
  historyPaths: string[];
  contextPaths: string[];
  statusPaths: string[];
} {
  const globalHistoryDir = join(paths.projectStateDir, "history");
  const globalContextDir = join(paths.projectStateDir, "context");
  const globalStatusDir = join(paths.projectStateDir, "status");
  return {
    historyPaths: listFiles(globalHistoryDir, (name) => name.endsWith(".jsonl")),
    contextPaths: listNestedFiles(globalContextDir, (name) => name.endsWith(".md") || name.endsWith(".jsonl")),
    statusPaths: listFiles(globalStatusDir, (name) => name.endsWith(".md")),
  };
}

function validateImportedExchange(exchange: RuntimeExchange): void {
  const dir = mkdtempSync(join(tmpdir(), "aimux-runtime-migration-validate-"));
  try {
    new RuntimeExchangeStore(join(dir, "runtime-exchange.yaml")).write(exchange);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function rollbackManifest(manifest: RuntimeMigrationManifest): void {
  const backedSources = new Set(manifest.backups.map((backup) => backup.source));
  for (const copied of manifest.copiedFiles) {
    if (existsSync(copied.target)) {
      rmSync(copied.target, { force: true });
    }
  }
  for (const copied of manifest.copiedDirs) {
    if (!existsSync(copied.target)) continue;
    try {
      if (readdirSync(copied.target).length === 0) {
        rmSync(copied.target, { recursive: true, force: true });
      }
    } catch {}
  }
  for (const wrote of manifest.wrote) {
    if (!backedSources.has(wrote.path) && existsSync(wrote.path)) {
      rmSync(wrote.path, { force: true });
    }
  }
  for (const backup of manifest.backups) {
    mkdirSync(dirname(backup.source), { recursive: true });
    copyFileSync(backup.backup, backup.source);
  }
}

export function buildRuntimeMigrationReport(input: { cwd?: string; now?: string } = {}): RuntimeMigrationReport {
  const generatedAt = input.now ?? new Date().toISOString();
  const paths = getReadOnlyProjectPathsFor(input.cwd ?? process.cwd());
  const legacy = emptyLegacyCounts();
  const diagnostics: RuntimeMigrationDiagnostic[] = [];
  const localThreadsDir = join(paths.localAimuxDir, "threads");
  const localTasksDir = join(paths.localAimuxDir, "tasks");
  const localPlansDir = join(paths.localAimuxDir, "plans");
  const localHistoryDir = join(paths.localAimuxDir, "history");
  const localContextDir = join(paths.localAimuxDir, "context");
  const localStatusDir = join(paths.localAimuxDir, "status");
  const localAttachmentsDir = join(paths.localAimuxDir, "attachments");
  const globalRecordingsDir = join(paths.projectStateDir, "recordings");
  const globalHistoryDir = join(paths.projectStateDir, "history");
  const globalContextDir = join(paths.projectStateDir, "context");
  const globalStatusDir = join(paths.projectStateDir, "status");

  const threadFiles = listFiles(localThreadsDir, (name) => name.endsWith(".json"));
  const messageLogs = listFiles(localThreadsDir, (name) => name.endsWith(".jsonl"));
  const taskFiles = listFiles(localTasksDir, (name) => name.endsWith(".json"));
  const attachmentFiles = listFiles(localAttachmentsDir, (name) => name.endsWith(".json"));
  legacy["legacy-thread"] = threadFiles.length;
  legacy["legacy-message-log"] = messageLogs.length;
  legacy["legacy-task"] = taskFiles.length;
  legacy["legacy-plan"] = listFiles(localPlansDir, (name) => name.endsWith(".md")).length;
  legacy["legacy-history"] =
    listFiles(localHistoryDir, (name) => name.endsWith(".jsonl")).length +
    listFiles(globalHistoryDir, (name) => name.endsWith(".jsonl")).length;
  legacy["legacy-context"] =
    listNestedFiles(localContextDir, (name) => name.endsWith(".md") || name.endsWith(".jsonl")).length +
    listNestedFiles(globalContextDir, (name) => name.endsWith(".md") || name.endsWith(".jsonl")).length;
  legacy["legacy-status"] =
    listFiles(localStatusDir, (name) => name.endsWith(".md")).length +
    listFiles(globalStatusDir, (name) => name.endsWith(".md")).length;
  legacy["legacy-recording"] = listFiles(
    globalRecordingsDir,
    (name) => name.endsWith(".txt") || name.endsWith(".log"),
  ).length;
  legacy["legacy-attachment"] = attachmentFiles.length;
  legacy["runtime-topology"] = existsSync(paths.runtimeTopologyPath) ? 1 : 0;
  legacy["runtime-exchange"] = existsSync(paths.runtimeExchangePath) ? 1 : 0;
  legacy["saved-state"] = existsSync(paths.statePath) ? 1 : 0;
  legacy.metadata = existsSync(paths.metadataPath) ? 1 : 0;

  for (const path of threadFiles) pushJsonDiagnostic(diagnostics, "legacy-thread", path);
  for (const path of messageLogs) pushJsonlDiagnostics(diagnostics, "legacy-message-log", path);
  for (const path of taskFiles) pushJsonDiagnostic(diagnostics, "legacy-task", path);
  for (const path of attachmentFiles) pushJsonDiagnostic(diagnostics, "legacy-attachment", path);
  if (existsSync(paths.statePath)) pushJsonDiagnostic(diagnostics, "saved-state", paths.statePath);
  if (existsSync(paths.metadataPath)) pushJsonDiagnostic(diagnostics, "metadata", paths.metadataPath);
  validateRuntimeYaml(diagnostics, paths);

  for (const subdir of ["context", "history", "status"] as const) {
    const source = join(paths.projectStateDir, subdir);
    const target = join(paths.localAimuxDir, subdir);
    if (existsSync(source) && hasEntries(source) && hasEntries(target)) {
      diagnostics.push({
        severity: "warning",
        kind: `legacy-${subdir}` as RuntimeMigrationSourceKind,
        path: source,
        message: `legacy global ${subdir} exists but local .aimux/${subdir} is not empty; explicit import will leave it untouched`,
      });
    }
  }

  const hasErrors = diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const hasLegacy = Object.entries(legacy).some(([kind, count]) => kind.startsWith("legacy-") && count > 0);
  if (
    !hasErrors &&
    hasLegacy &&
    existsSync(paths.runtimeExchangePath) &&
    runtimeExchangeHasRecords(paths.runtimeExchangePath)
  ) {
    diagnostics.push({
      severity: "error",
      kind: "runtime-exchange",
      path: paths.runtimeExchangePath,
      message: "runtime-exchange.yaml already contains authoritative records; migration import would overwrite them",
    });
  }
  return {
    version: 1,
    generatedAt,
    status: diagnostics.some((diagnostic) => diagnostic.severity === "error")
      ? "blocked"
      : hasLegacy
        ? "needs_import"
        : "clean",
    project: {
      repoRoot: paths.repoRoot,
      projectId: paths.projectId,
      projectStateDir: paths.projectStateDir,
      localAimuxDir: paths.localAimuxDir,
    },
    authority: {
      runtimeTopologyPath: paths.runtimeTopologyPath,
      runtimeExchangePath: paths.runtimeExchangePath,
      note: "runtime-topology.yaml and runtime-exchange.yaml are authoritative; legacy files are imported only by this explicit command.",
    },
    legacy,
    diagnostics,
  };
}

export function importRuntimeMigration(input: { cwd?: string; now?: string } = {}): {
  exchange: RuntimeExchange;
  manifest: RuntimeMigrationManifest;
} {
  const generatedAt = input.now ?? new Date().toISOString();
  const report = buildRuntimeMigrationReport({ cwd: input.cwd, now: generatedAt });
  const errors = report.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    throw new Error(`runtime migration blocked by ${errors.length} diagnostic error(s)`);
  }
  const paths = getReadOnlyProjectPathsFor(input.cwd ?? process.cwd());
  const globals = legacyGlobalFiles(paths);
  const exchange = importRuntimeExchangeFromLegacyFiles({
    now: generatedAt,
    additionalHistoryPaths: globals.historyPaths,
    additionalContextPaths: globals.contextPaths,
    additionalStatusPaths: globals.statusPaths,
  });
  validateImportedExchange(exchange);

  const backupDir = join(report.project.projectStateDir, "migration-backups", timestampForPath(new Date(generatedAt)));
  const manifestPath = join(backupDir, "manifest.json");
  mkdirSync(backupDir, { recursive: true });
  const manifest: RuntimeMigrationManifest = {
    version: 1,
    generatedAt,
    report,
    backups: [],
    copiedDirs: [],
    copiedFiles: [],
    wrote: [],
  };

  try {
    backupFile(manifest, "runtime-exchange", report.authority.runtimeExchangePath, backupDir);
    for (const subdir of ["context", "history", "status"] as const) {
      copyLegacyDir(
        manifest,
        `legacy-${subdir}` as RuntimeMigrationSourceKind,
        join(report.project.projectStateDir, subdir),
        join(report.project.localAimuxDir, subdir),
      );
    }
    manifest.wrote.push({ kind: "runtime-exchange", path: report.authority.runtimeExchangePath });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    const writtenExchange = new RuntimeExchangeStore(report.authority.runtimeExchangePath).write(exchange);
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    return { exchange: writtenExchange, manifest };
  } catch (err) {
    rollbackManifest(manifest);
    throw err;
  }
}

export function rollbackRuntimeMigration(manifestPath: string): RuntimeMigrationManifest {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RuntimeMigrationManifest;
  rollbackManifest(manifest);
  return manifest;
}

export function renderRuntimeMigrationReport(report: RuntimeMigrationReport): string {
  return JSON.stringify(report, null, 2);
}

export function renderRuntimeMigrationImportResult(result: {
  exchange: RuntimeExchange;
  manifest: RuntimeMigrationManifest;
}): string {
  return JSON.stringify(
    {
      ok: true,
      manifestPath: join(
        result.manifest.report.project.projectStateDir,
        "migration-backups",
        timestampForPath(new Date(result.manifest.generatedAt)),
        "manifest.json",
      ),
      copiedDirs: result.manifest.copiedDirs,
      backups: result.manifest.backups,
      counts: {
        threads: result.exchange.threads.length,
        messages: result.exchange.messages.length,
        tasks: result.exchange.tasks.length,
        planRefs: result.exchange.planRefs.length,
        continuityRefs: result.exchange.continuityRefs.length,
        attachmentRefs: result.exchange.attachmentRefs.length,
      },
    },
    null,
    2,
  );
}

export function renderRuntimeMigrationRollbackResult(manifest: RuntimeMigrationManifest): string {
  return JSON.stringify(
    {
      ok: true,
      restored: manifest.backups,
      removedCopiedDirs: manifest.copiedDirs,
    },
    null,
    2,
  );
}
