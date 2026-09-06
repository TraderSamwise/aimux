#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/client-dashboard-slot.json", ROOT);
const { TmuxRuntimeManager } = await import(new URL("dist/tmux/runtime-manager.js", ROOT));

const HOST = "aimux-mobile-abc";
const CLIENT = `${HOST}-client-268eff9c`;
const DASHBOARD = { sessionName: HOST, windowId: "@10", windowIndex: 0, windowName: "dashboard" };

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function callToValue(args, options) {
  return options === undefined ? { args: [...args] } : { args: [...args], cwd: options.cwd };
}

function interestingCall(call) {
  const [verb] = call.args;
  if (
    ["new-session", "new-window", "link-window", "move-window", "swap-window", "unlink-window", "kill-window"].includes(
      verb,
    )
  ) {
    return true;
  }
  if (
    verb === "set-option" &&
    ["renumber-windows", "@aimux-return-session", "@aimux-host-session", "@aimux-runtime-build"].includes(call.args[3])
  ) {
    return true;
  }
  if (verb === "send-keys" && call.args.includes("-X")) return true;
  return false;
}

function normalizeCall(call) {
  return {
    ...call,
    args: call.args.map((arg, index) =>
      call.args[0] === "set-option" && call.args[3] === "@aimux-runtime-build" && index === 4 ? "<runtime-build>" : arg,
    ),
  };
}

function createExec(input) {
  const calls = [];
  const exec = (args, options) => {
    calls.push(callToValue(args, options));
    const joined = args.join(" ");
    const linked = calls.some(
      (call) => call.args.join(" ") === `link-window -d -s ${input.windowId ?? "@10"} -t ${CLIENT}`,
    );
    const swapped = calls.some(
      (call) => call.args.join(" ") === `swap-window -s ${CLIENT}:${input.windowId ?? "@10"} -t ${CLIENT}:0`,
    );
    const moved = calls.some(
      (call) => call.args.join(" ") === `move-window -s ${CLIENT}:${input.windowId ?? "@10"} -t ${CLIENT}:0`,
    );
    if (joined === "-V") return "tmux 3.5a";
    if (joined === `has-session -t ${CLIENT}`) {
      if (input.clientSessionMissing) throw new Error("missing");
      return "";
    }
    if (joined === `show-options -v -t ${HOST} @aimux-project-root`) return "/repo/mobile";
    if (joined === `show-options -v -t ${CLIENT} @aimux-host-session`) return input.currentHostSession ?? HOST;
    if (joined === `show-options -v -t ${CLIENT} @aimux-project-root`)
      return input.currentProjectRoot ?? "/repo/mobile";
    if (joined === `show-options -v -t ${CLIENT} @aimux-runtime-build`)
      return input.currentRuntimeBuild ?? "<stale-build>";
    if (joined === `show-options -v -t ${CLIENT} renumber-windows`) return input.renumberWindows ?? "on";
    if (joined.startsWith(`show-options -v -t ${CLIENT} terminal-features`)) return "";
    if (joined === "display-message -p #{client_session}") return input.currentClientSession ?? "";
    if (joined === `display-message -p -t ${input.windowId ?? "@10"} #{pane_in_mode}`)
      return input.targetPaneInMode ?? "0";
    if (joined === `link-window -d -s ${input.windowId ?? "@10"} -t ${CLIENT}` && input.linkError)
      throw new Error(input.linkError);
    if (joined === `move-window -s ${CLIENT}:${input.windowId ?? "@10"} -t ${CLIENT}:0` && input.moveError) {
      throw new Error(input.moveError);
    }
    if (joined === `unlink-window -t ${CLIENT}:@placeholder` && input.unlinkPlaceholderError) {
      throw new Error(input.unlinkPlaceholderError);
    }
    if (joined.startsWith(`list-windows -t ${HOST} -F `)) return input.hostWindows ?? "";
    if (joined.startsWith(`list-windows -t ${CLIENT} -F `)) {
      if (swapped && input.clientWindowsAfterSwap) return input.clientWindowsAfterSwap;
      if (moved && input.clientWindowsAfterMove) return input.clientWindowsAfterMove;
      if (linked && input.clientWindowsAfterLink) return input.clientWindowsAfterLink;
      return input.clientWindows ?? "";
    }
    return "";
  };
  exec.calls = calls;
  return exec;
}

const cases = [];

function record(name, input, target = DASHBOARD, options = { insideTmux: true, clientSuffix: "268eff9c" }) {
  const exec = createExec(input);
  const interactiveCalls = [];
  const manager = new TmuxRuntimeManager(exec, (args, callOptions) => {
    interactiveCalls.push(callToValue(args, callOptions));
  });
  let thrown = null;
  let result = null;
  try {
    result = manager.openTarget(target, options) ?? null;
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  const fullInput = { name, input, target, options };
  cases.push({
    id: `tmux-client-dashboard-slot-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/runtime-manager.ts",
    api: "TmuxRuntimeManager.openTarget",
    input: fullInput,
    output: {
      thrown,
      result,
      calls: exec.calls.filter(interestingCall).map(normalizeCall),
      interactiveCalls,
    },
    inputSha256: hash(fullInput),
  });
}

record("replaces a client dashboard placeholder atomically", {
  clientSessionMissing: true,
  clientWindows: "@placeholder\t0\tdashboard\t1\t100",
  clientWindowsAfterLink: "@placeholder\t0\tdashboard\t1\t100\n@10\t1\tdashboard\t0\t100",
  clientWindowsAfterSwap: "@10\t0\tdashboard\t1\t100\n@placeholder\t1\tdashboard\t0\t100",
});

record("moves an already linked dashboard into the requested client slot", {
  clientWindows: "@placeholder\t0\tdashboard\t1\t100\n@10\t1\tdashboard\t0\t100",
  clientWindowsAfterSwap: "@10\t0\tdashboard\t0\t100\n@placeholder\t1\tdashboard\t1\t100",
});

record("moves an already linked dashboard into an empty requested slot", {
  clientWindows: "@10\t1\tdashboard\t1\t100",
  clientWindowsAfterMove: "@10\t0\tdashboard\t1\t100",
});

record("preserves a pre-existing dashboard link when moving fails", {
  clientWindows: "@10\t1\tdashboard\t1\t100",
  moveError: "move failed",
});

record("keeps the existing dashboard slot intact when linking fails", {
  clientWindows: "@placeholder\t0\tdashboard\t1\t100\n@codex\t1\tcodex\t0\t100",
  linkError: "link failed",
});

record("unlinks a newly linked dashboard when slot verification fails", {
  clientWindows: "@placeholder\t0\tdashboard\t1\t100",
  clientWindowsAfterLink: "@placeholder\t0\tdashboard\t1\t100\n@10\t1\tdashboard\t0\t100",
});

record("restores window renumbering when dashboard link fails", {
  clientSessionMissing: true,
  clientWindows: "@placeholder\t0\tdashboard\t1\t100",
  linkError: "link failed",
});

record("restores window renumbering when stale dashboard unlink fails", {
  clientSessionMissing: true,
  clientWindows: "@placeholder\t0\tdashboard\t1\t100",
  clientWindowsAfterLink: "@placeholder\t0\tdashboard\t1\t100\n@10\t1\tdashboard\t0\t100",
  clientWindowsAfterSwap: "@10\t0\tdashboard\t1\t100\n@placeholder\t1\tdashboard\t0\t100",
  unlinkPlaceholderError: "unlink failed",
});

record(
  "switches an explicit client tty and suffix for cross-project target",
  {
    clientSessionMissing: true,
    clientWindowsAfterLink: "@3\t3\tcodex\t0\t90\t0",
    windowId: "@3",
  },
  { sessionName: HOST, windowId: "@3", windowIndex: 3, windowName: "codex" },
  { insideTmux: true, clientTty: "/dev/ttys999", clientSuffix: "268eff9c", returnSessionName: "other-client" },
);

record(
  "links a host dashboard into the client dashboard slot",
  {
    clientWindows: "@125\t0\tdashboard\t1\t100\t0",
    clientWindowsAfterLink: "@125\t0\tdashboard\t1\t100\t0\n@121\t1\tdashboard\t0\t100\t0",
    clientWindowsAfterSwap: "@121\t0\tdashboard\t1\t100\t0\n@125\t1\tdashboard\t0\t100\t0",
    currentRuntimeBuild: "",
    currentClientSession: CLIENT,
    windowId: "@121",
  },
  { sessionName: HOST, windowId: "@121", windowIndex: 0, windowName: "dashboard" },
  { insideTmux: true, clientTty: "/dev/ttys999", clientSuffix: "268eff9c" },
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-client-dashboard-slot-contract.mjs",
  source: "src/tmux/runtime-manager.ts",
  subject: "src/tmux/runtime-manager.ts",
  description: "TmuxRuntimeManager client dashboard slot link/swap/move behavior captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
