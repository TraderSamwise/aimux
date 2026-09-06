#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/team/semantics.json", ROOT);
const { isProjectControlSession, selectOrphanTeammates } = await import(new URL("dist/team.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const cases = [];
function record(name, api, input, output) {
  cases.push({
    id: `team-semantics-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/team.test.ts",
    api,
    input,
    output,
    inputSha256: hash(input),
  });
}

const sessions = [
  { id: "primary", createdAt: "2026-05-01T00:00:00.000Z" },
  {
    id: "attached",
    createdAt: "2026-05-01T00:00:00.000Z",
    team: { teamId: "team-1", parentSessionId: "primary" },
  },
  {
    id: "orphan",
    createdAt: "2026-05-02T00:00:00.000Z",
    team: { teamId: "team-1", parentSessionId: "missing" },
  },
  {
    id: "ordered-orphan",
    createdAt: "2026-05-03T00:00:00.000Z",
    team: { teamId: "team-1", parentSessionId: "missing", order: 0 },
  },
  {
    id: "orphan",
    createdAt: "2026-05-04T00:00:00.000Z",
    team: { teamId: "team-1", parentSessionId: "missing", order: 10 },
  },
];
record(
  "returns only teammate sessions whose parent id is not known",
  "selectOrphanTeammates",
  { sessions, knownParentIds: ["primary"] },
  selectOrphanTeammates(sessions, ["primary"]).map((session) => session.id),
);
const projectControlItems = [
  { session: { team: { teamId: "scribe", parentSessionId: "", role: "scribe" } } },
  { session: { scribe: false, team: { teamId: "scribe", parentSessionId: "", role: "scribe" } } },
  { session: { overseer: true } },
  { session: { projectControl: true } },
  { session: { team: { teamId: "team-1", parentSessionId: "primary", role: "coder" } } },
];
record(
  "allows explicit scribe demotion to override stale team role metadata",
  "isProjectControlSessionBatch",
  { items: projectControlItems },
  projectControlItems.map(({ session }) => isProjectControlSession(session)),
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/team.test.ts",
  generatedBy: "scripts/capture-team-contract.mjs",
  description: "Team orphan selection and project-control session classification captured by running TypeScript.",
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
