#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-state/atomic-write.json", ROOT);
const atomic = await import(new URL("dist/atomic-write.js", ROOT));
const { atomicWrite, quarantineCorruptFile, writeJsonAtomic, writeTextAtomic } = atomic;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const cases = [];
function normalizeCorruptName(name) {
  return typeof name === "string" ? name.replace(/\.corrupt-\d+$/, ".corrupt-<ts:1>") : name;
}
function record(name, api, input, output) {
  cases.push({
    id: `runtime-state-atomic-write-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/atomic-write.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}
function withDir(callback) {
  const dir = mkdtempSync(join(tmpdir(), "aimux-atomic-contract-"));
  try {
    return callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

record("writes content and leaves no temp files behind", "atomicWrite", { path: "nested/file.txt", data: "hello" }, withDir((dir) => {
  const target = join(dir, "nested", "file.txt");
  atomicWrite(target, "hello");
  return {
    content: readFileSync(target, "utf8"),
    tempFiles: readdirSync(join(dir, "nested")).filter((name) => name.includes(".tmp")),
  };
}));
record("writeJsonAtomic round-trips with a trailing newline", "writeJsonAtomic", { path: "state.json", value: { a: 1, b: ["x"] } }, withDir((dir) => {
  const target = join(dir, "state.json");
  writeJsonAtomic(target, { a: 1, b: ["x"] });
  const raw = readFileSync(target, "utf8");
  return { endsWithNewline: raw.endsWith("\n"), parsed: JSON.parse(raw) };
}));
record("writeTextAtomic writes bytes verbatim without appending a newline", "writeTextAtomic", { path: "endpoint.txt", text: "http://127.0.0.1:43190\n" }, withDir((dir) => {
  const target = join(dir, "endpoint.txt");
  writeTextAtomic(target, "http://127.0.0.1:43190\n");
  return readFileSync(target, "utf8");
}));
record("honors an explicit file mode", "atomicWriteMode", { path: "auth.json", data: "{}", mode: 384 }, withDir((dir) => {
  const target = join(dir, "auth.json");
  atomicWrite(target, "{}", { mode: 0o600 });
  return { mode: statSync(target).mode & 0o777 };
}));
record("overwrites an existing file atomically", "overwriteJsonAtomic", { path: "f.json", values: [{ v: 1 }, { v: 2 }] }, withDir((dir) => {
  const target = join(dir, "f.json");
  writeJsonAtomic(target, { v: 1 });
  writeJsonAtomic(target, { v: 2 });
  return { exists: existsSync(target), parsed: JSON.parse(readFileSync(target, "utf8")) };
}));
record("uses a unique temp path, not a shared <file>.tmp (race-safe)", "uniqueTempPath", { path: "statusline/bottom-dashboard.txt", occupiedTmp: true, text: "ok\n" }, withDir((dir) => {
  const statusDir = join(dir, "statusline");
  mkdirSync(statusDir, { recursive: true });
  const target = join(statusDir, "bottom-dashboard.txt");
  mkdirSync(`${target}.tmp`, { recursive: true });
  writeTextAtomic(target, "ok\n");
  return {
    content: readFileSync(target, "utf8"),
    tempFileNames: readdirSync(statusDir).filter((name) => name.endsWith(".tmp") && statSync(join(statusDir, name)).isFile()),
  };
}));
record("quarantines a corrupt file aside instead of dropping it", "quarantineCorruptFile", { path: "state.json", text: "{ not valid json" }, withDir((dir) => {
  const target = join(dir, "state.json");
  writeFileSync(target, "{ not valid json");
  const dest = quarantineCorruptFile(target);
  return {
    destName: normalizeCorruptName(basename(dest ?? "")),
    targetExists: existsSync(target),
    quarantinedContent: readFileSync(dest, "utf8"),
    hasCorruptFile: readdirSync(dir).some((name) => name.includes(".corrupt-")),
  };
}));
record("quarantine is a no-op for a missing file", "quarantineMissing", { path: "nope.json" }, withDir((dir) => quarantineCorruptFile(join(dir, "nope.json"))));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/atomic-write.test.ts",
  generatedBy: "scripts/capture-atomic-write-contract.mjs",
  description: "Atomic state write and corrupt-file quarantine contracts captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
