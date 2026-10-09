import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { shouldDismissKeyboardForSidebar } from "@/lib/app-shell-layout";

describe("shouldDismissKeyboardForSidebar", () => {
  it("dismisses when the drawer comes open over the chat", () => {
    expect(shouldDismissKeyboardForSidebar({ open: true, presentation: "drawer" })).toBe(true);
  });

  // Closing it must not fire: the composer is already blurred by then, and
  // re-running the blur on every close is a no-op that hides a real miss.
  it("leaves the keyboard alone when the drawer closes", () => {
    expect(shouldDismissKeyboardForSidebar({ open: false, presentation: "drawer" })).toBe(false);
  });

  // The persistent sidebar sits beside the chat rather than over it, so
  // toggling it while someone types must not take their keyboard away.
  it("never touches the keyboard for the persistent sidebar", () => {
    expect(shouldDismissKeyboardForSidebar({ open: true, presentation: "persistent" })).toBe(false);
    expect(shouldDismissKeyboardForSidebar({ open: false, presentation: "persistent" })).toBe(
      false,
    );
  });
});

describe("the shell wires the dismissal to the open state", () => {
  // Source rather than render: AppShell owns a dozen atoms and a Reanimated
  // tree, and the question is only whether the open state actually reaches
  // the blur. A guard that computes the rule and does nothing is the regression.
  it("blurs from an effect keyed on the sidebar's own state", () => {
    const path = "components/AppShell.tsx";
    expect(existsSync(path), `${path} is readable from the test cwd`).toBe(true);
    const source = readFileSync(path, "utf8");

    const effect = source
      .split("useEffect(")
      // The call, not the name: the import sits in the chunk before the first
      // effect and would match a shell that consults the rule nowhere.
      .find((block) => block.includes("shouldDismissKeyboardForSidebar({"));
    expect(effect, "an effect must consult the rule").toBeDefined();
    expect(effect, "and must actually dismiss the keyboard").toContain("blurWebActiveElement()");

    const dependencies = effect?.match(/\}, \[([^\]]*)\]/)?.[1] ?? "";
    expect(dependencies, "keyed on the open state, or it never re-runs").toContain("sidebarOpen");
    expect(dependencies, "and on the presentation it switches on").toContain("sidebarPresentation");
  });
});
