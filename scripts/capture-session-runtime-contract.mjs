#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/session/runtime.json", ROOT);
const runtimeModule = await import(new URL("dist/session-runtime.js", ROOT));
const { SessionRuntime } = runtimeModule;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function createTransport(overrides = {}) {
  let onData = null;
  let onExit = null;
  return {
    id: overrides.id ?? "s1",
    command: overrides.command ?? "codex",
    backendSessionId: overrides.backendSessionId,
    exited: overrides.exited ?? false,
    exitCode: overrides.exitCode,
    status: overrides.status ?? "idle",
    write() {},
    resize() {},
    hasVisibleContent: () => true,
    onData: (cb) => {
      onData = cb;
    },
    onExit: (cb) => {
      onExit = cb;
    },
    kill() {},
    destroy() {},
    emitData(data) {
      onData?.(data);
    },
    emitExit(code) {
      onExit?.(code);
    },
  };
}

const cases = [];
function record(name, input, output) {
  cases.push({
    id: `session-runtime-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/session-runtime.test.ts",
    api: "SessionRuntime",
    input,
    output,
    inputSha256: hash(input),
  });
}

for (const input of [
  { event: { kind: "data", data: "hello" } },
  { event: { kind: "exit", code: 7 } },
]) {
  const events = [];
  const transport = createTransport();
  new SessionRuntime(transport, Date.now(), { onEvent: (event) => events.push(event) });
  if (input.event.kind === "data") transport.emitData(input.event.data);
  else transport.emitExit(input.event.code);
  record(
    input.event.kind === "data" ? "emits output events from the transport" : "emits exit events from the transport",
    input,
    events,
  );
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/session-runtime.test.ts",
  generatedBy: "scripts/capture-session-runtime-contract.mjs",
  description: "SessionRuntime transport data/exit event forwarding captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
