import { describe, expect, it } from "vitest";
import {
  findStartupInterstitial,
  resolveInterstitialKey,
  StartupInterstitialDismisser,
  type StartupInterstitial,
} from "./startup-interstitials.js";

const CODEX_UPDATE: StartupInterstitial = {
  id: "codex-update-available",
  when: ["Update available!", "Press enter to continue"],
  choose: "^[\\s›>❯]*(\\d+)\\.\\s+Skip\\s*$",
};

/** Captured verbatim from `tmux capture-pane` against codex 0.146.0 with 0.146.1 released. */
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

/** The prompt waiting behind the update prompt, captured in the same session. */
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

describe("resolveInterstitialKey", () => {
  it("chooses Skip on the real codex update screen", () => {
    expect(resolveInterstitialKey(REAL_UPDATE_SCREEN, CODEX_UPDATE)).toBe("2");
  });

  it("never picks the preselected `Update now`, which would install", () => {
    expect(resolveInterstitialKey(REAL_UPDATE_SCREEN, CODEX_UPDATE)).not.toBe("1");
  });

  it("prefers plain Skip over `Skip until next version`, which persists host state", () => {
    const reordered = REAL_UPDATE_SCREEN.replace(
      "  2. Skip\n  3. Skip until next version",
      "  2. Skip until next version\n  3. Skip",
    );
    expect(resolveInterstitialKey(reordered, CODEX_UPDATE)).toBe("3");
  });

  it("reads the number off the menu rather than assuming 2", () => {
    const renumbered = REAL_UPDATE_SCREEN.replace("  2. Skip", "  7. Skip");
    expect(resolveInterstitialKey(renumbered, CODEX_UPDATE)).toBe("7");
  });

  it("finds Skip even when it is the selected line, prefixed with the caret", () => {
    const skipSelected = REAL_UPDATE_SCREEN.replace("› 1. Update now", "  1. Update now").replace(
      "  2. Skip",
      "› 2. Skip",
    );
    expect(resolveInterstitialKey(skipSelected, CODEX_UPDATE)).toBe("2");
  });

  it("sends nothing when the interstitial is not showing", () => {
    expect(resolveInterstitialKey(REAL_TRUST_SCREEN, CODEX_UPDATE)).toBeNull();
    expect(resolveInterstitialKey("", CODEX_UPDATE)).toBeNull();
  });

  it("sends nothing when the prompt shows but no Skip option exists", () => {
    const withoutSkip = REAL_UPDATE_SCREEN.replace("  2. Skip\n", "").replace(
      "  3. Skip until next version",
      "  2. Remind me later",
    );
    expect(resolveInterstitialKey(withoutSkip, CODEX_UPDATE)).toBeNull();
  });

  it("does not fire on an ordinary session that merely mentions the words", () => {
    const chatter = "› Ask codex whether an Update available! banner needs a Press enter to continue guard.";
    expect(resolveInterstitialKey(chatter, CODEX_UPDATE)).toBeNull();
  });
});

describe("findStartupInterstitial", () => {
  it("returns the matching interstitial and its key", () => {
    expect(findStartupInterstitial(REAL_UPDATE_SCREEN, [CODEX_UPDATE])).toEqual({
      interstitial: CODEX_UPDATE,
      key: "2",
    });
  });

  it("returns null when none of them are showing", () => {
    expect(findStartupInterstitial(REAL_TRUST_SCREEN, [CODEX_UPDATE])).toBeNull();
  });

  it("skips a non-matching interstitial to find a later one", () => {
    const never: StartupInterstitial = { id: "never", when: ["nothing like this"], choose: "^(\\d+)$" };
    expect(findStartupInterstitial(REAL_UPDATE_SCREEN, [never, CODEX_UPDATE])?.key).toBe("2");
  });
});

describe("StartupInterstitialDismisser", () => {
  const TRUST: StartupInterstitial = {
    id: "codex-trust-directory",
    when: ["Do you trust the contents of this directory?"],
    choose: "^[\\s›>❯]*(\\d+)\\.\\s+Yes, continue\\s*$",
  };

  it("answers a prompt once, even while it lingers on screen", () => {
    const dismisser = new StartupInterstitialDismisser([CODEX_UPDATE]);
    expect(dismisser.next(REAL_UPDATE_SCREEN)?.key).toBe("2");
    // This is the "22222 typed into the composer" bug: the prompt is still
    // rendered on the next few polls while the tool redraws.
    expect(dismisser.next(REAL_UPDATE_SCREEN)).toBeNull();
    expect(dismisser.next(REAL_UPDATE_SCREEN)).toBeNull();
  });

  it("still answers a different prompt waiting behind the first", () => {
    const dismisser = new StartupInterstitialDismisser([CODEX_UPDATE, TRUST]);
    expect(dismisser.next(REAL_UPDATE_SCREEN)?.interstitial.id).toBe("codex-update-available");
    expect(dismisser.next(REAL_TRUST_SCREEN)?.interstitial.id).toBe("codex-trust-directory");
    expect(dismisser.next(REAL_TRUST_SCREEN)).toBeNull();
  });

  it("reports done only once every interstitial has been answered", () => {
    const dismisser = new StartupInterstitialDismisser([CODEX_UPDATE, TRUST]);
    expect(dismisser.done).toBe(false);
    dismisser.next(REAL_UPDATE_SCREEN);
    expect(dismisser.done).toBe(false);
    dismisser.next(REAL_TRUST_SCREEN);
    expect(dismisser.done).toBe(true);
  });

  it("sends nothing across an ordinary session with no prompts", () => {
    const dismisser = new StartupInterstitialDismisser([CODEX_UPDATE, TRUST]);
    expect(dismisser.next("› ready\n\n  gpt-5.6-sol default · /srv/grand-console")).toBeNull();
    expect(dismisser.done).toBe(false);
  });
});
