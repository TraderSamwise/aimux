#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/dashboard/index.json", ROOT);
const { derivedStatusLabel } = await import(new URL("dist/dashboard/index.js", ROOT));
const { deriveSessionSemantics } = await import(new URL("dist/session-semantics.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const semantic = deriveSessionSemantics({ status: "running", attention: "needs_input" });
const input = {
  name: "uses semantic display labels with pending actions taking precedence",
  api: "derivedStatusLabel",
  sessions: [
    {
      index: 0,
      id: "claude-1",
      command: "claude",
      status: "running",
      active: true,
      semantic,
    },
    {
      index: 0,
      id: "claude-1",
      command: "claude",
      status: "running",
      active: true,
      semantic,
      pendingAction: "starting",
    },
    {
      index: 0,
      id: "claude-1",
      command: "claude",
      status: "waiting",
      active: true,
    },
  ],
};

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/dashboard/index.test.ts",
  sources: ["src/dashboard/index.test.ts", "src/dashboard/index.ts", "src/session-semantics.ts"],
  generatedBy: "scripts/capture-dashboard-index-contract.mjs",
  description:
    "Dashboard derived status label precedence captured by running TypeScript Dashboard index helpers.",
  cases: [
    {
      id: "dashboard-index-001",
      name: input.name,
      source: "src/dashboard/index.test.ts",
      input,
      output: input.sessions.map((session) => derivedStatusLabel(session)),
      inputSha256: hash(input),
    },
  ],
});

console.log(`${FIXTURE_PATH.pathname}: 1 cases`);
