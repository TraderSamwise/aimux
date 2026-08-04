import { existsSync, readFileSync } from "node:fs";

import { quarantineCorruptFile } from "./atomic-write.js";
import { log } from "./debug.js";
import { getGlobalConfigPath } from "./paths.js";

/**
 * Hosted mode is configured from the GLOBAL config only.
 *
 * Project config (`.aimux/config.json`) is committed in repos, so letting it
 * reach these fields would mean cloning a repo could enable a network listener
 * or move its bind address. Hosted config therefore never joins `AimuxConfig`.
 */

export const HOSTED_DEFAULT_PORT = 43195;

export interface HostedRateLimitConfig {
  /** Per-principal request ceiling. */
  requestsPerMinute: number;
  /** Per-principal in-flight request ceiling. */
  maxConcurrent: number;
}

export interface HostedConfig {
  enabled: boolean;
  bindAddress: string;
  port: number;
  rateLimit: HostedRateLimitConfig;
  maxPromptBytes: number;
  maxResponseBytes: number;
  /** Persist prompt text in the audit log, not just its hash. */
  auditPromptBodies: boolean;
  webhookUrl: string | null;
  /** Env var holding the HMAC secret; the secret itself is never stored in config. */
  webhookSecretEnv: string;
  /**
   * Header carrying the real client address, honoured ONLY when the request
   * arrives from loopback (i.e. from a tunnel or reverse proxy we run).
   * Null means the client address is simply unknown, which is reported
   * honestly rather than guessed.
   */
  trustedForwardedHeader: string | null;
  /** How long audit records and device records are kept. */
  retentionDays: number;
}

export const DEFAULT_HOSTED_CONFIG: HostedConfig = {
  enabled: false,
  bindAddress: "127.0.0.1",
  port: HOSTED_DEFAULT_PORT,
  rateLimit: {
    requestsPerMinute: 60,
    maxConcurrent: 4,
  },
  maxPromptBytes: 16_384,
  maxResponseBytes: 1_048_576,
  auditPromptBodies: true,
  webhookUrl: null,
  webhookSecretEnv: "AIMUX_HOSTED_WEBHOOK_SECRET",
  trustedForwardedHeader: null,
  retentionDays: 30,
};

/**
 * Only aimux-owned env vars may name the signing secret.
 *
 * Without this, pointing `webhookSecretEnv` at PATH or a cloud credential turns
 * the webhook into a signing oracle over an unrelated secret.
 */
const SECRET_ENV_PREFIX = "AIMUX_";

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  if (rounded < min || rounded > max) return fallback;
  return rounded;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function isLoopbackBindAddress(address: string): boolean {
  const host = address
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host === "::ffff:127.0.0.1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function isLoopbackHostname(hostname: string): boolean {
  return isLoopbackBindAddress(hostname);
}

/**
 * Headers a proxy sets that a client cannot.
 *
 * The value is trusted whenever the peer is loopback — which, behind a tunnel,
 * is every request. A name outside this set is one the tunnel does not set, so
 * the client supplies it: it would forge device identity at will and defeat the
 * per-address throttles by rotating it. Refused here rather than at startup,
 * because a startup failure skips hosted mode entirely and would take an
 * already-running listener down over a field it can safely ignore.
 */
const ALLOWED_FORWARDED_HEADERS = new Set(["cf-connecting-ip", "x-forwarded-for", "true-client-ip"]);

function normalizeForwardedHeader(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const name = raw.trim().toLowerCase();
  if (ALLOWED_FORWARDED_HEADERS.has(name)) return name;
  log.warn("hosted trustedForwardedHeader ignored", "hosted", {
    header: name,
    allowed: [...ALLOWED_FORWARDED_HEADERS].join(", "),
  });
  return null;
}

/** Coerce a user-authored `hosted` block into a complete, in-range config. */
export function normalizeHostedConfig(raw: unknown): HostedConfig {
  if (!raw || typeof raw !== "object")
    return { ...DEFAULT_HOSTED_CONFIG, rateLimit: { ...DEFAULT_HOSTED_CONFIG.rateLimit } };
  const value = raw as Record<string, unknown>;
  const rateLimitRaw = (value.rateLimit ?? {}) as Record<string, unknown>;
  const webhookUrl = typeof value.webhookUrl === "string" && value.webhookUrl.trim() ? value.webhookUrl.trim() : null;

  return {
    enabled: boolOr(value.enabled, DEFAULT_HOSTED_CONFIG.enabled),
    bindAddress: nonEmptyString(value.bindAddress, DEFAULT_HOSTED_CONFIG.bindAddress),
    port: boundedInt(value.port, DEFAULT_HOSTED_CONFIG.port, 1, 65_535),
    rateLimit: {
      requestsPerMinute: boundedInt(
        rateLimitRaw.requestsPerMinute,
        DEFAULT_HOSTED_CONFIG.rateLimit.requestsPerMinute,
        1,
        100_000,
      ),
      maxConcurrent: boundedInt(rateLimitRaw.maxConcurrent, DEFAULT_HOSTED_CONFIG.rateLimit.maxConcurrent, 1, 1_000),
    },
    maxPromptBytes: boundedInt(value.maxPromptBytes, DEFAULT_HOSTED_CONFIG.maxPromptBytes, 1, 10_485_760),
    // Floored: a tiny response cap truncates every reply and reads as an outage.
    maxResponseBytes: boundedInt(value.maxResponseBytes, DEFAULT_HOSTED_CONFIG.maxResponseBytes, 4_096, 104_857_600),
    auditPromptBodies: boolOr(value.auditPromptBodies, DEFAULT_HOSTED_CONFIG.auditPromptBodies),
    webhookUrl,
    webhookSecretEnv: nonEmptyString(value.webhookSecretEnv, DEFAULT_HOSTED_CONFIG.webhookSecretEnv),
    trustedForwardedHeader: normalizeForwardedHeader(value.trustedForwardedHeader),
    retentionDays: boundedInt(value.retentionDays, DEFAULT_HOSTED_CONFIG.retentionDays, 1, 3_650),
  };
}

/** Read the `hosted` block from the global config file. */
export function loadHostedConfig(): HostedConfig {
  const globalPath = getGlobalConfigPath();
  if (!existsSync(globalPath)) return normalizeHostedConfig(undefined);
  try {
    const parsed = JSON.parse(readFileSync(globalPath, "utf-8")) as Record<string, unknown>;
    return normalizeHostedConfig(parsed?.hosted);
  } catch {
    quarantineCorruptFile(globalPath);
    return normalizeHostedConfig(undefined);
  }
}

export type HostedStartupValidation = { ok: true } | { ok: false; error: string };

/**
 * Startup gate. Binding off-loopback with nobody authorized to connect is
 * always a misconfiguration, so it fails closed instead of warning — otherwise
 * the window between "listener up" and "principals created" is an open door.
 *
 * `activePrincipalCount` must exclude revoked principals: a box whose only
 * token was revoked has nobody authorized, whatever the file still contains.
 */
export function validateHostedStartup(config: HostedConfig, activePrincipalCount: number): HostedStartupValidation {
  if (!config.enabled) return { ok: true };

  if (!isLoopbackBindAddress(config.bindAddress) && activePrincipalCount <= 0) {
    return {
      ok: false,
      error: `hosted mode refuses to bind ${config.bindAddress} with no principals — run "aimux hosted token create" first`,
    };
  }

  if (!config.webhookSecretEnv.startsWith(SECRET_ENV_PREFIX)) {
    return {
      ok: false,
      error: `hosted webhookSecretEnv must name an ${SECRET_ENV_PREFIX}* variable, not ${config.webhookSecretEnv}`,
    };
  }

  if (config.webhookUrl) {
    let parsed: URL;
    try {
      parsed = new URL(config.webhookUrl);
    } catch {
      // The URL itself is a bearer secret for most receivers — never echo it.
      return { ok: false, error: "hosted webhookUrl is not a valid URL" };
    }
    if (parsed.protocol !== "https:" && !isLoopbackHostname(parsed.hostname)) {
      return { ok: false, error: "hosted webhookUrl must be https unless it targets loopback" };
    }
  }

  return { ok: true };
}
