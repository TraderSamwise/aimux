#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/shell/hooks.json", ROOT);
const AIMUX_HOME = "/tmp/aimux-shell-hooks-contract-home";

process.env.AIMUX_HOME = AIMUX_HOME;

const { getProjectStateDirFor } = await import(new URL("dist/paths.js", ROOT));
const {
  prepareShellIntegration,
  wrapCommandWithShellIntegration,
  wrapInteractiveShellWithIntegration,
} = await import(new URL("dist/shell-hooks.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function cleanHome() {
  rmSync(AIMUX_HOME, { recursive: true, force: true });
}

function readGeneratedFiles(prepared) {
  return {
    integrationScript: readFileSync(prepared.integrationScriptPath, "utf8"),
    rc: readFileSync(prepared.rcPath, "utf8"),
    ...(prepared.zshEnvPath ? { zshEnv: readFileSync(prepared.zshEnvPath, "utf8") } : {}),
  };
}

function summarizePrepared(prepared) {
  return {
    shellPath: prepared.shellPath,
    shellName: prepared.shellName,
    integrationScriptPath: prepared.integrationScriptPath,
    rcPath: prepared.rcPath,
    ...(prepared.zshEnvPath ? { zshEnvPath: prepared.zshEnvPath } : {}),
    files: readGeneratedFiles(prepared),
  };
}

function summarizeWrapped(wrapped, input) {
  const args = wrapped.args;
  const envAssignments = args.filter((arg) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg));
  const contains = {
    [`AIMUX_SESSION_ID=${input.sessionId}`]: args.includes(`AIMUX_SESSION_ID=${input.sessionId}`),
    [`AIMUX_TOOL=${input.tool}`]: args.includes(`AIMUX_TOOL=${input.tool}`),
    [`AIMUX_METADATA_ENDPOINT_FILE=${join(input.projectStateDir, "metadata-api.txt")}`]: args.includes(
      `AIMUX_METADATA_ENDPOINT_FILE=${join(input.projectStateDir, "metadata-api.txt")}`,
    ),
    [`AIMUX_SHELL_INTEGRATION_SCRIPT=${join(input.projectStateDir, "shell-integration", input.integrationFile)}`]:
      args.includes(`AIMUX_SHELL_INTEGRATION_SCRIPT=${join(input.projectStateDir, "shell-integration", input.integrationFile)}`),
    [`AIMUX_SHELL_STATE_SUPPRESS_FILE=${join(input.projectStateDir, "shell-state-suppress", input.sessionId)}`]:
      args.includes(`AIMUX_SHELL_STATE_SUPPRESS_FILE=${join(input.projectStateDir, "shell-state-suppress", input.sessionId)}`),
    [input.shellPath]: args.includes(input.shellPath),
  };
  const excludes = {
    "AIMUX_NODE_BIN=": !args.some((arg) => arg.startsWith("AIMUX_NODE_BIN=")),
    "AIMUX_CLI_ENTRY=": !args.some((arg) => arg.startsWith("AIMUX_CLI_ENTRY=")),
  };
  const realSession = `AIMUX_SESSION_ID=${input.sessionId}`;
  const spoofSession = "AIMUX_SESSION_ID=spoofed";
  const realTool = `AIMUX_TOOL=${input.tool}`;
  const spoofTool = "AIMUX_TOOL=spoofed";
  return {
    command: wrapped.command,
    firstArg: args[0],
    contains,
    excludes,
    envOrdering: {
      realSessionAfterSpoof: envAssignments.lastIndexOf(realSession) > envAssignments.indexOf(spoofSession),
      realToolAfterSpoof: envAssignments.lastIndexOf(realTool) > envAssignments.indexOf(spoofTool),
    },
    hasLoginCommandFlag: args.includes("-ic"),
    hasInteractiveFlag: args.includes("-i"),
    hasBashRcfile: args.includes("--rcfile"),
    hasZdotdir: args.includes(`ZDOTDIR=${join(input.projectStateDir, "shell-integration")}`),
    lastArg: args.at(-1),
  };
}

function runSuppressMarker(input) {
  const prepared = prepareShellIntegration(input.projectRoot, "/bin/bash");
  const suppressFile = join(input.projectStateDir, "shell-state-suppress", input.sessionId);
  mkdirSync(dirname(suppressFile), { recursive: true });
  writeFileSync(suppressFile, String(input.suppressCount));
  execFileSync(
    "/bin/bash",
    [
      "-lc",
      [
        `source '${prepared.integrationScriptPath.replace(/'/g, `'\\''`)}'`,
        `AIMUX_SESSION_ID=${input.sessionId}`,
        `AIMUX_TOOL=${input.tool}`,
        `AIMUX_SHELL_STATE_SUPPRESS_FILE='${suppressFile.replace(/'/g, `'\\''`)}'`,
        "_aimux_report_shell_state prompt",
        "_aimux_report_shell_state prompt",
      ].join("; "),
    ],
    { encoding: "utf8" },
  );
  return {
    suppressFileExists: existsSync(suppressFile),
    suppressFileContents: existsSync(suppressFile) ? readFileSync(suppressFile, "utf8") : null,
  };
}

const projectRoot = "/repo/project";
const projectStateDir = getProjectStateDirFor(projectRoot);
cleanHome();

const cases = [];
function record(name, api, input, run) {
  cleanHome();
  const enriched = { api, projectRoot, projectStateDir, ...input };
  cases.push({
    id: `shell-hooks-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/shell-hooks.test.ts",
    api,
    input: enriched,
    output: run(enriched),
    inputSha256: hash(enriched),
  });
}

record(
  "wraps generic tool launches through env and zsh shell integration",
  "wrapCommandWithShellIntegration",
  {
    sessionId: "codex-123",
    tool: "codex",
    command: "codex",
    args: ["--dangerously-bypass-approvals-and-sandbox", "it's complicated"],
    shellPath: "/bin/zsh",
    integrationFile: "aimux-zsh-integration.zsh",
    extraEnv: { CLAUDE_YOLO: "1", AIMUX_SESSION_ID: "spoofed", AIMUX_TOOL: "spoofed" },
    env: { HOME: "/home/test", PATH: "/usr/bin", TERM: "xterm-256color" },
  },
  (input) =>
    summarizeWrapped(
      wrapCommandWithShellIntegration({
        projectRoot: input.projectRoot,
        sessionId: input.sessionId,
        tool: input.tool,
        command: input.command,
        args: input.args,
        shellPath: input.shellPath,
        extraEnv: input.extraEnv,
        env: input.env,
      }),
      input,
    ),
);

record(
  "wraps interactive bash services through rcfile shell integration",
  "wrapInteractiveShellWithIntegration",
  {
    sessionId: "service-123",
    tool: "service",
    shellPath: "/bin/bash",
    integrationFile: "aimux-bash-integration.bash",
    env: { HOME: "/home/test", PATH: "/usr/bin", TERM: "xterm-256color" },
  },
  (input) =>
    summarizeWrapped(
      wrapInteractiveShellWithIntegration({
        projectRoot: input.projectRoot,
        sessionId: input.sessionId,
        tool: input.tool,
        shellPath: input.shellPath,
        env: input.env,
      }),
      input,
    ),
);

record(
  "preserves zshenv by writing a shim into the temporary ZDOTDIR",
  "prepareShellIntegration",
  {
    shellPath: "/bin/zsh",
  },
  (input) => summarizePrepared(prepareShellIntegration(input.projectRoot, input.shellPath)),
);

record(
  "decrements shell-state suppression markers before reporting prompt state",
  "suppressMarker",
  {
    sessionId: "service-1",
    tool: "service",
    suppressCount: 2,
  },
  runSuppressMarker,
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/shell-hooks.test.ts",
  generatedBy: "scripts/capture-shell-hooks-contract.mjs",
  description:
    "Shell integration argv wrapping, generated shell hook files, zshenv preservation, quoting, protected control env ordering, and suppression marker behavior captured by running TypeScript shell-hooks.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
