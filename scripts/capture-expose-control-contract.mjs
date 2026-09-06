#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/expose/control.json", ROOT);
const { listAllProjectsExposeItems } = await import(new URL("dist/expose-control.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function makeItem(projectRoot, suffix = "agent") {
  const projectKey = projectRoot.split("/").filter(Boolean).at(-1) ?? "root";
  return {
    id: `${projectKey}-${suffix}`,
    label: `${projectKey} ${suffix}`,
    target: { sessionName: `aimux-${projectKey}`, windowId: `@${projectKey.length}`, windowIndex: 1, windowName: suffix },
    metadata: { sessionId: `${projectKey}-${suffix}` },
    urgency: suffix === "urgent" ? 2 : 0,
    activity: 1,
    recentRank: suffix === "urgent" ? 0 : 1,
  };
}

const inputs = [
  {
    name: "sorts projects and flattens running project items",
    sessions: ["aimux-two", "aimux-one", "random"],
    sessionOptions: {
      "aimux-one": "/repo/one",
      "aimux-two": "/repo/two",
      random: "",
    },
    projects: [
      { id: "two", name: "two", repoRoot: "/repo/two", lastSeen: "" },
      { id: "one", name: "one", repoRoot: "/repo/one", lastSeen: "" },
      { id: "stopped", name: "stopped", repoRoot: "/repo/stopped", lastSeen: "" },
    ],
    itemsByRoot: {
      "/repo/one": [makeItem("/repo/one")],
      "/repo/two": [makeItem("/repo/two")],
    },
  },
  {
    name: "groups normalized session roots before listing expose items",
    sessions: ["aimux-alpha-a", "aimux-alpha-b", "aimux-beta"],
    sessionOptions: {
      "aimux-alpha-a": "/repo/root/../alpha",
      "aimux-alpha-b": "/repo/alpha",
      "aimux-beta": "/repo/beta/.",
    },
    projects: [
      { id: "alpha", name: "alpha", repoRoot: "/repo/alpha", lastSeen: "" },
      { id: "beta", name: "beta", repoRoot: "/repo/beta", lastSeen: "" },
    ],
    itemsByRoot: {
      "/repo/alpha": [makeItem("/repo/alpha"), makeItem("/repo/alpha", "urgent")],
      "/repo/beta": [makeItem("/repo/beta")],
    },
  },
  {
    name: "skips stopped projects and list failures",
    sessions: ["aimux-good", "aimux-bad", "aimux-throwing", "aimux-missing"],
    sessionOptions: {
      "aimux-good": "/repo/good",
      "aimux-bad": "/repo/bad",
      "aimux-throwing": { throws: "tmux unavailable" },
      "aimux-missing": "",
    },
    projects: [
      { id: "bad", name: "bad", repoRoot: "/repo/bad", lastSeen: "" },
      { id: "good", name: "good", repoRoot: "/repo/good", lastSeen: "" },
      { id: "missing", name: "missing", repoRoot: "/repo/missing", lastSeen: "" },
    ],
    itemsByRoot: {
      "/repo/good": [makeItem("/repo/good")],
      "/repo/bad": { throws: "list failed" },
    },
  },
];

function run(input) {
  const calls = [];
  const tmux = {
    listSessionNames() {
      calls.push({ api: "listSessionNames" });
      return input.sessions;
    },
    getSessionOption(sessionName, option) {
      calls.push({ api: "getSessionOption", sessionName, option });
      const value = input.sessionOptions[sessionName];
      if (value && typeof value === "object" && "throws" in value) throw new Error(value.throws);
      return value ?? "";
    },
  };
  const output = listAllProjectsExposeItems({
    tmux,
    listProjectsFn: () => {
      calls.push({ api: "listProjects" });
      return input.projects;
    },
    listItemsFn: (context, _tmux, options) => {
      calls.push({ api: "listItems", context, options });
      const value = input.itemsByRoot[context.projectRoot];
      if (value && typeof value === "object" && !Array.isArray(value) && "throws" in value) throw new Error(value.throws);
      return Array.isArray(value) ? value : [];
    },
  });
  return { items: output, calls };
}

const cases = inputs.map((input, index) => ({
  id: `expose-control-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/expose-control.test.ts",
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/expose-control.test.ts",
  generatedBy: "scripts/capture-expose-control-contract.mjs",
  description:
    "Global expose-control project/session flattening contracts captured by running TypeScript listAllProjectsExposeItems with deterministic dependency doubles.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
