#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/agent-output/io-methods.json", ROOT);

const { agentIoMethods } = await import(new URL("dist/multiplexer/agent-io-methods.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

function calls() {
  const items = [];
  const fn = (...args) => {
    items.push(args);
  };
  fn.items = items;
  return fn;
}

const sessionWrite = calls();
const legacyInputPath = calls();
const input = {
  recipients: ["codex-1"],
  threadId: "thread-1",
  from: "claude-1",
  body: "Review is done.",
  kind: "status",
  title: "review complete",
  host: {
    sessions: [{ id: "codex-1", exited: false, status: "running" }],
    semantic: { runtime: { canReceiveInput: true, isAlive: true } },
  },
};
const session = { ...input.host.sessions[0], write: sessionWrite };
const host = {
  sessions: [session],
  deriveSessionSemanticState: () => input.host.semantic,
  legacyInputPath,
};
const delivered = agentIoMethods.deliverOrchestrationMessage.call(
  host,
  input.recipients,
  input.threadId,
  input.from,
  input.body,
  input.kind,
  input.title,
);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/multiplexer/agent-io-methods.test.ts",
  generatedBy: "scripts/capture-agent-io-methods-contract.mjs",
  description:
    "Agent IO orchestration delivery side effects captured by running TypeScript agentIoMethods.deliverOrchestrationMessage.",
  cases: [
    {
      id: "agent-output-io-methods-001",
      name: "does not deliver direct messages through the old agent input path",
      source: "src/multiplexer/agent-io-methods.test.ts",
      sourceName: "does not deliver direct messages through the old agent input path",
      api: "agentIoMethods.deliverOrchestrationMessage",
      input,
      output: {
        delivered,
        calls: {
          sessionWrite: sessionWrite.items,
          legacyInputPath: legacyInputPath.items,
        },
      },
      inputSha256: hash(input),
    },
  ],
});

console.log(`${FIXTURE_PATH.pathname}: 1 cases`);
