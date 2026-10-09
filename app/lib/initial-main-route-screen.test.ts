import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LANDING = "app/(main)/(tabs)/(dashboard)/index.tsx";

// Source rather than render: this route is an Expo Router screen with six atoms
// and no renderer in this app runs an effect. The rule itself is tested next
// door; all this has to claim is that the screen feeds it the real signals and
// acts on all three answers.
describe("the landing screen", () => {
  const path = join(APP_ROOT, LANDING);
  const source = (() => {
    expect(existsSync(path), `${path} is readable`).toBe(true);
    // Comments stripped: `toContain` is happy to match a call commented out.
    return readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, "");
  })();

  it("derives the relay signal instead of reading the raw status", () => {
    expect(source, "the three-valued signal is the whole fix").toContain(
      "relaySignal: relayLandingSignal(relayConfigured, relayStatus)",
    );
    expect(source, "and the raw comparison must not come back").not.toMatch(
      /relayStatus\s*(!==|===)\s*"/,
    );
  });

  it("passes the machines the relay reported, not a constant", () => {
    expect(source, "an empty fleet is how a guest is told apart").toContain(
      "ownMachineCount: relayMachines.length",
    );
    expect(source).toContain("useAtomValue(relayMachinesAtom)");
  });

  it("passes the real share count, not a constant", () => {
    expect(source).toContain("realSharedChatCount: acceptedShares.length");
    expect(source).toContain("useAtomValue(acceptedSharedSessionsAtom)");
  });

  it("tells the rule whether stored shares have been read", () => {
    expect(source).toContain("sharesHydrated");
    expect(source, "from the store, not a constant").toContain(
      "useAtomValue(settingsHydratedAtom)",
    );
  });

  it("ends the wait, so a relay that never answers cannot hold the app", () => {
    expect(source).toContain("RELAY_LANDING_WAIT_MS");
    expect(source, "a timer that is cleared on unmount").toMatch(
      /setTimeout\([\s\S]*?setWaitExpired\(true\)[\s\S]*?RELAY_LANDING_WAIT_MS\)/,
    );
    expect(source).toContain("clearTimeout(timer)");
  });

  it("acts on all three answers", () => {
    expect(source, "pending must render rather than navigate").toMatch(
      /route === "pending"[\s\S]*?ActivityIndicator/,
    );
    expect(source).toMatch(/route === "shared"[\s\S]*?href="\/shares"/);
    expect(source, "and project is the fall-through").toContain('buildViewHref("/project"');
  });
});
