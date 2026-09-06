#!/usr/bin/env node
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const LOCAL_UI_FIXTURE = new URL("testdata/contracts/v1/service/local-ui-server.json", ROOT);
const NOTIFY_FIXTURE = new URL("testdata/contracts/v1/notifications/notify-alert.json", ROOT);

const mockDir = mkdtempSync(join(tmpdir(), "aimux-notify-contract-"));
const configMock = join(mockDir, "config.mjs");
const contextMock = join(mockDir, "notification-context.mjs");
const desktopMock = join(mockDir, "desktop-notifier.mjs");

writeFileSync(
  configMock,
  `export function loadConfig() { return { notifications: globalThis.__notifyContract.config }; }\n`,
);
writeFileSync(
  contextMock,
  `export function shouldSuppressNotification(event, projectRoot) {
  globalThis.__notifyContract.suppressCalls.push({ event, projectRoot });
  return globalThis.__notifyContract.suppress;
}\n`,
);
writeFileSync(
  desktopMock,
  `export function sendDesktopNotification(payload) { globalThis.__notifyContract.desktopCalls.push(payload); }\n`,
);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/dist/notify.js")) {
      if (specifier === "./config.js") return { url: pathToFileURL(configMock).href, shortCircuit: true };
      if (specifier === "./notification-context.js") {
        return { url: pathToFileURL(contextMock).href, shortCircuit: true };
      }
      if (specifier === "./desktop-notifier.js") return { url: pathToFileURL(desktopMock).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const notify = await import(new URL("dist/notify.js", ROOT));
const { startLocalUiServer } = await import(new URL("dist/local-ui-server.js", ROOT));

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function record(prefix, index, source, api, name, input, output) {
  return {
    id: `${prefix}-${String(index + 1).padStart(3, "0")}`,
    name,
    source,
    api,
    input,
    output,
    inputSha256: hash(input),
  };
}

function makeUiRoot() {
  const root = mkdtempSync(join(tmpdir(), "aimux-ui-contract-"));
  writeFileSync(
    join(root, "index.html"),
    '<!doctype html><html><head><script src="/aimux-local-config.js"></script></head><body>aimux ui</body></html>',
  );
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "app.js"), "console.log('aimux');");
  return root;
}

async function fetchSummary(url, path = "") {
  const res = await fetch(`${url}${path}`);
  const text = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    cacheControl: res.headers.get("cache-control"),
    bodyContainsAimuxUi: text.includes("aimux ui"),
    bodyContainsDaemonUrl: text.includes('"daemonUrl":"http://127.0.0.1:43190"'),
    bodyContainsConsoleLog: text.includes("console.log"),
  };
}

function rawGetStatus(url, path) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path,
        method: "GET",
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function withLocalServer(run) {
  const root = makeUiRoot();
  const handle = await startLocalUiServer({
    host: "127.0.0.1",
    port: 0,
    uiRoot: root,
    config: {
      connectionMode: "local",
      daemonUrl: "http://127.0.0.1:43190",
    },
  });
  try {
    return await run(handle);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const localUiCases = [];
async function localUi(name, input, run) {
  localUiCases.push(record("local-ui-server", localUiCases.length, "src/local-ui-server.test.ts", "startLocalUiServer", name, input, await run()));
}

await localUi("serves the exported app shell", { path: "/" }, async () => withLocalServer((server) => fetchSummary(server.url)));
await localUi("serves runtime local connection config", { path: "/aimux-local-config.js" }, async () =>
  withLocalServer((server) => fetchSummary(server.url, "/aimux-local-config.js")),
);
await localUi("falls back to index for routed app paths", { path: "/topology/agent/claude-1/chat?from=map" }, async () =>
  withLocalServer((server) => fetchSummary(server.url, "/topology/agent/claude-1/chat?from=map")),
);
await localUi("serves static assets with immutable caching", { path: "/assets/app.js" }, async () =>
  withLocalServer((server) => fetchSummary(server.url, "/assets/app.js")),
);
await localUi("rejects path traversal attempts", { path: "/%2e%2e/package.json" }, async () =>
  withLocalServer(async (server) => ({ status: await rawGetStatus(server.url, "/%2e%2e/package.json") })),
);
await localUi("rejects non-loopback hosts", { host: "0.0.0.0" }, async () => {
  const root = makeUiRoot();
  try {
    await startLocalUiServer({
      host: "0.0.0.0",
      port: 0,
      uiRoot: root,
      config: { connectionMode: "local", daemonUrl: "http://127.0.0.1:43190" },
    });
    return { rejected: false, message: null };
  } catch (error) {
    return { rejected: true, message: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function alert(overrides = {}) {
  return {
    type: "alert",
    kind: "needs_input",
    sessionId: "claude-1",
    title: "claude-1 needs input",
    message: "waiting for input",
    ts: "2026-06-06T00:00:00.000Z",
    ...overrides,
  };
}

function resetNotifyState(overrides = {}) {
  globalThis.__notifyContract = {
    config: { enabled: true, onPrompt: true, onError: true, onComplete: true, ...overrides.config },
    suppress: overrides.suppress ?? false,
    suppressCalls: [],
    desktopCalls: [],
  };
  delete process.env.AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS;
  delete process.env.AIMUX_DISABLE_DESKTOP_NOTIFICATIONS;
  if (overrides.env) Object.assign(process.env, overrides.env);
  notify.resetNotifyConfig();
}

const notifyCases = [];
function notifyCase(name, input, run) {
  resetNotifyState(input);
  const returnValue = run();
  const output = {
    returnValue,
    suppressCalls: globalThis.__notifyContract.suppressCalls.map((call) => ({
      eventKind: call.event.kind,
      projectRoot: call.projectRoot ?? null,
    })),
    desktopCalls: globalThis.__notifyContract.desktopCalls,
  };
  notifyCases.push(record("notify-alert", notifyCases.length, "src/notify.test.ts", "notifyAlert", name, input, output));
}

notifyCase("sends desktop alerts when host notification settings allow them", { event: alert() }, () =>
  notify.notifyAlert(alert()),
);
notifyCase("does not send when notifications are disabled", { config: { enabled: false }, event: alert() }, () =>
  notify.notifyAlert(alert()),
);
notifyCase(
  "does not send externally when the test/runtime guard is enabled",
  { env: { AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS: "1" }, event: alert() },
  () => notify.notifyAlert(alert()),
);
notifyCase("does not send when the alert is focus-suppressed", { suppress: true, event: alert({ projectRoot: "/tmp/project" }) }, () =>
  notify.notifyAlert(alert({ projectRoot: "/tmp/project" })),
);
notifyCase("does not send when the alert's category gate is off", { config: { onPrompt: false }, event: alert({ kind: "needs_input" }) }, () =>
  notify.notifyAlert(alert({ kind: "needs_input" })),
);
notifyCase("gates interaction requests as prompt notifications", { config: { onPrompt: false }, event: alert({ kind: "interaction_request" }) }, () =>
  notify.notifyAlert(alert({ kind: "interaction_request" })),
);
notifyCase("gates next-step alerts as prompt notifications", { config: { onPrompt: false }, event: alert({ kind: "next_step" }) }, () =>
  notify.notifyAlert(alert({ kind: "next_step" })),
);
notifyCase(
  "does not forward telemetry-only interaction requests",
  { event: alert({ kind: "interaction_request", interaction: { id: "interaction-1", type: "permission", telemetry: true } }) },
  () =>
    notify.notifyAlert(
      alert({ kind: "interaction_request", interaction: { id: "interaction-1", type: "permission", telemetry: true } }),
    ),
);
notifyCase("sends completion alerts gated by onComplete", { event: alert({ kind: "task_done" }) }, () =>
  notify.notifyAlert(alert({ kind: "task_done" })),
);

await writeContractJson(LOCAL_UI_FIXTURE, {
  version: 1,
  source: "src/local-ui-server.test.ts",
  generatedBy: "scripts/capture-service-notify-contract.mjs",
  description:
    "Local UI server shell/config/static/fallback/traversal/loopback behavior captured by running TypeScript startLocalUiServer against a temporary UI root.",
  cases: localUiCases,
});
await writeContractJson(NOTIFY_FIXTURE, {
  version: 1,
  source: "src/notify.test.ts",
  generatedBy: "scripts/capture-service-notify-contract.mjs",
  description:
    "notifyAlert category gates, focus suppression, external notification guard, and desktop delivery payloads captured by running TypeScript notify with config/suppression/desktop recorders.",
  cases: notifyCases,
});

rmSync(mockDir, { recursive: true, force: true });
console.log(`${LOCAL_UI_FIXTURE.pathname}: ${localUiCases.length} cases`);
console.log(`${NOTIFY_FIXTURE.pathname}: ${notifyCases.length} cases`);
