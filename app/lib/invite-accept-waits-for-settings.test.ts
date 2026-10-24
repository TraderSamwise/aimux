import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { componentBody } from "@/test/component-source";

// Accepting an invite CONSUMES it server-side and then writes three settings:
// the accepted share, the active share and the chat view mode. Those writes
// are held until the stored settings have been read, so accepting first would
// consume the invite, report "Invite accepted.", navigate to the shared chat --
// and have stored no accepted share, which is exactly what that route resolves
// from. Nothing on it refreshes shares, so it does not heal.
const screen = componentBody(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "app",
    "shares",
    "invite",
    "[ownerUserId]",
    "[token]",
    "accept.tsx",
  ),
  "export default function AcceptShareInviteScreen(",
);

describe("accepting a share invite", () => {
  it("waits for the stored settings before it can accept", () => {
    expect(screen, "from the store, not a constant").toContain(
      "useAtomValue(settingsHydratedAtom)",
    );
    // In `canAccept`'s CONDITION, so it gates the auto-accept effect and the
    // button together rather than one of the two. Asserting the name alone was
    // satisfied by the dependency array after the condition had lost it.
    expect(screen).toMatch(
      /const canAccept = useMemo\(\s*\(\)\s*=>[\s\S]{0,400}?settingsHydrated &&/,
    );
    expect(screen, "and it re-evaluates when the read lands").toMatch(
      /const canAccept = useMemo\([\s\S]{0,600}?\[[^\]]{0,200}settingsHydrated,/,
    );
  });

  it("still gates the auto-accept and the button on it", () => {
    expect(screen).toContain('if (!canAccept || status !== "idle" || autoAcceptedRef.current)');
    expect(screen).toContain("disabled={!canAccept}");
  });
});
