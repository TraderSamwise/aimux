#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/query-memo.json", ROOT);
const { TmuxRuntimeManager } = await import(new URL("dist/tmux/runtime-manager.js", ROOT));
const { isInTmuxQueryMemoScope, memoizedTmuxQuery, resetTmuxQueryMemo, tmuxQueryKey, withTmuxQueryMemo } = await import(
  new URL("dist/tmux/query-memo.js", ROOT)
);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const cases = [];
function record(name, input, run) {
  let output;
  try {
    output = { thrown: null, snapshot: run() };
  } catch (error) {
    output = { thrown: error instanceof Error ? error.message : String(error), snapshot: null };
  }
  const fullInput = { name, ...input };
  cases.push({
    id: `tmux-query-memo-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/query-memo.test.ts",
    api: "query-memo",
    input: fullInput,
    output,
    inputSha256: hash(fullInput),
  });
}

function managerWith(log) {
  return new TmuxRuntimeManager((args, options) => {
    log.push(options === undefined ? [...args] : [...args, { cwd: options.cwd }]);
    return args[0] === "capture-pane" ? `capture-${log.length}` : "ok";
  });
}

record("is inert outside a scope", {}, () => {
  let calls = 0;
  const compute = () => {
    calls += 1;
    return "x";
  };
  memoizedTmuxQuery("k", compute);
  memoizedTmuxQuery("k", compute);
  return { calls, inScope: isInTmuxQueryMemoScope() };
});

record("answers a repeated question once inside one scope", {}, () => {
  let calls = 0;
  const compute = () => {
    calls += 1;
    return "windows";
  };
  const result = withTmuxQueryMemo(() => [
    memoizedTmuxQuery("list-windows", compute),
    memoizedTmuxQuery("list-windows", compute),
    memoizedTmuxQuery("list-windows", compute),
  ]);
  return { result, calls, inScope: isInTmuxQueryMemoScope() };
});

record("keys separately and includes cwd", {}, () => ({
  keys: [
    tmuxQueryKey(["list-windows", "-t", "s"]),
    tmuxQueryKey(["list-windows", "-t", "s"], "/repo/a"),
    tmuxQueryKey(["list-windows", "-t", "s"], "/repo/b"),
  ],
}));

record("clears even when the scope throws", {}, () => {
  try {
    withTmuxQueryMemo(() => {
      throw new Error("snapshot failed");
    });
  } catch (error) {
    return { thrown: error instanceof Error ? error.message : String(error), inScope: isInTmuxQueryMemoScope() };
  }
  return { thrown: null, inScope: isInTmuxQueryMemoScope() };
});

record("inherits an outer scope rather than nesting a fresh one", {}, () => {
  let calls = 0;
  const compute = () => {
    calls += 1;
    return "x";
  };
  const innerScope = withTmuxQueryMemo(() => {
    memoizedTmuxQuery("k", compute);
    return withTmuxQueryMemo(() => ({
      value: memoizedTmuxQuery("k", compute),
      inScope: isInTmuxQueryMemoScope(),
    }));
  });
  return { innerScope, calls, inScope: isInTmuxQueryMemoScope() };
});

record("memoizes a failure", {}, () => {
  let calls = 0;
  const thrown = [];
  withTmuxQueryMemo(() => {
    for (let i = 0; i < 2; i += 1) {
      try {
        memoizedTmuxQuery("k", () => {
          calls += 1;
          throw new Error("no server");
        });
      } catch (error) {
        thrown.push(error instanceof Error ? error.message : String(error));
      }
    }
  });
  return { calls, thrown };
});

record("re-asks after a reset", {}, () => {
  let calls = 0;
  withTmuxQueryMemo(() => {
    memoizedTmuxQuery("k", () => {
      calls += 1;
      return "x";
    });
    resetTmuxQueryMemo();
    memoizedTmuxQuery("k", () => {
      calls += 1;
      return "x";
    });
  });
  return { calls };
});

record("asks tmux once for a repeated read inside a scope", {}, () => {
  const log = [];
  const tmux = managerWith(log);
  withTmuxQueryMemo(() => {
    tmux.hasSession("s");
    tmux.hasSession("s");
    tmux.hasSession("s");
  });
  return { log };
});

record("re-reads after a mutation", {}, () => {
  const log = [];
  const tmux = managerWith(log);
  withTmuxQueryMemo(() => {
    tmux.hasSession("s");
    tmux.renameWindow("@1", "renamed");
    tmux.hasSession("s");
  });
  return { log };
});

record("never memoizes pane contents", {}, () => {
  const log = [];
  const tmux = managerWith(log);
  const target = { sessionName: "s", windowId: "@1", windowIndex: 0 };
  let captures;
  withTmuxQueryMemo(() => {
    captures = [tmux.captureTarget(target), tmux.captureTarget(target)];
  });
  return { captures, log };
});

record("keeps the memo across a pane capture", {}, () => {
  const log = [];
  const tmux = managerWith(log);
  const target = { sessionName: "s", windowId: "@1", windowIndex: 0 };
  withTmuxQueryMemo(() => {
    tmux.hasSession("s");
    tmux.captureTarget(target);
    tmux.hasSession("s");
  });
  return { log };
});

record("re-reads on every poll after reset", {}, () => {
  const log = [];
  const tmux = managerWith(log);
  withTmuxQueryMemo(() => {
    for (let i = 0; i < 3; i += 1) {
      resetTmuxQueryMemo();
      tmux.hasSession("s");
    }
  });
  return { log };
});

record("is inert with no scope open", {}, () => {
  const log = [];
  const tmux = managerWith(log);
  tmux.hasSession("s");
  tmux.hasSession("s");
  return { log };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-06T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-query-memo-contract.mjs",
  source: "src/tmux/query-memo.test.ts",
  subject: "src/tmux/query-memo.ts",
  description: "Tmux query memo behavior captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
