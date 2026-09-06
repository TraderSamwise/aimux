#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURES = {
  compactor: new URL("testdata/contracts/v1/context/compactor.json", ROOT),
  bridge: new URL("testdata/contracts/v1/context/bridge.json", ROOT),
  promptDelivery: new URL("testdata/contracts/v1/agent-prompt-delivery/delivery.json", ROOT),
};

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const recordCase = (idPrefix, index, name, source, api, input, output) => ({
  id: `${idPrefix}-${String(index + 1).padStart(3, "0")}`,
  name,
  source,
  api,
  input,
  output,
  inputSha256: hash(input),
});

const paths = await import(new URL("dist/paths.js", ROOT));
const history = await import(new URL("dist/context/history.js", ROOT));
const compactor = await import(new URL("dist/context/compactor.js", ROOT));
const bridge = await import(new URL("dist/context/context-bridge.js", ROOT));
const promptDelivery = await import(new URL("dist/agent-prompt-delivery.js", ROOT));

const target = {
  sessionName: "aimux-test",
  windowId: "@1",
  windowIndex: 1,
  windowName: "codex",
};

async function withTempProject(prefix, fn) {
  const previousAimuxHome = process.env.AIMUX_HOME;
  const aimuxHome = mkdtempSync(join(tmpdir(), `${prefix}-home-`));
  const repoRoot = mkdtempSync(join(tmpdir(), `${prefix}-repo-`));
  process.env.AIMUX_HOME = aimuxHome;
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  await paths.initPaths(repoRoot);
  try {
    return await fn(repoRoot);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(aimuxHome, { recursive: true, force: true });
    if (previousAimuxHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousAimuxHome;
  }
}

function normalizeTimestamps(value) {
  return JSON.parse(
    JSON.stringify(value, (key, nested) => {
      if (typeof nested !== "string") return nested;
      if ((key === "generatedAt" || key === "ts") && !nested.startsWith("2026-03-31T")) return `<${key}>`;
      if (key === "live" || key === "summary") {
        return nested.replace(/^Generated: .+$/m, "Generated: <generatedAt>").replace(/^Updated: .+$/m, "Updated: <updatedAt>");
      }
      return nested;
    }),
  );
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

async function captureCompactor() {
  const source = "src/context/compactor.test.ts";
  const cases = [];
  const runCase = async (name, input) => {
    const output = await withTempProject("aimux-priority2-compactor", () => {
      for (const turn of input.turns) history.appendTurn(input.sessionId, turn);
      for (let index = 0; index < (input.compactions ?? 1); index += 1) {
        compactor.algorithmicCompact([input.sessionId]);
      }
      const sessionDir = join(paths.getContextDir(), input.sessionId);
      const checkpoints = readIfExists(join(sessionDir, "summary.checkpoints.jsonl"))
        ?.trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      return normalizeTimestamps({
        summary: readIfExists(join(sessionDir, "summary.md")),
        meta: JSON.parse(readIfExists(join(sessionDir, "summary.meta.json")) ?? "null"),
        checkpoints,
        history: history.readHistory(input.sessionId),
      });
    });
    cases.push(recordCase("context-compactor", cases.length, name, source, "algorithmicCompact", input, output));
  };

  await runCase("writes summary provenance and append-only checkpoints", {
    sessionId: "claude-test",
    compactions: 1,
    turns: [
      { ts: "2026-03-31T00:00:00.000Z", type: "prompt", content: "write a poem" },
      { ts: "2026-03-31T00:00:05.000Z", type: "response", content: "here is a poem" },
    ],
  });
  await runCase("does not mutate raw history when compacting repeatedly", {
    sessionId: "codex-test",
    compactions: 2,
    turns: [
      { ts: "2026-03-31T00:10:00.000Z", type: "prompt", content: "investigate login bug" },
      { ts: "2026-03-31T00:10:05.000Z", type: "response", content: "found the root cause" },
    ],
  });

  return {
    version: 1,
    source,
    generatedBy: "scripts/capture-priority2-contracts.mjs",
    description: "Algorithmic compactor provenance and append-only checkpoint contracts captured by running TypeScript.",
    cases,
  };
}

async function captureContextBridge() {
  const source = "src/context/context-bridge.test.ts";
  const cases = [];
  const getParserFixture = (name) => {
    if (name === "codex-live-startup-suggestion-loop") {
      return [
        "╭──────────────────────────────────────────────╮",
        "│ >_ OpenAI Codex (v0.60.0)                    │",
        "╰──────────────────────────────────────────────╯",
        "",
        "› Find and fix a bug in @filename",
        "",
        "› Find and fix a bug in @filename",
      ].join("\n");
    }
    if (name === "claude-live-tool-action-rows") {
      return ["⏺ All checks are green", "⏺ Bash(cd /repo && yarn test)", "⏺ Read 2 files", "⏺ Update(src/relay.ts)"].join("\n");
    }
    throw new Error(`unknown parser fixture ${name}`);
  };
  const runCase = async (name, input) => {
    const output = await withTempProject("aimux-priority2-bridge", () => {
      const capture = () => input.fixture ? getParserFixture(input.fixture) : input.pane;
      const watcher = new bridge.ContextWatcher(capture, input.enabled === false ? { enabled: false } : undefined);
      const session = {
        id: input.sessionId,
        command: input.command,
        tmuxTarget: target,
      };
      for (let index = 0; index < (input.updateSessions ? 1 : input.captures ?? 1); index += 1) {
        if (input.updateSessions) watcher.updateSessions([session]);
        else watcher.capturePaneSnapshot(session);
      }
      const livePath = join(paths.getContextDir(), input.sessionId, "live.md");
      return normalizeTimestamps({
        live: readIfExists(livePath),
        history: history.readHistory(input.sessionId),
      });
    });
    cases.push(recordCase("context-bridge", cases.length, name, source, "ContextWatcher.capturePaneSnapshot", input, output));
  };

  await runCase("writes live.md from tmux pane snapshots when no structured history exists", {
    sessionId: "claude-live",
    command: "claude",
    pane: ["Streaming output", "Still thinking through the change"].join("\n"),
  });
  await runCase("seeds live.md as soon as a tmux-backed managed session is registered", {
    sessionId: "claude-registered",
    command: "claude",
    pane: ["Registered session output", "No history file yet"].join("\n"),
    updateSessions: true,
  });
  await runCase("does not write live.md when disabled", {
    sessionId: "claude-disabled",
    command: "claude",
    pane: "Streaming output",
    enabled: false,
    updateSessions: true,
  });
  await runCase("bounds live.md to recent pane content instead of growing unbounded", {
    sessionId: "claude-bounded",
    command: "claude",
    pane: Array.from({ length: 400 }, (_, index) => `line-${index.toString().padStart(3, "0")}`).join("\n"),
  });
  await runCase("does not capture terminal chrome as a Claude response turn", {
    sessionId: "claude-prompt",
    command: "claude",
    pane: ["sam@host ~/repo main", "▶▶ bypass permissions on (shift+tab to cycle)", "❯ "].join("\n"),
    captures: 2,
  });
  await runCase("captures only the last parsed response when Codex returns to a visible prompt", {
    sessionId: "codex-prompt",
    command: "codex",
    pane: ["• The work is complete.", "", "› Find and fix a bug in @filename"].join("\n"),
    captures: 2,
  });
  await runCase("does not capture Codex startup chrome as a response turn", {
    sessionId: "codex-startup",
    command: "codex",
    pane: [
      "╭──────────────────────────────────────────────╮",
      "│ >_ OpenAI Codex (v0.60.0)                    │",
      "│                                              │",
      "│ cwd: ~/repo                                  │",
      "╰──────────────────────────────────────────────╯",
      "",
      "› Find and fix a bug in @filename",
    ].join("\n"),
  });
  await runCase("does not capture Codex progress rows as a response turn", {
    sessionId: "codex-progress",
    command: "codex",
    pane: ["› reply exactly CODEX_OK", "", "• Starting MCP servers", "• Sautéed for 5s", "", "›"].join("\n"),
  });
  await runCase("does not capture mined Codex startup suggestion loops as response turns", {
    sessionId: "codex-startup-loop",
    command: "codex",
    fixture: "codex-live-startup-suggestion-loop",
  });
  await runCase("captures Claude responses without capturing mined tool action rows", {
    sessionId: "claude-tool-actions",
    command: "claude",
    pane: [getParserFixture("claude-live-tool-action-rows"), "", "❯ "].join("\n"),
  });

  return {
    version: 1,
    source,
    generatedBy: "scripts/capture-priority2-contracts.mjs",
    description: "Context bridge live snapshot and history-mining contracts captured by running TypeScript ContextWatcher.",
    cases,
  };
}

async function capturePromptDelivery() {
  const source = "src/agent-prompt-delivery.test.ts";
  const cases = [];
  const add = (name, api, input, output) => cases.push(recordCase("agent-prompt-delivery", cases.length, name, source, api, input, output));
  const runtimeFor = (captures, events) => ({
    captureCount: 0,
    sentText: [],
    carriageReturns: 0,
    captureTarget() {
      const value = captures[Math.min(this.captureCount, captures.length - 1)] ?? "";
      this.captureCount += 1;
      return value;
    },
    sendText(_target, text) {
      this.sentText.push(text);
    },
    sendCarriageReturn() {
      this.carriageReturns += 1;
    },
    output(eventsOut) {
      return {
        result: eventsOut,
        events,
        captureCount: this.captureCount,
        sentText: this.sentText,
        carriageReturns: this.carriageReturns,
      };
    },
  });

  for (const tool of ["codex", "claude"]) {
    const input = { tool, prompt: "Aimux task\n\nRun:\n  aimux task show t1\n", submit: true };
    add("normalizes submitted prompts to the reliable single-line shape", "normalizeSubmittedPrompt", input, promptDelivery.normalizeSubmittedPrompt(input.tool, input.prompt, input.submit));
  }
  add(
    "detects Codex pasted-content markers as visible drafts",
    "paneStillContainsPromptDraft",
    {
      pane: "› [Pasted Content 3434 chars]",
      draft: "This is a long aimux task prompt that Codex will collapse into a pasted-content marker.",
    },
    promptDelivery.paneStillContainsPromptDraft(
      { captureTarget: () => "› [Pasted Content 3434 chars]" },
      target,
      "This is a long aimux task prompt that Codex will collapse into a pasted-content marker.",
    ),
  );
  for (const pane of [
    ["• Ran yarn test", "", "────────────────────────────────", "", "› Write tests for @filename", "", "  gpt-5.5 high · ~/cs/thegrand"].join("\n"),
    ["Dropped. Moving on.", "", "✶ Embellishing... (26s)", "", "❯ take the next branch"].join("\n"),
    ["⏺ Ready", "", "❯", "  [Image #71] unrelated. rename Booking", "  to Artists on the sidebar", "  claude · ~/cs/thegrand"].join("\n"),
    ["› previous submitted prompt", "• Response from the agent", "  all done", "", "›", "  gpt-5.5 high · ~/cs/repo"].join("\n"),
    ["> quoted markdown", "  not a live prompt", "", "  claude · ~/cs/thegrand"].join("\n"),
  ]) {
    add("detects or ignores visible prompt input drafts", "detectVisiblePromptInputDraft", { pane }, promptDelivery.detectVisiblePromptInputDraft(pane));
  }

  const waitCases = [
    {
      name: "waits until visible prompt input stops changing",
      captures: ["› human draft one\n  gpt-5.5 high", "› human draft two\n  gpt-5.5 high", "› human draft two\n  gpt-5.5 high", "› human draft two\n  gpt-5.5 high"],
      options: { stablePolls: 2, pollMs: 1 },
    },
    {
      name: "force-sends after the maximum buffer delay when prompt input keeps changing",
      captures: ["› human draft 0\n  gpt-5.5 high", "› human draft 1\n  gpt-5.5 high", "› human draft 2\n  gpt-5.5 high"],
      options: { stablePolls: 3, pollMs: 1, maxWaitMs: 2 },
    },
    {
      name: "waits through an initially empty prompt before writing if a Claude draft appears",
      captures: ["❯\n  claude · ~/cs/thegrand", "❯\n  claude · ~/cs/thegrand", "❯ [Image #71] unrelat\n  claude · ~/cs/thegrand", "❯ [Image #71] unrelat\n  claude · ~/cs/thegrand", "❯ [Image #71] unrelat\n  claude · ~/cs/thegrand"],
      options: { noDraftStablePolls: 2, stablePolls: 2, pollMs: 1, maxWaitMs: 10 },
    },
    {
      name: "reports no draft after the empty prompt stays quiet",
      captures: ["❯\n  claude · ~/cs/thegrand"],
      options: { noDraftStablePolls: 2, pollMs: 1 },
    },
  ];
  for (const waitCase of waitCases) {
    const events = [];
    const runtime = runtimeFor(waitCase.captures, events);
    const result = await promptDelivery.waitForVisiblePromptInputIdle({
      tmuxRuntimeManager: runtime,
      target,
      isTargetCurrent: () => true,
      ...waitCase.options,
      onEvent: (event) => events.push(event),
    });
    add(waitCase.name, "waitForVisiblePromptInputIdle", waitCase, runtime.output(result));
  }

  for (const submit of [true, false]) {
    const events = [];
    const runtime = runtimeFor(
      submit ? ["› [Pasted Content 3434 chars]", "› [Pasted Content 3434 chars]", "› [Pasted Content 3434 chars]", ""] : [""],
      events,
    );
    const result = await promptDelivery.deliverTmuxPrompt({
      tmuxRuntimeManager: runtime,
      target,
      prompt: "Review task details and respond through aimux.",
      submit,
      isTargetCurrent: () => true,
    });
    add("delivers tmux prompts", "deliverTmuxPrompt", { submit }, runtime.output(result));
  }

  return {
    version: 1,
    source,
    generatedBy: "scripts/capture-priority2-contracts.mjs",
    description: "Agent prompt delivery normalization, draft detection, waiting, and submit contracts captured by running TypeScript.",
    cases,
  };
}

const contracts = {
  compactor: await captureCompactor(),
  bridge: await captureContextBridge(),
  promptDelivery: await capturePromptDelivery(),
};

for (const [key, contract] of Object.entries(contracts)) {
  await writeContractJson(FIXTURES[key], contract);
  console.log(`${FIXTURES[key].pathname}: ${contract.cases.length} cases`);
}
