#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const PATHS = {
  config: new URL("testdata/contracts/v1/hosted/config.json", ROOT),
  rateLimit: new URL("testdata/contracts/v1/hosted/rate-limit.json", ROOT),
  previewCrop: new URL("testdata/contracts/v1/expose/preview-crop.json", ROOT),
};

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const hostedConfig = await import(new URL("dist/full/hosted-config.js", ROOT));
const hostedRateLimit = await import(new URL("dist/full/hosted-rate-limit.js", ROOT));
const previewCrop = await import(new URL("dist/expose-preview-crop.js", ROOT));
const config = await import(new URL("dist/config.js", ROOT));

function recordCase(prefix, index, name, source, api, input, output) {
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

function capturePreviewCrop() {
  const source = "src/expose-preview-crop.test.ts";
  const inputs = [
    { name: "crops more bottom rows as the preview gets shorter", api: "exposePreviewFooterCropRows", values: [6, 10, 13, 16, 0, -1] },
    {
      name: "slides older content up rather than shrinking the rendered preview",
      api: "cropExposePreviewFooter",
      lines: ["content 1", "content 2", "content 3", "footer 1", "footer 2", "footer 3"],
      visibleLineCount: 3,
    },
    { name: "does not crop when there are no replacement rows", api: "cropExposePreviewFooter", lines: ["one", "two", "three"], visibleLineCount: 3 },
    { name: "floors fractional visible counts before cropping", api: "cropExposePreviewFooter", lines: ["a", "b", "c", "d"], visibleLineCount: 2.9 },
  ];
  const cases = inputs.map((input, index) => {
    const output =
      input.api === "exposePreviewFooterCropRows"
        ? input.values.map((value) => previewCrop.exposePreviewFooterCropRows(value))
        : previewCrop.cropExposePreviewFooter(input.lines, input.visibleLineCount);
    return recordCase("expose-preview-crop", index, input.name, source, input.api, input, output);
  });
  return {
    version: 1,
    source,
    generatedBy: "scripts/capture-hosted-runtime-contract.mjs",
    description:
      "Expose preview footer crop row thresholds and line-window behavior captured by running TypeScript expose-preview-crop helpers.",
    cases,
  };
}

function limiter(options = {}) {
  let now = 0;
  const instance = new hostedRateLimit.HostedRateLimiter({
    requestsPerMinute: options.requestsPerMinute ?? 3,
    maxConcurrent: options.maxConcurrent ?? 2,
    bytesPerMinute: options.bytesPerMinute,
    now: () => now,
  });
  return { instance, advance: (ms) => (now += ms) };
}

function outcome(value) {
  if (value.ok) return { ok: true };
  return value;
}

function captureRateLimit() {
  const source = "src/full/hosted-rate-limit.test.ts";
  const cases = [];

  {
    const { instance } = limiter({ requestsPerMinute: 3, maxConcurrent: 10 });
    const acquisitions = [];
    for (let i = 0; i < 3; i += 1) {
      const slot = instance.acquire("prn_a");
      acquisitions.push(outcome(slot));
      if (slot.ok) slot.release();
    }
    acquisitions.push(outcome(instance.acquire("prn_a")));
    const input = { scenario: "per-minute-budget", options: { requestsPerMinute: 3, maxConcurrent: 10 } };
    cases.push(recordCase("hosted-rate-limit", cases.length, "allows up to the per-minute budget then refuses", source, "HostedRateLimiter.acquire", input, acquisitions));
  }

  {
    const { instance, advance } = limiter({ requestsPerMinute: 60, maxConcurrent: 10 });
    for (let i = 0; i < 60; i += 1) {
      const slot = instance.acquire("prn_a");
      if (slot.ok) slot.release();
    }
    const before = outcome(instance.acquire("prn_a"));
    advance(1_000);
    const after = instance.acquire("prn_a");
    if (after.ok) after.release();
    const input = { scenario: "refill-over-time", options: { requestsPerMinute: 60, maxConcurrent: 10 }, advanceMs: 1000 };
    cases.push(recordCase("hosted-rate-limit", cases.length, "refills over time", source, "HostedRateLimiter.acquire", input, { before, after: outcome(after) }));
  }

  {
    const { instance } = limiter({ requestsPerMinute: 100, maxConcurrent: 2 });
    const first = instance.acquire("prn_a");
    const second = instance.acquire("prn_a");
    const third = instance.acquire("prn_a");
    if (first.ok) first.release();
    const fourth = instance.acquire("prn_a");
    const input = { scenario: "concurrency", options: { requestsPerMinute: 100, maxConcurrent: 2 } };
    cases.push(recordCase("hosted-rate-limit", cases.length, "caps concurrency independently of the rate budget", source, "HostedRateLimiter.acquire", input, { first: outcome(first), second: outcome(second), third: outcome(third), afterRelease: outcome(fourth) }));
  }

  {
    const { instance } = limiter({ requestsPerMinute: 1, maxConcurrent: 1 });
    const a = instance.acquire("prn_a");
    const aAgain = instance.acquire("prn_a");
    const b = instance.acquire("prn_b");
    const input = { scenario: "independent-principals", options: { requestsPerMinute: 1, maxConcurrent: 1 } };
    cases.push(recordCase("hosted-rate-limit", cases.length, "keeps principals independent", source, "HostedRateLimiter.acquire", input, { a: outcome(a), aAgain: outcome(aAgain), b: outcome(b) }));
  }

  {
    const { instance } = limiter({ requestsPerMinute: 100, maxConcurrent: 1 });
    const slot = instance.acquire("prn_a");
    if (slot.ok) {
      slot.release();
      slot.release();
    }
    const afterDoubleRelease = instance.acquire("prn_a");
    const next = instance.acquire("prn_a");
    const input = { scenario: "double-release", options: { requestsPerMinute: 100, maxConcurrent: 1 } };
    cases.push(recordCase("hosted-rate-limit", cases.length, "ignores a double release", source, "HostedRateLimiter.acquire", input, { initial: outcome(slot), afterDoubleRelease: outcome(afterDoubleRelease), next: outcome(next) }));
  }

  {
    const { instance, advance } = limiter({ requestsPerMinute: 1, maxConcurrent: 2 });
    const held = instance.acquire("prn_busy");
    const done = instance.acquire("prn_idle");
    if (done.ok) done.release();
    advance(400_000);
    instance.prune();
    const idleAfterPrune = instance.acquire("prn_idle");
    const input = { scenario: "prune-idle", options: { requestsPerMinute: 1, maxConcurrent: 2 }, advanceMs: 400000 };
    cases.push(recordCase("hosted-rate-limit", cases.length, "prunes idle principals but keeps in-flight ones", source, "HostedRateLimiter.prune", input, { held: outcome(held), idleAfterPrune: outcome(idleAfterPrune) }));
  }

  {
    const { instance, advance } = limiter({ requestsPerMinute: 10, maxConcurrent: 2, bytesPerMinute: 100 });
    const first = instance.charge("prn_a", 60);
    const second = instance.charge("prn_a", 50);
    advance(30_000);
    const third = instance.charge("prn_a", 50);
    const zero = instance.charge("prn_a", 0);
    const input = { scenario: "byte-budget", options: { requestsPerMinute: 10, maxConcurrent: 2, bytesPerMinute: 100 }, charges: [60, 50, 50, 0], advanceBeforeThirdMs: 30000 };
    cases.push(recordCase("hosted-rate-limit", cases.length, "charges and refills per-principal byte budgets", "src/full/hosted-rate-limit.ts", "HostedRateLimiter.charge", input, [first, second, third, zero]));
  }

  return {
    version: 1,
    source,
    generatedBy: "scripts/capture-hosted-runtime-contract.mjs",
    description:
      "Hosted per-principal request, concurrency, idle-prune, and byte-budget limiter behavior captured by running TypeScript HostedRateLimiter.",
    cases,
  };
}

function withHome(run) {
  const previous = process.env.AIMUX_HOME;
  const aimuxHome = mkdtempSync(join(tmpdir(), "aimux-hosted-config-contract-"));
  process.env.AIMUX_HOME = aimuxHome;
  try {
    return run(aimuxHome);
  } finally {
    if (previous === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previous;
    rmSync(aimuxHome, { recursive: true, force: true });
  }
}

function captureHostedConfig() {
  const source = "src/full/hosted-config.test.ts";
  const cases = [];
  const add = (name, api, input, output) =>
    cases.push(recordCase("hosted-config", cases.length, name, source, api, input, output));

  add("accepts loopback forms", "isLoopbackBindAddress", { values: ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"] }, ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]", "::ffff:127.0.0.1"].map((value) => hostedConfig.isLoopbackBindAddress(value)));
  add("rejects routable addresses", "isLoopbackBindAddress", { values: ["0.0.0.0", "192.168.1.10", "10.0.0.1", "::", "example.com", "1270.0.1"] }, ["0.0.0.0", "192.168.1.10", "10.0.0.1", "::", "example.com", "1270.0.1"].map((value) => hostedConfig.isLoopbackBindAddress(value)));
  add("returns defaults for absent or non-object input", "normalizeHostedConfig", { values: [null, "nope"] }, [hostedConfig.normalizeHostedConfig(undefined), hostedConfig.normalizeHostedConfig("nope")]);
  add("floors the context cap at the envelope a full-size context needs", "normalizeHostedConfig", { values: [{ maxContextBytes: 512 }, { maxContextBytes: 16_384 }] }, [{ value: hostedConfig.normalizeHostedConfig({ maxContextBytes: 512 }).maxContextBytes }, { value: hostedConfig.normalizeHostedConfig({ maxContextBytes: 16_384 }).maxContextBytes }]);
  {
    const normalized = hostedConfig.normalizeHostedConfig(undefined);
    normalized.rateLimit.requestsPerMinute = 1;
    add("does not share nested state with the default object", "normalizeHostedConfig", { mutateNormalizedRateLimit: 1 }, { defaultRequestsPerMinute: hostedConfig.DEFAULT_HOSTED_CONFIG.rateLimit.requestsPerMinute });
  }
  add(
    "clamps out-of-range and wrongly typed values back to defaults",
    "normalizeHostedConfig",
    {
      value: {
        enabled: "yes",
        bindAddress: "   ",
        port: 0,
        rateLimit: { requestsPerMinute: -5, maxConcurrent: 9_999_999 },
        maxPromptBytes: null,
        maxResponseBytes: 512,
        auditPromptBodies: 0,
        webhookUrl: "   ",
        webhookSecretEnv: "",
      },
    },
    hostedConfig.normalizeHostedConfig({
      enabled: "yes",
      bindAddress: "   ",
      port: 0,
      rateLimit: { requestsPerMinute: -5, maxConcurrent: 9_999_999 },
      maxPromptBytes: Number.NaN,
      maxResponseBytes: 512,
      auditPromptBodies: 0,
      webhookUrl: "   ",
      webhookSecretEnv: "",
    }),
  );
  add("keeps valid overrides", "normalizeHostedConfig", { value: { enabled: true, port: 44000, bindAddress: "0.0.0.0" } }, hostedConfig.normalizeHostedConfig({ enabled: true, port: 44000, bindAddress: "0.0.0.0" }));

  add("defaults when there is no global config", "loadHostedConfig", { scenario: "no-global-config" }, withHome(() => hostedConfig.loadHostedConfig()));
  add("reads the hosted block from the global config", "loadHostedConfig", { globalConfig: { hosted: { enabled: true, port: 44100 } } }, withHome((home) => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ hosted: { enabled: true, port: 44100 } }));
    return hostedConfig.loadHostedConfig();
  }));
  add("quarantines a corrupt global config instead of throwing", "loadHostedConfig", { globalConfigText: "{ not json" }, withHome((home) => {
    writeFileSync(join(home, "config.json"), "{ not json");
    return { config: hostedConfig.loadHostedConfig(), quarantined: readdirSync(home).some((name) => name.includes("corrupt")) };
  }));
  add("ignores a hosted block in project config", "loadHostedConfig/loadConfig", { projectConfig: { hosted: { enabled: true, bindAddress: "0.0.0.0" } } }, withHome((home) => {
    const projectRoot = mkdtempSync(join(tmpdir(), "aimux-hosted-project-contract-"));
    try {
      mkdirSync(join(projectRoot, ".aimux"), { recursive: true });
      writeFileSync(join(projectRoot, ".aimux", "config.json"), JSON.stringify({ hosted: { enabled: true, bindAddress: "0.0.0.0" } }));
      return {
        hostedConfig: hostedConfig.loadHostedConfig(),
        projectHosted: config.loadConfig({ projectRoot }).hosted ?? null,
      };
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }));
  add("keeps a global hosted block through a config load", "loadConfig", { globalConfig: { hosted: { enabled: true, port: 44200 } } }, withHome((home) => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ hosted: { enabled: true, port: 44200 } }));
    const projectRoot = mkdtempSync(join(tmpdir(), "aimux-hosted-project-contract-"));
    try {
      return config.loadConfig({ projectRoot }).hosted;
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  }));

  add("validates hosted startup branches", "validateHostedStartup", {
    cases: [
      { config: { ...hostedConfig.DEFAULT_HOSTED_CONFIG, bindAddress: "0.0.0.0" }, activePrincipalCount: 0 },
      { config: { ...hostedConfig.DEFAULT_HOSTED_CONFIG, enabled: true, bindAddress: "0.0.0.0" }, activePrincipalCount: 0 },
      { config: { ...hostedConfig.DEFAULT_HOSTED_CONFIG, enabled: true, bindAddress: "0.0.0.0" }, activePrincipalCount: 1 },
      { config: { ...hostedConfig.DEFAULT_HOSTED_CONFIG, enabled: true }, activePrincipalCount: 0 },
      { config: { ...hostedConfig.DEFAULT_HOSTED_CONFIG, enabled: true, webhookUrl: "http://example.com/hook" }, activePrincipalCount: 1 },
      { config: { ...hostedConfig.DEFAULT_HOSTED_CONFIG, enabled: true, webhookUrl: "http://127.0.0.1:9000/h" }, activePrincipalCount: 1 },
      { config: { ...hostedConfig.DEFAULT_HOSTED_CONFIG, enabled: true, webhookUrl: "https://example.com/h" }, activePrincipalCount: 1 },
      { config: { ...hostedConfig.DEFAULT_HOSTED_CONFIG, enabled: true, webhookUrl: "not-a-url" }, activePrincipalCount: 1 },
      { config: { ...hostedConfig.DEFAULT_HOSTED_CONFIG, enabled: true, webhookSecretEnv: "PATH" }, activePrincipalCount: 1 },
      { config: { ...hostedConfig.DEFAULT_HOSTED_CONFIG, enabled: true, webhookSecretEnv: "AIMUX_OTHER" }, activePrincipalCount: 1 },
    ],
  }, [
    hostedConfig.validateHostedStartup({ ...hostedConfig.DEFAULT_HOSTED_CONFIG, bindAddress: "0.0.0.0" }, 0),
    hostedConfig.validateHostedStartup({ ...hostedConfig.DEFAULT_HOSTED_CONFIG, enabled: true, bindAddress: "0.0.0.0" }, 0),
    hostedConfig.validateHostedStartup({ ...hostedConfig.DEFAULT_HOSTED_CONFIG, enabled: true, bindAddress: "0.0.0.0" }, 1),
    hostedConfig.validateHostedStartup({ ...hostedConfig.DEFAULT_HOSTED_CONFIG, enabled: true }, 0),
    hostedConfig.validateHostedStartup({ ...hostedConfig.DEFAULT_HOSTED_CONFIG, enabled: true, webhookUrl: "http://example.com/hook" }, 1),
    hostedConfig.validateHostedStartup({ ...hostedConfig.DEFAULT_HOSTED_CONFIG, enabled: true, webhookUrl: "http://127.0.0.1:9000/h" }, 1),
    hostedConfig.validateHostedStartup({ ...hostedConfig.DEFAULT_HOSTED_CONFIG, enabled: true, webhookUrl: "https://example.com/h" }, 1),
    hostedConfig.validateHostedStartup({ ...hostedConfig.DEFAULT_HOSTED_CONFIG, enabled: true, webhookUrl: "not-a-url" }, 1),
    hostedConfig.validateHostedStartup({ ...hostedConfig.DEFAULT_HOSTED_CONFIG, enabled: true, webhookSecretEnv: "PATH" }, 1),
    hostedConfig.validateHostedStartup({ ...hostedConfig.DEFAULT_HOSTED_CONFIG, enabled: true, webhookSecretEnv: "AIMUX_OTHER" }, 1),
  ]);
  add("never echoes the webhook url in an error", "validateHostedStartup", { config: { ...hostedConfig.DEFAULT_HOSTED_CONFIG, enabled: true, webhookUrl: "not-a-url-secret-token" }, activePrincipalCount: 1 }, hostedConfig.validateHostedStartup({ ...hostedConfig.DEFAULT_HOSTED_CONFIG, enabled: true, webhookUrl: "not-a-url-secret-token" }, 1));
  add("normalizes trustedForwardedHeader to lower case, defaulting to null", "normalizeHostedConfig", { values: [{}, { trustedForwardedHeader: "  X-Forwarded-For " }, { trustedForwardedHeader: "   " }, { trustedForwardedHeader: 42 }] }, [{ value: hostedConfig.normalizeHostedConfig({}).trustedForwardedHeader }, { value: hostedConfig.normalizeHostedConfig({ trustedForwardedHeader: "  X-Forwarded-For " }).trustedForwardedHeader }, { value: hostedConfig.normalizeHostedConfig({ trustedForwardedHeader: "   " }).trustedForwardedHeader }, { value: hostedConfig.normalizeHostedConfig({ trustedForwardedHeader: 42 }).trustedForwardedHeader }]);
  add("ignores a forwarded header the tunnel does not set", "normalizeHostedConfig", { values: ["x-real-ip", "forwarded", "x-client-ip", "cf-connecting-ip", "x-forwarded-for", "true-client-ip"] }, ["x-real-ip", "forwarded", "x-client-ip", "cf-connecting-ip", "x-forwarded-for", "true-client-ip"].map((trustedForwardedHeader) => hostedConfig.normalizeHostedConfig({ trustedForwardedHeader }).trustedForwardedHeader));
  add("does not refuse startup over an unusable forwarded header", "validateHostedStartup", { config: { enabled: true, trustedForwardedHeader: "x-real-ip" }, activePrincipalCount: 1 }, hostedConfig.validateHostedStartup(hostedConfig.normalizeHostedConfig({ enabled: true, trustedForwardedHeader: "x-real-ip" }), 1));
  add("clamps retentionDays", "normalizeHostedConfig", { values: [{}, { retentionDays: 7 }, { retentionDays: 0 }, { retentionDays: 99_999 }] }, [{ value: hostedConfig.normalizeHostedConfig({}).retentionDays }, { value: hostedConfig.normalizeHostedConfig({ retentionDays: 7 }).retentionDays }, { value: hostedConfig.normalizeHostedConfig({ retentionDays: 0 }).retentionDays }, { value: hostedConfig.normalizeHostedConfig({ retentionDays: 99_999 }).retentionDays }]);

  return {
    version: 1,
    source,
    generatedBy: "scripts/capture-hosted-runtime-contract.mjs",
    description:
      "Hosted configuration normalization, global/project config loading boundaries, startup validation, forwarded-header allowlist, and retention behavior captured by running TypeScript hosted-config helpers.",
    cases,
  };
}

const contracts = {
  config: captureHostedConfig(),
  rateLimit: captureRateLimit(),
  previewCrop: capturePreviewCrop(),
};

for (const [name, contract] of Object.entries(contracts)) {
  await writeContractJson(PATHS[name], contract);
  console.log(`${PATHS[name].pathname}: ${contract.cases.length} cases`);
}
