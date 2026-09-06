#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/transport/security.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function importTypeScriptModule(path, stripImports = false) {
  const url = new URL(path, ROOT);
  let source = await readFile(url, "utf8");
  if (stripImports) source = source.replace(/^import .*;\n/gm, "");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: url.pathname,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const actor = await importTypeScriptModule("app/lib/shared-chat-actor.ts", true);
const proof = await importTypeScriptModule("app/lib/client-device-proof.ts", true);

function run(input) {
  switch (input.api) {
    case "resolveSharedChatActor":
      return actor.resolveSharedChatActor(input.value);
    case "deviceProofMessage":
      return proof.deviceProofMessage(input.deviceId, input.timestamp, input.nonce);
    case "encodeDevicePublicKey":
      return proof.encodeDevicePublicKey(input.publicKeyJwk);
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const owner = {
  userId: "user_owner",
  displayName: "Sam Owner",
  email: "sam@example.com",
  role: "owner",
  status: "active",
  joinedAt: "2026-08-13T00:00:00.000Z",
};

const guest = {
  userId: "user_guest",
  displayName: "Ada Guest",
  email: "ada@example.com",
  role: "guest",
  status: "active",
  joinedAt: "2026-08-13T00:00:00.000Z",
};

const publicKeyJwk = {
  kty: "EC",
  crv: "P-256",
  x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  y: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  ext: true,
  key_ops: ["verify"],
};

const inputs = [
  {
    name: "does not tag non-shared conversations",
    source: "app/lib/shared-chat-actor.test.ts",
    api: "resolveSharedChatActor",
    value: { isCanonicalSharedRoute: false, isSharedConversation: false },
  },
  {
    name: "tags owners correctly in the shared experience",
    source: "app/lib/shared-chat-actor.test.ts",
    api: "resolveSharedChatActor",
    value: {
      currentParticipant: owner,
      isCanonicalSharedRoute: true,
      isSharedConversation: true,
      routeOwnerUserId: owner.userId,
      userId: owner.userId,
    },
  },
  {
    name: "tags guests correctly in the shared experience",
    source: "app/lib/shared-chat-actor.test.ts",
    api: "resolveSharedChatActor",
    value: {
      currentParticipant: guest,
      isCanonicalSharedRoute: true,
      isSharedConversation: true,
      routeOwnerUserId: owner.userId,
      userId: guest.userId,
    },
  },
  {
    name: "still tags owner GUI messages from normal project routes",
    source: "app/lib/shared-chat-actor.test.ts",
    api: "resolveSharedChatActor",
    value: {
      currentParticipant: owner,
      displayName: "Fallback Name",
      email: "fallback@example.com",
      isCanonicalSharedRoute: false,
      isSharedConversation: true,
      userId: owner.userId,
    },
  },
  {
    name: "uses fallback guest identity on canonical shared routes",
    source: "app/lib/shared-chat-actor.ts",
    api: "resolveSharedChatActor",
    value: {
      displayName: "Fallback Guest",
      email: "guest@example.com",
      isCanonicalSharedRoute: true,
      isSharedConversation: true,
      routeOwnerUserId: owner.userId,
      userId: "unknown",
    },
  },
  {
    name: "formats device proof signing messages",
    source: "app/lib/client-device-proof.ts",
    api: "deviceProofMessage",
    deviceId: "client_1",
    timestamp: "2026-05-24T00:00:00.000Z",
    nonce: "nonce",
  },
  {
    name: "base64url-encodes exported device public keys",
    source: "app/lib/client-device-proof.ts",
    api: "encodeDevicePublicKey",
    publicKeyJwk,
  },
];

const cases = inputs.map((input, index) => {
  const output = run(input);
  return {
    id: `transport-security-${String(index + 1).padStart(3, "0")}`,
    name: input.name,
    source: input.source,
    api: input.api,
    input,
    output: output === undefined ? null : output,
    inputSha256: hash(input),
  };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: ["app/lib/shared-chat-actor.test.ts", "app/lib/client-device-proof.test.ts"],
  generatedBy: "scripts/capture-transport-security-contract.mjs",
  description:
    "Shared-chat actor attribution and client device proof message/public-key encoding contracts captured by running TypeScript transport/security helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
