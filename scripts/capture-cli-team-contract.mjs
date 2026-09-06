#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/cli/team.json", ROOT);
const { buildTeamCliPayload, renderTeamInitLines, renderTeamShowLines } = await import(
  new URL("dist/cli/team.js", ROOT)
);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function run(input) {
  switch (input.api) {
    case "renderTeamShowLines":
      return renderTeamShowLines(input.config);
    case "renderTeamInitLines":
      return renderTeamInitLines(input.config);
    case "buildTeamCliPayload":
      return buildTeamCliPayload(input.projectRoot, input.config, input.role);
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const config = {
  defaultRole: "coder",
  roles: {
    coder: { description: "Write code", canEdit: true },
    reviewer: { description: "Review changes", reviewedBy: "lead" },
  },
};

const inputs = [
  {
    name: "renders team show output with role flags",
    api: "renderTeamShowLines",
    config,
  },
  {
    name: "renders team init output",
    api: "renderTeamInitLines",
    config,
  },
  {
    name: "builds JSON payloads with optional role",
    api: "buildTeamCliPayload",
    projectRoot: "/repo",
    role: "coder",
    config,
  },
];

const cases = inputs.map((input, index) => ({
  id: `cli-team-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/cli/team.test.ts",
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/cli/team.test.ts",
  generatedBy: "scripts/capture-cli-team-contract.mjs",
  description:
    "CLI team renderer and payload helper outputs captured by running TypeScript cli/team helpers. Commander route registration is intentionally not captured here because it belongs to the fenced core_cli/daemon text path.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
