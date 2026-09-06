#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import prettier from "prettier";

const ROOT = new URL("../", import.meta.url);
const FIXTURE_PATH = new URL("testdata/contracts/v1/tmux/startup-interstitials.json", ROOT);
const { StartupInterstitialDismisser, findStartupInterstitial, resolveInterstitialKey } = await import(
  new URL("dist/tmux/startup-interstitials.js", ROOT)
);

const CODEX_UPDATE = {
  id: "codex-update-available",
  when: ["Update available!", "Press enter to continue"],
  choose: "^[\\s›>❯]*(\\d+)\\.\\s+Skip\\s*$",
};

const TRUST = {
  id: "codex-trust-directory",
  when: ["Do you trust the contents of this directory?"],
  choose: "^[\\s›>❯]*(\\d+)\\.\\s+Yes, continue\\s*$",
};

const REAL_UPDATE_SCREEN = [
  "  ✨ Update available! 0.146.0 -> 0.146.1",
  "",
  "  Release notes: https://github.com/openai/codex/releases/latest",
  "",
  "› 1. Update now (runs `npm install -g @openai/codex`)",
  "  2. Skip",
  "  3. Skip until next version",
  "",
  "  Press enter to continue",
].join("\n");

const REAL_TRUST_SCREEN = [
  "> You are in /tmp",
  "",
  "  Do you trust the contents of this directory?",
  "",
  "› 1. Yes, continue",
  "  2. No, quit",
  "",
  "  Press enter to continue",
].join("\n");

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const writeContractJson = async (url, contract) => {
  await mkdir(new URL("./", url), { recursive: true });
  const prettierOptions = (await prettier.resolveConfig(url.pathname)) ?? {};
  await writeFile(url, await prettier.format(JSON.stringify(contract), { ...prettierOptions, parser: "json" }));
};

const cases = [];
function record(name, input, run) {
  const output = run();
  const fullInput = { name, ...input };
  cases.push({
    id: `tmux-startup-interstitials-${String(cases.length + 1).padStart(3, "0")}`,
    name,
    source: "src/tmux/startup-interstitials.test.ts",
    api: "startup-interstitials",
    input: fullInput,
    output,
    inputSha256: hash(fullInput),
  });
}

record(
  "chooses Skip on the real codex update screen",
  { screen: "REAL_UPDATE_SCREEN", interstitial: CODEX_UPDATE },
  () => ({
    key: resolveInterstitialKey(REAL_UPDATE_SCREEN, CODEX_UPDATE),
  }),
);

record(
  "prefers plain Skip over Skip until next version",
  { screen: "REORDERED_UPDATE_SCREEN", interstitial: CODEX_UPDATE },
  () => ({
    key: resolveInterstitialKey(
      REAL_UPDATE_SCREEN.replace("  2. Skip\n  3. Skip until next version", "  2. Skip until next version\n  3. Skip"),
      CODEX_UPDATE,
    ),
  }),
);

record("reads the number off the menu", { screen: "RENUMBERED_UPDATE_SCREEN", interstitial: CODEX_UPDATE }, () => ({
  key: resolveInterstitialKey(REAL_UPDATE_SCREEN.replace("  2. Skip", "  7. Skip"), CODEX_UPDATE),
}));

record("finds Skip when selected", { screen: "SKIP_SELECTED_UPDATE_SCREEN", interstitial: CODEX_UPDATE }, () => ({
  key: resolveInterstitialKey(
    REAL_UPDATE_SCREEN.replace("› 1. Update now", "  1. Update now").replace("  2. Skip", "› 2. Skip"),
    CODEX_UPDATE,
  ),
}));

record("returns null when not showing or option missing", { interstitial: CODEX_UPDATE }, () => ({
  trust: resolveInterstitialKey(REAL_TRUST_SCREEN, CODEX_UPDATE),
  empty: resolveInterstitialKey("", CODEX_UPDATE),
  withoutSkip: resolveInterstitialKey(
    REAL_UPDATE_SCREEN.replace("  2. Skip\n", "").replace("  3. Skip until next version", "  2. Remind me later"),
    CODEX_UPDATE,
  ),
  chatter: resolveInterstitialKey(
    "› Ask codex whether an Update available! banner needs a Press enter to continue guard.",
    CODEX_UPDATE,
  ),
}));

record("findStartupInterstitial returns matching interstitial and skips earlier misses", {}, () => ({
  direct: findStartupInterstitial(REAL_UPDATE_SCREEN, [CODEX_UPDATE]),
  none: findStartupInterstitial(REAL_TRUST_SCREEN, [CODEX_UPDATE]),
  later: findStartupInterstitial(REAL_UPDATE_SCREEN, [
    { id: "never", when: ["nothing like this"], choose: "^(\\d+)$" },
    CODEX_UPDATE,
  ]),
}));

record("dismisser answers each prompt once", {}, () => {
  const dismisser = new StartupInterstitialDismisser([CODEX_UPDATE, TRUST]);
  return {
    first: dismisser.next(REAL_UPDATE_SCREEN),
    lingering: dismisser.next(REAL_UPDATE_SCREEN),
    second: dismisser.next(REAL_TRUST_SCREEN),
    repeatedSecond: dismisser.next(REAL_TRUST_SCREEN),
    done: dismisser.done,
  };
});

record("dismisser ignores ordinary sessions without completing", {}, () => {
  const dismisser = new StartupInterstitialDismisser([CODEX_UPDATE, TRUST]);
  return {
    next: dismisser.next("› ready\n\n  gpt-5.6-sol default · /srv/grand-console"),
    done: dismisser.done,
  };
});

await writeContractJson(FIXTURE_PATH, {
  version: 1,
  generatedAt: "2026-09-06T00:00:00.000Z",
  generatedBy: "scripts/capture-tmux-startup-interstitials-contract.mjs",
  source: "src/tmux/startup-interstitials.test.ts",
  subject: "src/tmux/startup-interstitials.ts",
  description: "Startup interstitial matching and once-only dismissal captured by running TypeScript.",
  caseCount: cases.length,
  cases,
});
console.log(`${FIXTURE_PATH.pathname}: ${cases.length} cases`);
