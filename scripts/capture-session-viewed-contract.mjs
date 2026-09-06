#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/runtime-state/session-viewed.json", ROOT);
const paths = await import(new URL("dist/paths.js", ROOT));
const metadata = await import(new URL("dist/metadata-store.js", ROOT));
const notifications = await import(new URL("dist/notifications.js", ROOT));
const viewed = await import(new URL("dist/session-viewed.js", ROOT));
const semantics = await import(new URL("dist/session-semantics.js", ROOT));
const { initPaths } = paths;
const { loadMetadataState, updateSessionMetadata } = metadata;
const { addNotification, listNotifications } = notifications;
const { markSessionViewed } = viewed;
const { deriveSessionSemantics } = semantics;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};
const cases = [];
function record(name, input, output) {
  cases.push({
    id: `runtime-state-session-viewed-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/session-viewed.test.ts",
    api: "markSessionViewed",
    input,
    output,
    inputSha256: hash(input),
  });
}
async function withProject(callback) {
  const previousHome = process.env.AIMUX_HOME;
  const aimuxHome = mkdtempSync(join(tmpdir(), "aimux-session-viewed-home-contract-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "aimux-session-viewed-contract-"));
  process.env.AIMUX_HOME = aimuxHome;
  mkdirSync(join(repoRoot, ".git"), { recursive: true });
  try {
    await initPaths(repoRoot);
    return callback(repoRoot);
  } finally {
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(aimuxHome, { recursive: true, force: true });
  }
}
function seedAttention(repoRoot, sessionId, attention, activity = "waiting", unseenCount = 3) {
  updateSessionMetadata(
    sessionId,
    (current) => ({
      ...current,
      derived: { ...(current.derived ?? {}), activity, attention, unseenCount },
    }),
    repoRoot,
  );
}
function summarize(repoRoot, sessionId, result, extra = {}) {
  const derived = loadMetadataState(repoRoot).sessions[sessionId]?.derived;
  const sessionNotifications = listNotifications({ sessionId, projectRoot: repoRoot });
  return {
    result,
    derived,
    semanticLabel: deriveSessionSemantics({ status: "running", ...derived }).user.label,
    notificationUnread: sessionNotifications.map((record) => record.unread),
    notificationCount: sessionNotifications.length,
    ...extra,
  };
}

record(
  "marks notifications read and clears generic needs-input attention by default",
  { sessionId: "claude-1", derived: { activity: "waiting", attention: "needs_input", unseenCount: 3 }, notifications: [{ kind: "needs_input" }] },
  await withProject((repoRoot) => {
    seedAttention(repoRoot, "claude-1", "needs_input");
    addNotification({ title: "Needs input", body: "Agent is waiting", sessionId: "claude-1", kind: "needs_input" });
    return summarize(repoRoot, "claude-1", markSessionViewed("claude-1", repoRoot));
  }),
);
record(
  "marks notifications read in the explicit project root",
  { sessionId: "claude-other", explicitProjectRoot: true, derived: { activity: "waiting", attention: "needs_input", unseenCount: 2 }, notifications: [{ kind: "needs_input" }] },
  await withProject(async (repoRoot) => {
    const otherRoot = mkdtempSync(join(tmpdir(), "aimux-session-viewed-other-contract-"));
    mkdirSync(join(otherRoot, ".git"), { recursive: true });
    try {
      seedAttention(otherRoot, "claude-other", "needs_input", "waiting", 2);
      addNotification({ title: "Other project", body: "Agent is waiting", sessionId: "claude-other", kind: "needs_input", projectRoot: otherRoot });
      const result = markSessionViewed("claude-other", otherRoot);
      return summarize(otherRoot, "claude-other", result, { defaultProjectNotificationCount: listNotifications({ sessionId: "claude-other", projectRoot: repoRoot }).length });
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  }),
);
record(
  "leaves a genuinely working agent's activity untouched",
  { sessionId: "claude-busy", derived: { activity: "running", attention: "normal", unseenCount: 1 }, notifications: [] },
  await withProject((repoRoot) => {
    seedAttention(repoRoot, "claude-busy", "normal", "running", 1);
    return summarize(repoRoot, "claude-busy", markSessionViewed("claude-busy", repoRoot));
  }),
);
record(
  "does not clear formal interaction attention by default",
  { sessionId: "codex-ask", derived: { activity: "waiting", attention: "needs_response", unseenCount: 3 }, notifications: [{ kind: "interaction_request" }] },
  await withProject((repoRoot) => {
    seedAttention(repoRoot, "codex-ask", "needs_response");
    addNotification({ title: "Question", body: "Pick an option", sessionId: "codex-ask", kind: "interaction_request" });
    return summarize(repoRoot, "codex-ask", markSessionViewed("codex-ask", repoRoot));
  }),
);
record(
  "does not clear blocked attention on view",
  { sessionId: "codex-blocked", derived: { activity: "waiting", attention: "blocked", unseenCount: 3 }, notifications: [] },
  await withProject((repoRoot) => {
    seedAttention(repoRoot, "codex-blocked", "blocked");
    return summarize(repoRoot, "codex-blocked", markSessionViewed("codex-blocked", repoRoot));
  }),
);
record(
  "honors view behavior config overrides",
  {
    sessionId: "codex-ask",
    config: { notifications: { markReadOnView: false, clearNeedsInputOnView: false, clearFormalInteractionsOnView: true } },
    derived: { activity: "waiting", attention: "needs_response", unseenCount: 3 },
    notifications: [{ kind: "interaction_request" }],
  },
  await withProject((repoRoot) => {
    mkdirSync(join(repoRoot, ".aimux"), { recursive: true });
    writeFileSync(join(repoRoot, ".aimux/config.json"), `${JSON.stringify({ notifications: { markReadOnView: false, clearNeedsInputOnView: false, clearFormalInteractionsOnView: true } }, null, 2)}\n`);
    seedAttention(repoRoot, "codex-ask", "needs_response");
    addNotification({ title: "Question", body: "Pick an option", sessionId: "codex-ask", kind: "interaction_request" });
    return summarize(repoRoot, "codex-ask", markSessionViewed("codex-ask", repoRoot));
  }),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/session-viewed.test.ts",
  generatedBy: "scripts/capture-session-viewed-contract.mjs",
  description: "Session viewed metadata attention, activity, notification read, explicit-project, and config override contracts captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
