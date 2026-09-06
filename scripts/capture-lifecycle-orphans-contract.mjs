#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-state/lifecycle-orphans.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const lifecycle = await import(new URL("dist/lifecycle-orphans.js", ROOT));

const retiredMainEntrypoint = "/Users/sam/.aimux/native/current/dist/main.js";
const validationNode =
  "/Users/sam/.nvm/versions/node/v24.14.0/bin/node /Users/sam/.aimux/native/local-4a6316af-lifecycle-validate25/dist/launcher-bin.js daemon run daemon";
const validationHome = `env AIMUX_HOME=/tmp/aimux-home-validate42 ${retiredMainEntrypoint}`;
const normalDashboard = "/Users/sam/.aimux/native/local-a/dist/launcher-bin.js --tmux-dashboard-internal";

function tmux(input) {
  const killedSessions = [];
  const options = input.options ?? {};
  return {
    killedSessions,
    api: {
      isAvailable: () => input.available ?? true,
      listSessionNames: () => input.sessions ?? [],
      getSessionOption: (sessionName, option) => options[`${sessionName}:${option}`] ?? null,
      killSession: (sessionName) => {
        killedSessions.push(sessionName);
        if ((input.killFailures ?? []).includes(sessionName)) throw new Error(`cannot kill ${sessionName}`);
      },
    },
  };
}

async function cleanup(input) {
  const killedProcesses = [];
  const tmuxState = tmux(input.tmux ?? { available: false });
  const alive = new Set(input.alivePids ?? []);
  let readCount = 0;
  const readSequences = input.readProcessArgsSequence ?? {};
  const readProcessArgs = (pid) => {
    const key = String(pid);
    const sequence = readSequences[key];
    if (sequence) {
      const value = sequence[Math.min(readCount, sequence.length - 1)];
      readCount += 1;
      return value;
    }
    return input.readProcessArgs?.[key] ?? input.processes.find((entry) => entry.pid === pid)?.args ?? null;
  };
  const result = await lifecycle.cleanupLifecycleValidationOrphans({
    currentPid: input.currentPid ?? 999,
    tmux: tmuxState.api,
    listProcesses: () => input.processes,
    listProcessParents: () => new Map((input.parents ?? []).map(([pid, parent]) => [pid, parent])),
    listLiveTmuxPanePids: () => new Set(input.livePanePids ?? []),
    readProcessArgs,
    isPidAlive: (pid) => alive.has(pid),
    killPid: (pid, signal) => {
      killedProcesses.push([pid, signal]);
      if (input.killFailures?.[String(pid)]) throw new Error(input.killFailures[String(pid)]);
      if (input.killRemovesAlive !== false) alive.delete(pid);
    },
    sleep: async () => undefined,
    processExitTimeoutMs: input.processExitTimeoutMs ?? 1,
    processKillGraceMs: input.processKillGraceMs ?? 1,
  });
  return { result, killedProcesses, killedSessions: tmuxState.killedSessions };
}

async function run(input) {
  switch (input.api) {
    case "isLifecycleValidationProcessArgs":
      return lifecycle.isLifecycleValidationProcessArgs(input.args);
    case "isLifecycleValidationTmuxSession": {
      const tmuxState = tmux(input.tmux ?? {});
      return lifecycle.isLifecycleValidationTmuxSession(input.sessionName, tmuxState.api);
    }
    case "cleanupLifecycleValidationOrphans":
      return cleanup(input);
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const inputs = [
  {
    name: "matches validation-owned native local node entry",
    source: "src/lifecycle-orphans.test.ts",
    api: "isLifecycleValidationProcessArgs",
    args: validationNode,
  },
  {
    name: "matches retired main entrypoint under validation AIMUX_HOME",
    source: "src/lifecycle-orphans.test.ts",
    api: "isLifecycleValidationProcessArgs",
    args: validationHome,
  },
  {
    name: "does not match tmux option shell commands",
    source: "src/lifecycle-orphans.test.ts",
    api: "isLifecycleValidationProcessArgs",
    args: "/bin/zsh -c tmux set-option @aimux-project-root /tmp/aimux-home-validate42/project",
  },
  {
    name: "does not match current installed daemon entry",
    source: "src/lifecycle-orphans.test.ts",
    api: "isLifecycleValidationProcessArgs",
    args: "/Users/sam/.nvm/versions/node/v24.14.0/bin/node /Users/sam/.aimux/native/current/dist/launcher-bin.js daemon run daemon",
  },
  {
    name: "does not match user-named lifecycle feature builds",
    source: "src/lifecycle-orphans.test.ts",
    api: "isLifecycleValidationProcessArgs",
    args: "/Users/sam/.nvm/versions/node/v24.14.0/bin/node /Users/sam/.aimux/native/local-user-lifecycle-validate-feature/dist/launcher-bin.js daemon run daemon",
  },
  {
    name: "does not match shell-indirected validation native entry",
    source: "src/lifecycle-orphans.test.ts",
    api: "isLifecycleValidationProcessArgs",
    args: '/bin/zsh -lc entry=/Users/sam/.aimux/native/local-4a6316af-lifecycle-validate25/dist/launcher-bin.js node "$entry" daemon run daemon',
  },
  {
    name: "matches validation tmux session by name",
    source: "src/lifecycle-orphans.test.ts",
    api: "isLifecycleValidationTmuxSession",
    sessionName: "aimux-aimux-lifecycle-validate21",
    tmux: {},
  },
  {
    name: "matches validation tmux session by project-root option",
    source: "src/lifecycle-orphans.test.ts",
    api: "isLifecycleValidationTmuxSession",
    sessionName: "aimux-temp-123",
    tmux: { options: { "aimux-temp-123:@aimux-project-root": "/tmp/aimux-home-validate99/project" } },
  },
  {
    name: "does not match normal tmux sessions whose project path contains lifecycle words",
    source: "src/lifecycle-orphans.test.ts",
    api: "isLifecycleValidationTmuxSession",
    sessionName: "aimux-normal-123",
    tmux: { options: { "aimux-normal-123:@aimux-project-root": "/Users/sam/cs/lifecycle-validate-feature" } },
  },
  {
    name: "kills validation processes and sessions without touching regular Aimux runtime",
    source: "src/lifecycle-orphans.test.ts",
    api: "cleanupLifecycleValidationOrphans",
    currentPid: 999,
    processes: [
      { pid: 101, args: validationNode },
      { pid: 202, args: "env AIMUX_HOME=/tmp/aimux-home-validate25 /Users/sam/.aimux/native/current/dist/main.js" },
      { pid: 303, args: "/Users/sam/.aimux/native/current/dist/launcher-bin.js daemon run daemon" },
      { pid: 999, args: "env AIMUX_HOME=/tmp/aimux-home-validate25 current test process" },
    ],
    readProcessArgs: {
      101: validationNode,
      202: "env AIMUX_HOME=/tmp/aimux-home-validate25 /Users/sam/.aimux/native/current/dist/main.js",
    },
    alivePids: [101, 202],
    tmux: {
      available: true,
      sessions: ["aimux-tealstreet-next-abc", "aimux-aimux-lifecycle-validate25", "aimux-option-only"],
      options: {
        "aimux-option-only:@aimux-project-state-dir": "/tmp/aimux-home-validate25/state",
      },
    },
  },
  {
    name: "does not escalate to SIGKILL when a candidate pid no longer matches",
    source: "src/lifecycle-orphans.test.ts",
    api: "cleanupLifecycleValidationOrphans",
    currentPid: 999,
    processes: [{ pid: 101, args: validationNode }],
    readProcessArgsSequence: { 101: [validationNode, "node /Users/sam/cs/app/server.js"] },
    alivePids: [101],
    killRemovesAlive: false,
    tmux: { available: false },
  },
  {
    name: "reaps a dashboard whose window is gone",
    source: "src/lifecycle-orphans.test.ts",
    api: "cleanupLifecycleValidationOrphans",
    currentPid: 999,
    processes: [
      { pid: 11, args: "/Users/sam/.volta/bin/node /Users/sam/.aimux/native/local-old/dist/launcher-bin.js --tmux-dashboard-internal" },
      { pid: 12, args: "/Users/sam/.volta/bin/node /Users/sam/.aimux/native/local-current/dist/launcher-bin.js --tmux-dashboard-internal" },
      { pid: 13, args: "/Users/sam/.volta/bin/node /Users/sam/.aimux/native/local-current/dist/launcher-bin.js --tmux-dashboard-internal" },
    ],
    parents: [
      [11, 111],
      [111, 1],
      [12, 112],
      [112, 1],
      [13, 113],
      [113, 900],
      [900, 1],
    ],
    alivePids: [],
    tmux: { available: false },
  },
  {
    name: "reaps a dashboard whose shell is not a live tmux pane anymore",
    source: "src/lifecycle-orphans.test.ts",
    api: "cleanupLifecycleValidationOrphans",
    currentPid: 999,
    processes: [
      { pid: 11, args: normalDashboard },
      { pid: 12, args: normalDashboard },
    ],
    parents: [
      [11, 111],
      [111, 900],
      [12, 112],
      [112, 900],
      [900, 1],
    ],
    livePanePids: [112],
    alivePids: [],
    tmux: { available: true, sessions: [] },
  },
  {
    name: "never reaps a dashboard merely because its build differs",
    source: "src/lifecycle-orphans.test.ts",
    api: "cleanupLifecycleValidationOrphans",
    currentPid: 999,
    processes: [{ pid: 21, args: "/Users/sam/.aimux/native/local-newer/dist/launcher-bin.js --tmux-dashboard-internal" }],
    parents: [
      [21, 121],
      [121, 900],
      [900, 1],
    ],
    alivePids: [],
    tmux: { available: false },
  },
  {
    name: "does not kill a pid that is no longer a dashboard when re-read",
    source: "src/lifecycle-orphans.test.ts",
    api: "cleanupLifecycleValidationOrphans",
    currentPid: 999,
    processes: [{ pid: 31, args: normalDashboard }],
    parents: [
      [31, 131],
      [131, 1],
    ],
    readProcessArgs: { 31: "/usr/bin/some-other-process --unrelated" },
    alivePids: [],
    tmux: { available: false },
  },
];

const cases = [];
for (const input of inputs) {
  cases.push({
    id: `lifecycle-orphans-${String(cases.length + 1).padStart(3, "0")}`,
    name: input.name,
    source: input.source,
    api: input.api,
    input,
    output: await run(input),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: ["src/lifecycle-orphans.test.ts"],
  generatedBy: "scripts/capture-lifecycle-orphans-contract.mjs",
  description:
    "Lifecycle validation orphan process/session classification and cleanup side-effect contracts captured by running TypeScript lifecycle-orphans helpers with injected process and tmux state.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
