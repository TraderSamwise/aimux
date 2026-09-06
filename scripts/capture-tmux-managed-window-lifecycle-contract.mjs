#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/managed-window-lifecycle.json", ROOT);
const { TmuxRuntimeManager } = await import(new URL("dist/tmux/runtime-manager.js", ROOT));

const HOST = "aimux-mobile-078d0ecd20ec";
const CLIENT = `${HOST}-client-deadbeef`;
const TARGET = {
  sessionName: "aimux-mobile-abc",
  windowId: "@3",
  windowIndex: 3,
  windowName: "codex",
};

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function callToValue(args, options) {
  return options === undefined ? { args: [...args] } : { args: [...args], cwd: options.cwd };
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

function createExec(input) {
  const calls = [];
  const exec = (args, options) => {
    calls.push(callToValue(args, options));
    const joined = args.join(" ");
    if (joined === "-V") return "tmux 3.5a";
    if (input.errors?.includes(joined)) throw new Error(input.errorMessage ?? "tmux failed");
    if (joined === "list-sessions -F #{session_name}") return input.sessionList ?? "";
    if (joined === `show-options -v -t ${input.storedRootSession ?? "aimux-other-session"} @aimux-project-root`) {
      return input.storedRoot ?? "";
    }
    if (joined.startsWith(`list-windows -t ${HOST} -F `)) return input.hostWindows ?? "";
    if (joined.startsWith(`list-windows -t ${CLIENT} -F `)) return input.clientWindows ?? "";
    if (joined.startsWith("list-windows -t aimux-other-session -F ")) return input.otherWindows ?? "";
    if (joined.startsWith("list-windows -t aimux-mobile-abc -F ")) return input.abcWindows ?? "";
    if (joined === "display-message -p -t @3 #{pane_dead}") return input.paneDead ?? "0";
    if (joined === "display-message -p -t @3 #{window_active}") return input.windowActive ?? "1";
    if (joined.startsWith("show-window-options -v -t @3 @aimux-meta")) return input.windowMetadata ?? "";
    if (joined.startsWith("new-window -P ")) return input.newWindowRaw ?? "@3\t3\tcodex";
    return "";
  };
  exec.calls = calls;
  return exec;
}

const agentMeta = {
  kind: "agent",
  sessionId: "codex-abc123",
  command: "codex",
  args: ["--full-auto"],
  toolConfigKey: "codex",
  worktreePath: "/repo/mobile",
};
const serviceMeta = {
  kind: "service",
  sessionId: "service-123",
  command: "shell",
  args: ["-lc", "npm run dev"],
  toolConfigKey: "service",
  worktreePath: "/repo/mobile",
};
const dashboardMeta = {
  sessionId: "dashboard-123",
  command: "dashboard",
  args: [],
  toolConfigKey: "dashboard",
  worktreePath: "/repo/mobile",
};

const cases = [];

function record(name, api, input, run) {
  const exec = createExec(input);
  const manager = new TmuxRuntimeManager(exec);
  let result = null;
  let thrown = null;
  try {
    result = run(manager);
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error);
  }
  const fullInput = { name, ...input };
  cases.push({
    id: `tmux-managed-window-lifecycle-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/runtime-manager.ts",
    api,
    input: fullInput,
    output: {
      thrown,
      result,
      execCalls: exec.calls,
    },
    inputSha256: hash(fullInput),
  });
}

record(
  "lists managed windows across host and client sessions without duplicates",
  "listProjectManagedWindows",
  {
    sessionList: `${HOST}\n${CLIENT}\nother`,
    hostWindows: [
      `@3\t3\tcodex\t1\t100\t0\t${JSON.stringify(agentMeta)}`,
      `@9\t9\tshell\t0\t90\t0\t${JSON.stringify(serviceMeta)}`,
    ].join("\n"),
    clientWindows: [
      `@3\t3\tcodex\t0\t100\t0\t${JSON.stringify(agentMeta)}`,
      `@10\t10\tdashboard\t1\t110\t1\t${JSON.stringify(dashboardMeta)}`,
    ].join("\n"),
  },
  (manager) => managedToValue(manager.listProjectManagedWindows("/repo/mobile")),
);

record(
  "includes managed sessions whose stored root matches the requested project",
  "listProjectManagedWindows",
  {
    sessionList: `${HOST}\naimux-other-session\nuser-shell`,
    storedRoot: "/repo/mobile",
    hostWindows: `@3\t3\tcodex\t1\t100\t0\t${JSON.stringify(agentMeta)}`,
    otherWindows: `@4\t4\tclaude\t0\t99\t0\t${JSON.stringify({ ...agentMeta, sessionId: "claude-other", command: "claude", toolConfigKey: "claude" })}`,
  },
  (manager) => managedToValue(manager.listProjectManagedWindows("/repo/mobile")),
);

record(
  "finds managed windows by backend session id",
  "findManagedWindow",
  {
    abcWindows: `@3\t3\tcodex\t1\t100\t0\t${JSON.stringify({ ...agentMeta, sessionId: "codex-new", backendSessionId: "backend-existing" })}`,
  },
  (manager) =>
    targetToValue(manager.findManagedWindow("aimux-mobile-abc", { backendSessionId: "backend-existing" })?.target),
);

record("creates agent windows", "createWindow", {}, (manager) =>
  targetToValue(manager.createWindow("aimux-mobile-abc", "codex", "/repo/mobile", "codex", ["--full-auto"])),
);

record(
  "reports sanitized create window failures",
  "createWindow",
  {
    errors: [
      "new-window -P -t aimux-proj -c /repo -n claude -F #{window_id}\t#{window_index}\t#{window_name} env -i OPENAI_API_KEY=sk-real claude",
    ],
    errorMessage: "Command failed: tmux new-window env -i OPENAI_API_KEY=sk-real SECRET_TOKEN=abc",
  },
  (manager) => manager.createWindow("aimux-proj", "claude", "/repo", "env", ["-i", "OPENAI_API_KEY=sk-real", "claude"]),
);

record("runs basic window lifecycle commands", "window lifecycle commands", {}, (manager) => {
  manager.killWindow(TARGET);
  manager.unlinkWindow(TARGET);
  manager.renameWindow(TARGET.windowId, "renamed");
  manager.respawnWindow(TARGET, { cwd: "/repo/mobile", command: "codex", args: ["--resume"] });
  manager.clearTargetHistory(TARGET);
  manager.selectWindow(TARGET);
  return null;
});

record("checks window liveness and activity from tmux display-message", "window state checks", {}, (manager) => ({
  alive: manager.isWindowAlive(TARGET),
  active: manager.isWindowActive(TARGET),
}));

record(
  "reads and writes aimux window metadata",
  "window metadata",
  {
    windowMetadata: JSON.stringify(agentMeta),
  },
  (manager) => {
    manager.setWindowMetadata(TARGET, agentMeta);
    return manager.getWindowMetadata(TARGET);
  },
);

record("applies managed agent window policy", "applyManagedAgentWindowPolicy", {}, (manager) => {
  manager.applyManagedAgentWindowPolicy(TARGET, "codex");
  return null;
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-managed-window-lifecycle-contract.mjs",
  source: "src/tmux/runtime-manager.ts",
  subject: "src/tmux/runtime-manager.ts",
  description: "TmuxRuntimeManager managed window discovery and lifecycle behavior captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
