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
  // `shareSummaryCheckedKey` so it never runs again -- on a route outside
  // `(main)`, where nothing refreshes shares. Held writes there open a shared
  // chat that is absent from the list `useRouteShare` resolves from.
  it("waits for the stored settings before it fetches and records", () => {
    expect(chat).toContain("useAtomValue(settingsReadStateAtom)");
    expect(chat, "in the flag the effect and its deps both read").toMatch(
      /const shouldLoadShareSummary = Boolean\([\s\S]{0,200}?settingsReadState === "read" &&/,
    );
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
