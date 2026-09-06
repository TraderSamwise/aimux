#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/replace-window.json", ROOT);
const { TmuxRuntimeManager } = await import(new URL("dist/tmux/runtime-manager.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const target = { sessionName: "aimux-mobile-abc", windowId: "@1", windowIndex: 0, windowName: "dashboard" };
const spec = {
  cwd: "/repo/mobile",
  command: "/usr/local/bin/node",
  args: ["/repo/mobile/dist/launcher-bin.js", "--tmux-dashboard-internal"],
};
const readiness = { option: "@ready", value: "stamp", timeoutMs: 100 };

function normalizeString(value) {
  return value.replace(/aimux-reload-[A-Za-z0-9_-]+/g, "<RELOAD_WINDOW>");
}

function normalize(value) {
  if (typeof value === "string") return normalizeString(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, normalize(val)]));
  return value;
}

const cases = [];
function record(name, input) {
  const calls = [];
  const exec = (args, options) => {
    calls.push(options === undefined ? [...args] : [...args, { cwd: options.cwd }]);
    const joined = args.join(" ");
    if (joined === "display-message -p -t @1 #{window_active}") return input.wasActive ? "1" : "0";
    if (joined.startsWith("new-window -d -P -t aimux-mobile-abc ")) return "@2\t2\taimux-reload-1-fixed";
    if (joined === "show-window-options -v -t @2 @ready") return "stamp";
    if (input.swapError && joined === "swap-window -d -s @2 -t @1") throw new Error(input.swapError);
    if (joined.startsWith("list-windows -t aimux-mobile-abc -F ")) {
      return ["@2\t0\tdashboard\t1\t100\t0", "@1\t2\tdashboard-old\t0\t90\t0"].join("\n");
    }
    return "";
  };
  const tmux = new TmuxRuntimeManager(exec);
  let output;
  try {
    output = { thrown: null, result: tmux.replaceWindowWhenReady(target, spec, readiness), calls };
  } catch (error) {
    output = { thrown: error instanceof Error ? error.message : String(error), result: null, calls };
  }
  const fullInput = { name, ...input, target, spec, readiness };
  cases.push({
    id: `tmux-replace-window-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/runtime-manager.ts",
    api: "TmuxRuntimeManager.replaceWindowWhenReady",
    input: fullInput,
    output: normalize(output),
    inputSha256: hash(fullInput),
  });
}

record("replaces and reselects an active window after readiness", { wasActive: true });
record("replaces without reselecting an inactive window after readiness", { wasActive: false });
record("rolls back renamed windows and kills replacement when swap fails", {
  wasActive: true,
  swapError: "swap failed",
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-replace-window-contract.mjs",
  source: "src/tmux/runtime-manager.ts",
  subject: "src/tmux/runtime-manager.ts",
  description: "TmuxRuntimeManager.replaceWindowWhenReady behavior captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
