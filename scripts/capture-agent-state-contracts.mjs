#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);

const FIXTURES = {
  activityText: new URL("testdata/contracts/v1/agent-output/activity-text.json", ROOT),
  liveness: new URL("testdata/contracts/v1/agent-output/liveness.json", ROOT),
  status: new URL("testdata/contracts/v1/agent-status/chip.json", ROOT),
  restore: new URL("testdata/contracts/v1/agent-restore/state.json", ROOT),
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

const parser = await import(new URL("dist/agent-output-parser.js", ROOT));
const status = await import(new URL("dist/tui/render/agent-status.js", ROOT));
const text = await import(new URL("dist/tui/render/text.js", ROOT));
const paths = await import(new URL("dist/paths.js", ROOT));
const metadata = await import(new URL("dist/metadata-store.js", ROOT));
const sessionRuntime = await import(new URL("dist/multiplexer/session-runtime-core.js", ROOT));
const restore = await import(new URL("dist/runtime-core/agent-restore-state.js", ROOT));
const atomicWrite = await import(new URL("dist/atomic-write.js", ROOT));

function captureActivityText() {
  const source = "src/agent-output-activity-text.test.ts";
  const cases = [];
  const add = (name, pane, tool) => {
    const input = { pane, tool };
    const parsed = parser.parseAgentOutput(pane, { tool });
    const output = parser.activityTextFromParsedAgentOutput(parsed);
    cases.push(recordCase("agent-output-activity-text", cases.length, name, source, "activityTextFromParsedAgentOutput", input, output));
  };

  add("reads Claude's verb with its elapsed time and tokens", "✻ Jitterbugging… (2m 23s · ↓ 8.1k tokens)", "claude");
  for (const frame of ["✢", "✳", "✶", "✻", "✽", "·"]) {
    add("reads every spinner frame, not just the three it used to", `${frame} Transfiguring… (14s)`, "claude");
  }
  add("reads codex's line through the same path", "* Indexing… (running stop hook · 11s · ↓ 16 tokens)", "codex");
  add("drops codex's keybinding at 4s", "• Working (4s • esc to interrupt)", "codex");
  add("drops codex's keybinding at 12s", "• Working (12s • esc to interrupt)", "codex");
  add("refuses a finished codex turn", "- Worked for 20m 16s", "codex");
  add("refuses a finished claude turn", "✻ Cogitated for 35s · 3 shells still running", "claude");
  add("takes the newest line when the pane holds several", ["✻ Booting… (1s)", "⏺ Did a thing.", "✻ Jitterbugging… (2m 23s)"].join("\n"), "claude");
  add(
    "does not hand back the footer that shares its status block",
    ["✻ Jitterbugging… (2m 23s)", "sam@MacBook-Pro-4 ~/cs/aimux  42% (1M context)"].join("\n"),
    "claude",
  );
  add("is empty for a pane that is not reporting progress", "⏺ Here is the answer.", "claude");
  add("is empty for an empty pane", "", "claude");

  return {
    version: 1,
    source,
    generatedBy: "scripts/capture-agent-state-contracts.mjs",
    description: "Agent output activity-text contracts captured by running the TypeScript parser helper.",
    cases,
  };
}

function captureStatusChip() {
  const source = "src/tui/render/agent-status.test.ts";
  const cases = [];
  const add = (name, input) => {
    const rendered = status.renderAgentStatusChip(input);
    const output = {
      chip: status.agentStatusChip(input),
      rendered,
      visibleText: text.stripAnsi(rendered),
    };
    cases.push(recordCase("agent-status-chip", cases.length, name, source, "agentStatusChip/renderAgentStatusChip", input, output));
  };

  for (const activity of ["running", "waiting", "done", "idle", "error", "interrupted"]) {
    add(`maps activity ${activity} to a chip`, { activity });
  }
  for (const input of [
    { activity: "running", attention: "needs_input" },
    { activity: "running", attention: "error" },
    { activity: "idle", attention: "blocked" },
    { activity: "running", attention: "none" },
    { activity: "done", attention: "idle" },
    {},
    { activity: "bogus" },
    { activity: "waiting", userLabel: "working" },
    { activity: "idle", userLabel: "ready" },
    { attention: "needs_input", userLabel: "working" },
    { userLabel: "next_step" },
    { userLabel: "offline" },
  ]) {
    add("projects priority among userLabel, attention, and activity", input);
  }

  return {
    version: 1,
    source,
    generatedBy: "scripts/capture-agent-state-contracts.mjs",
    description: "Agent status chip contracts captured by running the TypeScript TUI renderer.",
    cases,
  };
}

function normalizeReadAgentOutput(value) {
  return JSON.parse(
    JSON.stringify(value, (key, nested) => {
      if (key === "sourceLines") return undefined;
      return nested === undefined ? undefined : nested;
    }),
  );
}

function hostWithPane(textValue, ansiText = textValue, tool = "codex") {
  const target = { sessionName: "aimux-test", windowId: "@1" };
  return {
    projectRoot: "",
    sessions: [{ id: "codex-1", command: tool, exited: false }],
    sessionTmuxTargets: new Map([["codex-1", target]]),
    sessionToolKeys: new Map([["codex-1", tool]]),
    tmuxRuntimeManager: {
      captureTarget: (_target, options) => (options.includeEscapes ? ansiText : textValue),
    },
  };
}

async function withTempProject(fn) {
  const previousAimuxHome = process.env.AIMUX_HOME;
  const aimuxHome = mkdtempSync(join(tmpdir(), "aimux-agent-state-home-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "aimux-agent-state-repo-"));
  process.env.AIMUX_HOME = aimuxHome;
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

async function captureLiveness() {
  const source = "src/multiplexer/agent-output-liveness.test.ts";
  const cases = [];
  const add = async (name, input, run) => {
    const output = await withTempProject(async (repoRoot) => run(repoRoot));
    cases.push(recordCase("agent-output-liveness", cases.length, name, source, "readAgentOutput", input, output));
  };
  const setDerived = (repoRoot, derived) => {
    metadata.updateSessionMetadata(
      "codex-1",
      (current) => (derived ? { ...current, derived } : current),
      repoRoot,
    );
  };

  await add(
    "reports fresh activity even when the pane is byte-for-byte identical",
    { pane: "nothing about this pane changes", reads: [{ derived: { activity: "running" } }, { derived: { activity: "done" } }] },
    async (repoRoot) => {
      const host = hostWithPane("nothing about this pane changes");
      host.projectRoot = repoRoot;
      setDerived(repoRoot, { activity: "running" });
      const first = await sessionRuntime.readAgentOutput(host, "codex-1");
      setDerived(repoRoot, { activity: "done" });
      const second = await sessionRuntime.readAgentOutput(host, "codex-1");
      return {
        first: normalizeReadAgentOutput(first),
        second: normalizeReadAgentOutput(second),
        sameMessagesReference: second.messages === first.messages,
      };
    },
  );

  await add("leaves activity undefined when the session has no derived state", { pane: "some output" }, async (repoRoot) => {
    const host = hostWithPane("some output");
    host.projectRoot = repoRoot;
    return normalizeReadAgentOutput(await sessionRuntime.readAgentOutput(host, "codex-1"));
  });

  await add("still projects the pane into messages", { pane: "> hello\n\nHi there" }, async (repoRoot) => {
    const host = hostWithPane("> hello\n\nHi there");
    host.projectRoot = repoRoot;
    return normalizeReadAgentOutput(await sessionRuntime.readAgentOutput(host, "codex-1"));
  });

  await add(
    "projects ANSI styling into cached messages",
    {
      pane: ["❯ ask", "⏺ red answer"].join("\n"),
      ansiPane: ["❯ ask", "⏺ \x1b[31mred\x1b[0m answer"].join("\n"),
    },
    async (repoRoot) => {
      const host = hostWithPane(
        ["❯ ask", "⏺ red answer"].join("\n"),
        ["❯ ask", "⏺ \x1b[31mred\x1b[0m answer"].join("\n"),
      );
      host.projectRoot = repoRoot;
      return normalizeReadAgentOutput(await sessionRuntime.readAgentOutput(host, "codex-1"));
    },
  );

  return {
    version: 1,
    source,
    generatedBy: "scripts/capture-agent-state-contracts.mjs",
    description: "readAgentOutput liveness contracts captured by running the TypeScript multiplexer helper.",
    cases,
  };
}

function normalizeVolatile(value) {
  const seen = new Map();
  let online = 0;
  return JSON.parse(
    JSON.stringify(value, (key, nested) => {
      if (typeof nested !== "string") return nested;
      if (key === "projectId" && nested.startsWith("aimux-agent-state-repo-")) return "<project-id>";
      if (key === "projectRoot" && nested.includes("aimux-agent-state-repo-")) return "<project-root>";
      if (key === "askedAt") return "<asked-at>";
      if ((key === "updatedAt" || key === "acknowledgedAt") && !nested.startsWith("2026-08-22T")) {
        return `<${key}>`;
      }
      if (key === "writerInstanceId") return "<writer-instance>";
      if (key === "id" && nested.startsWith("online-")) {
        if (!seen.has(nested)) seen.set(nested, `<online-${++online}>`);
        return seen.get(nested);
      }
      if (key === "snapshotId" && nested.startsWith("online-")) {
        if (!seen.has(nested)) seen.set(nested, `<online-${++online}>`);
        return seen.get(nested);
      }
      if (key === "id" && nested.startsWith("restore-online-")) {
        const sourceId = nested.slice("restore-".length);
        if (!seen.has(sourceId)) seen.set(sourceId, `<online-${++online}>`);
        return `restore-${seen.get(sourceId)}`;
      }
      return nested;
    }),
  );
}

function normalizePromptGateProjects(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalizePromptGateProjects);
  const entries = Object.entries(value).map(([key, nested]) => [
    key.startsWith("aimux-agent-state-repo-") ? "<project-id>" : key,
    normalizePromptGateProjects(nested),
  ]);
  return Object.fromEntries(entries);
}

async function captureRestoreState() {
  const source = "src/runtime-core/agent-restore-state.test.ts";
  const cases = [];

  const runCase = async (name, steps) => {
    const output = await withTempProject(async (repoRoot) => {
      mkdirSync(join(repoRoot, ".git"), { recursive: true });
      const events = [];
      const pathFor = (file) => join(paths.getProjectStateDir(), file);
      const seedGate = (now = "2026-08-22T01:01:00.000Z") =>
        restore.seedAgentRestorePromptGatesForDaemonBoot({
          daemonBootId: `daemon-${now}`,
          projects: [{ repoRoot }],
          now,
        });
      const writeProjectFile = (file, body) => atomicWrite.writeJsonAtomic(pathFor(file), body);
      for (const step of steps) {
        switch (step.op) {
          case "record":
            events.push({ step, result: restore.recordLastOnlineAgents(step.sessions, { now: step.now }) });
            break;
          case "readSnapshot":
            events.push({ step, result: restore.readLastOnlineAgentsSnapshot() });
            break;
          case "removeSnapshotSessions":
            events.push({ step, result: restore.removeLastOnlineAgentSessions(step.sessionIds, { now: step.now }) });
            break;
          case "writeFile":
            writeProjectFile(step.file, step.body);
            events.push({ step, result: "written" });
            break;
          case "rewriteSnapshotWriter": {
            const latest = restore.readLastOnlineAgentsSnapshot();
            writeProjectFile("last-online-agents.json", {
              ...latest,
              writerInstanceId: step.writerInstanceId,
            });
            events.push({ step, result: restore.readLastOnlineAgentsSnapshot() });
            break;
          }
          case "seedGate":
            events.push({ step, result: seedGate(step.now) });
            break;
          case "readGate":
            events.push({ step, result: restore.readAgentRestorePromptGate() });
            break;
          case "derive":
            events.push({ step, result: restore.deriveAgentRestoreOffer(step.liveSessionIds ?? [], { now: step.now }) });
            break;
          case "readOffer":
            events.push({ step, result: restore.readAgentRestoreOffer() });
            break;
          case "ack":
            restore.acknowledgeAgentRestoreOffer();
            events.push({ step, result: restore.readAgentRestoreOffer() });
            break;
          case "removeOfferSessions":
            events.push({ step, result: restore.removeAgentRestoreOfferSessions(step.sessionIds) });
            break;
          case "reconcile":
            events.push({
              step,
              result: restore.reconcileAgentRestoreOfferWithRestorableSessions(restore.readAgentRestoreOffer(), step.restorableSessionIds),
            });
            break;
          default:
            throw new Error(`unknown restore step ${step.op}`);
        }
      }
      return normalizePromptGateProjects(normalizeVolatile(events));
    });
    cases.push(recordCase("agent-restore-state", cases.length, name, source, "agentRestoreStateScenario", { steps }, output));
  };

  await runCase("records current online agents without prompting in the same process", [
    {
      op: "record",
      now: "2026-08-22T01:00:00.000Z",
      sessions: [
        { id: "claude-1", command: "claude", label: "claude(coder)" },
        { id: "codex-2", command: "codex", worktreePath: "/repo/.aimux/worktrees/feat" },
      ],
    },
    { op: "readSnapshot" },
    { op: "derive", liveSessionIds: [], now: "2026-08-22T01:01:00.000Z" },
    {
      op: "record",
      now: "2026-08-22T01:10:00.000Z",
      sessions: [
        { id: "claude-1", command: "claude", label: "claude(coder)" },
        { id: "codex-2", command: "codex", worktreePath: "/repo/.aimux/worktrees/feat" },
      ],
    },
  ]);
  await runCase("preserves the last online snapshot across an empty refresh", [
    { op: "record", now: "2026-08-22T01:00:00.000Z", sessions: [{ id: "claude-1", command: "claude" }] },
    { op: "record", now: "2026-08-22T01:01:00.000Z", sessions: [] },
    { op: "readSnapshot" },
  ]);
  await runCase("removes explicitly stopped sessions from the last online snapshot", [
    {
      op: "record",
      now: "2026-08-22T01:00:00.000Z",
      sessions: [
        { id: "claude-1", command: "claude" },
        { id: "codex-2", command: "codex" },
      ],
    },
    { op: "removeSnapshotSessions", now: "2026-08-22T01:01:00.000Z", sessionIds: ["claude-1"] },
    { op: "removeSnapshotSessions", now: "2026-08-22T01:02:00.000Z", sessionIds: ["codex-2"] },
    { op: "readSnapshot" },
  ]);
  await runCase("does not create an offer from a previous writer instance without a daemon-start gate", [
    {
      op: "writeFile",
      file: "last-online-agents.json",
      body: {
        version: 1,
        id: "snapshot-old",
        writerInstanceId: "previous-process",
        createdAt: "2026-08-22T01:00:00.000Z",
        updatedAt: "2026-08-22T01:00:00.000Z",
        sessionIds: ["claude-1"],
        sessions: [{ id: "claude-1", command: "claude", label: "claude(coder)" }],
      },
    },
    { op: "derive", liveSessionIds: [], now: "2026-08-22T01:02:00.000Z" },
    { op: "readOffer" },
  ]);
  await runCase("creates a one-shot offer from a daemon-start gate", [
    {
      op: "writeFile",
      file: "last-online-agents.json",
      body: {
        version: 1,
        id: "snapshot-old",
        writerInstanceId: "previous-process",
        createdAt: "2026-08-22T01:00:00.000Z",
        updatedAt: "2026-08-22T01:00:00.000Z",
        sessionIds: ["claude-1", "codex-2"],
        sessions: [
          { id: "claude-1", command: "claude", label: "claude(coder)" },
          { id: "codex-2", command: "codex", label: "codex(coder)" },
        ],
      },
    },
    { op: "seedGate" },
    { op: "derive", liveSessionIds: [], now: "2026-08-22T01:02:00.000Z" },
    { op: "readOffer" },
    { op: "readGate" },
    { op: "reconcile", restorableSessionIds: ["claude-1", "codex-2"] },
    { op: "readGate" },
    { op: "ack" },
    { op: "readOffer" },
    { op: "derive", liveSessionIds: [], now: "2026-08-22T01:03:00.000Z" },
  ]);
  await runCase("creates a previous-writer offer for only the offline subset when some agents are already live", [
    {
      op: "writeFile",
      file: "last-online-agents.json",
      body: {
        version: 1,
        id: "snapshot-old",
        writerInstanceId: "previous-process",
        createdAt: "2026-08-22T01:00:00.000Z",
        updatedAt: "2026-08-22T01:00:00.000Z",
        sessionIds: ["claude-1", "codex-2"],
        sessions: [
          { id: "claude-1", command: "claude", label: "claude(coder)" },
          { id: "codex-2", command: "codex", label: "codex(coder)" },
        ],
      },
    },
    { op: "seedGate" },
    { op: "derive", liveSessionIds: ["claude-1"], now: "2026-08-22T01:02:00.000Z" },
    { op: "readOffer" },
  ]);
  await runCase("clears a previous-writer offer when all snapshot agents are already live", [
    {
      op: "writeFile",
      file: "last-online-agents.json",
      body: {
        version: 1,
        id: "snapshot-old",
        writerInstanceId: "previous-process",
        createdAt: "2026-08-22T01:00:00.000Z",
        updatedAt: "2026-08-22T01:00:00.000Z",
        sessionIds: ["claude-1"],
        sessions: [{ id: "claude-1", command: "claude", label: "claude(coder)" }],
      },
    },
    { op: "seedGate" },
    { op: "derive", liveSessionIds: ["claude-1"], now: "2026-08-22T01:02:00.000Z" },
    { op: "readOffer" },
  ]);
  await runCase("starts a new prompt generation when a new writer records the same session ids", [
    {
      op: "writeFile",
      file: "last-online-agents.json",
      body: {
        version: 1,
        id: "snapshot-old",
        writerInstanceId: "previous-process",
        createdAt: "2026-08-22T01:00:00.000Z",
        updatedAt: "2026-08-22T01:00:00.000Z",
        sessionIds: ["claude-1"],
        sessions: [{ id: "claude-1", command: "claude" }],
      },
    },
    { op: "seedGate" },
    { op: "derive", liveSessionIds: [], now: "2026-08-22T01:01:00.000Z" },
    { op: "ack" },
    { op: "record", now: "2026-08-22T01:02:00.000Z", sessions: [{ id: "claude-1", command: "claude" }] },
    { op: "rewriteSnapshotWriter", writerInstanceId: "next-process" },
    { op: "seedGate", now: "2026-08-22T01:02:30.000Z" },
    { op: "derive", liveSessionIds: [], now: "2026-08-22T01:03:00.000Z" },
  ]);
  await runCase("continues updating the online snapshot while an old offer is unresolved", [
    {
      op: "writeFile",
      file: "last-online-agents.json",
      body: {
        version: 1,
        id: "snapshot-old",
        writerInstanceId: "previous-process",
        createdAt: "2026-08-22T01:00:00.000Z",
        updatedAt: "2026-08-22T01:00:00.000Z",
        sessionIds: ["claude-old"],
        sessions: [{ id: "claude-old", command: "claude" }],
      },
    },
    { op: "seedGate" },
    { op: "derive", liveSessionIds: [], now: "2026-08-22T01:01:00.000Z" },
    { op: "record", now: "2026-08-22T01:02:00.000Z", sessions: [{ id: "codex-new", command: "codex" }] },
    { op: "readOffer" },
    { op: "readSnapshot" },
    { op: "rewriteSnapshotWriter", writerInstanceId: "next-process" },
    { op: "seedGate", now: "2026-08-22T01:02:30.000Z" },
    { op: "derive", liveSessionIds: [], now: "2026-08-22T01:03:00.000Z" },
  ]);
  await runCase("removes restored sessions and acknowledges the offer after the last one", [
    {
      op: "writeFile",
      file: "last-online-agents.json",
      body: {
        version: 1,
        id: "snapshot-old",
        writerInstanceId: "previous-process",
        createdAt: "2026-08-22T01:00:00.000Z",
        updatedAt: "2026-08-22T01:00:00.000Z",
        sessionIds: ["claude-1", "codex-2"],
        sessions: [
          { id: "claude-1", command: "claude" },
          { id: "codex-2", command: "codex" },
        ],
      },
    },
    { op: "seedGate" },
    { op: "derive", liveSessionIds: [], now: "2026-08-22T01:02:00.000Z" },
    { op: "removeOfferSessions", sessionIds: ["claude-1"] },
    { op: "removeOfferSessions", sessionIds: ["codex-2"] },
    { op: "readOffer" },
    { op: "derive", liveSessionIds: [], now: "2026-08-22T01:03:00.000Z" },
  ]);
  await runCase("reconciles stale offers to the currently restorable offline inventory", [
    {
      op: "writeFile",
      file: "last-online-agents.json",
      body: {
        version: 1,
        id: "snapshot-old",
        writerInstanceId: "previous-process",
        createdAt: "2026-08-22T01:00:00.000Z",
        updatedAt: "2026-08-22T01:00:00.000Z",
        sessionIds: ["claude-ready", "codex-ready", "claude-stale", "codex-blocked"],
        sessions: [
          { id: "claude-ready", command: "claude", worktreePath: "/repo" },
          { id: "codex-ready", command: "codex", worktreePath: "/repo/.aimux/worktrees/feature-a" },
          { id: "claude-stale", command: "claude", worktreePath: "/repo/.aimux/worktrees/feature-a" },
          { id: "codex-blocked", command: "codex", worktreePath: "/repo/.aimux/worktrees/feature-a" },
        ],
      },
    },
    { op: "seedGate" },
    { op: "derive", liveSessionIds: [], now: "2026-08-22T01:02:00.000Z" },
    { op: "reconcile", restorableSessionIds: ["claude-ready", "codex-ready"] },
    { op: "readOffer" },
  ]);
  await runCase("groups legacy and repo-root main checkout sessions together", [
    {
      op: "writeFile",
      file: "last-online-agents.json",
      body: {
        version: 1,
        id: "snapshot-main-mixed",
        writerInstanceId: "previous-process",
        createdAt: "2026-08-22T01:00:00.000Z",
        updatedAt: "2026-08-22T01:00:00.000Z",
        sessionIds: ["claude-legacy", "codex-main"],
        sessions: [
          { id: "claude-legacy", command: "claude" },
          { id: "codex-main", command: "codex", worktreePath: "/repo" },
        ],
      },
    },
    { op: "seedGate" },
    { op: "derive", liveSessionIds: [], now: "2026-08-22T01:02:00.000Z" },
  ]);
  await runCase("deletes stale inventory-derived restore offers without prompting", [
    {
      op: "writeFile",
      file: "agent-restore-offer.json",
      body: {
        version: 1,
        id: "restore-inventory-old",
        snapshotId: "inventory-old",
        snapshotUpdatedAt: "2026-08-22T01:00:00.000Z",
        source: "restorable-inventory",
        createdAt: "2026-08-22T01:00:00.000Z",
        updatedAt: "2026-08-22T01:00:00.000Z",
        sessionIds: ["codex-stale"],
        sessions: [{ id: "codex-stale", command: "codex" }],
      },
    },
    { op: "readOffer" },
    { op: "derive", liveSessionIds: [], now: "2026-08-22T01:01:00.000Z" },
  ]);

  return {
    version: 1,
    source,
    generatedBy: "scripts/capture-agent-state-contracts.mjs",
    description: "Agent restore-state contracts captured by running TypeScript scenario transitions; volatile generated IDs are normalized.",
    cases,
  };
}

const contracts = {
  activityText: captureActivityText(),
  liveness: await captureLiveness(),
  status: captureStatusChip(),
  restore: await captureRestoreState(),
};

for (const [key, contract] of Object.entries(contracts)) {
  await writeContractJson(FIXTURES[key], contract);
  console.log(`${FIXTURES[key].pathname}: ${contract.cases.length} cases`);
}
