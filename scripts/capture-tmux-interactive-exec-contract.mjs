#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/interactive-exec.json", ROOT);
const { TmuxRuntimeManager } = await import(new URL("dist/tmux/runtime-manager.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const cases = [];
function record(name, input, run) {
  const execCalls = [];
  const interactiveCalls = [];
  const exec = (args, options) => {
    execCalls.push(options === undefined ? [...args] : [...args, { cwd: options.cwd }]);
    const joined = args.join(" ");
    if (joined === "display-message -p #{client_session}") return input.currentClientSession ?? "";
    if (joined.endsWith(" @aimux-return-session")) return input.returnSession ?? "";
    return "";
  };
  const interactiveExec = (args, options) => {
    interactiveCalls.push(options === undefined ? [...args] : [...args, { cwd: options.cwd }]);
    if (input.interactiveError) throw new Error(input.interactiveError);
  };
  const tmux = new TmuxRuntimeManager(exec, interactiveExec);
  let output;
  try {
    output = { thrown: null, snapshot: run(tmux, execCalls, interactiveCalls) };
  } catch (error) {
    output = {
      thrown: error instanceof Error ? error.message : String(error),
      snapshot: { execCalls, interactiveCalls },
    };
  }
  const fullInput = { name, ...input };
  cases.push({
    id: `tmux-interactive-exec-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/runtime-manager.ts",
    api: "TmuxRuntimeManager interactive exec",
    input: fullInput,
    output,
    inputSha256: hash(fullInput),
  });
}

record("detachClient uses interactive exec", {}, (tmux, execCalls, interactiveCalls) => {
  tmux.detachClient();
  return { execCalls, interactiveCalls };
});

record("switchToLastClientSession uses interactive exec", {}, (tmux, execCalls, interactiveCalls) => {
  tmux.switchToLastClientSession();
  return { execCalls, interactiveCalls };
});

record("switchClient uses interactive exec with explicit tty", {}, (tmux, execCalls, interactiveCalls) => {
  tmux.switchClient("aimux-repo-client-deadbeef", 3, "/dev/ttys001");
  return { execCalls, interactiveCalls };
});

record(
  "leaveManagedSession switches to external return session",
  {
    currentClientSession: "aimux-repo-client-deadbeef",
    returnSession: "user-main",
  },
  (tmux, execCalls, interactiveCalls) => {
    tmux.leaveManagedSession({ insideTmux: true, sessionName: "aimux-repo-client-deadbeef" });
    return { execCalls, interactiveCalls };
  },
);

record(
  "leaveManagedSession detaches without external return session",
  {
    currentClientSession: "aimux-repo-client-deadbeef",
    returnSession: "aimux-repo-client-deadbeef",
  },
  (tmux, execCalls, interactiveCalls) => {
    tmux.leaveManagedSession({ insideTmux: true, sessionName: "aimux-repo-client-deadbeef" });
    return { execCalls, interactiveCalls };
  },
);

record("attachSession refuses without a terminal", {}, (tmux, execCalls, interactiveCalls) => {
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  const stdout = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
  try {
    tmux.attachSession("aimux-repo", 2);
  } finally {
    if (stdin) Object.defineProperty(process.stdin, "isTTY", stdin);
    if (stdout) Object.defineProperty(process.stdout, "isTTY", stdout);
  }
  return { execCalls, interactiveCalls };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-06T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-interactive-exec-contract.mjs",
  source: "src/tmux/runtime-manager.ts",
  subject: "src/tmux/runtime-manager.ts",
  description:
    "TmuxRuntimeManager foreground/client-changing interactive exec behavior captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
