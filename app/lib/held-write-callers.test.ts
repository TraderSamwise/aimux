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
describe("the shared chat summary", () => {
  const chat = componentBody(
    join(APP, "components", "screens", "AgentChatScreen.tsx"),
    "export default function ChatScreen(",
  );

  // It writes `acceptedShares` and `activeShare` and then latches
  // `shareSummaryCheckedKey`, which switches the effect off for good. Latching
  // after a held write opened a shared chat that was absent from the list
  // `useRouteShare` resolves from.
  it("latches only once the writes could land", () => {
    expect(chat).toContain("useAtomValue(settingsReadStateAtom)");
    expect(chat, "at the latch that follows the writes").toMatch(
      /setLegacyActiveShare\(acceptedShare\);[\s\S]{0,700}?if \(settingsReadState !== "unread"\) \{\s*setShareSummaryCheckedKey\(shareSummaryRequestKey\);/,
    );
    expect(chat, "and re-runs when a read in flight arrives").toMatch(
      /\}, \[[^\]]{0,400}settingsReadState,/,
    );
  });

  // The regression this replaced, and it was worse than the bug: gating the
  // whole effect meant that with a settings read that never answers,
  // `shareSummaryCheckedKey` was never set, `ownerShareStatusPending` never
  // cleared, and the OWNER could not send a message in any chat -- silently,
  // because `handleSendMessage` returns without setting an error.
  it("does not gate the fetch itself, which is the owner's send gate", () => {
    const declaration = chat.slice(chat.indexOf("const shouldLoadShareSummary = Boolean("));
    expect(
      declaration.slice(0, declaration.indexOf(");")),
      "the send gate must not wait on a read that may never answer",
    ).not.toContain("settingsReadState");
  });
});

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
      /if \(securityEventsReadState !== "read"\) return;[\s\S]{0,400}?store\.set\(addSecurityEventAtom, event\)/,
    );
    expect(layout, "and the effect re-runs when it does").toMatch(
      /store\.set\(addSecurityEventAtom, event\);[\s\S]{0,120}\}, \[securityEventsReadState, store\]\)/,
    );
  });

  it("empties what it kept, so nothing is stored twice", () => {
    expect(layout).toMatch(
      /heldSecurityEventsRef\.current = \[\];[\s\S]{0,120}?for \(const event of held\)/,
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

  it("and the manual refresh waits too", () => {
    expect(shares).toContain('disabled={loading || settingsReadState !== "read"}');
  });
});
