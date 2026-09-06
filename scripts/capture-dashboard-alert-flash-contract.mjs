#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("src/multiplexer/dashboard-alert-flash.contract.v1.json", ROOT);
const { applyDashboardAlert } = await import(new URL("dist/multiplexer/project-event-stream.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function runInput(input) {
  let renders = 0;
  const host = {
    mode: input.mode ?? "dashboard",
    footerFlash: input.initialFooterFlash ?? "previous flash",
    footerFlashTicks: input.initialFooterFlashTicks ?? 2,
    renderCurrentDashboardView: () => {
      renders += 1;
    },
  };
  applyDashboardAlert(host, input.event);
  return {
    footerFlash: host.footerFlash,
    footerFlashTicks: host.footerFlashTicks,
    renders,
  };
}

const cases = [];

function record(name, input) {
  const fullInput = { name, ...input };
  cases.push({
    id: `dashboard-alert-flash-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/multiplexer/project-event-stream.ts",
    api: "applyDashboardAlert",
    input: fullInput,
    output: runInput(input),
    inputSha256: hash(fullInput),
  });
}

const base = {
  type: "alert",
  projectId: "project",
  title: "Build blocked",
  message: "Needs attention",
  ts: "2026-09-07T00:00:00.000Z",
};

record("ignores alerts outside dashboard mode", {
  mode: "client",
  event: { ...base, kind: "notification", title: "Inbox" },
});
record("notification flashes alert title", {
  event: { ...base, kind: "notification", title: "Inbox ready" },
});
record("needs input uses session id", {
  event: { ...base, kind: "needs_input", sessionId: "codex-1" },
});
record("needs input falls back to agent", {
  event: { ...base, kind: "needs_input" },
});
record("next step uses session id", {
  event: { ...base, kind: "next_step", sessionId: "claude-2" },
});
record("next step falls back to agent", {
  event: { ...base, kind: "next_step" },
});
record("message waiting targets the session", {
  event: { ...base, kind: "message_waiting", sessionId: "codex-3" },
});
record("handoff waiting targets the session", {
  event: { ...base, kind: "handoff_waiting", sessionId: "claude-4" },
});
record("task assigned targets the session", {
  event: { ...base, kind: "task_assigned", sessionId: "aider-5" },
});
record("review waiting targets the session", {
  event: { ...base, kind: "review_waiting", sessionId: "reviewer-6" },
});
record("blocked flashes title", {
  event: { ...base, kind: "blocked", title: "Waiting on merge" },
});
record("task done flashes title", {
  event: { ...base, kind: "task_done", title: "Fixture captured" },
});
record("task failed flashes title", {
  event: { ...base, kind: "task_failed", title: "Fixture failed" },
});
record("interaction request does not flash", {
  event: { ...base, kind: "interaction_request", sessionId: "codex-7" },
});
record("unknown runtime kind does not flash", {
  event: { ...base, kind: "unknown_kind", sessionId: "codex-8" },
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-dashboard-alert-flash-contract.mjs",
  source: "src/multiplexer/project-event-stream.ts",
  subject: "applyDashboardAlert",
  description: "Dashboard alert footer flash behavior captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
