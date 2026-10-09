import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { createSidebarKeyboardDismiss } from "@/lib/sidebar-keyboard-dismiss";

vi.mock("react-native", () => ({
  Keyboard: { dismiss: () => {} },
  Platform: { OS: "ios" },
}));

type Step = { open: boolean; presentation: "drawer" | "persistent" };

// Replays a render sequence through one watcher and reports which steps
// dismissed, so a test reads as the sequence a thumb actually produces.
function dismissedAt(initiallyOpen: boolean, steps: Step[]): number[] {
  const dismissOnOpen = createSidebarKeyboardDismiss(initiallyOpen);
  const dismiss = vi.fn();
  const dismissedSteps: number[] = [];
  steps.forEach((step, index) => {
    const before = dismiss.mock.calls.length;
    const acted = dismissOnOpen(step, dismiss);
    const calls = dismiss.mock.calls.length - before;
    expect(calls, `step ${index} must not dismiss more than once`).toBeLessThanOrEqual(1);
    expect(acted, `step ${index} must report what it did`).toBe(calls === 1);
    if (acted) dismissedSteps.push(index);
  });
  return dismissedSteps;
}

describe("the drawer opening puts the keyboard away", () => {
  it("dismisses when the drawer is opened over the chat", () => {
    expect(
      dismissedAt(false, [
        { open: true, presentation: "drawer" },
        { open: false, presentation: "drawer" },
        { open: true, presentation: "drawer" },
      ]),
      "once per opening, and not on the close between them",
    ).toEqual([0, 2]);
  });

  // The composer is already blurred by then. Dismissing again would be a no-op
  // that makes a real miss look handled.
  it("leaves the keyboard alone when the drawer closes", () => {
    expect(dismissedAt(true, [{ open: false, presentation: "drawer" }])).toEqual([]);
  });

  // The persistent sidebar sits BESIDE the chat rather than over it, so
  // toggling it mid-sentence must not take someone's keyboard away.
  it("never touches the keyboard for the persistent sidebar", () => {
    expect(
      dismissedAt(false, [
        { open: true, presentation: "persistent" },
        { open: false, presentation: "persistent" },
        { open: true, presentation: "persistent" },
      ]),
    ).toEqual([]);
  });

  // `sidebarOpenAtom` defaults to open, and the shell closes it a render later
  // on a drawer layout. A level rule reads that first render as an opening.
  it("does not dismiss on a mount that is already open", () => {
    expect(
      dismissedAt(true, [
        { open: true, presentation: "drawer" },
        { open: false, presentation: "drawer" },
      ]),
    ).toEqual([]);
  });

  // The bug a level rule has: iPad landscape, persistent sidebar open, someone
  // typing, rotate to portrait. 820pt < 900 makes it a drawer with `open`
  // still true, so `drawer && open` turns true with nothing opened.
  it("does not dismiss when a rotation turns the persistent sidebar into a drawer", () => {
    expect(
      dismissedAt(false, [
        { open: true, presentation: "persistent" },
        { open: true, presentation: "drawer" },
        { open: false, presentation: "drawer" },
      ]),
    ).toEqual([]);
  });

  // And the reverse: widening to persistent while the drawer is open must not
  // leave the watcher thinking the next narrow render is an opening.
  it("does not dismiss when widening to persistent and back", () => {
    expect(
      dismissedAt(false, [
        { open: true, presentation: "drawer" },
        { open: true, presentation: "persistent" },
        { open: true, presentation: "drawer" },
      ]),
      "only the first render opened anything",
    ).toEqual([0]);
  });
});

describe("the shell runs it", () => {
  // Source rather than render: there is no effect-running renderer in this app
  // (`WorktreeDashboard.test.tsx` calls components as plain functions), so the
  // behaviour is pinned above and this pins only that the shell is wired to it.
  it("hands the hook the sidebar's own state", () => {
    const path = "components/AppShell.tsx";
    expect(existsSync(path), `${path} is readable from the test cwd`).toBe(true);
    const source = readFileSync(path, "utf8");

    expect(source, "the shell must run the hook").toContain(
      "useSidebarKeyboardDismiss(sidebarOpen, sidebarPresentation)",
    );
    // No second rule beside it: the hook decides, the shell does not branch.
    expect(source, "and must not re-decide for itself").not.toContain("blurWebActiveElement");
  });
});
