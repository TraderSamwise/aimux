#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/project-observability/observability.json", ROOT);

const observability = await import(new URL("dist/project-observability.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function task(over = {}) {
  return {
    id: "t1",
    status: "pending",
    assignedBy: "user",
    description: "do a thing",
    prompt: "do a thing",
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    ...over,
  };
}

function notif(over = {}) {
  return {
    id: "n1",
    title: "Needs input",
    body: "please respond",
    unread: true,
    cleared: false,
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
    ...over,
  };
}

const cases = [];
function add(name, scenario, input) {
  cases.push({
    id: `project-observability-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/project-observability.test.ts",
    input: { scenario, ...input },
    output: observability.buildProjectObservability(input),
    inputSha256: hash(input),
  });
}

add("rolls up agent/service/worktree/task/notification summary", "summary-rollup", {
  sessions: [
    { status: "running" },
    { status: "idle" },
    { status: "ready" },
    { status: "waiting" },
    { status: "offline" },
    { status: "exited" },
  ],
  services: [{}, {}],
  worktrees: [{}],
  tasks: [task({ id: "a", status: "in_progress" }), task({ id: "b", status: "done" }), task({ id: "c", status: "failed" })],
  notifications: [notif({ id: "n1", unread: true }), notif({ id: "n2", unread: false })],
});

add("counts task progress by status", "task-progress", {
  sessions: [],
  services: [],
  worktrees: [],
  tasks: [
    task({ id: "a", status: "pending" }),
    task({ id: "b", status: "assigned" }),
    task({ id: "c", status: "in_progress" }),
    task({ id: "d", status: "blocked" }),
    task({ id: "e", status: "done" }),
    task({ id: "f", status: "failed" }),
    task({ id: "g", status: "pending" }),
  ],
  notifications: [],
});

add("merges tasks and notifications into a story sorted newest-first", "story-order", {
  sessions: [],
  services: [],
  worktrees: [],
  tasks: [task({ id: "old", description: "old task", updatedAt: "2026-06-17T01:00:00.000Z" })],
  notifications: [notif({ id: "new", title: "new notif", createdAt: "2026-06-17T02:00:00.000Z" })],
});

add("tags review tasks distinctly and caps the story to storyLimit", "review-story-limit", {
  sessions: [],
  services: [],
  worktrees: [],
  tasks: [
    ...Array.from({ length: 40 }, (_, index) =>
      task({ id: `t${index}`, updatedAt: `2026-06-17T00:00:${String(index).padStart(2, "0")}.000Z` }),
    ),
    task({ id: "rev", type: "review", description: "review it", updatedAt: "2026-06-17T03:00:00.000Z" }),
  ],
  notifications: [],
  storyLimit: 5,
});

add("handles empty inputs without throwing", "empty", {
  sessions: [],
  services: [],
  worktrees: [],
  tasks: [],
  notifications: [],
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/project-observability.test.ts",
  generatedBy: "scripts/capture-project-observability-contract.mjs",
  description:
    "Project observability summary, task progress, story ordering, review tagging, story-limit, and empty-input behavior captured by running TypeScript buildProjectObservability.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
