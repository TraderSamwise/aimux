#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Command } from "commander";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const METADATA_FIXTURE = new URL("testdata/contracts/v1/cli/metadata-command.json", ROOT);
const LOGS_FIXTURE = new URL("testdata/contracts/v1/cli/logs-command.json", ROOT);
const OUTLINE_FIXTURE = new URL("testdata/contracts/v1/cli/work-outline-command.json", ROOT);

const { PROJECT_API_ROUTES } = await import(new URL("dist/project-api-contract.js", ROOT));
const { registerMetadataCommand, serviceMetadataFromUrls } = await import(new URL("dist/cli/metadata.js", ROOT));
const { registerLogsCommand } = await import(new URL("dist/cli/logs.js", ROOT));
const { registerWorkOutlineCommand, renderWorkOutlineEntries } = await import(new URL("dist/cli/work-outline.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function record(prefix, index, source, api, name, input, output) {
  return {
    id: `${prefix}-${String(index + 1).padStart(3, "0")}`,
    name,
    source,
    api,
    input,
    output,
    inputSha256: hash(input),
  };
}

function program() {
  const command = new Command();
  command.exitOverride();
  command.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  return command;
}

async function captureConsole(run) {
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  const errors = [];
  console.log = (...args) => logs.push(args);
  console.error = (...args) => errors.push(args);
  try {
    const result = await run();
    return { result, logs, errors, exitCode: process.exitCode ?? null };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = undefined;
  }
}

const metadataCases = [];

metadataCases.push(
  record(
    "cli-metadata-command",
    metadataCases.length,
    "src/cli/metadata.test.ts",
    "serviceMetadataFromUrls",
    "maps service URLs to runtime metadata",
    { urls: ["http://localhost:3000", "https://example.com/app"], label: "web" },
    serviceMetadataFromUrls(["http://localhost:3000", "https://example.com/app"], "web"),
  ),
);

async function metadataCommand(name, args, deps) {
  const calls = { getProjectServiceEndpoint: [], postProjectServiceJson: [] };
  const output = await captureConsole(async () => {
    await programWithMetadata({
      getProjectServiceEndpoint: async () => {
        calls.getProjectServiceEndpoint.push([]);
        return { host: "127.0.0.1", port: 4321 };
      },
      postProjectServiceJson: async (path, body) => {
        calls.postProjectServiceJson.push([path, body]);
        return { ok: true };
      },
      ...deps,
    }).parseAsync(args, { from: "user" });
    return null;
  });
  metadataCases.push(
    record("cli-metadata-command", metadataCases.length, "src/cli/metadata.test.ts", "registerMetadataCommand", name, { args }, { ...output, calls }),
  );
}

function programWithMetadata(deps) {
  const command = program();
  registerMetadataCommand(command, deps);
  return command;
}

await metadataCommand("prints the metadata endpoint", ["metadata", "endpoint"]);
await metadataCommand(
  "posts set-services to the runtime metadata route",
  ["metadata", "set-services", "codex-1", "--url", "http://localhost:3000", "http://127.0.0.1:5173/", "--label", "dev"],
);
await metadataCommand(
  "rejects non-numeric progress values without posting",
  ["metadata", "set-progress", "codex-1", "one", "2"],
);

const logsCases = [];
async function logsCommand(name, args, deps = {}) {
  const calls = { selectedLogPath: [], parseLineCount: [], readLastLogLines: [], clearLogFile: [], exit: [] };
  const originalExit = process.exit;
  process.exit = ((code) => {
    calls.exit.push([code]);
    throw new Error("exit");
  });
  try {
    const output = await captureConsole(async () => {
      try {
        await programWithLogs({
          selectedLogPath: (opts) => {
            calls.selectedLogPath.push([opts]);
            return deps.selectedPath ?? "/logs/project";
          },
          parseLineCount: (value) => {
            calls.parseLineCount.push([value]);
            return deps.lineCount ?? 80;
          },
          readLastLogLines: (path, lines) => {
            calls.readLastLogLines.push([path, lines]);
            return deps.lines ?? "";
          },
          clearLogFile: (path) => {
            calls.clearLogFile.push([path]);
          },
        }).parseAsync(args, { from: "user" });
        return { threw: false };
      } catch (error) {
        return { threw: true, message: error instanceof Error ? error.message : String(error) };
      }
    });
    logsCases.push(record("cli-logs-command", logsCases.length, "src/cli/logs.test.ts", "registerLogsCommand", name, { args }, { ...output, calls }));
  } finally {
    process.exit = originalExit;
  }
}

function programWithLogs(deps) {
  const command = program();
  registerLogsCommand(command, deps);
  return command;
}

await logsCommand("prints the selected log path", ["logs", "path", "--project", "/repo"], { selectedPath: "/logs/project" });
await logsCommand("tails selected log lines", ["logs", "tail", "--daemon", "--lines", "5"], {
  selectedPath: "/logs/daemon",
  lineCount: 5,
  lines: "line one\nline two",
});
await logsCommand("clears the selected log file", ["logs", "clear"], { selectedPath: "/logs/project" });
await logsCommand("exits when there are no log entries to tail", ["logs", "tail"], { selectedPath: "/logs/missing" });

const entry = {
  entryId: "outline-1",
  topicKey: "release",
  title: "Release",
  summary: "Cut the release.",
  status: "active",
  source: "scribe",
  sessionIds: ["codex-a"],
  worktreePath: "/repo/main",
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
  lastSeenAt: "2026-08-30T00:00:00.000Z",
};

const outlineCases = [
  record(
    "cli-work-outline-command",
    0,
    "src/cli/work-outline.test.ts",
    "renderWorkOutlineEntries",
    "renders compact human-readable entries",
    { entries: [entry], empty: [] },
    { entries: renderWorkOutlineEntries([entry]), empty: renderWorkOutlineEntries([]) },
  ),
];

async function outlineCommand(name, args, deps = {}) {
  const calls = { prepareProjectContext: [], getProjectServiceJson: [], postProjectServiceJson: [] };
  const output = await captureConsole(async () => {
    await programWithOutline({
      prepareProjectContext: async (project) => {
        calls.prepareProjectContext.push([project]);
        return "/repo";
      },
      getProjectServiceJson: async (path, opts) => {
        calls.getProjectServiceJson.push([path, opts]);
        return { entries: [entry], entry };
      },
      postProjectServiceJson: async (path, body, opts) => {
        calls.postProjectServiceJson.push([path, body, opts]);
        return { entry };
      },
      ...deps,
    }).parseAsync(args, { from: "user" });
    return null;
  });
  outlineCases.push(
    record("cli-work-outline-command", outlineCases.length, "src/cli/work-outline.test.ts", "registerWorkOutlineCommand", name, { args }, { ...output, calls }),
  );
}

function programWithOutline(deps) {
  const command = program();
  registerWorkOutlineCommand(command, deps);
  return command;
}

await outlineCommand("lists through the project service with filters", [
  "outline",
  "list",
  "--project",
  "/repo",
  "--session",
  "codex-a",
  "--worktree",
  "/repo/main",
  "--status",
  "active",
  "--search",
  "release",
  "--limit",
  "25",
]);
await outlineCommand("shows one entry by id", ["outline", "show", "outline-1"]);
await outlineCommand("updates through the project service", [
  "outline",
  "update",
  "--title",
  "Release",
  "--summary",
  "Cut the release.",
  "--topic-key",
  "release",
  "--session",
  "codex-a",
  "--worktree",
  "/repo/main",
  "--source",
  "scribe",
]);

await writeContractJson(METADATA_FIXTURE, {
  version: 1,
  source: "src/cli/metadata.test.ts",
  generatedBy: "scripts/capture-cli-wrapper-contracts.mjs",
  description:
    "Metadata CLI endpoint printing, service URL mapping, set-services posting, and non-numeric progress rejection captured by running TypeScript registerMetadataCommand with recorded dependencies.",
  cases: metadataCases,
});
await writeContractJson(LOGS_FIXTURE, {
  version: 1,
  source: "src/cli/logs.test.ts",
  generatedBy: "scripts/capture-cli-wrapper-contracts.mjs",
  description:
    "Logs CLI path/tail/clear/empty-tail console output and dependency calls captured by running TypeScript registerLogsCommand with recorded dependencies.",
  cases: logsCases,
});
await writeContractJson(OUTLINE_FIXTURE, {
  version: 1,
  source: "src/cli/work-outline.test.ts",
  generatedBy: "scripts/capture-cli-wrapper-contracts.mjs",
  description:
    "Work outline CLI rendering, list/show query construction, and update posting captured by running TypeScript registerWorkOutlineCommand with recorded dependencies.",
  cases: outlineCases,
});

console.log(`${METADATA_FIXTURE.pathname}: ${metadataCases.length} cases`);
console.log(`${LOGS_FIXTURE.pathname}: ${logsCases.length} cases`);
console.log(`${OUTLINE_FIXTURE.pathname}: ${outlineCases.length} cases`);
