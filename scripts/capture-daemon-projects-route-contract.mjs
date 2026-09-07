#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/daemon/projects-route-counts.json", ROOT);
const { countOnlineDesktopAgents } = await import(new URL("dist/daemon/projects-route.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const inputs = [
  {
    name: "counts online sessions from worktree groups and hides overseers",
    state: {
      worktreeGroups: [
        {
          sessions: [
            { status: "running" },
            { status: "offline" },
            { status: "exited" },
            { status: "idle", overseer: true },
            { status: "idle", team: { role: "overseer" } },
            { status: "offline", pendingAction: { kind: "spawn" } },
          ],
        },
        { sessions: [{ status: "waiting" }] },
      ],
    },
  },
  {
    name: "falls back to top-level sessions and teammates",
    state: {
      sessions: [{ status: "running" }, { status: "offline" }],
      teammates: [{ status: "idle" }, { status: "exited" }],
    },
  },
  {
    name: "returns undefined without known session collections",
    state: {},
  },
];

const cases = inputs.map((input, index) => ({
  id: `daemon-projects-route-counts-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/daemon/projects-route.test.ts",
  api: "countOnlineDesktopAgents",
  input: { state: input.state },
  output: countOnlineDesktopAgents(input.state) ?? null,
  outputEncoding: "undefined-as-null",
  inputSha256: hash({ state: input.state }),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-07T00:00:00.000Z",
  generatedBy: "scripts/capture-daemon-projects-route-contract.mjs",
  source: "src/daemon/projects-route.test.ts",
  sources: ["src/daemon/projects-route.test.ts", "src/daemon/projects-route.ts"],
  subject: "countOnlineDesktopAgents",
  description: "Online desktop-agent count behavior captured by running TypeScript countOnlineDesktopAgents.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
