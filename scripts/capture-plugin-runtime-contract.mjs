#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/plugin/runtime.json", ROOT);
const plugin = await import(new URL("dist/plugin-runtime.js", ROOT));
const paths = await import(new URL("dist/paths.js", ROOT));
const { deriveAlertFromAgentEvent, ensureBundledDefaultPluginWrappers, PluginRuntime } = plugin;
const { initPaths } = paths;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function normalizePath(path, root) {
  if (path === root) return "<root>";
  if (path.startsWith(`${root}/`)) return `<root>/${path.slice(root.length + 1)}`;
  return path;
}

function normalizeStatus(status, root) {
  return { ...status, path: status.path ? normalizePath(status.path, root) : status.path };
}

const cases = [];
function record(name, api, input, output) {
  cases.push({
    id: `plugin-runtime-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/plugin-runtime.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}

for (const input of [
  {
    sessionId: "claude-1",
    event: { kind: "needs_input", message: "Ready for input", source: "claude", tone: "warn" },
  },
  { sessionId: "claude-1", event: { kind: "response", message: "Here is the answer" } },
  { sessionId: "claude-1", event: { kind: "notify", message: "Tool error", tone: "error" } },
  { sessionId: "codex-1", event: { kind: "notify", message: "Build complete", tone: "info" } },
]) {
  record(
    input.event.kind === "needs_input"
      ? "maps direct-chat needs_input into a semantic alert"
      : input.event.kind === "response"
        ? "does not alert on plain response events"
        : input.event.tone === "error"
          ? "maps error notifications to task_failed alerts"
          : "maps generic notifications to notification alerts",
    "deriveAlertFromAgentEvent",
    input,
    deriveAlertFromAgentEvent(input.sessionId, input.event) ?? null,
  );
}

record(
  "seeds the bundled wrappers once without overwriting user files",
  "ensureBundledDefaultPluginWrappers",
  {},
  (() => {
    const root = mkdtempSync(join(tmpdir(), "aimux-plugin-runtime-contract-"));
    try {
      ensureBundledDefaultPluginWrappers(root);
      const wrapperPath = join(root, "plugins", "gh-pr-context.js");
      const transcriptWrapperPath = join(root, "plugins", "transcript-length.js");
      const manifestPath = join(root, "plugins", ".bundled-default-plugins.json");
      const custom = "export default function custom() {}\n";
      writeFileSync(wrapperPath, custom);
      ensureBundledDefaultPluginWrappers(root);
      return {
        wrapperContainsGithubFactory: readFileSync(wrapperPath, "utf-8").includes("createGithubPrContextPlugin"),
        transcriptWrapperContainsDefaultExport: readFileSync(transcriptWrapperPath, "utf-8").includes("export default"),
        manifestContainsGithub: readFileSync(manifestPath, "utf-8").includes("gh-pr-context"),
        manifestContainsTranscriptLength: readFileSync(manifestPath, "utf-8").includes("transcript-length"),
        customPreservedAfterSecondSeed: readFileSync(wrapperPath, "utf-8") === custom,
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  })(),
);

record(
  "treats deletion after initial seed as intentional",
  "ensureBundledDefaultPluginWrappers",
  {},
  (() => {
    const root = mkdtempSync(join(tmpdir(), "aimux-plugin-runtime-delete-contract-"));
    try {
      ensureBundledDefaultPluginWrappers(root);
      const wrapperPath = join(root, "plugins", "gh-pr-context.js");
      const transcriptWrapperPath = join(root, "plugins", "transcript-length.js");
      rmSync(wrapperPath, { force: true });
      rmSync(transcriptWrapperPath, { force: true });
      ensureBundledDefaultPluginWrappers(root);
      return {
        wrapperExistsAfterDelete: existsSync(wrapperPath),
        transcriptWrapperExistsAfterDelete: existsSync(transcriptWrapperPath),
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  })(),
);

async function withPluginProject(label, callback) {
  const previousHome = process.env.AIMUX_HOME;
  const root = mkdtempSync(join(tmpdir(), `aimux-plugin-runtime-${label}-contract-`));
  const repoRoot = join(root, "repo");
  const aimuxHome = join(root, "home");
  process.env.AIMUX_HOME = aimuxHome;
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  mkdirSync(join(aimuxHome, "plugins"), { recursive: true });
  try {
    await initPaths(repoRoot);
    return await callback({ root, repoRoot, aimuxHome, pluginDir: join(aimuxHome, "plugins") });
  } finally {
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    delete globalThis.__aimuxFailedPluginStopped;
    rmSync(root, { recursive: true, force: true });
  }
}

record(
  "stops and reports a plugin that fails during startup with resource exhaustion",
  "PluginRuntime.start",
  {},
  await withPluginProject("failed-start", async ({ root, pluginDir }) => {
    const pluginPath = join(pluginDir, "emfile-plugin.js");
    writeFileSync(
      pluginPath,
      [
        "export default function plugin() {",
        "  return {",
        "    start() {",
        "      const error = new Error('EMFILE: too many open files, watch');",
        "      error.code = 'EMFILE';",
        "      throw error;",
        "    },",
        "    stop() {",
        "      globalThis.__aimuxFailedPluginStopped = (globalThis.__aimuxFailedPluginStopped || 0) + 1;",
        "    }",
        "  };",
        "}",
        "",
      ].join("\n"),
    );
    const runtime = new PluginRuntime({ host: "127.0.0.1", port: 43190, pid: process.pid, updatedAt: new Date().toISOString() });
    await runtime.start();
    const statuses = runtime.getPluginStatuses().map((status) => normalizeStatus(status, root));
    await runtime.stop();
    return { statuses, stoppedCount: globalThis.__aimuxFailedPluginStopped };
  }),
);

record(
  "reports invalid user plugin module shapes as failed statuses",
  "PluginRuntime.start",
  {},
  await withPluginProject("invalid-shape", async ({ root, pluginDir }) => {
    writeFileSync(join(pluginDir, "no-default.js"), "export const plugin = true;\n");
    writeFileSync(join(pluginDir, "no-instance.js"), "export default function plugin() {}\n");
    const runtime = new PluginRuntime({ host: "127.0.0.1", port: 43190, pid: process.pid, updatedAt: new Date().toISOString() });
    await runtime.start();
    const statuses = runtime.getPluginStatuses().map((status) => normalizeStatus(status, root));
    await runtime.stop();
    return { statuses };
  }),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/plugin-runtime.test.ts",
  generatedBy: "scripts/capture-plugin-runtime-contract.mjs",
  description: "Plugin alert derivation, bundled wrapper seeding/deletion, failed-start cleanup, and invalid module shape reporting captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
