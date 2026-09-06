#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/remote-access/access.json", ROOT);
const { PROJECT_API_ROUTES } = await import(new URL("dist/project-api-contract.js", ROOT));
const { assertOperatorStreamAllowed, assertRemoteAccessAllowed, parseRemoteActor } = await import(
  new URL("dist/full/remote-access.js", ROOT)
);

const PROJECT_ROOT = "/srv/grand";
const SESSION = "assistant";
const PORT_PATH = (subPath) => `/proxy/127.0.0.1/43210${subPath}`;

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function principal(grants = []) {
  return {
    id: "prn_test",
    label: "test",
    tokenHash: "sha256:abcd",
    role: "operator",
    grants,
    createdAt: "1970-01-01T00:00:00.000Z",
    revokedAt: null,
    lastSeenAt: null,
  };
}

function operator(grants = [{ projectRoot: PROJECT_ROOT, sessionId: SESSION }]) {
  return { role: "operator", principal: principal(grants) };
}

function guest(sessionId = SESSION) {
  return {
    role: "guest",
    userId: "usr_guest",
    shareId: "share-1",
    shareSessionId: sessionId,
    displayName: "Ada Guest",
    email: "ada@example.com",
  };
}

function allowCheck(actor, method, path, options = {}) {
  return {
    mode: "allow",
    actor,
    method,
    path,
    query: options.query ?? "",
    body: options.body,
    projectRoot: "projectRoot" in options ? options.projectRoot : PROJECT_ROOT,
  };
}

function streamCheck(actor, method, path, options = {}) {
  return {
    mode: "stream",
    actor,
    method,
    path,
    query: options.query ?? "",
    projectRoot: "projectRoot" in options ? options.projectRoot : PROJECT_ROOT,
  };
}

function runCheck(check) {
  if (check.mode === "parseActor") return parseRemoteActor(check.headers);
  const url = new URL(`http://127.0.0.1${check.path}${check.query ?? ""}`);
  if (check.mode === "stream") {
    return assertOperatorStreamAllowed(check.actor, check.method, url.pathname, url.searchParams, {
      projectRoot: check.projectRoot,
    });
  }
  return assertRemoteAccessAllowed(check.actor, check.method, url.pathname, url.searchParams, {
    body: check.body,
    projectRoot: check.projectRoot,
  });
}

function normalizeCheck(check) {
  return JSON.parse(JSON.stringify(check));
}

const cases = [];
function add(name, checks) {
  const input = { checks: checks.map(normalizeCheck) };
  cases.push({
    id: `remote-access-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/full/remote-access.test.ts",
    api: "remote-access",
    input,
    output: checks.map(runCheck),
    inputSha256: hash(input),
  });
}

add("allows a granted session on each permitted route", [
  allowCheck(operator(), "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), { query: `?sessionId=${SESSION}` }),
  allowCheck(operator(), "POST", PORT_PATH(PROJECT_API_ROUTES.agents.input), {
    body: { sessionId: SESSION, text: "hi" },
  }),
  allowCheck(operator(), "POST", PORT_PATH(PROJECT_API_ROUTES.agents.promptContext), {
    body: { sessionId: SESSION, text: "page=/admin" },
  }),
  allowCheck(operator(), "POST", PORT_PATH(PROJECT_API_ROUTES.agents.interrupt), { body: { sessionId: SESSION } }),
]);
add("refuses to let an operator set context on a session it was not granted", [
  allowCheck(operator(), "POST", PORT_PATH(PROJECT_API_ROUTES.agents.promptContext), {
    body: { sessionId: "someone-elses-session", text: "steer" },
  }),
]);
add("gives the context route no way to be read back", [
  allowCheck(operator(), "GET", PORT_PATH(PROJECT_API_ROUTES.agents.promptContext), {
    query: `?sessionId=${SESSION}`,
  }),
]);
add(
  "denies every route not on the allowlist",
  [
    PROJECT_API_ROUTES.agents.list,
    PROJECT_API_ROUTES.agents.outputStream,
    PROJECT_API_ROUTES.agents.history,
    PROJECT_API_ROUTES.events,
    PROJECT_API_ROUTES.agents.spawn,
    PROJECT_API_ROUTES.agents.kill,
    PROJECT_API_ROUTES.agents.stop,
    PROJECT_API_ROUTES.agents.fork,
    PROJECT_API_ROUTES.livePane.input,
    PROJECT_API_ROUTES.threads.send,
    PROJECT_API_ROUTES.worktreeActions.create,
    PROJECT_API_ROUTES.desktopState,
  ].flatMap((route) => [
    allowCheck(operator(), "GET", PORT_PATH(route), { query: `?sessionId=${SESSION}` }),
    allowCheck(operator(), "POST", PORT_PATH(route), { body: { sessionId: SESSION } }),
  ]),
);
add("allows the attachment routes an operator needs", [
  allowCheck(operator(), "GET", PORT_PATH("/attachments/att_abc123/content"), { query: `?sessionId=${SESSION}` }),
  allowCheck(operator(), "POST", PORT_PATH(PROJECT_API_ROUTES.attachments), { body: { sessionId: SESSION } }),
]);
add("binds attachment content to the granted session like every other route", [
  allowCheck(operator(), "GET", PORT_PATH("/attachments/att_abc123/content"), { query: "?sessionId=someone-else" }),
  allowCheck(operator(), "GET", PORT_PATH("/attachments/att_abc123/content")),
]);
add(
  "refuses every attempt to smuggle another route through the attachment pattern",
  [
    "/attachments/att_x/content/../../agents/spawn",
    "/attachments/..%2f..%2fagents%2fspawn/content",
    "/attachments/%2e%2e/%2e%2e/agents/spawn/content",
    "/attachments/att%2fx/content",
    "/attachments/att_x;a=b/content",
    "/attachments//content",
    "/attachments/att_x/content/extra",
    "/attachments/att_x/content/",
    "/attachments/att_x",
    "/attachments/att_x/contentious",
  ].map((path) => allowCheck(operator(), "GET", PORT_PATH(path), { query: `?sessionId=${SESSION}` })),
);
add("enforces the method on the pattern-matched route too", [
  allowCheck(operator(), "POST", PORT_PATH("/attachments/att_abc123/content"), { body: { sessionId: SESSION } }),
  allowCheck(operator(), "GET", PORT_PATH(PROJECT_API_ROUTES.attachments), { query: `?sessionId=${SESSION}` }),
]);
add("denies daemon routes outside the proxy form", [
  allowCheck(operator(), "GET", "/health"),
  allowCheck(operator(), "GET", PROJECT_API_ROUTES.agents.output),
  allowCheck(operator(), "POST", "/projects/stop", { body: { sessionId: SESSION } }),
]);
add("enforces the method each route accepts", [
  allowCheck(operator(), "POST", PORT_PATH(PROJECT_API_ROUTES.agents.output), { body: { sessionId: SESSION } }),
  allowCheck(operator(), "GET", PORT_PATH(PROJECT_API_ROUTES.agents.input), { query: `?sessionId=${SESSION}` }),
  allowCheck(operator(), "DELETE", PORT_PATH(PROJECT_API_ROUTES.agents.input), { body: { sessionId: SESSION } }),
]);
add("operator session binding denies missing or mismatched session ids", [
  allowCheck(operator(), "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output)),
  allowCheck(operator(), "POST", PORT_PATH(PROJECT_API_ROUTES.agents.input), { body: { text: "hi" } }),
  allowCheck(operator(), "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), { query: "?sessionId=someone-else" }),
  allowCheck(operator(), "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), {
    query: `?sessionId=${SESSION}`,
    projectRoot: "/srv/other",
  }),
  allowCheck(operator(), "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), {
    query: `?sessionId=${SESSION}`,
    projectRoot: null,
  }),
]);
add("reads and rejects session ids from the source the service will use", [
  allowCheck(operator(), "POST", PORT_PATH(PROJECT_API_ROUTES.agents.input), { query: `?sessionId=${SESSION}` }),
  allowCheck(operator(), "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), { body: { sessionId: SESSION } }),
  allowCheck(operator(), "POST", PORT_PATH(PROJECT_API_ROUTES.agents.input), {
    body: { sessionId: SESSION },
    query: "?sessionId=someone-else",
  }),
  allowCheck(operator(), "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), {
    body: { sessionId: "someone-else" },
    query: `?sessionId=${SESSION}`,
  }),
]);
add("operator principal validity gates", [
  allowCheck({ role: "operator" }, "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), {
    query: `?sessionId=${SESSION}`,
  }),
  allowCheck(
    { role: "operator", principal: { ...principal([{ projectRoot: PROJECT_ROOT, sessionId: SESSION }]), revokedAt: "2020-01-01T00:00:00Z" } },
    "GET",
    PORT_PATH(PROJECT_API_ROUTES.agents.output),
    { query: `?sessionId=${SESSION}` },
  ),
  allowCheck(operator([]), "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), { query: `?sessionId=${SESSION}` }),
]);
add("operator cannot be minted from headers", [
  { mode: "parseActor", headers: { "x-aimux-actor-role": "operator" } },
  { mode: "parseActor", headers: { "x-aimux-actor": JSON.stringify({ role: "operator", userId: "u" }) } },
  {
    mode: "parseActor",
    headers: {
      "x-aimux-actor-role": "operator",
      "x-aimux-principal": JSON.stringify(principal([{ projectRoot: PROJECT_ROOT, sessionId: SESSION }])),
    },
  },
]);
add("existing owner/headerless/guest roles are unaffected", [
  allowCheck({ role: "owner" }, "POST", PORT_PATH(PROJECT_API_ROUTES.agents.spawn)),
  allowCheck(null, "POST", PORT_PATH(PROJECT_API_ROUTES.agents.spawn)),
  allowCheck(guest(), "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), { query: `?sessionId=${SESSION}` }),
  allowCheck(guest(), "GET", PORT_PATH(PROJECT_API_ROUTES.agents.output), { query: "?sessionId=other" }),
  allowCheck(guest(), "POST", PORT_PATH(PROJECT_API_ROUTES.agents.input), { body: { sessionId: SESSION } }),
]);
add("shared guest live-pane input and attachments", [
  allowCheck(guest(), "POST", PORT_PATH(PROJECT_API_ROUTES.livePane.input), {
    body: { sessionId: SESSION, text: "hello" },
  }),
  allowCheck(guest(), "POST", PORT_PATH(PROJECT_API_ROUTES.livePane.input), {
    body: { sessionId: SESSION, attachmentIds: ["att_1"] },
  }),
  allowCheck(guest(), "POST", PORT_PATH(PROJECT_API_ROUTES.livePane.input), {
    body: { sessionId: SESSION, text: "  \n\t " },
  }),
  allowCheck(guest(), "POST", PORT_PATH(PROJECT_API_ROUTES.attachments), { body: { sessionId: SESSION } }),
  allowCheck(guest(), "GET", PORT_PATH("/attachments/att_abc123/content"), { query: `?sessionId=${SESSION}` }),
  allowCheck(guest(), "GET", PORT_PATH("/attachments/att_abc123"), { query: `?sessionId=${SESSION}` }),
  allowCheck(guest(), "GET", PORT_PATH("/attachments/att_abc123/content")),
]);
add("shared guest rejects other sessions and owner write routes", [
  allowCheck(guest(), "POST", PORT_PATH(PROJECT_API_ROUTES.livePane.input), {
    body: { sessionId: "other", text: "hello" },
  }),
  allowCheck(guest(), "POST", PORT_PATH(PROJECT_API_ROUTES.livePane.input), {
    body: { sessionId: SESSION, text: "hello" },
    query: "?sessionId=other",
  }),
  allowCheck(guest(), "POST", PORT_PATH(PROJECT_API_ROUTES.agents.input), {
    body: { sessionId: SESSION, text: "hello" },
  }),
  allowCheck(guest(), "POST", PORT_PATH(PROJECT_API_ROUTES.agents.interrupt), {
    body: { sessionId: SESSION, text: "hello" },
  }),
  allowCheck(guest(), "POST", PORT_PATH(PROJECT_API_ROUTES.agents.spawn), {
    body: { sessionId: SESSION, text: "hello" },
  }),
  allowCheck({ role: "nonsense" }, "GET", PORT_PATH("/health")),
]);

const streamPath = PORT_PATH(PROJECT_API_ROUTES.agents.outputStream);
add("operator stream allowlist", [
  streamCheck(operator(), "GET", streamPath, { query: `?sessionId=${SESSION}` }),
  streamCheck(operator(), "GET", streamPath, { query: "?sessionId=someone-else" }),
  streamCheck(operator([{ projectRoot: "/srv/other", sessionId: SESSION }]), "GET", streamPath, {
    query: `?sessionId=${SESSION}`,
  }),
  streamCheck(operator(), "GET", streamPath, { query: `?sessionId=${SESSION}`, projectRoot: null }),
  ...[
    PROJECT_API_ROUTES.events,
    PROJECT_API_ROUTES.agents.output,
    PROJECT_API_ROUTES.agents.interactionStream,
    PROJECT_API_ROUTES.agents.list,
  ].map((route) => streamCheck(operator(), "GET", PORT_PATH(route), { query: `?sessionId=${SESSION}` })),
  streamCheck(operator(), "POST", streamPath, { query: `?sessionId=${SESSION}` }),
  streamCheck({ role: "guest" }, "GET", streamPath, { query: `?sessionId=${SESSION}` }),
  streamCheck(null, "GET", streamPath, { query: `?sessionId=${SESSION}` }),
  streamCheck(operator(), "GET", "/events", { query: `?sessionId=${SESSION}` }),
  streamCheck(operator(), "GET", streamPath),
]);

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/full/remote-access.test.ts",
  generatedBy: "scripts/capture-remote-access-contract.mjs",
  description:
    "Hosted remote-access operator/guest route allowlists, session binding, header actor parsing, attachment route hardening, and operator stream gates captured by running TypeScript remote-access helpers.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
