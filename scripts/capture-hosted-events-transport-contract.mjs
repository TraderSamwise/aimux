#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const HOSTED_EVENTS_FIXTURE = new URL("testdata/contracts/v1/hosted/events.json", ROOT);
const MOBILE_PUSH_FIXTURE = new URL("testdata/contracts/v1/notifications/mobile-push.json", ROOT);
const FIXED_SALT = "0".repeat(64);
const SECRET_ENV = "AIMUX_HOSTED_WEBHOOK_SECRET";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

function normalizeDynamic(value, state = { ids: new Map(), timestamps: new Map() }) {
  if (Array.isArray(value)) return value.map((entry) => normalizeDynamic(entry, state));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeDynamic(entry, state)]));
  }
  if (typeof value !== "string") return value;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    if (!state.ids.has(value)) state.ids.set(value, `<id:${state.ids.size + 1}>`);
    return state.ids.get(value);
  }
  if (value === "1970-01-01T00:00:00.000Z") return value;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    if (!state.timestamps.has(value)) state.timestamps.set(value, `<ts:${state.timestamps.size + 1}>`);
    return state.timestamps.get(value);
  }
  return value.replace(process.cwd(), "<cwd>");
}

function caseRecord(index, source, api, name, input, output) {
  return {
    id: `${api.replaceAll(".", "-")}-${String(index + 1).padStart(3, "0")}`,
    name,
    source,
    api,
    input,
    output: normalizeDynamic(output),
    inputSha256: hash(input),
  };
}

function withHome(run) {
  const previousHome = process.env.AIMUX_HOME;
  const previousSecret = process.env[SECRET_ENV];
  const home = mkdtempSync(join(tmpdir(), "aimux-hosted-events-contract-"));
  process.env.AIMUX_HOME = home;
  try {
    return run(home);
  } finally {
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    if (previousSecret === undefined) delete process.env[SECRET_ENV];
    else process.env[SECRET_ENV] = previousSecret;
    rmSync(home, { recursive: true, force: true });
  }
}

const hostedEvents = await import(new URL("dist/full/hosted-events.js", ROOT));
const hostedConfig = await import(new URL("dist/full/hosted-config.js", ROOT));
const paths = await import(new URL("dist/paths.js", ROOT));
const { forwardAlertToMobilePush } = await import(new URL("dist/mobile-push-bridge.js", ROOT));

function seededDevices(devices = []) {
  mkdirSync(paths.getHostedDir(), { recursive: true, mode: 0o700 });
  writeFileSync(
    paths.getHostedDevicesPath(),
    `${JSON.stringify({ version: 1, salt: FIXED_SALT, devices }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function readDevices() {
  return JSON.parse(readFileSync(paths.getHostedDevicesPath(), "utf-8"));
}

const configWithHeader = (header) => ({ ...hostedConfig.DEFAULT_HOSTED_CONFIG, trustedForwardedHeader: header });
const sighting = (address, userAgent = "ua", principalId = "prn_a") => ({
  principalId,
  label: "grand",
  address,
  userAgent,
});

const hostedCases = [];
const hosted = (api, name, input, run) => {
  hostedCases.push(caseRecord(hostedCases.length, "src/full/hosted-events.test.ts", api, name, input, run()));
};
const hostedHome = (api, name, input, run) => {
  hostedCases.push(caseRecord(hostedCases.length, "src/full/hosted-events.test.ts", api, name, input, withHome(run)));
};

hosted("clientAddress", "uses the peer address when no forwarded header is configured", {
  peerAddress: "203.0.113.9",
  headers: { "x-forwarded-for": "1.2.3.4" },
  trustedForwardedHeader: null,
}, () => hostedEvents.clientAddress("203.0.113.9", { "x-forwarded-for": "1.2.3.4" }, configWithHeader(null)));
hosted("clientAddress", "honours the configured header only when the peer is loopback", {
  peerAddress: "127.0.0.1",
  headers: { "x-forwarded-for": "1.2.3.4" },
  trustedForwardedHeader: "x-forwarded-for",
}, () => hostedEvents.clientAddress("127.0.0.1", { "x-forwarded-for": "1.2.3.4" }, configWithHeader("x-forwarded-for")));
hosted("clientAddress", "ignores forwarded headers from routable peers", {
  peerAddress: "203.0.113.9",
  headers: { "x-forwarded-for": "1.2.3.4" },
  trustedForwardedHeader: "x-forwarded-for",
}, () => hostedEvents.clientAddress("203.0.113.9", { "x-forwarded-for": "1.2.3.4" }, configWithHeader("x-forwarded-for")));
hosted("clientAddress", "takes the rightmost forwarded entry", {
  peerAddress: "::1",
  headers: { "x-forwarded-for": "spoofed, 203.0.113.9 " },
  trustedForwardedHeader: "x-forwarded-for",
}, () => hostedEvents.clientAddress("::1", { "x-forwarded-for": "spoofed, 203.0.113.9 " }, configWithHeader("x-forwarded-for")));
hosted("clientAddress", "falls back to the peer when the header is absent or empty", {
  values: [
    { peerAddress: "127.0.0.1", headers: {}, trustedForwardedHeader: "x-forwarded-for" },
    { peerAddress: "127.0.0.1", headers: { "x-forwarded-for": "  " }, trustedForwardedHeader: "x-forwarded-for" },
  ],
}, () => [
  hostedEvents.clientAddress("127.0.0.1", {}, configWithHeader("x-forwarded-for")),
  hostedEvents.clientAddress("127.0.0.1", { "x-forwarded-for": "  " }, configWithHeader("x-forwarded-for")),
]);
hosted("clientAddress", "reports null when there is genuinely no address", {
  headers: {},
  trustedForwardedHeader: null,
}, () => hostedEvents.clientAddress(undefined, {}, configWithHeader(null)));

hosted("deviceFingerprint", "is stable and varies with each input", {
  salt: "salt",
  address: "1.2.3.4",
  userAgent: "ua",
}, () => {
  const base = hostedEvents.deviceFingerprint("salt", "1.2.3.4", "ua");
  return {
    base,
    same: hostedEvents.deviceFingerprint("salt", "1.2.3.4", "ua"),
    otherSalt: hostedEvents.deviceFingerprint("other-salt", "1.2.3.4", "ua"),
    otherAddress: hostedEvents.deviceFingerprint("salt", "5.6.7.8", "ua"),
    otherUserAgent: hostedEvents.deviceFingerprint("salt", "1.2.3.4", "other"),
    exposesAddress: base.includes("203.0.113"),
  };
});
hosted("deviceFingerprint", "normalizes null address and user agent distinctly", {
  salt: "salt",
  address: null,
  userAgent: null,
}, () => hostedEvents.deviceFingerprint("salt", null, null));

hostedHome("recordDeviceSighting", "reports first use, then a new device, then nothing", {
  seed: { salt: FIXED_SALT, devices: [] },
  sightings: [sighting("1.2.3.4"), sighting("5.6.7.8"), sighting("1.2.3.4"), sighting("5.6.7.8")],
}, () => {
  seededDevices();
  const events = [
    hostedEvents.recordDeviceSighting(sighting("1.2.3.4")),
    hostedEvents.recordDeviceSighting(sighting("5.6.7.8")),
    hostedEvents.recordDeviceSighting(sighting("1.2.3.4")),
    hostedEvents.recordDeviceSighting(sighting("5.6.7.8")),
  ];
  return { events, state: readDevices() };
});
hostedHome("recordDeviceSighting", "keeps principals separate", {
  seed: { salt: FIXED_SALT, devices: [] },
  sightings: [sighting("1.2.3.4", "ua", "prn_a"), sighting("1.2.3.4", "ua", "prn_b")],
}, () => {
  seededDevices();
  hostedEvents.recordDeviceSighting(sighting("1.2.3.4", "ua", "prn_a"));
  return hostedEvents.recordDeviceSighting(sighting("1.2.3.4", "ua", "prn_b"));
});
hostedHome("recordDeviceSighting", "marks an unknown address honestly", {
  seed: { salt: FIXED_SALT, devices: [] },
  sighting: sighting(null),
}, () => {
  seededDevices();
  return hostedEvents.recordDeviceSighting(sighting(null));
});
hostedHome("recordDeviceSighting", "does not rewrite the store on every routine sighting", {
  seed: { salt: FIXED_SALT, devices: [] },
  sightings: [sighting("1.2.3.4"), sighting("1.2.3.4")],
}, () => {
  seededDevices();
  hostedEvents.recordDeviceSighting(sighting("1.2.3.4"));
  const first = readFileSync(paths.getHostedDevicesPath(), "utf-8");
  const event = hostedEvents.recordDeviceSighting(sighting("1.2.3.4"));
  return { event, stateUnchanged: readFileSync(paths.getHostedDevicesPath(), "utf-8") === first };
});
hostedHome("recordDeviceSighting", "stores a salt and never the raw address, at 0600", {
  seed: null,
  sighting: sighting("203.0.113.9"),
}, () => {
  const event = hostedEvents.recordDeviceSighting(sighting("203.0.113.9"));
  const raw = readFileSync(paths.getHostedDevicesPath(), "utf-8");
  return {
    event: {
      kind: event?.kind,
      principalId: event?.principalId,
      label: event?.label,
      addressKnown: event?.addressKnown,
      userAgent: event?.userAgent,
      fingerprintLooksHashed: /^[0-9a-f]{32}$/.test(event?.fingerprint ?? ""),
      fingerprintContainsAddress: event?.fingerprint?.includes("203.0.113") ?? false,
    },
    rawContainsAddress: raw.includes("203.0.113.9"),
    saltLooksHex: /^[0-9a-f]{64}$/.test(JSON.parse(raw).salt),
    mode: statSync(paths.getHostedDevicesPath()).mode & 0o777,
  };
});
hostedHome("pruneHostedDevices", "prunes devices past the retention window", {
  seed: { salt: FIXED_SALT, devices: [] },
  retentionDays: 30,
}, () => {
  seededDevices();
  hostedEvents.recordDeviceSighting(sighting("1.2.3.4"));
  hostedEvents.pruneHostedDevices(30, Date.now() + 31 * 24 * 60 * 60 * 1000);
  return { eventAfterPrune: hostedEvents.recordDeviceSighting(sighting("1.2.3.4")), state: readDevices() };
});

hosted("signHostedEvent", "binds the timestamp to the body", {
  secret: "secret",
  timestamp: "1000",
  body: "{\"a\":1}",
}, () => {
  const a = hostedEvents.signHostedEvent("secret", "1000", "{\"a\":1}");
  return {
    a,
    formatOk: /^sha256=[0-9a-f]{64}$/.test(a),
    otherTimestamp: hostedEvents.signHostedEvent("secret", "1001", "{\"a\":1}"),
    otherBody: hostedEvents.signHostedEvent("secret", "1000", "{\"a\":2}"),
    otherSecret: hostedEvents.signHostedEvent("other", "1000", "{\"a\":1}"),
  };
});

async function listen(handler) {
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.statusCode = handler ? handler(received.length) : 200;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/hook`,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function settle(ms = 250) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function event() {
  return {
    id: "evt_1",
    kind: "hosted_token_first_use",
    ts: new Date(0).toISOString(),
    principalId: "prn_a",
    label: "grand",
    fingerprint: "abc",
    addressKnown: true,
    userAgent: "ua",
  };
}

async function hostedAsync(api, name, input, run) {
  hostedCases.push(caseRecord(hostedCases.length, "src/full/hosted-events.test.ts", api, name, input, await run()));
}

await hostedAsync("HostedEventDelivery", "posts a signed, timestamped event", {
  event: event(),
  secretConfigured: true,
  webhookConfigured: true,
}, async () => {
  const server = await listen();
  process.env[SECRET_ENV] = "shhh";
  const delivery = new hostedEvents.HostedEventDelivery({
    ...hostedConfig.DEFAULT_HOSTED_CONFIG,
    webhookUrl: server.url,
  });
  try {
    delivery.enqueue(event());
    await settle();
    const first = server.received[0];
    const timestamp = first?.headers["x-aimux-timestamp"];
    const body = first?.body ?? "";
    return {
      received: server.received.length,
      signatureMatches: first?.headers["x-aimux-signature"] === hostedEvents.signHostedEvent("shhh", timestamp, body),
      timestampLooksNumeric: /^\d+$/.test(timestamp),
      body: JSON.parse(body),
    };
  } finally {
    delivery.stop();
    await server.close();
    delete process.env[SECRET_ENV];
  }
});
await hostedAsync("HostedEventDelivery", "sends nothing when no secret is configured", {
  event: event(),
  secretConfigured: false,
  webhookConfigured: true,
}, async () => {
  const server = await listen();
  const delivery = new hostedEvents.HostedEventDelivery({ ...hostedConfig.DEFAULT_HOSTED_CONFIG, webhookUrl: server.url });
  try {
    delete process.env[SECRET_ENV];
    delivery.enqueue(event());
    await settle();
    return { received: server.received.length };
  } finally {
    delivery.stop();
    await server.close();
  }
});
await hostedAsync("HostedEventDelivery", "sends nothing when no webhook url is configured", {
  event: event(),
  secretConfigured: true,
  webhookConfigured: false,
}, async () => {
  process.env[SECRET_ENV] = "shhh";
  const delivery = new hostedEvents.HostedEventDelivery({ ...hostedConfig.DEFAULT_HOSTED_CONFIG, webhookUrl: null });
  try {
    let threw = false;
    try {
      delivery.enqueue(event());
    } catch {
      threw = true;
    }
    return { threw };
  } finally {
    delivery.stop();
    delete process.env[SECRET_ENV];
  }
});
await hostedAsync("HostedEventDelivery", "retries a failing receiver and gives up without throwing", {
  event: event(),
  firstStatus: 500,
  secondStatus: 200,
}, async () => {
  const server = await listen((count) => (count >= 2 ? 200 : 500));
  process.env[SECRET_ENV] = "shhh";
  const delivery = new hostedEvents.HostedEventDelivery({
    ...hostedConfig.DEFAULT_HOSTED_CONFIG,
    webhookUrl: server.url,
  });
  try {
    delivery.enqueue(event());
    await settle(2_000);
    return { receivedAtLeastTwo: server.received.length >= 2, received: server.received.length };
  } finally {
    delivery.stop();
    await server.close();
    delete process.env[SECRET_ENV];
  }
});
await hostedAsync("HostedEventDelivery", "does not throw when the receiver is unreachable", {
  event: event(),
  webhookUrl: "http://127.0.0.1:1/hook",
}, async () => {
  process.env[SECRET_ENV] = "shhh";
  const delivery = new hostedEvents.HostedEventDelivery({
    ...hostedConfig.DEFAULT_HOSTED_CONFIG,
    webhookUrl: "http://127.0.0.1:1/hook",
  });
  try {
    let threw = false;
    try {
      delivery.enqueue(event());
    } catch {
      threw = true;
    }
    await settle(100);
    return { threw };
  } finally {
    delivery.stop();
    delete process.env[SECRET_ENV];
  }
});

const mobileCases = [];
function alert(overrides = {}) {
  return {
    type: "alert",
    kind: "needs_input",
    projectId: "project-1",
    sessionId: "claude-1",
    title: "claude-1 needs input",
    message: "waiting for input",
    ts: "2026-06-06T00:00:00.000Z",
    ...overrides,
  };
}

async function withDaemonServer(run) {
  const previousHome = process.env.AIMUX_HOME;
  const home = mkdtempSync(join(tmpdir(), "aimux-mobile-push-contract-"));
  process.env.AIMUX_HOME = home;
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  mkdirSync(join(home, "daemon"), { recursive: true });
  writeFileSync(
    join(home, "daemon", "daemon.json"),
    `${JSON.stringify({ pid: process.pid, port: address.port, startedAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() }, null, 2)}\n`,
  );
  try {
    return await run(received);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}

async function mobile(name, input, run) {
  mobileCases.push(caseRecord(mobileCases.length, "src/full/mobile-push-bridge.test.ts", "forwardAlertToMobilePush", name, input, await run()));
}

await mobile("forwards alert payloads to the daemon", {
  event: alert({ dedupeKey: "needs_input:claude-1" }),
  env: {},
}, async () => withDaemonServer(async (received) => {
  delete process.env.AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS;
  delete process.env.AIMUX_DISABLE_DESKTOP_NOTIFICATIONS;
  forwardAlertToMobilePush(alert({ dedupeKey: "needs_input:claude-1" }));
  await settle(100);
  return received.map((request) => ({
    method: request.method,
    path: request.path,
    contentType: request.headers["content-type"],
    body: normalizeDynamic(JSON.parse(request.body)),
  }));
}));
await mobile("does not forward when external notifications are disabled", {
  event: alert(),
  env: { AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS: "1" },
}, async () => withDaemonServer(async (received) => {
  process.env.AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS = "1";
  delete process.env.AIMUX_DISABLE_DESKTOP_NOTIFICATIONS;
  forwardAlertToMobilePush(alert());
  await settle(100);
  delete process.env.AIMUX_DISABLE_EXTERNAL_NOTIFICATIONS;
  return { received: received.length };
}));

await writeContractJson(HOSTED_EVENTS_FIXTURE, {
  version: 1,
  source: "src/full/hosted-events.test.ts",
  generatedBy: "scripts/capture-hosted-events-transport-contract.mjs",
  description:
    "Hosted event address selection, device fingerprinting, device-sighting side effects, webhook signing, and delivery behavior captured by running the TypeScript hosted-events module.",
  cases: hostedCases,
});
await writeContractJson(MOBILE_PUSH_FIXTURE, {
  version: 1,
  source: "src/full/mobile-push-bridge.test.ts",
  generatedBy: "scripts/capture-hosted-events-transport-contract.mjs",
  description:
    "Mobile push alert forwarding request shape and notification-disable behavior captured by running the TypeScript mobile-push bridge against a local daemon endpoint.",
  cases: mobileCases,
});

console.log(`${HOSTED_EVENTS_FIXTURE.pathname}: ${hostedCases.length} cases`);
console.log(`${MOBILE_PUSH_FIXTURE.pathname}: ${mobileCases.length} cases`);
