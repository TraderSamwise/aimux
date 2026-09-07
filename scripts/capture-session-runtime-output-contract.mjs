#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/multiplexer/session-runtime-output.json", ROOT);

const { initPaths, getContextDir } = await import(new URL("dist/paths.js", ROOT));
const { updateSessionMetadata } = await import(new URL("dist/metadata-store.js", ROOT));
const { forgetAgentTranscript, readAgentOutput } = await import(new URL("dist/multiplexer/session-runtime-core.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalize(value, repoRoot, aimuxHome) {
  return JSON.parse(
    JSON.stringify(value)
      .split(repoRoot)
      .join("<REPO>")
      .split(aimuxHome)
      .join("<AIMUX_HOME>")
      .replaceAll(/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/g, "<ISO_DATE>"),
  );
}

function recorder() {
  const calls = [];
  return {
    calls,
    fn(method, impl) {
      return (...args) => {
        calls.push({ method, args: clone(args) });
        return impl?.(...args);
      };
    },
  };
}

function mapFromPairs(pairs = []) {
  return new Map(pairs.map(([key, value]) => [key, clone(value)]));
}

function makeHost(input, repoRoot) {
  const rec = recorder();
  const captureText = input.captureText ?? "";
  const captureAnsi = input.captureAnsi ?? captureText;
  const host = {
    projectRoot: repoRoot,
    sessions: clone(input.sessions ?? [{ id: input.sessionId, command: input.tool ?? "codex", status: "running" }]),
    sessionTmuxTargets: mapFromPairs(input.sessionTmuxTargets),
    sessionToolKeys: mapFromPairs(input.sessionToolKeys ?? [[input.sessionId, input.tool ?? "codex"]]),
    sessionWorktreePaths: mapFromPairs(input.sessionWorktreePaths ?? [[input.sessionId, repoRoot]]),
    sessionLabels: new Map(),
    sessionRoles: new Map(),
    sessionOriginalArgs: new Map([[input.sessionId, []]]),
    offlineSessions: [],
    tmuxRuntimeManager: {
      getTargetByWindowId: rec.fn("tmuxRuntimeManager.getTargetByWindowId", (_sessionName, windowId) => {
        const entry = (input.resolvedTargets ?? []).find(([candidate]) => candidate === windowId);
        return entry ? clone(entry[1]) : null;
      }),
      getWindowMetadata: rec.fn("tmuxRuntimeManager.getWindowMetadata", (target) => {
        const windowId = target?.windowId;
        const entry = (input.metadataByWindow ?? []).find(([candidate]) => candidate === windowId);
        return entry ? clone(entry[1]) : null;
      }),
      listProjectManagedWindows: rec.fn("tmuxRuntimeManager.listProjectManagedWindows", () =>
        clone(input.projectWindows ?? []),
      ),
      isWindowAlive: rec.fn("tmuxRuntimeManager.isWindowAlive", (target) => target?.alive !== false),
      captureTarget: rec.fn("tmuxRuntimeManager.captureTarget", (_target, options) =>
        options?.includeEscapes ? captureAnsi : captureText,
      ),
    },
  };
  return { host, calls: rec.calls };
}

function normalizeOutput(value) {
  return JSON.parse(
    JSON.stringify(value, (key, nested) => {
      if (key === "sourceLines") return undefined;
      return nested === undefined ? undefined : nested;
    }),
  );
}

async function withProject(input, fn) {
  const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-runtime-output-"));
  const aimuxHome = mkdtempSync(join(tmpdir(), "aimux-session-runtime-output-home-"));
  const previousAimuxHome = process.env.AIMUX_HOME;
  try {
    process.env.AIMUX_HOME = aimuxHome;
    await initPaths(repoRoot);
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    writeFileSync(join(repoRoot, ".aimux", "config.json"), "{}\n");
    return normalize(await fn(repoRoot, aimuxHome), repoRoot, aimuxHome);
  } finally {
    if (previousAimuxHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousAimuxHome;
    rmSync(aimuxHome, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

async function runCase(input) {
  return withProject(input, async (repoRoot, aimuxHome) => {
    forgetAgentTranscript(input.sessionId);
    if (input.derived) {
      updateSessionMetadata(input.sessionId, (current) => ({ ...current, derived: clone(input.derived) }), repoRoot);
    }
    const { host, calls } = makeHost(input, repoRoot);
    let result = null;
    let error = null;
    try {
      result = normalizeOutput(await readAgentOutput(host, input.sessionId, input.startLine));
    } catch (err) {
      error = err instanceof Error ? { name: err.name, message: err.message } : { name: "Error", message: String(err) };
    }
    const livePath = join(getContextDir(), input.sessionId, "live.md");
    const livePaneSnapshot = existsSync(livePath) ? readFileSync(livePath, "utf-8") : null;
    forgetAgentTranscript(input.sessionId);
    return {
      result,
      error,
      calls,
      sessionTmuxTargets: [...host.sessionTmuxTargets.entries()],
      livePaneSnapshot,
      aimuxHome,
    };
  });
}

const baseTarget = { sessionName: "aimux-test", windowId: "@1", windowIndex: 1, windowName: "codex" };

const inputs = [
  {
    name: "revalidates cached target and captures ansi output once",
    input: {
      sessionId: "codex-output-1",
      tool: "codex",
      captureText: "> hello\n\nHi there",
      captureAnsi: "> hello\n\n\u001b[32mHi\u001b[0m there",
      sessionTmuxTargets: [["codex-output-1", baseTarget]],
      resolvedTargets: [["@1", { ...baseTarget, windowIndex: 2 }]],
      metadataByWindow: [["@1", { kind: "agent", sessionId: "codex-output-1" }]],
      derived: { activity: "idle", attention: "normal" },
    },
  },
  {
    name: "drops a stale cached target when no live replacement exists",
    input: {
      sessionId: "codex-output-stale",
      sessionTmuxTargets: [["codex-output-stale", { ...baseTarget, windowId: "@stale" }]],
      resolvedTargets: [["@stale", null]],
      projectWindows: [],
      captureText: "should not capture",
    },
  },
  {
    name: "adopts a scanned project window after cached metadata mismatch",
    input: {
      sessionId: "codex-output-scan",
      sessionTmuxTargets: [["codex-output-scan", { ...baseTarget, windowId: "@wrong" }]],
      resolvedTargets: [["@wrong", { ...baseTarget, windowId: "@wrong" }]],
      metadataByWindow: [["@wrong", { kind: "agent", sessionId: "other" }]],
      projectWindows: [
        { target: { ...baseTarget, windowId: "@other", windowIndex: 4 }, metadata: { kind: "agent", sessionId: "other" } },
        {
          target: { ...baseTarget, windowId: "@dead", windowIndex: 5, alive: false },
          metadata: { kind: "agent", sessionId: "codex-output-scan" },
        },
        { target: { ...baseTarget, windowId: "@live", windowIndex: 6 }, metadata: { kind: "agent", sessionId: "codex-output-scan" } },
      ],
      captureText: "scan adopted output",
    },
  },
  {
    name: "clamps very negative start lines to the bounded tail window",
    input: {
      sessionId: "codex-output-bounds",
      startLine: -5000,
      captureText: "bounded output",
      sessionTmuxTargets: [["codex-output-bounds", baseTarget]],
      resolvedTargets: [["@1", baseTarget]],
      metadataByWindow: [["@1", { kind: "agent", sessionId: "codex-output-bounds" }]],
    },
  },
  {
    name: "reports interrupted and blanks progress when the pane shows an interruption prompt",
    input: {
      sessionId: "claude-output-interrupted",
      tool: "claude",
      captureText: ["• Working (4s · esc to interrupt)", "", "Interrupted · What should Claude do instead?"].join("\n"),
      sessionTmuxTargets: [["claude-output-interrupted", baseTarget]],
      resolvedTargets: [["@1", baseTarget]],
      metadataByWindow: [["@1", { kind: "agent", sessionId: "claude-output-interrupted" }]],
      derived: { activity: "running", attention: "normal" },
    },
  },
];

const cases = [];
for (const [index, entry] of inputs.entries()) {
  const input = clone(entry.input);
  cases.push({
    id: `session-runtime-output-${String(index + 1).padStart(3, "0")}`,
    name: entry.name,
    source: "src/multiplexer/session-runtime-core.ts",
    api: "readAgentOutput",
    input,
    output: await runCase(input),
    inputSha256: hash(input),
  });
}

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/session-runtime-core.ts",
  generatedBy: "scripts/capture-session-runtime-output-contract.mjs",
  description: "readAgentOutput target validation, capture window, and liveness parity captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
