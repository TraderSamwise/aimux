#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/session-runtime-agent-controls.json", ROOT);

const { interruptAgent, resizeAgentPane, sendAgentInput } = await import(
  new URL("dist/multiplexer/session-runtime-core.js", ROOT)
);

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalize(value) {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

function recorder() {
  const calls = [];
  return {
    calls,
    fn(method, impl) {
      return (...args) => {
        calls.push({ method, args: normalize(clone(args)) });
        return impl?.(...args);
      };
    },
  };
}

function makeSession(input, rec) {
  const writes = [];
  return {
    id: input.sessionId,
    command: input.command ?? "codex",
    exited: input.exited === true,
    write: rec.fn("session.write", (text) => writes.push(text)),
    resize: rec.fn("session.resize"),
    writes,
  };
}

function makeHost(input) {
  const rec = recorder();
  const session = makeSession(input, rec);
  const host = {
    projectRoot: mkdtempSync(join(tmpdir(), "aimux-session-runtime-controls-")),
    sessions: input.missing ? [] : [session],
    sessionToolKeys: new Map(input.sessionToolKeys ?? []),
    sessionWorktreePaths: new Map(input.sessionWorktreePaths ?? []),
    writeStatuslineFile: rec.fn("writeStatuslineFile"),
    metadataServer: {
      notifyChange: rec.fn("metadataServer.notifyChange"),
    },
  };
  return { host, calls: rec.calls, session };
}

async function runCase(input) {
  const { host, calls, session } = makeHost(input);
  let result = null;
  let error = null;
  try {
    if (input.api === "interruptAgent") {
      result = await interruptAgent(host, input.sessionId);
    } else if (input.api === "resizeAgentPane") {
      result = await resizeAgentPane(host, input.sessionId, input.cols, input.rows);
    } else if (input.api === "sendAgentInput") {
      result = await sendAgentInput(host, input.sessionId, input.text, input.options);
    } else {
      throw new Error(`unknown api ${input.api}`);
    }
  } catch (err) {
    error = normalize(err);
  }
  return {
    result,
    error,
    writes: session.writes,
    calls,
  };
}

const casesInput = [
  {
    name: "interrupts a running plain session and updates metadata observers",
    input: { api: "interruptAgent", sessionId: "plain-1" },
  },
  {
    name: "interrupt rejects a missing session",
    input: { api: "interruptAgent", sessionId: "missing-1", missing: true },
  },
  {
    name: "resize rejects invalid cols before resolving the session",
    input: { api: "resizeAgentPane", sessionId: "plain-1", cols: 0, rows: 24 },
  },
  {
    name: "resizes a running plain session",
    input: { api: "resizeAgentPane", sessionId: "plain-1", cols: 120, rows: 40 },
  },
  {
    name: "send input writes text and carriage return to a plain session",
    input: { api: "sendAgentInput", sessionId: "plain-1", text: "hello agent" },
  },
  {
    name: "send input rejects an exited plain session",
    input: { api: "sendAgentInput", sessionId: "plain-1", text: "hello", exited: true },
  },
];

const cases = [];
for (const [index, entry] of casesInput.entries()) {
  const input = clone(entry.input);
  cases.push({
    id: `session-runtime-agent-controls-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/session-runtime-core.ts",
    api: input.api,
    input,
    output: await runCase(clone(input)),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/session-runtime-core.ts",
  generatedBy: "scripts/capture-session-runtime-agent-controls-contract.mjs",
  description:
    "Session-runtime non-tmux interrupt, resize, and input helper behavior captured by running TypeScript.",
  cases,
});
