#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/cli/attachment.json", ROOT);
const { mimeTypeForPublishedAttachment, relayHttpUrl } = await import(new URL("dist/cli/attachment.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function run(input) {
  switch (input.api) {
    case "mimeTypeForPublishedAttachment":
      return mimeTypeForPublishedAttachment(input.filePath);
    case "relayHttpUrl":
      return relayHttpUrl(input.relayUrl);
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const inputs = [
  {
    name: "maps uppercase image extension to png mime",
    api: "mimeTypeForPublishedAttachment",
    filePath: "screenshot.PNG",
  },
  {
    name: "maps webm video extension",
    api: "mimeTypeForPublishedAttachment",
    filePath: "clip.webm",
  },
  {
    name: "falls back unknown extension to octet stream",
    api: "mimeTypeForPublishedAttachment",
    filePath: "archive.bin",
  },
  {
    name: "normalizes secure websocket relay URLs to https",
    api: "relayHttpUrl",
    relayUrl: "wss://relay.aimux.app/socket",
  },
  {
    name: "normalizes websocket localhost URL and strips trailing slash",
    api: "relayHttpUrl",
    relayUrl: "ws://localhost:8787/",
  },
];

const cases = inputs.map((input, index) => ({
  id: `cli-attachment-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "src/cli/attachment.test.ts",
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/cli/attachment.test.ts",
  generatedBy: "scripts/capture-cli-attachment-contract.mjs",
  description:
    "CLI attachment MIME and relay URL helper outputs captured by running TypeScript cli/attachment helpers. Commander publish wiring is not captured here because it belongs to the fenced core_cli/project-service route path.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
