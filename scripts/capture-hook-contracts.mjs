#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/hooks/tool-hooks.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const recordCase = (index, name, source, api, input, output) => ({
  id: `tool-hooks-${String(index + 1).padStart(3, "0")}`,
  name,
  source,
  api,
  input,
  output,
  inputSha256: hash(input),
});

const claude = await import(new URL("dist/claude-hooks.js", ROOT));
const codex = await import(new URL("dist/codex-hooks.js", ROOT));

function normalizePaths(value, tempRoot) {
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested === "string" && tempRoot && nested.includes(tempRoot)) {
        return nested
          .replaceAll(tempRoot, "<temp>")
          .replace(/aimux-hook-claude(?:-settings)?-[A-Za-z0-9]+-[0-9a-f]{12}/g, "<project-id>")
          .replace(/aimux-hook-codex-[A-Za-z0-9]+/g, "<codex-home>");
      }
      if (typeof nested === "string") {
        return nested
          .replace(/aimux-hook-claude(?:-settings)?-[A-Za-z0-9]+-[0-9a-f]{12}/g, "<project-id>")
          .replace(/aimux-hook-codex-[A-Za-z0-9]+/g, "<codex-home>");
      }
      return nested;
    }),
  );
}

const cases = [];
const add = (name, source, api, input, output) => cases.push(recordCase(cases.length, name, source, api, input, output));

{
  const projectRoot = mkdtempSync(join(tmpdir(), "aimux-hook-claude-settings-"));
  const previousHome = process.env.AIMUX_HOME;
  process.env.AIMUX_HOME = join(projectRoot, "aimux-home");
  try {
    add(
      "builds the supported Claude hook set",
      "src/claude-hooks.test.ts",
      "buildClaudeHookSettings",
      { sessionId: "claude-abc123", projectRoot: "<temp>" },
      normalizePaths(
        JSON.parse(claude.buildClaudeHookSettings({ sessionId: "claude-abc123", projectRoot })),
        projectRoot,
      ),
    );
  } finally {
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(projectRoot, { recursive: true, force: true });
  }
}
for (const decision of ["allow_once", "allow_always", "deny", undefined, "weird"]) {
  add(
    "maps registry decisions to PermissionRequest hook output",
    "src/claude-hooks.test.ts",
    "permissionRequestHookOutput",
    { decision },
    claude.permissionRequestHookOutput(decision),
  );
}
for (const payload of [
  { tool_name: "Bash", tool_input: { command: "rm -rf build" } },
  { tool_name: "Read", tool_input: { file_path: "/a/b.ts" } },
  {},
  { tool_name: "Bash", tool_input: { command: "x".repeat(500) } },
]) {
  add(
    "summarizes a Claude permission request payload",
    "src/claude-hooks.test.ts",
    "summarizeClaudePermissionRequest",
    { payload },
    claude.summarizeClaudePermissionRequest(payload),
  );
}
for (const args of [["--resume"], ["--continue"], ["hello"], ["--resume", "abc", "--fork-session"]]) {
  add(
    "detects Claude args that skip session id injection",
    "src/claude-hooks.test.ts",
    "shouldSkipClaudeSessionIdInjection",
    { args },
    claude.shouldSkipClaudeSessionIdInjection(args),
  );
}
for (const args of [
  ["--resume", "backend-123"],
  ["--resume=backend-456"],
  ["--session-id", "backend-789"],
  ["--resume", "--dangerously-skip-permissions"],
  ["--resume"],
  ["--resume", "0f0e2b1a-1111-2222-3333-444455556666", "--fork-session"],
]) {
  add(
    "extracts explicit backend ids from Claude args",
    "src/claude-hooks.test.ts",
    "extractClaudeBackendSessionIdFromArgs",
    { args },
    claude.extractClaudeBackendSessionIdFromArgs(args) ?? null,
  );
  add("detects Claude fork-style launch args", "src/claude-hooks.test.ts", "isClaudeForkStyleLaunch", { args }, claude.isClaudeForkStyleLaunch(args));
}
{
  const projectRoot = mkdtempSync(join(tmpdir(), "aimux-hook-claude-"));
  const previousHome = process.env.AIMUX_HOME;
  process.env.AIMUX_HOME = join(projectRoot, "aimux-home");
  try {
    const args = claude.injectClaudeHookArgs(["hello"], {
      sessionId: "claude-abc123",
      projectRoot,
      backendSessionId: "backend-123",
    });
    const settings = JSON.parse(readFileSync(args[3], "utf-8"));
    add(
      "injects Claude settings and backend session id when allowed",
      "src/claude-hooks.test.ts",
      "injectClaudeHookArgs",
      { args: ["hello"], sessionId: "claude-abc123", backendSessionId: "backend-123" },
      normalizePaths({ args, settings }, projectRoot),
    );
  } finally {
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

add("builds Codex project-service hook command", "src/codex-hooks.test.ts", "buildCodexHookCommand", { action: "permission-request" }, codex.buildCodexHookCommand("permission-request"));
add("builds Codex launch hook args", "src/codex-hooks.test.ts", "codexLaunchHookArgs", {}, codex.codexLaunchHookArgs());
for (const command of [
  "curl http://127.0.0.1:1/hooks/codex?action=stop",
  "aimux codex-hook stop --project /tmp/repo",
  "cmux hooks codex stop",
  "my-own-thing.sh",
  undefined,
]) {
  add("detects aimux-owned Codex hook commands", "src/codex-hooks.test.ts", "isAimuxOwnedCodexHookCommand", { command }, codex.isAimuxOwnedCodexHookCommand(command));
}
for (const existing of [
  {},
  { hooks: { Stop: [{ hooks: [{ type: "command", command: "cmux hooks codex stop", timeout: 5000 }] }] } },
  { hooks: { Stop: [{ hooks: [{ type: "command", command: "aimux codex-hook stop --project /tmp/repo" }] }] } },
  { version: 1 },
]) {
  add("merges Codex hooks without clobbering foreign entries", "src/codex-hooks.test.ts", "mergeCodexHooks", { existing }, codex.mergeCodexHooks(existing));
}
{
  const dir = mkdtempSync(join(tmpdir(), "aimux-hook-codex-"));
  try {
    const first = codex.installCodexHooks({ codexHome: dir });
    const second = codex.installCodexHooks({ codexHome: dir });
    const written = JSON.parse(readFileSync(codex.codexHooksPath(dir), "utf8"));
    add(
      "installs Codex hooks and no-ops on second run",
      "src/codex-hooks.test.ts",
      "installCodexHooks",
      { existing: null },
      normalizePaths({ first, second, written }, dir),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = mkdtempSync(join(tmpdir(), "aimux-hook-codex-"));
  try {
    const path = codex.codexHooksPath(dir);
    writeFileSync(path, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "cmux hooks codex stop" }] }] } }));
    const result = codex.installCodexHooks({ codexHome: dir });
    const written = JSON.parse(readFileSync(path, "utf8"));
    add(
      "installs Codex hooks over foreign hooks without clobbering",
      "src/codex-hooks.test.ts",
      "installCodexHooks",
      { existing: { hooks: { Stop: [{ hooks: [{ type: "command", command: "cmux hooks codex stop" }] }] } } },
      normalizePaths({ result, written }, dir),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = mkdtempSync(join(tmpdir(), "aimux-hook-codex-"));
  try {
    const path = codex.codexHooksPath(dir);
    writeFileSync(path, "not json");
    let output;
    try {
      codex.installCodexHooks({ codexHome: dir });
      output = { ok: true, afterRaw: readFileSync(path, "utf8") };
    } catch (error) {
      output = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        afterRaw: readFileSync(path, "utf8"),
      };
    }
    add(
      "throws on a non-JSON Codex hooks file rather than clobbering it",
      "src/codex-hooks.test.ts",
      "installCodexHooks",
      { existingRaw: "not json" },
      normalizePaths(output, dir),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
for (const raw of ['{"session_id":"abc","tool_name":"Bash"}', "nope"]) {
  add("parses Codex hook payloads", "src/codex-hooks.test.ts", "parseCodexHookPayload", { raw }, codex.parseCodexHookPayload(raw));
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/claude-hooks.test.ts + src/codex-hooks.test.ts",
  generatedBy: "scripts/capture-hook-contracts.mjs",
  description: "Claude and Codex hook command, merge/install, permission, args, and payload contracts captured by running TypeScript hook helpers.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
