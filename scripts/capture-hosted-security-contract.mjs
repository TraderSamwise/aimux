#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const AUTH_PATH = new URL("testdata/contracts/v1/hosted/auth.json", ROOT);
const LOCKDOWN_PATH = new URL("testdata/contracts/v1/hosted/lockdown.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const auth = await import(new URL("dist/full/hosted-auth.js", ROOT));
const principals = await import(new URL("dist/full/hosted-principals.js", ROOT));
const lockdown = await import(new URL("dist/full/hosted-lockdown.js", ROOT));
const outbox = await import(new URL("dist/full/hosted-outbox.js", ROOT));
const audit = await import(new URL("dist/full/hosted-audit.js", ROOT));
const paths = await import(new URL("dist/paths.js", ROOT));

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

function withHome(prefix, run) {
  const previous = process.env.AIMUX_HOME;
  const home = mkdtempSync(join(tmpdir(), prefix));
  process.env.AIMUX_HOME = home;
  lockdown.resetHostedLockdownCache();
  try {
    return run(home);
  } finally {
    lockdown.resetHostedLockdownCache();
    if (previous === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

function normalizeAuthResult(result) {
  if (!result.ok) return result;
  return {
    ok: true,
    actor: {
      role: result.actor.role,
      principalId: "<principal:1>",
      principalMatches: result.actor.principal?.id === result.principal.id,
    },
    principal: {
      id: "<principal:1>",
      label: result.principal.label,
      role: result.principal.role,
      grants: result.principal.grants,
      revoked: result.principal.revokedAt !== null,
    },
  };
}

function captureAuth() {
  const cases = [];
  const add = (name, api, input, output) =>
    cases.push(recordCase("hosted-auth", cases.length, name, "src/full/hosted-auth.test.ts", api, input, output));

  add(
    "removes every x-aimux-* header regardless of case",
    "stripTrustedHeaders",
    {
      headers: {
        "x-aimux-actor-role": "owner",
        "X-Aimux-Actor-User-Id": "u1",
        "x-AIMUX-share-session-id": "s1",
        "x-aimux-anything-invented-later": "v",
        "content-type": "application/json",
        authorization: "Bearer amx_token",
      },
    },
    auth.stripTrustedHeaders({
      "x-aimux-actor-role": "owner",
      "X-Aimux-Actor-User-Id": "u1",
      "x-AIMUX-share-session-id": "s1",
      "x-aimux-anything-invented-later": "v",
      "content-type": "application/json",
      authorization: "Bearer amx_token",
    }),
  );
  add(
    "normalizes casing and joins repeated headers",
    "stripTrustedHeaders",
    { headers: { "Content-Type": "application/json", accept: ["a", "b"], missing: null } },
    auth.stripTrustedHeaders({ "Content-Type": "application/json", accept: ["a", "b"], missing: undefined }),
  );
  add(
    "parses a bearer header in any case, with padding",
    "bearerToken",
    { values: [{ authorization: "Bearer amx_abc" }, { authorization: "bearer   amx_abc  " }, { Authorization: "BEARER amx_abc" }] },
    [{ authorization: "Bearer amx_abc" }, { authorization: "bearer   amx_abc  " }, { Authorization: "BEARER amx_abc" }].map((headers) => auth.bearerToken(headers)),
  );
  add(
    "returns null for anything else",
    "bearerToken",
    { values: [{}, { authorization: "Basic abc" }, { authorization: "Bearer" }, { authorization: "Bearer    " }] },
    [{}, { authorization: "Basic abc" }, { authorization: "Bearer" }, { authorization: "Bearer    " }].map((headers) => auth.bearerToken(headers)),
  );
  add(
    "mints an operator actor for a live token",
    "authenticateHosted",
    { scenario: "live-token", label: "grand" },
    withHome("aimux-hosted-auth-contract-", () => {
      const { token } = principals.createHostedPrincipal({ label: "grand" });
      return normalizeAuthResult(auth.authenticateHosted({ authorization: `Bearer ${token}` }));
    }),
  );
  add(
    "refuses a missing, unknown, or revoked token",
    "authenticateHosted",
    { scenario: "missing-unknown-revoked", label: "grand" },
    withHome("aimux-hosted-auth-contract-", () => {
      const { principal, token } = principals.createHostedPrincipal({ label: "grand" });
      const missing = auth.authenticateHosted({});
      const unknown = auth.authenticateHosted({ authorization: "Bearer amx_nope" });
      principals.revokeHostedPrincipal(principal.id);
      const revoked = auth.authenticateHosted({ authorization: `Bearer ${token}` });
      return { missing, unknown, revoked };
    }),
  );
  add(
    "cannot be satisfied by a forged actor header",
    "authenticateHosted/stripTrustedHeaders",
    { headers: { "x-aimux-actor-role": "owner", "x-aimux-actor-user-id": "attacker" } },
    auth.authenticateHosted(auth.stripTrustedHeaders({ "x-aimux-actor-role": "owner", "x-aimux-actor-user-id": "attacker" })),
  );

  return {
    version: 1,
    source: "src/full/hosted-auth.test.ts",
    generatedBy: "scripts/capture-hosted-security-contract.mjs",
    description:
      "Hosted authentication trusted-header stripping, bearer-token parsing, and live/missing/unknown/revoked token decisions captured by running TypeScript hosted-auth helpers. Generated principal identities are normalized after execution.",
    cases,
  };
}

function normalizeLockdownState(state) {
  return state.since ? { ...state, since: "<ts:1>" } : state;
}

function event(kind = "hosted_lockdown") {
  return {
    id: `evt_${kind}`,
    kind,
    ts: "2026-01-01T00:00:00.000Z",
    principalId: "prn_a",
    label: "cli",
    fingerprint: null,
    addressKnown: false,
    userAgent: null,
  };
}

function captureLockdown() {
  const cases = [];
  const add = (name, api, input, output) =>
    cases.push(recordCase("hosted-lockdown", cases.length, name, "src/full/hosted-lockdown.test.ts", api, input, output));

  add("is off until engaged, and clears again", "hostedLockdownState/setHostedLockdown", { scenario: "engage-clear" }, withHome("aimux-hosted-lockdown-contract-", () => {
    const initial = { locked: lockdown.isHostedLockedDown(), state: lockdown.hostedLockdownState() };
    const engaged = normalizeLockdownState(lockdown.setHostedLockdown(true));
    const afterEngage = { locked: lockdown.isHostedLockedDown(), state: normalizeLockdownState(lockdown.hostedLockdownState()) };
    const cleared = lockdown.setHostedLockdown(false);
    const afterClear = { locked: lockdown.isHostedLockedDown(), markerExists: existsSync(paths.getHostedLockdownPath()) };
    return { initial, engaged, afterEngage, cleared, afterClear };
  }));
  add("writes the marker 0600", "setHostedLockdown", { scenario: "marker-mode" }, withHome("aimux-hosted-lockdown-contract-", () => {
    lockdown.setHostedLockdown(true);
    return { mode: statSync(paths.getHostedLockdownPath()).mode & 0o777 };
  }));
  add("treats an unreadable marker as locked down", "hostedLockdownState", { scenario: "corrupt-marker" }, withHome("aimux-hosted-lockdown-contract-", () => {
    mkdirSync(paths.getHostedDir(), { recursive: true });
    writeFileSync(paths.getHostedLockdownPath(), "{ not json");
    return { state: lockdown.hostedLockdownState(), locked: lockdown.isHostedLockedDown() };
  }));
  add("caches for a second but sees a change after it expires", "isHostedLockedDown", { scenario: "cache-window" }, withHome("aimux-hosted-lockdown-contract-", () => {
    const first = lockdown.isHostedLockedDown(1_000);
    mkdirSync(paths.getHostedDir(), { recursive: true });
    writeFileSync(paths.getHostedLockdownPath(), "{}");
    const within = lockdown.isHostedLockedDown(1_500);
    const after = lockdown.isHostedLockedDown(2_500);
    return { first, within, after };
  }));
  add("drains what was spooled and leaves the file empty", "drainHostedOutbox/spoolHostedEvent", { scenario: "drain-spooled" }, withHome("aimux-hosted-lockdown-contract-", () => {
    outbox.spoolHostedEvent(event("hosted_token_revoked"));
    outbox.spoolHostedEvent(event("hosted_grant_changed"));
    const drained = outbox.drainHostedOutbox();
    return { kinds: drained.map((entry) => entry.kind), existsAfterDrain: existsSync(paths.getHostedOutboxPath()), secondDrain: outbox.drainHostedOutbox() };
  }));
  add("skips a torn line rather than failing the drain", "drainHostedOutbox", { scenario: "torn-line" }, withHome("aimux-hosted-lockdown-contract-", () => {
    outbox.spoolHostedEvent(event());
    writeFileSync(paths.getHostedOutboxPath(), `${JSON.stringify(event())}\n{"kind":"hosted_`, { flag: "a" });
    return { drainedLength: outbox.drainHostedOutbox().length };
  }));
  add("records a CLI event in the audit log as well as the outbox", "raiseHostedCliEvent", { scenario: "cli-event", kind: "hosted_token_revoked", principalId: "prn_a", detail: "revoked via CLI" }, withHome("aimux-hosted-lockdown-contract-", () => {
    outbox.raiseHostedCliEvent("hosted_token_revoked", "prn_a", "revoked via CLI");
    const audited = audit.tailHostedAudit(10).at(-1);
    return {
      audit: audited ? { event: audited.event, detail: audited.detail, principalId: audited.principalId, label: audited.label } : null,
      outboxKinds: outbox.drainHostedOutbox().map((entry) => entry.kind),
    };
  }));

  return {
    version: 1,
    source: "src/full/hosted-lockdown.test.ts",
    generatedBy: "scripts/capture-hosted-security-contract.mjs",
    description:
      "Hosted lockdown marker/cache and hosted outbox drain/torn-line/CLI-audit side-effect behavior captured by running TypeScript hosted-lockdown and hosted-outbox helpers. Lockdown timestamps are normalized after execution.",
    cases,
  };
}

await writeContractJson(AUTH_PATH, captureAuth());
await writeContractJson(LOCKDOWN_PATH, captureLockdown());
console.log(`${AUTH_PATH.pathname}: 7 cases`);
console.log(`${LOCKDOWN_PATH.pathname}: 7 cases`);
