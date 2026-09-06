#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/session-transport.json", ROOT);
const { TmuxSessionTransport } = await import(new URL("dist/tmux/session-transport.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function target(over = {}) {
  return {
    sessionName: "aimux-mobile-abc",
    windowId: "@3",
    windowIndex: 3,
    windowName: "codex",
    ...over,
  };
}

function manager(config = {}) {
  const calls = [];
  let getTargetIndex = 0;
  const getTargetResponses = config.getTargetResponses ?? [target()];
  return {
    calls,
    sendText: (targetValue, text) => calls.push(["sendText", targetValue, text]),
    sendEnter: (targetValue) => calls.push(["sendEnter", targetValue]),
    sendKey: (targetValue, key) => calls.push(["sendKey", targetValue, key]),
    resizeTarget: (targetValue, cols, rows) => {
      calls.push(["resizeTarget", targetValue, cols, rows]);
      if (config.resizeError) throw new Error(config.resizeError);
    },
    killWindow: (targetValue) => {
      calls.push(["killWindow", targetValue]);
      if (config.killError) throw new Error(config.killError);
    },
    killWindowAsync: async (targetValue) => {
      calls.push(["killWindowAsync", targetValue]);
      if (config.killError) throw new Error(config.killError);
    },
    renameWindow: (windowId, name) => calls.push(["renameWindow", windowId, name]),
    openTarget: (targetValue, options) => calls.push(["openTarget", targetValue, options]),
    isInsideTmux: () => Boolean(config.insideTmux),
    getTargetByWindowId: (sessionName, windowId) => {
      calls.push(["getTargetByWindowId", sessionName, windowId]);
      const response = getTargetResponses[Math.min(getTargetIndex, getTargetResponses.length - 1)];
      getTargetIndex += 1;
      return response;
    },
  };
}

function snapshot(transport, managerValue, exitCalls) {
  return {
    exited: transport.exited,
    exitCode: transport.exitCode,
    status: transport.status,
    target: transport.tmuxTarget,
    cols: transport.cols,
    rows: transport.rows,
    calls: managerValue.calls,
    exitCalls,
  };
}

const cases = [];
async function record(name, input, run) {
  const managerValue = manager(input.manager);
  const transport = new TmuxSessionTransport("codex-1", "codex", target(input.target), managerValue, 80, 24);
  const exitCalls = [];
  transport.onExit((code) => exitCalls.push(code));
  let thrown = null;
  try {
    await run(transport, managerValue);
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  transport.destroy();
  const fullInput = { name, ...input };
  cases.push({
    id: `tmux-session-transport-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/session-transport.test.ts",
    api: "TmuxSessionTransport",
    input: fullInput,
    output: { thrown, snapshot: snapshot(transport, managerValue, exitCalls) },
    inputSha256: hash(fullInput),
  });
}

await record("sends text and enter keys through tmux", {}, (transport) => {
  transport.write("hello\r");
  transport.write("one\ntwo");
});

await record("resizes the backing tmux window", {}, (transport) => {
  transport.resize(100, 32);
});

await record(
  "keeps dimensions unchanged when tmux resize fails",
  { manager: { resizeError: "missing window" } },
  (transport) => {
    transport.resize(100, 32);
  },
);

await record(
  "settles kill when the tmux window is already gone",
  { manager: { killError: "no such window: @3" } },
  (transport) => {
    transport.kill();
  },
);

await record(
  "settles async kill when the tmux window is already gone",
  { manager: { killError: "no such window: @3" } },
  async (transport) => {
    await transport.killAsync();
  },
);

await record("renames and opens the tmux target", { manager: { insideTmux: true } }, (transport) => {
  transport.renameWindow("renamed");
  transport.open();
});

await record(
  "marks exit when the tmux window disappears",
  { manager: { getTargetResponses: [target(), null] } },
  (transport) => {
    transport.pollLiveness();
    transport.pollLiveness();
  },
);

await record(
  "marks exit when the tmux pane is dead but the window still exists",
  { manager: { getTargetResponses: [target(), target({ paneDead: true })] } },
  (transport) => {
    transport.pollLiveness();
    transport.pollLiveness();
  },
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-06T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-session-transport-contract.mjs",
  source: "src/tmux/session-transport.test.ts",
  subject: "src/tmux/session-transport.ts",
  description: "Tmux session transport behavior captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
