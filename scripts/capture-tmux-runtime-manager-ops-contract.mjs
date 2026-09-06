#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/runtime-manager-ops.json", ROOT);
const { TmuxRuntimeManager } = await import(new URL("dist/tmux/runtime-manager.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const target = {
  sessionName: "aimux-mobile-abc",
  windowId: "@3",
  windowIndex: 3,
  windowName: "codex",
};

const dashboardTarget = {
  sessionName: "aimux-mobile-abc",
  windowId: "@0",
  windowIndex: 0,
  windowName: "dashboard",
};

function callToValue(args, options) {
  return options === undefined ? [...args] : [...args, { cwd: options.cwd }];
}

function targetToValue(value) {
  if (!value) return null;
  return {
    sessionName: value.sessionName,
    windowId: value.windowId,
    windowIndex: value.windowIndex,
    windowName: value.windowName,
    paneDead: value.paneDead,
  };
}

function managedToValue(entries) {
  return entries.map((entry) => ({
    target: targetToValue(entry.target),
    metadata: entry.metadata,
  }));
}

const cases = [];
function record(name, api, input, run) {
  const fullInput = { name, ...input };
  const execCalls = [];
  const state = { createdDashboard: false };
  const exec = (args, options) => {
    execCalls.push(callToValue(args, options));
    const joined = args.join(" ");
    if (input.errors?.includes(joined)) throw new Error(input.errorMessage ?? "tmux unavailable");
    if (
      joined ===
      "list-windows -t aimux-mobile-abc -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}"
    ) {
      return input.listWindowsAfterCreate && state.createdDashboard
        ? input.listWindowsAfterCreate
        : (input.listWindowsRaw ?? "");
    }
    if (
      joined ===
      "list-windows -t aimux-mobile-abc -F #{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_activity}\t#{pane_dead}\t#{@aimux-meta}"
    ) {
      return input.listManagedWindowsRaw ?? "";
    }
    if (joined === "new-window -d -t aimux-mobile-abc -c /repo/mobile -n dashboard sh -lc tail -f /dev/null") {
      state.createdDashboard = true;
      return "";
    }
    if (joined === "capture-pane -p -J -t @3 -S -") return "default capture";
    if (joined === "capture-pane -p -J -e -t @3 -S 0 -E 1999") return "bounded capture";
    if (input.responses && Object.hasOwn(input.responses, joined)) return input.responses[joined];
    return "";
  };
  const tmux = new TmuxRuntimeManager(exec);
  let output;
  try {
    output = {
      thrown: null,
      result: run(tmux),
      snapshot: { execCalls },
    };
  } catch (error) {
    output = {
      thrown: error instanceof Error ? error.message : String(error),
      result: null,
      snapshot: { execCalls },
    };
  }
  cases.push({
    id: `tmux-runtime-manager-ops-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/runtime-manager.ts",
    api,
    input: fullInput,
    output,
    inputSha256: hash(fullInput),
  });
}

record("captures default pane tail", "captureTarget", {}, (tmux) => tmux.captureTarget(target));

record("captures bounded pane output with escapes", "captureTarget", {}, (tmux) =>
  tmux.captureTarget(target, { startLine: 0, endLine: 1999, includeEscapes: true }),
);

record("starts file pane pipes with quoted sinks and ownership", "pipeTargetToFile", {}, (tmux) => {
  tmux.startPanePipe(target, "cat >> /tmp/plain.log");
  tmux.pipeTargetToFile(target, "/tmp/aimux tap/it's.log", { onlyIfNotPiped: true });
  tmux.pipeTargetToFile(target, "/tmp/aimux tap/output.log", {
    onlyIfNotPiped: true,
    ownership: { token: "tap-token", tokenFilePath: "/tmp/aimux tap/token.txt" },
  });
  tmux.stopPanePipe(target);
  return null;
});

record(
  "collects persisted command text from global and per-session tmux stores",
  "listPersistedCommandText",
  {
    responses: {
      "list-panes -a -F #{pane_start_command}": "bash -lc dashboard",
      "list-keys": "bind-key -T root MouseDown1Pane run-shell '/installs/a/scripts/x.sh'",
      "show-options -g": "global option",
      "list-sessions -F #{session_name}": "alpha\nbeta\n",
      "show-options -t alpha": "alpha options",
      "show-options -w -t alpha": "",
      "show-hooks -t alpha": "pane-focus-in run-shell '/installs/b/scripts/y.sh'",
      "show-options -t beta": "beta options",
      "show-options -w -t beta": "beta window options",
      "show-hooks -t beta": "",
    },
  },
  (tmux) => tmux.listPersistedCommandText(),
);

record(
  "marks persisted command text incomplete while keeping successful reads",
  "listPersistedCommandText",
  {
    responses: {
      "list-keys": "",
      "show-options -g": "global option",
      "list-sessions -F #{session_name}": "alpha",
      "show-options -t alpha": "alpha options",
      "show-options -w -t alpha": "",
    },
    errors: ["list-panes -a -F #{pane_start_command}", "show-hooks -t alpha"],
    errorMessage: "no server running",
  },
  (tmux) => tmux.listPersistedCommandText(),
);

record(
  "renames an existing dashboard window",
  "ensureDashboardWindow",
  {
    listWindowsRaw: "@7\t7\tdashboard-old\t0\t22\t0\n@8\t8\tcodex\t1\t30\t0",
  },
  (tmux) => targetToValue(tmux.ensureDashboardWindow("aimux-mobile-abc", "/repo/mobile")),
);

record(
  "creates a dashboard window when absent",
  "ensureDashboardWindow",
  {
    listWindowsRaw: "@8\t8\tcodex\t1\t30\t0",
    listWindowsAfterCreate: "@8\t8\tcodex\t1\t30\t0\n@0\t0\tdashboard\t0\t31\t0",
  },
  (tmux) => targetToValue(tmux.ensureDashboardWindow("aimux-mobile-abc", "/repo/mobile")),
);

record(
  "lists managed windows and skips invalid metadata",
  "listManagedWindows",
  {
    listManagedWindowsRaw: [
      '@3\t3\tcodex\t1\t100\t0\t{"sessionId":"codex-1","command":"codex","args":[],"toolConfigKey":"codex"}',
      "@4\t4\tbroken\t0\t90\t0\t{not-json",
      "@5\t5\tempty\t0\t80\t1\t",
      '@6\t6\tclaude\t0\t70\t1\t{"sessionId":"claude-1","backendSessionId":"backend-existing","command":"claude","args":["--resume"],"toolConfigKey":"claude"}',
    ].join("\n"),
  },
  (tmux) => managedToValue(tmux.listManagedWindows("aimux-mobile-abc")),
);

record(
  "finds managed windows by session or backend id",
  "findManagedWindow",
  {
    listManagedWindowsRaw: [
      '@3\t3\tcodex\t1\t100\t0\t{"sessionId":"codex-1","command":"codex","args":[],"toolConfigKey":"codex"}',
      '@6\t6\tclaude\t0\t70\t1\t{"sessionId":"claude-1","backendSessionId":"backend-existing","command":"claude","args":["--resume"],"toolConfigKey":"claude"}',
    ].join("\n"),
  },
  (tmux) => ({
    bySession: targetToValue(tmux.findManagedWindow("aimux-mobile-abc", { sessionId: "codex-1" })?.target),
    byBackend: targetToValue(
      tmux.findManagedWindow("aimux-mobile-abc", { backendSessionId: "backend-existing" })?.target,
    ),
    missing: tmux.findManagedWindow("aimux-mobile-abc", {}) ?? null,
  }),
);

record(
  "cancels copy mode only when pane is in mode",
  "cancelCopyMode",
  {
    responses: {
      "display-message -p -t @0 #{pane_in_mode}": "0",
      "display-message -p -t @3 #{pane_in_mode}": "1",
    },
  },
  (tmux) => {
    tmux.cancelCopyMode(dashboardTarget);
    tmux.cancelCopyMode(target);
    return null;
  },
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-runtime-manager-ops-contract.mjs",
  source: "src/tmux/runtime-manager.ts",
  subject: "src/tmux/runtime-manager.ts",
  description:
    "TmuxRuntimeManager capture, pane pipe, persisted command text, dashboard window, metadata, and copy-mode behavior captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
