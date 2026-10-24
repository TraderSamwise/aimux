import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { componentBody } from "@/test/component-source";

const APP = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The callers that cannot afford a HELD write.
 *
 * `readBeforeWriteAtom` holds a write until the value it modifies has been
 * read, which is right -- merging onto a fallback and storing it back is what
 * destroyed the stored value in the first place. But a held write is DROPPED,
 * not deferred, so a caller that cannot be asked again has to wait for the
 * read or keep what it was going to write. These are the two that cannot, and
 * neither announces itself: both are mount-time or socket-time, with no user
 * gesture to repeat.
 */
// The shared chat summary's two cases are NOT here. They were source-text
// gates asserting spellings, and they passed through both regressions this
// branch produced -- a grep cannot see that `shareSummaryCheckedKey` is the
// owner's send gate. They are
// `app/components/AgentChatScreen.sendgate.component.test.tsx` now, which
// renders the screen and fails on either one.

describe("a security event from the relay", () => {
  const layout = componentBody(
    join(APP, "app", "(main)", "_layout.tsx"),
    "export default function MainLayout(",
  );

  // Waiting is not an option here: the relay does not resend, so a held write
  // loses the event outright -- while the notification two lines below still
  // fires, telling the user about something the inbox will never show.
  it("is kept rather than written before the inbox has been read", () => {
    expect(layout).toMatch(
      /if \(store\.get\(securityEventsReadStateAtom\) === "read"\) \{[\s\S]{0,120}?addSecurityEventAtom, event\);[\s\S]{0,80}?\} else \{[\s\S]{0,120}?heldSecurityEventsRef\.current\.push\(event\)/,
    );
  });

  it("and is written once the inbox arrives", () => {
    expect(layout).toMatch(
      /if \(securityEventsReadState === "unread"\) return;[\s\S]{0,600}?store\.set\(addSecurityEventAtom, event\)/,
    );
    expect(layout, "and the effect re-runs when it does").toMatch(
      /store\.set\(addSecurityEventAtom, event\);[\s\S]{0,120}\}, \[securityEventsReadState, store\]\)/,
    );
  });

  // A read that FAILED will not arrive, so holding them only grows for the
  // rest of the session -- and discarding them in silence is the habit this
  // whole change exists to break.
  it("stops holding them when the inbox cannot be read, and says so", () => {
    expect(layout).toMatch(
      /if \(securityEventsReadState === "failed"\) \{[\s\S]{0,400}?console\.warn\(/,
    );
  });

  it("empties what it kept, so nothing is stored twice", () => {
    expect(layout).toMatch(
      /heldSecurityEventsRef\.current = \[\];[\s\S]{0,1200}?for \(const event of held\)/,
    );
  });
});

describe("the shared chats list", () => {
  const shares = componentBody(
    join(APP, "app", "(main)", "shares", "index.tsx"),
    "export default function SharedChatsScreen(",
  );

  // `refresh` writes the shares it fetched and then calls
  // `setHasHydrated(true)`, which switches off the loading state -- so a held
  // write left the screen presenting the default empty list as loaded, saying
  // nobody had shared anything.
  it("does not fetch until the write could land", () => {
    expect(shares).toContain("useAtomValue(settingsReadStateAtom)");
    expect(shares).toMatch(
      /if \(settingsReadState !== "read"\) return;[\s\S]{0,200}?void refresh\(\)/,
    );
    expect(shares, "and re-runs when the read lands").toMatch(
      /\}, \[refresh, settingsReadState\]\)/,
    );
  });

  // A read that FAILED is its own answer. `loading` starts true and only the
  // fetch clears it, so skipping the fetch left a permanent "Loading shared
  // chats..." -- a wrapper reporting a storage error as still loading, with
  // the refresh button disabled so there was no way out of it.
  it("says what happened instead of loading forever when the read failed", () => {
    // Derived, not set in an effect: setting state there cascades renders, and
    // the answer is a pure function of the read state.
    expect(shares).toContain('const storageUnreadable = settingsReadState === "failed"');
    expect(shares, "so the spinner stops").toContain(
      "const visibleLoading = loading && !storageUnreadable",
    );
    expect(shares, "and the reason is shown").toMatch(/cannot read its stored shared chats/);
    expect(shares, "through the card the screen already has").toContain("body={visibleError}");
  });

  it("and the manual refresh waits too", () => {
    expect(shares).toContain('disabled={loading || settingsReadState !== "read"}');
  });
});
