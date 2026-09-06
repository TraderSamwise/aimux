#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import prettier from "prettier";
import ts from "typescript";

const ROOT = new URL("../", import.meta.url);
const SOURCE_PATH = new URL("src/tmux/control-script.test.ts", ROOT);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/control-script.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function recorderPrelude() {
  return String.raw`
const __captureCases = [];
let __currentCase = null;
const vi = { setConfig() {} };
const __afterEach = [];
function afterEach(fn) {
  __afterEach.push(fn);
}
function describe(_name, fn) {
  fn();
}
function __runExpectation(value) {
  if (typeof value === "function") value();
}
function expect(value) {
  const api = {
    toBe() {},
    toEqual() {},
    toContain() {},
    toHaveLength() {},
    toMatchObject() {},
    toBeTruthy() {},
    toBeFalsy() {},
    toBeDefined() {},
    toBeUndefined() {},
    toThrow() {
      __runExpectation(value);
    },
  };
  api.not = {
    toBe() {},
    toEqual() {},
    toContain() {},
    toHaveLength() {},
    toMatchObject() {},
    toBeTruthy() {},
    toBeFalsy() {},
    toBeDefined() {},
    toBeUndefined() {},
    toThrow() {
      __runExpectation(value);
    },
  };
  return api;
}
function __readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
function __readJsonLines(path) {
  const text = __readText(path);
  if (!text) return [];
  return text.trim().split("\n").filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return line;
    }
  });
}
function __listFiles(root, base = root, output = {}) {
  if (!existsSync(root)) return output;
  for (const entry of readdirSync(root).sort()) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      __listFiles(path, base, output);
    } else {
      output[relative(base, path)] = readFileSync(path, "utf8");
    }
  }
  return output;
}
function __listRootFiles(root) {
  const output = {};
  if (!existsSync(root)) return output;
  const ignored = new Set(["bin", "project", "tmux-state.json", "tmux-log.jsonl", "curl-log.jsonl", "aimux-log.txt"]);
  for (const entry of readdirSync(root).sort()) {
    if (ignored.has(entry)) continue;
    const path = join(root, entry);
    if (statSync(path).isFile()) output[entry] = readFileSync(path, "utf8");
  }
  return output;
}
function __snapshotRoot(root) {
  return {
    root,
    tmuxLog: __readJsonLines(join(root, "tmux-log.jsonl")),
    curlLog: __readText(join(root, "curl-log.jsonl"))?.trim().split("\n").filter(Boolean) ?? [],
    aimuxLog: __readText(join(root, "aimux-log.txt"))?.trim().split("\n").filter(Boolean) ?? [],
    state: (() => {
      const text = __readText(join(root, "tmux-state.json"));
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    })(),
    rootFiles: __listRootFiles(root),
    projectFiles: __listFiles(join(root, "project")),
  };
}
function __normalize(value, roots) {
  const replacements = [
    [process.cwd(), "<repo>"],
    ...roots.map((root, index) => [root, "<temp" + (index + 1) + ">"]),
  ].flatMap(([from, to]) => [
    [from, to],
    [encodeURIComponent(from), encodeURIComponent(to)],
  ]);
  return JSON.parse(JSON.stringify(value, (_key, nested) => {
    if (typeof nested !== "string") return nested;
    const text = replacements.reduce((text, [from, to]) => text.split(from).join(to), nested);
    return text.replace(/(?:\/private)?\/var\/folders\/[^'"\s]+\/T\/tmp\.[A-Za-z0-9]+/g, "<tempfile>");
  }));
}
function execFileSync(command, args = [], options = {}) {
  const statePath = options.env?.TMUX_FAKE_STATE;
  const root = typeof statePath === "string" ? statePath.slice(0, statePath.lastIndexOf("/")) : null;
  const call = {
    command,
    args,
    cwd: options.cwd ?? process.cwd(),
    env: {
      AIMUX_BIN: options.env?.AIMUX_BIN,
      PATH: options.env?.PATH ? "<path>" : undefined,
      TMUX_FAKE_CURL_EXIT: options.env?.TMUX_FAKE_CURL_EXIT,
      TMUX_FAKE_DISPLAY_MENU_EXIT: options.env?.TMUX_FAKE_DISPLAY_MENU_EXIT,
      TMUX_FAKE_DISPLAY_POPUP_EXIT: options.env?.TMUX_FAKE_DISPLAY_POPUP_EXIT,
      TMUX_FAKE_DISPLAY_POPUP_RUN_COMMAND: options.env?.TMUX_FAKE_DISPLAY_POPUP_RUN_COMMAND,
      TMUX_FAKE_NC_EXIT: options.env?.TMUX_FAKE_NC_EXIT,
      TMUX_FAKE_NC_SELECTION: options.env?.TMUX_FAKE_NC_SELECTION,
      TMUX_FAKE_NC_STATUS: options.env?.TMUX_FAKE_NC_STATUS,
      TMUX_FAKE_NC_STATUS_SEQUENCE_FILE: options.env?.TMUX_FAKE_NC_STATUS_SEQUENCE_FILE,
      TMUX_FAKE_OPEN_DASHBOARD_RESPONSE: options.env?.TMUX_FAKE_OPEN_DASHBOARD_RESPONSE,
      TMUX_FAKE_SWITCHABLE_RESPONSE: options.env?.TMUX_FAKE_SWITCHABLE_RESPONSE,
    },
    beforeRoot: root ? __snapshotRoot(root) : null,
  };
  try {
    const stdout = __execFileSync(command, args, options);
    call.status = 0;
    call.stdout = stdout;
    __currentCase?.execCalls.push(call);
    return stdout;
  } catch (error) {
    call.status = error.status ?? null;
    call.stdout = error.stdout?.toString?.() ?? "";
    call.stderr = error.stderr?.toString?.() ?? "";
    __currentCase?.execCalls.push(call);
    throw error;
  }
}
function it(name, fn) {
  const id = "tmux-control-script-" + String(__captureCases.length + 1).padStart(3, "0");
  const record = { id, name, source: "src/tmux/control-script.test.ts", api: "scripts/tmux-control.sh", execCalls: [] };
  __currentCase = record;
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = { name: error?.name ?? "Error", message: String(error?.message ?? error), status: error?.status ?? null };
  }
  const roots = [...tempRoots];
  record.output = {
    thrown,
    roots: roots.map(__snapshotRoot),
  };
  record.input = {
    name,
    execCalls: record.execCalls,
  };
  record.inputSha256 = __captureHash(__normalize(record.input, roots));
  __captureCases.push(__normalize(record, roots));
  __currentCase = null;
  for (const cleanup of __afterEach) cleanup();
}
`;
}

function buildSource() {
  let source = readFileSync(SOURCE_PATH, "utf8");
  source = source.replace(
    'import { execFileSync } from "node:child_process";',
    'import { execFileSync as __execFileSync } from "node:child_process";',
  );
  source = source.replace(
    'import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
    'import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";',
  );
  source = source.replace('import { join } from "node:path";', 'import { join, relative } from "node:path";');
  source = source.replace(
    'import { afterEach, describe, expect, it, vi } from "vitest";',
    `import { createHash } from "node:crypto";\n${recorderPrelude()}\nconst __captureHash = ${hash.toString()};`,
  );
  source += "\nglobalThis.__AIMUX_TMUX_CONTROL_SCRIPT_CONTRACT__ = __captureCases;\n";
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
    fileName: SOURCE_PATH.pathname,
  }).outputText;
}

const temp = mkdtempSync(join(tmpdir(), "aimux-capture-tmux-control-"));
try {
  const modulePath = join(temp, "control-script-contract.mjs");
  writeFileSync(modulePath, buildSource());
  await import(pathToFileURL(modulePath).href);
  const cases = globalThis.__AIMUX_TMUX_CONTROL_SCRIPT_CONTRACT__ ?? [];
  await writeContractJson(FIXTURE_PATH, {
    version: 1,
    generatedAt: "2026-09-06T00:00:00.000Z",
    source: "src/tmux/control-script.test.ts",
    subject: "scripts/tmux-control.sh",
    caseCount: cases.length,
    description:
      "tmux control script behavior captured by running the TypeScript test scenarios against the shell script with fake tmux, curl, nc, and aimux binaries.",
    cases,
  });
  console.log(`wrote ${FIXTURE_PATH.pathname} (${cases.length} cases)`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
