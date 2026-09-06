#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/app-state/lifecycle-transitions.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function importPureModule() {
  const sourceText = await readFile(new URL("app/stores/lifecycleTransitions.ts", ROOT), "utf8");
  const pureSource = `const PROJECTABLE_PHASES = new Set(["queued", "started", "settling", "succeeded"]);\n${sourceText.slice(sourceText.indexOf("export function localProjectLifecycleTransition"))}`;
  const transpiled = ts.transpileModule(pureSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "app-lifecycle-transitions-contract.ts",
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const lifecycle = await importPureModule();

function desktopState(overrides = {}) {
  return { ok: true, sessions: [], services: [], worktrees: [], ...overrides };
}

function transition(operation, targetId, targetKind = "agent", targetPath, phase = "started") {
  return {
    operationId: `${operation}:${targetId}`,
    operation,
    targetKind,
    targetId,
    targetPath,
    phase,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function normalizeVolatile(value) {
  return JSON.parse(
    JSON.stringify(value, (key, val) => {
      if ((key === "startedAt" || key === "updatedAt") && typeof val === "string" && /^\d{4}-/.test(val)) {
        return "<ts:1>";
      }
      if (key === "operationId" && typeof val === "string" && val.startsWith("client:")) {
        return val.replace(/:\d+$/, ":<id:1>");
      }
      return val;
    }),
  );
}

const oldWorktree = "/repo/.aimux/worktrees/old";
const featureWorktree = "/repo/.aimux/worktrees/feature";

const inputs = [
  {
    name: "builds local transitions and failed clearing transitions for slow client actions",
    source: "app/stores/lifecycleTransitions.test.ts",
    api: "localAndFail",
    value: { operation: "agent.stop", targetKind: "agent", targetId: "agent-1" },
  },
  {
    name: "overlays an in-flight agent resume over stale desktop-state",
    source: "app/stores/lifecycleTransitions.test.ts",
    api: "applyProjectLifecycleTransitionsToDesktopState",
    state: desktopState({ sessions: [{ id: "agent-1", label: "claude", status: "offline" }] }),
    records: [{ transition: transition("agent.resume", "agent-1"), label: "claude", tool: "claude" }],
  },
  {
    name: "adds optimistic agent rows before the next desktop-state includes them",
    source: "app/stores/lifecycleTransitions.test.ts",
    api: "applyProjectLifecycleTransitionsToDesktopState",
    state: desktopState(),
    records: [
      {
        transition: transition("agent.spawn", "agent-2", "agent", featureWorktree),
        label: "agent-2",
        tool: "codex",
        worktreePath: featureWorktree,
      },
    ],
  },
  {
    name: "updates agent rename labels optimistically",
    source: "app/stores/lifecycleTransitions.test.ts",
    api: "applyProjectLifecycleTransitionsToDesktopState",
    state: desktopState({ sessions: [{ id: "agent-1", label: "old", status: "running" }] }),
    records: [{ transition: transition("agent.rename", "agent-1"), label: "new" }],
  },
  {
    name: "projects worktree create and remove transitions onto worktree state",
    source: "app/stores/lifecycleTransitions.test.ts",
    api: "applyProjectLifecycleTransitionsToDesktopState",
    state: desktopState({ worktrees: [{ name: "old", path: oldWorktree, branch: "old" }] }),
    records: [
      {
        transition: transition("worktree.create", "feature", "worktree", featureWorktree),
        worktreeName: "feature",
        worktreePath: featureWorktree,
      },
      {
        transition: transition("worktree.remove", "old", "worktree", oldWorktree),
        worktreePath: oldWorktree,
      },
    ],
  },
  {
    name: "projects worktree resurrect transitions like worktree creation",
    source: "app/stores/lifecycleTransitions.test.ts",
    api: "applyProjectLifecycleTransitionsToDesktopState",
    state: desktopState(),
    records: [
      {
        transition: transition("graveyard.worktree.resurrect", "restored", "worktree", "/repo/.aimux/worktrees/restored"),
        worktreeName: "restored",
        worktreePath: "/repo/.aimux/worktrees/restored",
      },
    ],
  },
  {
    name: "overlays service stop transitions",
    source: "app/stores/lifecycleTransitions.test.ts",
    api: "applyProjectLifecycleTransitionsToDesktopState",
    state: desktopState({ services: [{ id: "svc-1", label: "server", status: "running" }] }),
    records: [{ transition: transition("service.stop", "svc-1", "service"), label: "server" }],
  },
  {
    name: "overlays service resume transitions",
    source: "app/stores/lifecycleTransitions.test.ts",
    api: "applyProjectLifecycleTransitionsToDesktopState",
    state: desktopState({ services: [{ id: "svc-1", label: "server", status: "offline" }] }),
    records: [{ transition: transition("service.resume", "svc-1", "service"), label: "server" }],
  },
  {
    name: "adds optimistic service rows before the next desktop-state includes them",
    source: "app/stores/lifecycleTransitions.test.ts",
    api: "applyProjectLifecycleTransitionsToDesktopState",
    state: desktopState(),
    records: [
      {
        transition: transition("service.create", "svc-2", "service", "/repo/worktree"),
        label: "server",
        worktreePath: "/repo/worktree",
      },
    ],
  },
  {
    name: "ignores failed and unsupported transition projections",
    source: "app/stores/lifecycleTransitions.ts",
    api: "applyProjectLifecycleTransitionsToDesktopState",
    state: desktopState({ sessions: [{ id: "agent-1", label: "old", status: "running" }] }),
    records: [
      { transition: transition("agent.rename", "agent-1", "agent", undefined, "failed"), label: "new" },
      { transition: transition("agent.unknown", "agent-2", "agent"), label: "agent-2" },
    ],
  },
];

function run(input) {
  switch (input.api) {
    case "localAndFail": {
      const local = lifecycle.localProjectLifecycleTransition(input.value);
      return normalizeVolatile({ local, failed: lifecycle.failLocalProjectLifecycleTransition(local) });
    }
    case "applyProjectLifecycleTransitionsToDesktopState":
      return lifecycle.applyProjectLifecycleTransitionsToDesktopState(input.state, input.records);
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const cases = inputs.map((input, index) => ({
  id: `app-state-lifecycle-transitions-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: input.source,
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: ["app/stores/lifecycleTransitions.test.ts", "app/stores/lifecycleTransitions.ts"],
  generatedBy: "scripts/capture-app-lifecycle-transitions-contract.mjs",
  description:
    "App project lifecycle transition local/failure records and optimistic desktop-state projections captured by running TypeScript lifecycle transition helpers. Generated client ids and timestamps are normalized after execution.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
