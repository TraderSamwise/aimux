#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const SOURCE_URL = new URL("app/lib/push-registration-url.ts", ROOT);
const FIXTURE_PATH = new URL("testdata/contracts/v1/push-registration/url.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function importTypeScriptModule(url) {
  const source = await readFile(url, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: url.pathname,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const { buildSecurityPushRegistrationUrl, buildSecurityPushTestUrl } = await importTypeScriptModule(SOURCE_URL);

function run(input) {
  try {
    const url =
      input.api === "buildSecurityPushRegistrationUrl"
        ? buildSecurityPushRegistrationUrl(input.relayUrl, input.options).toString()
        : buildSecurityPushTestUrl(input.relayUrl, input.options).toString();
    return { ok: true, url };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const inputs = [
  { name: "routes normal security push registration to authenticated relay", api: "buildSecurityPushRegistrationUrl", relayUrl: "wss://relay.aimux.app/" },
  { name: "routes shared push registration through owner relay context", api: "buildSecurityPushRegistrationUrl", relayUrl: "wss://relay.aimux.app", options: { ownerUserId: " user_owner ", shareId: " share_123 " } },
  { name: "rejects missing share id", api: "buildSecurityPushRegistrationUrl", relayUrl: "wss://relay.aimux.app", options: { ownerUserId: "user_owner" } },
  { name: "rejects missing owner user id", api: "buildSecurityPushRegistrationUrl", relayUrl: "wss://relay.aimux.app", options: { shareId: "share_123" } },
  { name: "routes test pushes through owner relay context", api: "buildSecurityPushTestUrl", relayUrl: "wss://relay.aimux.app", options: { ownerUserId: " user_owner ", shareId: " share_123 " } },
  { name: "converts websocket relay URLs to http URLs", api: "buildSecurityPushRegistrationUrl", relayUrl: "ws://localhost:43190///" },
  { name: "keeps http relay URLs as http", api: "buildSecurityPushTestUrl", relayUrl: "http://localhost:43190/" },
  { name: "ignores blank shared context", api: "buildSecurityPushRegistrationUrl", relayUrl: "wss://relay.aimux.app", options: { ownerUserId: " ", shareId: " " } },
];

const cases = inputs.map((input, index) => ({
  id: `push-registration-url-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: "app/lib/push-registration.test.ts",
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "app/lib/push-registration.test.ts",
  generatedBy: "scripts/capture-push-registration-url-contract.mjs",
  description:
    "App security push registration/test URL construction, relay protocol conversion, shared relay context query params, trimming, and partial-context errors captured by running TypeScript push-registration-url helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
