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
const { TmuxSessionTransport } = await import(new URL("dist/tmux/session-transport.js", ROOT));
const { SessionRuntime } = await import(new URL("dist/session-runtime.js", ROOT));

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

function normalizeRoot(value, projectRoot) {
  return JSON.parse(JSON.stringify(value).split(projectRoot).join("<REPO>"));
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

function makeTmuxManager(input, rec) {
  const target = input.target ?? { sessionName: "aimux-project", windowId: "@7", windowName: "codex" };
  const resolvedTarget = input.resolvedTarget ?? target;
  let submitted = false;
  return {
    target,
    manager: {
      getTargetByWindowId: rec.fn("tmuxRuntimeManager.getTargetByWindowId", () =>
        input.targetMissing ? null : resolvedTarget,
      ),
      getWindowMetadata: rec.fn("tmuxRuntimeManager.getWindowMetadata", () =>
        input.metadata ?? { kind: "agent", sessionId: input.sessionId },
      ),
      listProjectManagedWindows: rec.fn("tmuxRuntimeManager.listProjectManagedWindows", () => []),
      isWindowAlive: rec.fn("tmuxRuntimeManager.isWindowAlive", () => true),
      sendEscape: rec.fn("tmuxRuntimeManager.sendEscape"),
      sendText: rec.fn("tmuxRuntimeManager.sendText"),
      sendEnter: rec.fn("tmuxRuntimeManager.sendEnter"),
      sendKey: rec.fn("tmuxRuntimeManager.sendKey"),
      sendCarriageReturn: rec.fn("tmuxRuntimeManager.sendCarriageReturn", () => {
        submitted = true;
      }),
      resizeTarget: rec.fn("tmuxRuntimeManager.resizeTarget"),
      killWindow: rec.fn("tmuxRuntimeManager.killWindow"),
    },
    captureTarget: rec.fn("tmuxRuntimeManager.captureTarget", () => {
      if (submitted) return input.afterSubmitPane ?? "";
      return input.promptPane ?? `› ${String(input.text ?? "").replace(/(?:\r\n|\r|\n)+/g, " ").trim()}`;
    }),
  };
}

function makeSession(input, rec) {
  const writes = [];
  if (input.transport === "tmux") {
    const tmux = makeTmuxManager(input, rec);
    tmux.manager.captureTarget = tmux.captureTarget;
    const transport = new TmuxSessionTransport(
      input.sessionId,
      input.command ?? "codex",
      tmux.target,
      tmux.manager,
      input.initialCols ?? 80,
      input.initialRows ?? 24,
    );
    const runtime = new SessionRuntime(transport, input.startTime);
    runtime.writes = writes;
    runtime.tmuxRuntimeManager = tmux.manager;
    return runtime;
  }
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
    sessionTmuxTargets: new Map(session.transport ? [[input.sessionId, session.transport.tmuxTarget]] : []),
    sessionToolKeys: new Map(input.sessionToolKeys ?? []),
    sessionWorktreePaths: new Map(input.sessionWorktreePaths ?? []),
    tmuxRuntimeManager: session.tmuxRuntimeManager,
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
  return normalizeRoot({
    result,
    error,
    writes: session.writes,
    target: session.transport ? normalize(session.transport.tmuxTarget) : null,
    sessionTmuxTargets: [...(host.sessionTmuxTargets?.entries?.() ?? [])],
    calls,
  }, host.projectRoot);
}

const casesInput = [
  {
    name: "interrupts a running plain session and updates metadata observers",
    input: { api: "interruptAgent", sessionId: "plain-1" },
  },
  {
    name: "interrupts a running tmux session through the resolved target",
    input: {
      api: "interruptAgent",
      sessionId: "tmux-1",
      transport: "tmux",
      target: { sessionName: "aimux-project", windowId: "@7", windowName: "stale" },
      resolvedTarget: { sessionName: "aimux-project", windowId: "@8", windowName: "codex" },
    },
  },
  {
    name: "interrupt rejects a missing session",
    input: { api: "interruptAgent", sessionId: "missing-1", missing: true },
  },
  {
    name: "interrupt rejects a tmux session whose cached target is gone",
    input: { api: "interruptAgent", sessionId: "tmux-missing", transport: "tmux", targetMissing: true },
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
    name: "resizes a running tmux session after retargeting",
    input: {
      api: "resizeAgentPane",
      sessionId: "tmux-1",
      transport: "tmux",
      cols: 132,
      rows: 43,
      resolvedTarget: { sessionName: "aimux-project", windowId: "@8", windowName: "codex" },
    },
  },
  {
    name: "send input writes text and carriage return to a plain session",
    input: { api: "sendAgentInput", sessionId: "plain-1", text: "hello agent" },
  },
  {
    name: "send input to tmux normalizes multiline prompt and confirms submit",
    input: {
      api: "sendAgentInput",
      sessionId: "tmux-1",
      transport: "tmux",
      text: " hello\n\nagent \n",
      options: { waitForSubmit: true },
      promptPane: "› hello agent",
      afterSubmitPane: "Thinking...",
    },
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
