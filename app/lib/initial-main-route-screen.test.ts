import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { componentBody } from "@/test/component-source";

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LANDING = "app/(main)/(tabs)/(dashboard)/index.tsx";

// Source rather than render: this route is an Expo Router screen with six atoms
// and no renderer in this app runs an effect. The rule itself is tested next
// door; all this has to claim is that the screen feeds it the real signals and
// acts on all three answers.
describe("the landing screen", () => {
  const path = join(APP_ROOT, LANDING);
  // The EXPORTED COMPONENT's body, not the file. A reviewer replaced the body
  // with `return <Redirect href="/shares" />` and moved the real one into an
  // uncalled function: every assertion below still matched, while the app
  // opened on shared chats every time. Dead code cannot satisfy a gate that
  // only reads what runs.
  const source = componentBody(path, "export default function DashboardIndex(");

  it("derives the backend answer instead of reading the raw status", () => {
    expect(source, "the three-valued answer is the whole fix").toContain(
      "ownBackend: ownBackendSignal(relayConfigured, relayStatus, relayMachines.length)",
    );
    expect(source, "and the raw comparison must not come back").not.toMatch(
      /relayStatus\s*(!==|===)\s*"/,
    );
  });

  it("passes the machines the relay reported, not a constant", () => {
    expect(source, "an empty fleet is how a guest is told apart").toContain(
      "useAtomValue(relayMachinesAtom)",
    );
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

  // The wait itself is driven for real in `landing-wait.test.ts`; a source
  // match could not tell a timer from `setWaitExpired(true)` on first render.
  it("ends the wait through the hook that is tested for it", () => {
    expect(source).toContain("useLandingWaitExpired()");
    expect(source, "and must not re-arm a timer of its own").not.toContain("setTimeout(");
  });

  // A reviewer froze the answer with `const [route] = React.useState(() =>
  // initialMainRoute({...}))`. Every assertion above still matched, and the
  // screen stopped re-deciding when the relay finally replied -- which is the
  // entire mechanism by which the wait ends early.
  it("re-decides on every render instead of freezing the first answer", () => {
    expect(source, "a plain call, recomputed each render").toContain(
      "const route = initialMainRoute({",
    );
    expect(source, "a frozen answer ignores the relay's later reply").not.toMatch(
      /(useState|useRef|useMemo|useCallback)[\s\S]{0,40}initialMainRoute/,
    );
  });

  it("acts on all three answers", () => {
    expect(source, "pending must render rather than navigate").toMatch(
      /route === "pending"[\s\S]*?ActivityIndicator/,
    );
    expect(source).toMatch(/route === "shared"[\s\S]*?href="\/shares"/);
    expect(source, "and project is the fall-through").toContain('buildViewHref("/project"');
  });
});
