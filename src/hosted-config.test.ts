import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";
import {
  DEFAULT_HOSTED_CONFIG,
  isLoopbackBindAddress,
  loadHostedConfig,
  normalizeHostedConfig,
  validateHostedStartup,
} from "./hosted-config.js";

let previousAimuxHome: string | undefined;
let aimuxHome = "";

function writeGlobalConfig(value: unknown): void {
  writeFileSync(join(aimuxHome, "config.json"), JSON.stringify(value));
}

beforeEach(() => {
  previousAimuxHome = process.env.AIMUX_HOME;
  aimuxHome = mkdtempSync(join(tmpdir(), "aimux-hosted-config-"));
  process.env.AIMUX_HOME = aimuxHome;
});

afterEach(() => {
  if (previousAimuxHome === undefined) delete process.env.AIMUX_HOME;
  else process.env.AIMUX_HOME = previousAimuxHome;
  rmSync(aimuxHome, { recursive: true, force: true });
});

describe("isLoopbackBindAddress", () => {
  it("accepts loopback forms", () => {
    for (const address of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"]) {
      expect(isLoopbackBindAddress(address), address).toBe(true);
    }
  });

  it("rejects routable addresses", () => {
    for (const address of ["0.0.0.0", "192.168.1.10", "10.0.0.1", "::", "example.com", "1270.0.1"]) {
      expect(isLoopbackBindAddress(address), address).toBe(false);
    }
  });
});

describe("normalizeHostedConfig", () => {
  it("returns defaults for absent or non-object input", () => {
    expect(normalizeHostedConfig(undefined)).toEqual(DEFAULT_HOSTED_CONFIG);
    expect(normalizeHostedConfig("nope")).toEqual(DEFAULT_HOSTED_CONFIG);
  });

  it("floors the context cap at the envelope a full-size context needs", () => {
    // Below this the project service's own 4 KB text limit stops being the
    // binding one, and a legal context is refused by the transport instead of
    // by the layer that could say why.
    expect(normalizeHostedConfig({ maxContextBytes: 512 }).maxContextBytes).toBe(8_192);
    expect(normalizeHostedConfig({ maxContextBytes: 16_384 }).maxContextBytes).toBe(16_384);
  });

  it("does not share nested state with the default object", () => {
    const normalized = normalizeHostedConfig(undefined);
    normalized.rateLimit.requestsPerMinute = 1;
    expect(DEFAULT_HOSTED_CONFIG.rateLimit.requestsPerMinute).toBe(60);
  });

  it("clamps out-of-range and wrongly typed values back to defaults", () => {
    const normalized = normalizeHostedConfig({
      enabled: "yes",
      bindAddress: "   ",
      port: 0,
      rateLimit: { requestsPerMinute: -5, maxConcurrent: 9_999_999 },
      maxPromptBytes: Number.NaN,
      maxResponseBytes: 512, // below the 4 KiB floor

      auditPromptBodies: 0,
      webhookUrl: "   ",
      webhookSecretEnv: "",
    });

    expect(normalized.enabled).toBe(false);
    expect(normalized.bindAddress).toBe("127.0.0.1");
    expect(normalized.port).toBe(43195);
    expect(normalized.rateLimit).toEqual({
      requestsPerMinute: 60,
      maxConcurrent: 4,
      bytesPerMinute: 48 * 1024 * 1024,
    });
    expect(normalized.maxPromptBytes).toBe(16_384);
    expect(normalized.maxResponseBytes).toBe(1_048_576);
    expect(normalized.auditPromptBodies).toBe(true);
    expect(normalized.webhookUrl).toBeNull();
    expect(normalized.webhookSecretEnv).toBe("AIMUX_HOSTED_WEBHOOK_SECRET");
  });

  it("keeps valid overrides", () => {
    const normalized = normalizeHostedConfig({ enabled: true, port: 44000, bindAddress: "0.0.0.0" });
    expect(normalized.enabled).toBe(true);
    expect(normalized.port).toBe(44000);
    expect(normalized.bindAddress).toBe("0.0.0.0");
  });
});

describe("loadHostedConfig", () => {
  it("defaults when there is no global config", () => {
    expect(loadHostedConfig()).toEqual(DEFAULT_HOSTED_CONFIG);
  });

  it("reads the hosted block from the global config", () => {
    writeGlobalConfig({ hosted: { enabled: true, port: 44100 } });
    const config = loadHostedConfig();
    expect(config.enabled).toBe(true);
    expect(config.port).toBe(44100);
  });

  it("quarantines a corrupt global config instead of throwing", () => {
    writeFileSync(join(aimuxHome, "config.json"), "{ not json");
    expect(loadHostedConfig()).toEqual(DEFAULT_HOSTED_CONFIG);
    expect(readdirSync(aimuxHome).some((name) => name.includes("corrupt"))).toBe(true);
  });

  it("ignores a hosted block in project config", () => {
    // The escalation this guards: a committed .aimux/config.json turning on a
    // listener for anyone who clones the repo.
    const projectRoot = mkdtempSync(join(tmpdir(), "aimux-hosted-project-"));
    try {
      mkdirSync(join(projectRoot, ".aimux"), { recursive: true });
      writeFileSync(
        join(projectRoot, ".aimux", "config.json"),
        JSON.stringify({ hosted: { enabled: true, bindAddress: "0.0.0.0" } }),
      );

      expect(loadHostedConfig()).toEqual(DEFAULT_HOSTED_CONFIG);
      expect((loadConfig({ projectRoot }) as Record<string, unknown>).hosted).toBeUndefined();
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("keeps a global hosted block through a config load", () => {
    // The project-config strip must not also destroy legitimate global
    // settings on any load→save round trip.
    writeGlobalConfig({ hosted: { enabled: true, port: 44200 } });
    const projectRoot = mkdtempSync(join(tmpdir(), "aimux-hosted-project-"));
    try {
      expect((loadConfig({ projectRoot }) as Record<string, unknown>).hosted).toEqual({
        enabled: true,
        port: 44200,
      });
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe("validateHostedStartup", () => {
  it("passes when disabled, whatever else is set", () => {
    const config = { ...DEFAULT_HOSTED_CONFIG, bindAddress: "0.0.0.0" };
    expect(validateHostedStartup(config, 0)).toEqual({ ok: true });
  });

  it("refuses an off-loopback bind with no principals", () => {
    const config = { ...DEFAULT_HOSTED_CONFIG, enabled: true, bindAddress: "0.0.0.0" };
    const result = validateHostedStartup(config, 0);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("no principals");
  });

  it("allows an off-loopback bind once an active principal exists", () => {
    const config = { ...DEFAULT_HOSTED_CONFIG, enabled: true, bindAddress: "0.0.0.0" };
    expect(validateHostedStartup(config, 1)).toEqual({ ok: true });
    // The count is of ACTIVE principals; a revoked-only box must not bind.
    expect(validateHostedStartup(config, 0).ok).toBe(false);
  });

  it("allows a loopback bind with no principals", () => {
    const config = { ...DEFAULT_HOSTED_CONFIG, enabled: true };
    expect(validateHostedStartup(config, 0)).toEqual({ ok: true });
  });

  it("rejects a plaintext webhook to a remote host", () => {
    const config = { ...DEFAULT_HOSTED_CONFIG, enabled: true, webhookUrl: "http://example.com/hook" };
    const result = validateHostedStartup(config, 1);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("https");
  });

  it("allows a plaintext webhook to loopback and https anywhere", () => {
    expect(
      validateHostedStartup({ ...DEFAULT_HOSTED_CONFIG, enabled: true, webhookUrl: "http://127.0.0.1:9000/h" }, 1),
    ).toEqual({ ok: true });
    expect(
      validateHostedStartup({ ...DEFAULT_HOSTED_CONFIG, enabled: true, webhookUrl: "https://example.com/h" }, 1),
    ).toEqual({ ok: true });
  });

  it("rejects a malformed webhook url", () => {
    const config = { ...DEFAULT_HOSTED_CONFIG, enabled: true, webhookUrl: "not-a-url" };
    expect(validateHostedStartup(config, 1).ok).toBe(false);
  });

  it("refuses to sign with a secret from a non-aimux env var", () => {
    // Otherwise pointing this at PATH or a cloud credential turns the webhook
    // into a signing oracle over an unrelated secret.
    for (const name of ["PATH", "AWS_SECRET_ACCESS_KEY", "HOME"]) {
      const config = { ...DEFAULT_HOSTED_CONFIG, enabled: true, webhookSecretEnv: name };
      const result = validateHostedStartup(config, 1);
      expect(result.ok, name).toBe(false);
      expect(result.ok === false && result.error).toContain("AIMUX_");
    }

    expect(validateHostedStartup({ ...DEFAULT_HOSTED_CONFIG, enabled: true }, 1)).toEqual({ ok: true });
    expect(
      validateHostedStartup({ ...DEFAULT_HOSTED_CONFIG, enabled: true, webhookSecretEnv: "AIMUX_OTHER" }, 1),
    ).toEqual({ ok: true });
  });

  it("never echoes the webhook url in an error", () => {
    const config = { ...DEFAULT_HOSTED_CONFIG, enabled: true, webhookUrl: "not-a-url-secret-token" };
    const result = validateHostedStartup(config, 1);
    expect(result.ok === false && result.error).not.toContain("secret-token");
  });
});

describe("hosted config additions", () => {
  it("normalizes trustedForwardedHeader to lower case, defaulting to null", () => {
    expect(normalizeHostedConfig({}).trustedForwardedHeader).toBeNull();
    expect(normalizeHostedConfig({ trustedForwardedHeader: "  X-Forwarded-For " }).trustedForwardedHeader).toBe(
      "x-forwarded-for",
    );
    expect(normalizeHostedConfig({ trustedForwardedHeader: "   " }).trustedForwardedHeader).toBeNull();
    expect(normalizeHostedConfig({ trustedForwardedHeader: 42 }).trustedForwardedHeader).toBeNull();
  });

  it("ignores a forwarded header the tunnel does not set", () => {
    // The value is trusted whenever the peer is loopback — which behind a tunnel
    // is every request. A header cloudflared never sets is one the CLIENT sets,
    // so honouring it would let anyone forge device identity and rotate past the
    // per-address throttles.
    for (const header of ["x-real-ip", "forwarded", "x-client-ip"]) {
      expect(normalizeHostedConfig({ trustedForwardedHeader: header }).trustedForwardedHeader).toBeNull();
    }
    for (const header of ["cf-connecting-ip", "x-forwarded-for", "true-client-ip"]) {
      expect(normalizeHostedConfig({ trustedForwardedHeader: header }).trustedForwardedHeader).toBe(header);
    }
  });

  it("does not refuse startup over an unusable forwarded header", () => {
    // Rejecting at startup would skip hosted mode entirely, taking a running
    // listener down over a field it can safely ignore.
    const config = normalizeHostedConfig({ enabled: true, trustedForwardedHeader: "x-real-ip" });
    expect(validateHostedStartup(config, 1).ok).toBe(true);
  });

  it("clamps retentionDays", () => {
    expect(normalizeHostedConfig({}).retentionDays).toBe(30);
    expect(normalizeHostedConfig({ retentionDays: 7 }).retentionDays).toBe(7);
    expect(normalizeHostedConfig({ retentionDays: 0 }).retentionDays).toBe(30);
    expect(normalizeHostedConfig({ retentionDays: 99_999 }).retentionDays).toBe(30);
  });
});
