#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/hosted/principals.json", ROOT);

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function writeContractJson(url, contract) {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
}

const principals = await import(new URL("dist/full/hosted-principals.js", ROOT));
const paths = await import(new URL("dist/paths.js", ROOT));

function recordCase(index, name, input, output) {
  return {
    id: `hosted-principals-${String(index + 1).padStart(3, "0")}`,
    name,
    source: "src/full/hosted-principals.test.ts",
    api: "hosted-principals",
    input,
    output,
    inputSha256: hash(input),
  };
}

function withHome(run) {
  const previous = process.env.AIMUX_HOME;
  const home = mkdtempSync(join(tmpdir(), "aimux-hosted-principals-contract-"));
  process.env.AIMUX_HOME = home;
  try {
    return run(home);
  } finally {
    if (previous === undefined) delete process.env.AIMUX_HOME;
    else process.env.AIMUX_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  }
}

const cases = [];

function add(name, scenario, run) {
  cases.push(recordCase(cases.length, name, { scenario }, withHome(run)));
}

add("starts empty when nothing is persisted", "empty", () => principals.loadHostedPrincipals());
add("returns the token once and persists only its hash", "token-hash-only", () => {
  const { principal, token } = principals.createHostedPrincipal({ label: "grand:admin:user_1" });
  const raw = readFileSync(paths.getHostedPrincipalsPath(), "utf-8");
  return {
    tokenHasPrefix: token.startsWith("amx_"),
    hashMatchesToken: principal.tokenHash === principals.hashHostedToken(token),
    hashHasPrefix: principal.tokenHash.startsWith("sha256:"),
    rawContainsToken: raw.includes(token),
    rawContainsHash: raw.includes(principal.tokenHash),
  };
});
add("writes the store 0600 inside a 0700 directory", "store-modes", () => {
  principals.createHostedPrincipal({ label: "a" });
  return {
    fileMode: statSync(paths.getHostedPrincipalsPath()).mode & 0o777,
    dirMode: statSync(paths.getHostedDir()).mode & 0o777,
  };
});
add("resolves a live token and rejects an unknown one", "resolve-live-token", () => {
  const { principal, token } = principals.createHostedPrincipal({ label: "a" });
  return {
    liveMatches: principals.findPrincipalByToken(token)?.id === principal.id,
    unknown: principals.findPrincipalByToken("amx_nope"),
    empty: principals.findPrincipalByToken(""),
    blank: principals.findPrincipalByToken("   "),
  };
});
add("stops resolving a revoked token", "revoke-token", () => {
  const { principal, token } = principals.createHostedPrincipal({ label: "a" });
  const first = principals.revokeHostedPrincipal(principal.id);
  return {
    first,
    resolvedAfterRevoke: principals.findPrincipalByToken(token),
    second: principals.revokeHostedPrincipal(principal.id),
    missing: principals.revokeHostedPrincipal("prn_missing"),
  };
});
add("keeps grants scoped to one project and session", "grant-scope", () => {
  const { principal } = principals.createHostedPrincipal({ label: "a" });
  const grant = principals.grantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "assistant" });
  const stored = principals.listHostedPrincipals()[0];
  return {
    grant,
    same: principals.principalHasGrant(stored, { projectRoot: "/srv/grand", sessionId: "assistant" }),
    differentProject: principals.principalHasGrant(stored, { projectRoot: "/srv/other", sessionId: "assistant" }),
    differentSession: principals.principalHasGrant(stored, { projectRoot: "/srv/grand", sessionId: "other" }),
  };
});
add("normalizes project roots so a trailing slash still matches", "grant-root-normalization", () => {
  const { principal } = principals.createHostedPrincipal({ label: "a" });
  principals.grantHostedSession(principal.id, { projectRoot: "/srv/grand/", sessionId: "assistant" });
  return principals.principalHasGrant(principals.listHostedPrincipals()[0], { projectRoot: "/srv/grand", sessionId: "assistant" });
});
add("never authorizes a revoked principal even with a matching grant", "revoked-grant", () => {
  const { principal } = principals.createHostedPrincipal({ label: "a" });
  principals.grantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "assistant" });
  principals.revokeHostedPrincipal(principal.id);
  return principals.principalHasGrant(principals.listHostedPrincipals()[0], { projectRoot: "/srv/grand", sessionId: "assistant" });
});
add("does not duplicate an identical grant, and refuses partial ones", "duplicate-partial-grants", () => {
  const { principal } = principals.createHostedPrincipal({ label: "a" });
  principals.grantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "assistant" });
  principals.grantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "assistant" });
  return {
    grantsLength: principals.listHostedPrincipals()[0].grants.length,
    emptyRoot: principals.grantHostedSession(principal.id, { projectRoot: "", sessionId: "assistant" }),
    emptySession: principals.grantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "" }),
  };
});
add("refuses to grant to a revoked principal", "grant-revoked-principal", () => {
  const { principal } = principals.createHostedPrincipal({ label: "a" });
  principals.revokeHostedPrincipal(principal.id);
  return principals.grantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "assistant" });
});
add("ungrants only the named session", "ungrant-session", () => {
  const { principal } = principals.createHostedPrincipal({ label: "a" });
  principals.grantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "one" });
  principals.grantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "two" });
  return {
    first: principals.ungrantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "one" }),
    second: principals.ungrantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "one" }),
    grants: principals.listHostedPrincipals()[0].grants,
  };
});
add("keeps principals separate", "separate-principals", () => {
  const first = principals.createHostedPrincipal({ label: "first" });
  const second = principals.createHostedPrincipal({ label: "second" });
  principals.grantHostedSession(first.principal.id, { projectRoot: "/srv/grand", sessionId: "one" });
  const resolved = principals.findPrincipalByToken(second.token);
  return {
    resolvedSecond: resolved?.id === second.principal.id,
    secondHasFirstGrant: principals.principalHasGrant(resolved, { projectRoot: "/srv/grand", sessionId: "one" }),
    count: principals.listHostedPrincipals().length,
  };
});
add("records last-seen without disturbing other fields", "last-seen-throttle", () => {
  const { principal, token } = principals.createHostedPrincipal({ label: "a" });
  principals.markPrincipalSeen(principal.id);
  const resolved = principals.findPrincipalByToken(token);
  const first = resolved?.lastSeenAt;
  principals.markPrincipalSeen(principal.id);
  principals.markPrincipalSeen("prn_missing");
  return {
    lastSeenNotNull: first !== null,
    label: resolved?.label,
    throttledSame: principals.findPrincipalByToken(token)?.lastSeenAt === first,
  };
});
add("counts only active principals", "count-active", () => {
  const counts = [principals.countActiveHostedPrincipals()];
  const first = principals.createHostedPrincipal({ label: "a" });
  principals.createHostedPrincipal({ label: "b" });
  counts.push(principals.countActiveHostedPrincipals());
  principals.revokeHostedPrincipal(first.principal.id);
  counts.push(principals.countActiveHostedPrincipals());
  return counts;
});
add("refuses a relative project root on the check side", "relative-root-check", () => {
  const { principal } = principals.createHostedPrincipal({ label: "a" });
  principals.grantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "assistant" });
  const stored = principals.listHostedPrincipals()[0];
  return {
    relative: principals.principalHasGrant(stored, { projectRoot: "srv/grand", sessionId: "assistant" }),
    empty: principals.principalHasGrant(stored, { projectRoot: "", sessionId: "assistant" }),
  };
});
add("releases the store lock after each mutation", "lock-released", () => {
  const { principal } = principals.createHostedPrincipal({ label: "a" });
  principals.grantHostedSession(principal.id, { projectRoot: "/srv/grand", sessionId: "assistant" });
  return { lockExists: existsSync(`${paths.getHostedPrincipalsPath()}.lock`) };
});
add("steals a stale lock rather than deadlocking", "stale-lock", () => {
  const lock = `${paths.getHostedPrincipalsPath()}.lock`;
  mkdirSync(paths.getHostedDir(), { recursive: true });
  writeFileSync(lock, "999999.deadbeef");
  const ancient = new Date(Date.now() - 120_000);
  utimesSync(lock, ancient, ancient);
  const { principal } = principals.createHostedPrincipal({ label: "a" });
  return {
    ids: principals.listHostedPrincipals().map((entry) => (entry.id === principal.id ? "<principal:1>" : entry.id)),
    lockExists: existsSync(lock),
  };
});
add("refuses to persist over a store it could not read", "unreadable-store", () => {
  principals.createHostedPrincipal({ label: "a" });
  const path = paths.getHostedPrincipalsPath();
  chmodSync(path, 0o000);
  let threw = false;
  try {
    principals.loadHostedPrincipals();
  } catch {
    threw = true;
  } finally {
    chmodSync(path, 0o600);
  }
  return { threw, count: principals.listHostedPrincipals().length };
});
add("drops malformed entries and survives a corrupt store", "malformed-corrupt-store", () => {
  mkdirSync(paths.getHostedDir(), { recursive: true });
  writeFileSync(
    paths.getHostedPrincipalsPath(),
    JSON.stringify({
      version: 1,
      principals: [
        { id: "prn_ok", tokenHash: "sha256:abcd", label: "ok", grants: [{ projectRoot: "/p", sessionId: "s" }] },
        { id: "prn_nohash" },
        { tokenHash: "sha256:abcd" },
        { id: "prn_badhash", tokenHash: "plaintext" },
        "garbage",
      ],
    }),
  );
  const loadedIds = principals.loadHostedPrincipals().principals.map((entry) => entry.id);
  writeFileSync(paths.getHostedPrincipalsPath(), "{ not json");
  return {
    loadedIds,
    afterCorrupt: principals.loadHostedPrincipals(),
    quarantined: readdirSync(paths.getHostedDir()).some((name) => name.includes("corrupt")),
  };
});
add("does not match a stored hash of the wrong length", "short-hash", () => {
  mkdirSync(paths.getHostedDir(), { recursive: true });
  writeFileSync(
    paths.getHostedPrincipalsPath(),
    JSON.stringify({ version: 1, principals: [{ id: "prn_short", tokenHash: "sha256:ab", label: "s", grants: [] }] }),
  );
  return principals.findPrincipalByToken("anything");
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  source: "src/full/hosted-principals.test.ts",
  generatedBy: "scripts/capture-hosted-principals-contract.mjs",
  description:
    "Hosted principal token, hash, mode, grant, revoke, last-seen, active-count, lock, malformed-store, and corrupt-store behavior captured by running TypeScript hosted-principals helpers. Generated principal identities are normalized after execution.",
  cases,
});

console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
