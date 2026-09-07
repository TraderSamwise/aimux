#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/tool-picker.json", ROOT);
const {
  buildToolPickerOverlayOutput,
  defaultsLaunchOverride,
  formatEnvDefaults,
  runSelectedTool,
  showToolPicker,
} = await import(new URL("dist/multiplexer/tool-picker.js", ROOT));
const { getGlobalConfigPath, initPaths } = await import(new URL("dist/paths.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function run(input) {
  switch (input.api) {
    case "formatEnvDefaults":
      return formatEnvDefaults(input.env);
    case "defaultsLaunchOverride":
      return defaultsLaunchOverride({ command: "claude", args: ["--base"], enabled: true, ...input.tool }) ?? null;
    case "runSelectedTool":
      return withTempPaths(input, () => runSelectedToolCase(input));
    case "showToolPicker":
      return withTempPaths(input, () => showToolPickerCase(input));
    case "buildToolPickerOverlayOutput":
      return withTempPaths(input, () => buildToolPickerOverlayOutput(input.host ?? {}, input.cols ?? 80, input.rows ?? 24));
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

async function withTempPaths(input, callback) {
  const root = mkdtempSync(join(tmpdir(), "aimux-tool-picker-contract-"));
  const previous = {
    cwd: process.cwd(),
    home: process.env.AIMUX_HOME,
  };
  try {
    process.env.AIMUX_HOME = join(root, "home");
    process.chdir(root);
    await initPaths(root);
    writeFileSync(
      getGlobalConfigPath(),
      JSON.stringify({
        tools: input.configTools ?? {
          claude: { command: "claude", args: ["--base"], enabled: true },
          codex: { command: "codex", args: ["--base"], enabled: true },
        },
      }),
    );
    return callback();
  } finally {
    process.chdir(previous.cwd);
    if (previous.home === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previous.home;
    rmSync(root, { recursive: true, force: true });
  }
}

function recorder() {
  const calls = {};
  const fn = (name, impl = () => undefined) => {
    calls[name] = [];
    return (...args) => {
      calls[name].push(args);
      return impl(...args);
    };
  };
  return { calls, fn };
}

function baseHost(input, calls, fn) {
  return {
    pickerMode: input.pickerMode ?? "create",
    forkSourceSessionId: input.forkSourceSessionId ?? null,
    switchToolSourceSessionId: input.switchToolSourceSessionId ?? null,
    toolPickerOverseer: input.toolPickerOverseer ?? false,
    toolPickerScribe: input.toolPickerScribe ?? false,
    launchOptionsState: input.launchOptionsState ?? null,
    startedInDashboard: false,
    mode: input.mode ?? "session",
    dashboardState: { focusedWorktreePath: input.focusedWorktreePath },
    generateDashboardSessionId: fn("generateDashboardSessionId", (command) => `${command}-generated`),
    switchAgentTool: fn("switchAgentTool"),
    forkAgent: fn("forkAgent"),
    createSession: fn("createSession", (_command, _args, _preambleFlag, _toolKey, _unused, _sessionIdFlag, _wtPath, _u2, sessionId) => ({
      id: sessionId,
    })),
    showDashboardError: fn("showDashboardError"),
    openDashboardOverlay: fn("openDashboardOverlay"),
    redrawDashboardWithOverlay: fn("redrawDashboardWithOverlay"),
    getViewportSize: fn("getViewportSize", () => ({ cols: 80, rows: 24 })),
    clearDashboardOverlay: fn("clearDashboardOverlay"),
    restoreDashboardAfterOverlayDismiss: fn("restoreDashboardAfterOverlayDismiss"),
  };
}

function hostSnapshot(host, calls) {
  return {
    pickerMode: host.pickerMode,
    forkSourceSessionId: host.forkSourceSessionId,
    switchToolSourceSessionId: host.switchToolSourceSessionId,
    toolPickerOverseer: host.toolPickerOverseer,
    toolPickerScribe: host.toolPickerScribe,
    toolPickerIndex: host.toolPickerIndex,
    launchOptionsState: host.launchOptionsState,
    calls,
  };
}

function runSelectedToolCase(input) {
  const { calls, fn } = recorder();
  const host = baseHost(input.host ?? {}, calls, fn);
  runSelectedTool(host, input.toolKey, input.tool, input.options ?? {});
  return hostSnapshot(host, calls);
}

function showToolPickerCase(input) {
  const { calls, fn } = recorder();
  const host = baseHost(input.host ?? {}, calls, fn);
  showToolPicker(host, input.sourceSessionId, input.options);
  return hostSnapshot(host, calls);
}

const inputs = [
  {
    name: "formats undefined env defaults as empty",
    api: "formatEnvDefaults",
  },
  {
    name: "renders env defaults and quotes values with spaces",
    api: "formatEnvDefaults",
    env: { A: "1", MSG: "hello world" },
  },
  {
    name: "omits launch override when no defaults are configured",
    api: "defaultsLaunchOverride",
    tool: {},
  },
  {
    name: "omits launch override for empty default args and env",
    api: "defaultsLaunchOverride",
    tool: { defaultArgs: [], defaultEnv: {} },
  },
  {
    name: "appends default args after base args",
    api: "defaultsLaunchOverride",
    tool: { defaultArgs: ["--model", "opus"] },
  },
  {
    name: "carries default env through",
    api: "defaultsLaunchOverride",
    tool: { defaultEnv: { CLAUDE_YOLO: "1" } },
  },
  {
    name: "combines default args and env",
    api: "defaultsLaunchOverride",
    tool: { defaultArgs: ["--model", "opus"], defaultEnv: { FOO: "bar" } },
  },
  {
    name: "switches selected tool and resets switch picker state",
    api: "runSelectedTool",
    host: {
      pickerMode: "switch-tool",
      switchToolSourceSessionId: "claude-1",
      forkSourceSessionId: "stale-fork",
      launchOptionsState: { stale: true },
    },
    toolKey: "codex",
    tool: { command: "codex", args: ["--base"], enabled: true },
  },
  {
    name: "reports an error when switch source is missing",
    api: "runSelectedTool",
    host: { pickerMode: "switch-tool", switchToolSourceSessionId: null },
    toolKey: "codex",
    tool: { command: "codex", args: ["--base"], enabled: true },
  },
  {
    name: "forks from the selected source session with launch defaults",
    api: "runSelectedTool",
    host: { pickerMode: "fork", forkSourceSessionId: "claude-1", focusedWorktreePath: "/repo/worktrees/a" },
    toolKey: "codex",
    tool: { command: "codex", args: ["--base"], enabled: true, defaultArgs: ["--model", "gpt-5"] },
  },
  {
    name: "creates a plain session with explicit launch override env",
    api: "runSelectedTool",
    host: { pickerMode: "create" },
    toolKey: "claude",
    tool: { command: "claude", args: ["--base"], enabled: true, preambleFlag: "--preamble", sessionIdFlag: "--session" },
    options: { override: { command: "claude", args: ["--base", "--debug"], env: { FOO: "bar" } } },
  },
  {
    name: "opens switch picker mode without carrying fork state",
    api: "showToolPicker",
    sourceSessionId: "claude-1",
    options: { mode: "switch-tool" },
    host: {
      pickerMode: "fork",
      forkSourceSessionId: "claude-old",
      switchToolSourceSessionId: null,
      toolPickerOverseer: true,
      launchOptionsState: { stale: true },
    },
  },
  {
    name: "renders a tool picker overlay with enabled tools and options hint",
    api: "buildToolPickerOverlayOutput",
    host: { pickerMode: "create", toolPickerIndex: 0 },
    cols: 80,
    rows: 24,
  },
  {
    name: "explains the empty state when no tools are enabled",
    api: "buildToolPickerOverlayOutput",
    configTools: {
      claude: { command: "claude", args: ["--base"], enabled: false },
      codex: { command: "codex", args: ["--base"], enabled: false },
      aider: { command: "aider", args: [], enabled: false },
    },
    host: { pickerMode: "create" },
    cols: 80,
    rows: 24,
  },
  {
    name: "renders the switch source in the tool picker title",
    api: "buildToolPickerOverlayOutput",
    host: { pickerMode: "switch-tool", switchToolSourceSessionId: "claude-1" },
    cols: 80,
    rows: 24,
  },
];

const cases = [];
for (const [index, input] of inputs.entries()) {
  cases.push({
    id: `tool-picker-${String(index + 1).padStart(3, "0")}`,
    name: input.name,
    source: "src/multiplexer/tool-picker.test.ts",
    api: input.api,
    input,
    output: await run(input),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/tool-picker.test.ts",
  generatedBy: "scripts/capture-tool-picker-contract.mjs",
  description:
    "Tool picker default environment formatting, launch override, picker mode, and non-dashboard launch dispatch contracts captured by running TypeScript tool-picker helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
