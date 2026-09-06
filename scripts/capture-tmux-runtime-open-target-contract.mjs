#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/runtime-open-target.json", ROOT);
const { TmuxRuntimeManager } = await import(new URL("dist/tmux/runtime-manager.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const target = {
  sessionName: "aimux-mobile-abc",
  windowId: "@3",
  windowIndex: 3,
  windowName: "codex",
};

function callToJson(args, options) {
  return options === undefined ? [...args] : [...args, { cwd: options.cwd }];
}

function makeRuntime(input) {
  const execCalls = [];
  const interactiveCalls = [];
  const linkedSessions = new Set();
  const exec = (args, options) => {
    execCalls.push(callToJson(args, options));
    const joined = args.join(" ");
    if (joined === "display-message -p #{client_session}") return input.currentClientSession ?? "";
    if (joined === "display-message -p #{client_tty}") return input.clientTty ?? "";
    if (joined === "display-message -p #{client_pid}") return input.clientPid ?? "";
    if (joined === "show-options -v -t aimux-mobile-abc @aimux-project-root") return "";
    if (joined.startsWith("list-windows -t aimux-mobile-abc-client-")) {
      const sessionName = args[2];
      return linkedSessions.has(sessionName) ? "@3\t3\tcodex\t0\t90\t0" : "";
    }
    if (joined.startsWith("link-window -d -s @3 -t aimux-mobile-abc-client-")) {
      linkedSessions.add(args[5]);
      return "";
    }
    return "";
  };
  const interactiveExec = (args, options) => {
    interactiveCalls.push(callToJson(args, options));
  };
  return { tmux: new TmuxRuntimeManager(exec, interactiveExec), execCalls, interactiveCalls };
}

const cases = [];
function record(name, input) {
  const previousClientKey = process.env.AIMUX_CLIENT_KEY;
  delete process.env.AIMUX_CLIENT_KEY;
  const runtime = makeRuntime(input);
  let output;
  try {
    const result = runtime.tmux.openTarget(target, { insideTmux: true });
    output = {
      thrown: null,
      result: result ?? null,
      execCalls: runtime.execCalls,
      interactiveCalls: runtime.interactiveCalls,
    };
  } catch (error) {
    output = {
      thrown: error instanceof Error ? error.message : String(error),
      result: null,
      execCalls: runtime.execCalls,
      interactiveCalls: runtime.interactiveCalls,
    };
  } finally {
    if (previousClientKey === undefined) delete process.env.AIMUX_CLIENT_KEY;
    else process.env.AIMUX_CLIENT_KEY = previousClientKey;
  }
  const fullInput = { name, ...input, target, options: { insideTmux: true } };
  cases.push({
    id: `tmux-runtime-open-target-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/runtime-manager.ts",
    api: "TmuxRuntimeManager.openTarget",
    input: fullInput,
    output,
    inputSha256: hash(fullInput),
  });
}

record("uses suffix embedded in current client session", {
  currentClientSession: "aimux-mobile-abc-client-268eff9c",
});

record("uses client tty and pid when current session is not a client session", {
  currentClientSession: "user-main",
  clientTty: "/dev/ttys111",
  clientPid: "4242",
});

record("stays on host session when no client identity is available", {
  currentClientSession: "user-main",
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-runtime-open-target-contract.mjs",
  source: "src/tmux/runtime-manager.ts",
  subject: "src/tmux/runtime-manager.ts",
  description: "TmuxRuntimeManager.openTarget client-session resolution captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
