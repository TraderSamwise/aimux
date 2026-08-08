import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_HOSTED_CONFIG, type HostedConfig } from "./hosted-config.js";
import {
  clientAddress,
  deviceFingerprint,
  HostedEventDelivery,
  pruneHostedDevices,
  recordDeviceSighting,
  signHostedEvent,
  type HostedEvent,
} from "./hosted-events.js";
import { getHostedDevicesPath } from "./paths.js";

let previousAimuxHome: string | undefined;
let previousSecret: string | undefined;
let aimuxHome = "";

const SECRET_ENV = "AIMUX_HOSTED_WEBHOOK_SECRET";

beforeEach(() => {
  previousAimuxHome = process.env.AIMUX_HOME;
  previousSecret = process.env[SECRET_ENV];
  aimuxHome = mkdtempSync(join(tmpdir(), "aimux-hosted-events-"));
  process.env.AIMUX_HOME = aimuxHome;
});

afterEach(() => {
  if (previousAimuxHome === undefined) delete process.env.AIMUX_HOME;
  else process.env.AIMUX_HOME = previousAimuxHome;
  if (previousSecret === undefined) delete process.env[SECRET_ENV];
  else process.env[SECRET_ENV] = previousSecret;
  rmSync(aimuxHome, { recursive: true, force: true });
});

describe("clientAddress", () => {
  const withHeader = (header: string | null): HostedConfig => ({
    ...DEFAULT_HOSTED_CONFIG,
    trustedForwardedHeader: header,
  });

  it("uses the peer address when no forwarded header is configured", () => {
    expect(clientAddress("203.0.113.9", { "x-forwarded-for": "1.2.3.4" }, withHeader(null))).toBe("203.0.113.9");
  });

  it("honours the configured header only when the peer is loopback", () => {
    const config = withHeader("x-forwarded-for");
    expect(clientAddress("127.0.0.1", { "x-forwarded-for": "1.2.3.4" }, config)).toBe("1.2.3.4");

    // A routable peer's forwarded header is just an attacker-supplied string.
    expect(clientAddress("203.0.113.9", { "x-forwarded-for": "1.2.3.4" }, config)).toBe("203.0.113.9");
  });

  it("takes the rightmost forwarded entry, which is the hop we trust", () => {
    const config = withHeader("x-forwarded-for");
    // Proxies APPEND, so the leftmost entry is whatever the client typed. Using
    // it would let anyone forge a new device, or rotate the value to defeat the
    // auth-failure throttle and flood the webhook receiver.
    expect(clientAddress("::1", { "x-forwarded-for": "1.2.3.4, 5.6.7.8" }, config)).toBe("5.6.7.8");
    expect(clientAddress("::1", { "x-forwarded-for": "spoofed, 203.0.113.9 " }, config)).toBe("203.0.113.9");
  });

  it("falls back to the peer when the header is absent or empty", () => {
    const config = withHeader("x-forwarded-for");
    expect(clientAddress("127.0.0.1", {}, config)).toBe("127.0.0.1");
    expect(clientAddress("127.0.0.1", { "x-forwarded-for": "  " }, config)).toBe("127.0.0.1");
  });

  it("reports null when there is genuinely no address", () => {
    expect(clientAddress(undefined, {}, withHeader(null))).toBeNull();
  });
});

describe("deviceFingerprint", () => {
  it("is stable for the same inputs and varies with each of them", () => {
    const base = deviceFingerprint("salt", "1.2.3.4", "ua");
    expect(deviceFingerprint("salt", "1.2.3.4", "ua")).toBe(base);
    expect(deviceFingerprint("other-salt", "1.2.3.4", "ua")).not.toBe(base);
    expect(deviceFingerprint("salt", "5.6.7.8", "ua")).not.toBe(base);
    expect(deviceFingerprint("salt", "1.2.3.4", "other")).not.toBe(base);
  });

  it("never contains the address it was built from", () => {
    expect(deviceFingerprint("salt", "203.0.113.9", "ua")).not.toContain("203.0.113");
  });
});

describe("recordDeviceSighting", () => {
  const sighting = (address: string | null, userAgent = "ua", principalId = "prn_a") => ({
    principalId,
    label: "grand",
    address,
    userAgent,
  });

  it("reports first use, then a new device, then nothing", () => {
    const first = recordDeviceSighting(sighting("1.2.3.4"));
    expect(first?.kind).toBe("hosted_token_first_use");
    expect(first?.addressKnown).toBe(true);

    const second = recordDeviceSighting(sighting("5.6.7.8"));
    expect(second?.kind).toBe("hosted_new_device");

    expect(recordDeviceSighting(sighting("1.2.3.4"))).toBeNull();
    expect(recordDeviceSighting(sighting("5.6.7.8"))).toBeNull();
  });

  it("keeps principals separate", () => {
    recordDeviceSighting(sighting("1.2.3.4", "ua", "prn_a"));
    expect(recordDeviceSighting(sighting("1.2.3.4", "ua", "prn_b"))?.kind).toBe("hosted_token_first_use");
  });

  it("marks an unknown address honestly", () => {
    expect(recordDeviceSighting(sighting(null))?.addressKnown).toBe(false);
  });

  it("does not rewrite the store on every routine sighting", () => {
    recordDeviceSighting(sighting("1.2.3.4"));
    const first = statSync(getHostedDevicesPath()).mtimeMs;

    // Throttled: a known device seen again within the window leaves the file
    // alone, so a busy operator does not rewrite it on every request.
    expect(recordDeviceSighting(sighting("1.2.3.4"))).toBeNull();
    expect(statSync(getHostedDevicesPath()).mtimeMs).toBe(first);
  });

  it("stores a salt and never the raw address, at 0600", () => {
    recordDeviceSighting(sighting("203.0.113.9"));
    const raw = readFileSync(getHostedDevicesPath(), "utf-8");
    expect(raw).not.toContain("203.0.113.9");
    expect(JSON.parse(raw).salt).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(getHostedDevicesPath()).mode & 0o777).toBe(0o600);
  });

  it("prunes devices past the retention window", () => {
    recordDeviceSighting(sighting("1.2.3.4"));
    pruneHostedDevices(30, Date.now() + 31 * 24 * 60 * 60 * 1000);
    // Pruned, so the same device reads as first use again.
    expect(recordDeviceSighting(sighting("1.2.3.4"))?.kind).toBe("hosted_token_first_use");
  });
});

describe("signHostedEvent", () => {
  it("binds the timestamp to the body", () => {
    const a = signHostedEvent("secret", "1000", '{"a":1}');
    expect(a).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signHostedEvent("secret", "1001", '{"a":1}')).not.toBe(a);
    expect(signHostedEvent("secret", "1000", '{"a":2}')).not.toBe(a);
    expect(signHostedEvent("other", "1000", '{"a":1}')).not.toBe(a);
  });
});

describe("HostedEventDelivery", () => {
  let server: Server | null = null;
  let received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];

  async function listen(handler?: (count: number) => number): Promise<string> {
    received = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.statusCode = handler ? handler(received.length) : 200;
        res.end();
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return `http://127.0.0.1:${port}/hook`;
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  const event = (): HostedEvent => ({
    id: "evt_1",
    kind: "hosted_token_first_use",
    ts: new Date(0).toISOString(),
    principalId: "prn_a",
    label: "grand",
    fingerprint: "abc",
    addressKnown: true,
    userAgent: "ua",
  });

  async function settle(ms = 250): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  it("posts a signed, timestamped event", async () => {
    const url = await listen();
    process.env[SECRET_ENV] = "shhh";
    const delivery = new HostedEventDelivery({ ...DEFAULT_HOSTED_CONFIG, webhookUrl: url });

    delivery.enqueue(event());
    await settle();

    expect(received).toHaveLength(1);
    const { headers, body } = received[0]!;
    const timestamp = headers["x-aimux-timestamp"] as string;
    expect(headers["x-aimux-signature"]).toBe(signHostedEvent("shhh", timestamp, body));
    expect(JSON.parse(body).kind).toBe("hosted_token_first_use");
    delivery.stop();
  });

  it("sends nothing when no secret is configured", async () => {
    const url = await listen();
    delete process.env[SECRET_ENV];
    const delivery = new HostedEventDelivery({ ...DEFAULT_HOSTED_CONFIG, webhookUrl: url });

    delivery.enqueue(event());
    await settle();

    // Never unsigned: an unconfigured secret means no delivery at all.
    expect(received).toHaveLength(0);
    delivery.stop();
  });

  it("sends nothing when no webhook url is configured", async () => {
    process.env[SECRET_ENV] = "shhh";
    const delivery = new HostedEventDelivery({ ...DEFAULT_HOSTED_CONFIG, webhookUrl: null });
    expect(() => delivery.enqueue(event())).not.toThrow();
    delivery.stop();
  });

  it("retries a failing receiver and gives up without throwing", async () => {
    const url = await listen((count) => (count >= 2 ? 200 : 500));
    process.env[SECRET_ENV] = "shhh";
    const delivery = new HostedEventDelivery({ ...DEFAULT_HOSTED_CONFIG, webhookUrl: url });

    delivery.enqueue(event());
    await settle(2_000);

    expect(received.length).toBeGreaterThanOrEqual(2);
    delivery.stop();
  });

  it("does not throw when the receiver is unreachable", async () => {
    process.env[SECRET_ENV] = "shhh";
    const delivery = new HostedEventDelivery({
      ...DEFAULT_HOSTED_CONFIG,
      webhookUrl: "http://127.0.0.1:1/hook",
    });

    delivery.enqueue(event());
    await settle(100);
    delivery.stop();
  });
});
