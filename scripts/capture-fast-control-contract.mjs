#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/fast-control/switching.json", ROOT);

const paths = await import(new URL("dist/paths.js", ROOT));
const metadataStore = await import(new URL("dist/metadata-store.js", ROOT));
const fastControl = await import(new URL("dist/fast-control.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function normalize(value, base) {
  const roots = [base];
  try {
    const canonical = realpathSync(base);
    if (canonical !== base) roots.push(canonical);
  } catch {
    // Temporary directory may have been intentionally removed.
  }
  return JSON.parse(
    JSON.stringify(value, (_key, nested) => {
      if (typeof nested !== "string") return nested;
      return roots.reduce((text, root) => text.replaceAll(root, "<root>"), nested);
    }),
  );
}

function target(windowId, windowIndex, windowName, sessionName = "aimux-repo-abc") {
  return { sessionName, windowId, windowIndex, windowName };
}

function entry(windowId, windowIndex, sessionId, command, worktreePath, metadata = {}) {
  return {
    target: target(windowId, windowIndex, command),
    metadata: {
      kind: "agent",
      sessionId,
      label: metadata.label ?? sessionId,
      command,
      worktreePath,
      ...metadata,
    },
    alive: metadata.alive ?? true,
    activity: metadata.activity ?? windowIndex,
  };
}

function service(windowId, windowIndex, sessionId, worktreePath, metadata = {}) {
  return {
    target: target(windowId, windowIndex, metadata.windowName ?? "shell"),
    metadata: {
      kind: "service",
      sessionId,
      label: metadata.label ?? "shell",
      command: metadata.command ?? "shell",
      worktreePath,
      ...metadata,
    },
    alive: metadata.alive ?? true,
    activity: metadata.activity ?? windowIndex,
  };
}

function fakeTmux(input) {
  const entries = input.entries;
  return {
    getProjectSession: () => ({ sessionName: "aimux-repo-abc" }),
    listManagedWindows: () => entries.map(({ target, metadata }) => ({ target, metadata })),
    isWindowAlive: (target) => entries.find((entry) => entry.target.windowId === target.windowId)?.alive !== false,
    listWindows: () =>
      entries.map((entry) => ({
        id: entry.target.windowId,
        index: entry.target.windowIndex,
        name: entry.target.windowName,
        active: entry.target.windowId === input.context.currentWindowId,
        activity: entry.activity,
      })),
    isClientSessionName: (sessionName) => /-client-[a-f0-9]{8}$/.test(sessionName),
  };
}

function serialize(item) {
  return item ? fastControl.serializeFastControlItem(item) : null;
}

function runCall(input, call) {
  const tmux = fakeTmux(input);
  const options = call.options ?? {};
  if (call.fn === "list") {
    return fastControl.listSwitchableAgentItems(input.context, tmux, options).map(serialize);
  }
  if (call.fn === "next") return serialize(fastControl.resolveNextAgent(input.context, tmux, options));
  if (call.fn === "prev") return serialize(fastControl.resolvePrevAgent(input.context, tmux, options));
  throw new Error(`unknown fast-control call: ${call.fn}`);
}

async function withProject(label, buildInput) {
  const base = mkdtempSync(join(tmpdir(), `aimux-fast-control-contract-${label}-`));
  try {
    const projectRoot = join(base, "repo");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    await paths.initPaths(projectRoot);
    const input = { scenario: label, ...buildInput(projectRoot) };
    metadataStore.saveMetadataState({ version: 1, sessions: input.metadataSessions ?? {} }, projectRoot);
    const output = Object.fromEntries(input.calls.map((call) => [call.name, runCall(input, call)]));
    return { input: normalize(input, base), output: normalize(output, base) };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

const cases = [];
const add = async (name, scenario, buildInput) => {
  const { input, output } = await withProject(scenario, buildInput);
  cases.push({
    id: `fast-control-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/fast-control.test.ts",
    input,
    output,
    inputSha256: hash(input),
  });
};

await add("omits the overseer from switchable agents unless explicitly requested", "overseer-filter", (root) => ({
  context: { projectRoot: root, currentClientSession: "aimux-repo-abc-client-123", currentWindow: "codex", currentWindowId: "@1", currentPath: root },
  metadataSessions: { boss: { overseer: true } },
  entries: [
    entry("@1", 1, "coder", "codex", root, { label: "Coder" }),
    entry("@2", 2, "boss", "claude", root, {
      label: "Overseer",
      team: { teamId: "overseer", parentSessionId: "", role: "overseer" },
    }),
  ],
  calls: [
    { name: "default", fn: "list" },
    { name: "includeOverseer", fn: "list", options: { includeOverseer: true } },
  ],
}));

await add("does not switch from an active overseer into normal agents", "current-overseer", (root) => ({
  context: { projectRoot: root, currentClientSession: "aimux-repo-abc-client-123", currentWindow: "claude", currentWindowId: "@2", currentPath: root },
  metadataSessions: { boss: { overseer: true } },
  entries: [
    entry("@1", 1, "coder", "codex", root, { label: "Coder" }),
    entry("@2", 2, "boss", "claude", root, {
      label: "Overseer",
      overseer: true,
      team: { teamId: "overseer", parentSessionId: "", role: "overseer" },
    }),
  ],
  calls: [
    { name: "items", fn: "list" },
    { name: "next", fn: "next" },
    { name: "prev", fn: "prev" },
  ],
}));

await add("omits the scribe from switchable agents", "scribe-filter", (root) => ({
  context: { projectRoot: root, currentClientSession: "aimux-repo-abc-client-123", currentWindow: "codex", currentWindowId: "@1", currentPath: root },
  metadataSessions: { scribe: { scribe: true } },
  entries: [
    entry("@1", 1, "coder", "codex", root, { label: "Coder" }),
    entry("@2", 2, "scribe", "claude", root, {
      label: "Scribe",
      projectControl: false,
      team: { teamId: "scribe", parentSessionId: "", role: "scribe" },
    }),
  ],
  calls: [{ name: "items", fn: "list" }],
}));

await add("does not switch from an active scribe into normal agents", "current-scribe", (root) => ({
  context: { projectRoot: root, currentClientSession: "aimux-repo-abc-client-123", currentWindow: "claude", currentWindowId: "@2", currentPath: root },
  metadataSessions: { scribe: { scribe: true } },
  entries: [
    entry("@1", 1, "coder", "codex", root, { label: "Coder" }),
    entry("@2", 2, "scribe", "claude", root, {
      label: "Scribe",
      projectControl: false,
      team: { teamId: "scribe", parentSessionId: "", role: "scribe" },
    }),
  ],
  calls: [
    { name: "next", fn: "next" },
    { name: "prev", fn: "prev" },
  ],
}));

await add("uses current window metadata worktree when cwd is outside the worktree", "metadata-worktree-scope", (root) => {
  const worktree = join(root, ".aimux/worktrees/tealchart-cleanup-11");
  return {
    context: { projectRoot: root, currentClientSession: "aimux-repo-abc-client-123", currentWindow: "claude", currentWindowId: "@593", currentPath: "/private/tmp/tealstreet-pr5180" },
    entries: [
      entry("@593", 4, "claude-a", "claude", worktree, { label: "Claude" }),
      entry("@594", 5, "codex-b", "codex", worktree, { label: "Codex" }),
    ],
    calls: [{ name: "items", fn: "list" }],
  };
});

await add("keeps unlinked worktree candidates after client-session ordering", "unlinked-worktree-candidates", () => ({
  context: { projectRoot: "/repo", currentClientSession: "aimux-repo-abc-client-123", currentWindow: "claude", currentWindowId: "@596", currentPath: "/private/tmp/tealstreet-pr5180" },
  entries: [
    entry("@596", 1, "claude-a", "claude", "/private/tmp/tealstreet-pr5180", { label: "Claude", activity: 100 }),
    entry("@597", 4, "codex-b", "codex", "/private/tmp/tealstreet-pr5180", { label: "Codex", activity: 90 }),
  ],
  calls: [{ name: "items", fn: "list" }],
}));

await add("renders compact switch labels for autogenerated agent names and services", "compact-labels", (root) => ({
  context: { projectRoot: root, currentClientSession: "aimux-repo-abc-client-123", currentWindow: "claude", currentWindowId: "@1", currentPath: join(root, "wt") },
  entries: [
    entry("@1", 1, "claude-zjlduv", "claude", join(root, "wt"), { label: "claude-zjlduv", role: "coder", activity: 100 }),
    service("@2", 2, "shell-1", join(root, "wt"), { label: "shell", activity: 90 }),
  ],
  calls: [{ name: "items", fn: "list" }],
}));

await add("keeps root navigation out of teammate windows in the same worktree", "root-navigation-excludes-teammates", (root) => ({
  context: { projectRoot: root, currentClientSession: "aimux-repo-abc-client-123", currentWindow: "parent", currentWindowId: "@1", currentPath: join(root, "wt") },
  entries: [
    entry("@1", 1, "parent", "claude", join(root, "wt"), { label: "parent", activity: 100 }),
    entry("@2", 2, "reviewer", "codex", join(root, "wt"), {
      label: "reviewer",
      team: { teamId: "team-parent", parentSessionId: "parent", role: "reviewer", order: 1 },
      activity: 90,
    }),
    service("@3", 3, "shell-1", join(root, "wt"), { label: "shell", activity: 80 }),
  ],
  calls: [
    { name: "items", fn: "list" },
    { name: "next", fn: "next" },
    { name: "prev", fn: "prev" },
  ],
}));

await add("cycles only direct teammates after entering teammate land", "direct-teammates", (root) => ({
  context: { projectRoot: root, currentClientSession: "aimux-repo-abc-client-123", currentWindow: "implementer", currentWindowId: "@2", currentPath: join(root, "other") },
  entries: [
    entry("@1", 1, "parent", "claude", join(root, "wt"), { label: "parent", activity: 100 }),
    entry("@2", 4, "implementer", "codex", join(root, "other"), {
      label: "implementer",
      team: { teamId: "team-parent", parentSessionId: "parent", role: "coder", order: 2 },
      activity: 90,
    }),
    entry("@3", 3, "reviewer", "codex", join(root, "wt"), {
      label: "reviewer",
      team: { teamId: "team-parent", parentSessionId: "parent", role: "reviewer", order: 1 },
      activity: 80,
    }),
    entry("@4", 2, "other-team", "codex", join(root, "wt"), {
      label: "other-team",
      team: { teamId: "team-other", parentSessionId: "other-parent", role: "coder", order: 0 },
      activity: 70,
    }),
    service("@5", 5, "shell-1", join(root, "wt"), { label: "shell", activity: 60 }),
  ],
  calls: [
    { name: "items", fn: "list" },
    { name: "next", fn: "next" },
    { name: "prev", fn: "prev" },
  ],
}));

await add("uses a dead current teammate window only for teammate scoping", "dead-current-teammate", (root) => ({
  context: { projectRoot: root, currentClientSession: "aimux-repo-abc-client-123", currentWindow: "dead-coder", currentWindowId: "@2", currentPath: join(root, "wt") },
  entries: [
    entry("@1", 1, "parent", "claude", join(root, "wt"), { label: "parent", activity: 100 }),
    entry("@2", 2, "dead-coder", "codex", join(root, "wt"), {
      label: "dead-coder",
      team: { teamId: "team-parent", parentSessionId: "parent", role: "coder", order: 1 },
      alive: false,
      activity: 90,
    }),
    entry("@3", 3, "reviewer", "codex", join(root, "other"), {
      label: "reviewer",
      team: { teamId: "team-parent", parentSessionId: "parent", role: "reviewer", order: 2 },
      activity: 80,
    }),
    entry("@4", 4, "other-team", "codex", join(root, "wt"), {
      label: "other-team",
      team: { teamId: "team-other", parentSessionId: "other-parent", role: "coder", order: 1 },
      activity: 70,
    }),
  ],
  calls: [
    { name: "items", fn: "list" },
    { name: "next", fn: "next" },
    { name: "prev", fn: "prev" },
  ],
}));

await add("excludes dead managed windows from switch controls", "dead-windows", (root) => ({
  context: { projectRoot: root, currentClientSession: "aimux-repo-abc-client-123", currentWindow: "claude", currentWindowId: "@1", currentPath: join(root, "wt") },
  entries: [
    entry("@1", 1, "claude-a", "claude", join(root, "wt"), { label: "Claude A", activity: 100 }),
    entry("@2", 2, "codex-b", "codex", join(root, "wt"), { label: "Codex B", alive: false, activity: 90 }),
    entry("@3", 3, "claude-c", "claude", join(root, "wt"), { label: "Claude C", activity: 80 }),
  ],
  calls: [
    { name: "items", fn: "list" },
    { name: "next", fn: "next" },
    { name: "prev", fn: "prev" },
  ],
}));

await add("uses a dead current root window only for next/prev ordering", "dead-current-root", (root) => ({
  context: { projectRoot: root, currentClientSession: "aimux-repo-abc-client-123", currentWindow: "codex", currentWindowId: "@2", currentPath: join(root, "wt") },
  entries: [
    entry("@1", 1, "claude-a", "claude", join(root, "wt"), { label: "Claude A", activity: 100 }),
    entry("@2", 2, "codex-b", "codex", join(root, "wt"), { label: "Codex B", alive: false, activity: 90 }),
    entry("@3", 3, "claude-c", "claude", join(root, "wt"), { label: "Claude C", activity: 80 }),
  ],
  calls: [
    { name: "items", fn: "list" },
    { name: "next", fn: "next" },
    { name: "prev", fn: "prev" },
  ],
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/fast-control.test.ts",
  generatedBy: "scripts/capture-fast-control-contract.mjs",
  description: "Fast-control switchable-agent filtering, project-control guards, worktree scoping, teammate navigation, liveness, and serialization contracts captured by running TypeScript fast-control helpers.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
