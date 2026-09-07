#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/dashboard-tail-actions.json", ROOT);

const { dashboardTailMethods } = await import(new URL("dist/multiplexer/dashboard-tail-methods.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalize(value) {
  return JSON.parse(JSON.stringify(value));
}

function fn(calls, method, impl) {
  return async (...args) => {
    calls.push({ method, args: normalize(args) });
    return impl?.(...args);
  };
}

async function runCase(input) {
  const calls = [];
  const host = {
    forkSessionFromSource: fn(calls, "forkSessionFromSource", () => input.forkResult),
    openLiveTmuxWindowForEntry: (...args) =>
      calls.push({ method: "openLiveTmuxWindowForEntry", args: normalize(args) }),
    updateSessionLabel: fn(calls, "updateSessionLabel"),
    migrateAgent: fn(calls, "migrateAgent"),
  };

  try {
    let result;
    if (input.method === "forkAgent") {
      result = await dashboardTailMethods.forkAgent.call(host, input.options);
    } else if (input.method === "renameAgent") {
      result = await dashboardTailMethods.renameAgent.call(host, input.sessionId, input.label);
    } else if (input.method === "migrateAgentSession") {
      result = await dashboardTailMethods.migrateAgentSession.call(host, input.sessionId, input.targetWorktreePath);
    } else {
      throw new Error(`unknown method ${input.method}`);
    }
    return { result: normalize(result), error: null, calls };
  } catch (error) {
    return { result: null, error: error instanceof Error ? error.message : String(error), calls };
  }
}

const inputs = [
  {
    name: "forkAgent forwards source, target, instruction, worktree, launch override and opens result",
    input: {
      method: "forkAgent",
      forkResult: { sessionId: "codex-child", threadId: "thread-child" },
      options: {
        sourceSessionId: "codex-parent",
        targetToolConfigKey: "codex",
        targetSessionId: "codex-child",
        instruction: "continue from here",
        targetWorktreePath: "/repo/.aimux/worktrees/child",
        launchOverride: { command: "codex", args: ["--model", "gpt-5"], env: { AIMUX: "1" } },
        open: true,
      },
    },
  },
  {
    name: "forkAgent throws when the source cannot be forked",
    input: {
      method: "forkAgent",
      forkResult: null,
      options: {
        sourceSessionId: "missing-parent",
        targetToolConfigKey: "claude",
      },
    },
  },
  {
    name: "renameAgent returns a trimmed label while forwarding the original input",
    input: {
      method: "renameAgent",
      sessionId: "codex-1",
      label: "  Review Lead  ",
    },
  },
  {
    name: "renameAgent omits blank labels after updating",
    input: {
      method: "renameAgent",
      sessionId: "codex-1",
      label: "   ",
    },
  },
  {
    name: "migrateAgentSession forwards target worktree and reports it",
    input: {
      method: "migrateAgentSession",
      sessionId: "claude-1",
      targetWorktreePath: "/repo/.aimux/worktrees/review",
    },
  },
];

const cases = [];
for (const [index, entry] of inputs.entries()) {
  cases.push({
    id: `dashboard-tail-actions-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/dashboard-tail-methods.ts",
    api: "dashboardTailMethods.actions",
    input: entry.input,
    output: await runCase(entry.input),
    inputSha256: hash(entry.input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/dashboard-tail-methods.ts",
  generatedBy: "scripts/capture-dashboard-tail-actions-contract.mjs",
  description: "Dashboard tail fork/rename/migrate wrapper behavior captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
