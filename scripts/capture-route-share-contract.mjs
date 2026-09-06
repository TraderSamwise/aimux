#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/transport/route-share.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

async function importTypeScriptModule(path, stripImports = false) {
  const url = new URL(path, ROOT);
  let source = await readFile(url, "utf8");
  if (stripImports) source = source.replace(/^import[\s\S]*?;\n/gm, "");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: url.pathname,
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
}

const resolver = await importTypeScriptModule("app/lib/route-share-resolver.ts", true);
const routeShare = await importTypeScriptModule("app/lib/use-route-share.ts", true);

const share = {
  shareId: "share_123",
  ownerUserId: "user_owner",
  projectRoot: "/Users/sam/cs/scratch",
  sessionId: "claude-k4lihz",
  serviceEndpoint: { host: "relay.aimux.app", port: 443 },
  acceptedAt: "2026-08-13T00:00:00.000Z",
};

function run(input) {
  switch (input.api) {
    case "resolveRouteShare":
      return resolver.resolveRouteShare(input.value);
    case "sharedChatHref":
      return routeShare.sharedChatHref(input.share);
    default:
      throw new Error(`unknown api ${input.api}`);
  }
}

const inputs = [
  {
    name: "resolves canonical shared chat routes",
    source: "app/lib/use-route-share.test.ts",
    api: "resolveRouteShare",
    value: {
      acceptedShares: [share],
      legacyActiveShare: null,
      ownerUserId: share.ownerUserId,
      pathname: "/shares/user_owner/share_123/agent/claude-k4lihz/chat",
      sessionId: share.sessionId,
      shareId: share.shareId,
    },
  },
  {
    name: "resolves legacy agent chat routes for accepted shared sessions",
    source: "app/lib/use-route-share.test.ts",
    api: "resolveRouteShare",
    value: {
      acceptedShares: [share],
      currentUserId: "user_guest",
      legacyActiveShare: null,
      pathname: "/agent/claude-k4lihz/chat",
      routeProjectPath: share.projectRoot,
      sessionId: share.sessionId,
    },
  },
  {
    name: "waits for a current user before resolving legacy shared routes",
    source: "app/lib/use-route-share.test.ts",
    api: "resolveRouteShare",
    value: {
      acceptedShares: [share],
      legacyActiveShare: null,
      pathname: "/agent/claude-k4lihz/chat",
      routeProjectPath: share.projectRoot,
      sessionId: share.sessionId,
    },
  },
  {
    name: "leaves owner project routes in the normal project experience",
    source: "app/lib/use-route-share.test.ts",
    api: "resolveRouteShare",
    value: {
      acceptedShares: [share],
      currentUserId: share.ownerUserId,
      legacyActiveShare: null,
      pathname: "/agent/claude-k4lihz/chat",
      routeProjectPath: share.projectRoot,
      sessionId: share.sessionId,
    },
  },
  {
    name: "resolves canonical share routes even for owners",
    source: "app/lib/use-route-share.test.ts",
    api: "resolveRouteShare",
    value: {
      acceptedShares: [share],
      currentUserId: share.ownerUserId,
      legacyActiveShare: null,
      ownerUserId: share.ownerUserId,
      pathname: "/shares/user_owner/share_123/agent/claude-k4lihz/chat",
      sessionId: share.sessionId,
      shareId: share.shareId,
    },
  },
  {
    name: "resolves leaked project routes only when they match the active shared session",
    source: "app/lib/use-route-share.test.ts",
    api: "resolveRouteShare",
    value: {
      acceptedShares: [],
      currentUserId: "user_guest",
      legacyActiveShare: share,
      pathname: "/project",
      routeProjectPath: share.projectRoot,
    },
  },
  {
    name: "does not resolve leaked project routes for local projects",
    source: "app/lib/use-route-share.test.ts",
    api: "resolveRouteShare",
    value: {
      acceptedShares: [share],
      legacyActiveShare: null,
      pathname: "/project",
      routeProjectPath: "/Users/sam/cs/local",
    },
  },
  {
    name: "does not treat ordinary local agent routes as shared",
    source: "app/lib/use-route-share.test.ts",
    api: "resolveRouteShare",
    value: {
      acceptedShares: [share],
      legacyActiveShare: null,
      pathname: "/agent/local-session/chat",
      routeProjectPath: share.projectRoot,
      sessionId: "local-session",
    },
  },
  {
    name: "builds canonical shared chat hrefs",
    source: "app/lib/use-route-share.ts",
    api: "sharedChatHref",
    share,
  },
];

const cases = inputs.map((input, index) => ({
  id: `route-share-${String(index + 1).padStart(3, "0")}`,
  name: input.name,
  source: input.source,
  api: input.api,
  input,
  output: run(input),
  inputSha256: hash(input),
}));

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: ["app/lib/use-route-share.test.ts", "app/lib/use-route-share.ts"],
  generatedBy: "scripts/capture-route-share-contract.mjs",
  description:
    "Shared route-to-session resolution and canonical shared-chat href contracts captured by running TypeScript route-share helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
