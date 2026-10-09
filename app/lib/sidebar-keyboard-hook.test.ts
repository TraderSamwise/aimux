import { beforeEach, describe, expect, it, vi } from "vitest";

/// A four-line hook with no renderer to run it is where the whole feature can
/// quietly die: the gate beside this one drives the watcher directly, so the
/// ref seeding, the effect and the dep array were covered by nothing. This is
/// the smallest React that can execute them -- refs by call order, and effects
/// re-run only when a dependency actually changes, which is the one React rule
/// the hook depends on.
const refs: { current: unknown }[] = [];
const effects: { deps: unknown[] | undefined; run: () => void }[] = [];
let refCursor = 0;
let effectCursor = 0;

vi.mock("react", () => ({
  useRef: <T>(initial: T) => {
    const slot = (refs[refCursor] ??= { current: initial });
    refCursor += 1;
    return slot as { current: T };
  },
  useEffect: (run: () => void, deps?: unknown[]) => {
    const previous = effects[effectCursor];
    const changed =
      !previous ||
      previous.deps === undefined ||
      deps === undefined ||
      deps.length !== previous.deps.length ||
      deps.some((value, index) => value !== previous.deps?.[index]);
    effects[effectCursor] = { deps, run };
    if (changed) run();
    effectCursor += 1;
  },
}));

const blurWebActiveElement = vi.fn();
vi.mock("@/lib/blur-web-active-element", () => ({
  blurWebActiveElement: () => blurWebActiveElement(),
}));

let hardwareKeyboard = false;
vi.mock("@/lib/hardware-keyboard", () => ({
  useHasHardwareKeyboard: () => hardwareKeyboard,
}));

const { useSidebarKeyboardDismiss } = await import("@/lib/sidebar-keyboard-dismiss");

type Render = { open: boolean; presentation?: "drawer" | "persistent" };

/// Mounts the hook and replays renders through it, returning the blur count
/// after each one. A real React would run the effect after commit; running it
/// inline is the same ordering for a hook that only reads its arguments.
function blursPerRender(renders: Render[], dismiss?: () => void): number[] {
  refs.length = 0;
  effects.length = 0;
  blurWebActiveElement.mockClear();
  return renders.map(({ open, presentation = "drawer" }) => {
    refCursor = 0;
    effectCursor = 0;
    useSidebarKeyboardDismiss(open, presentation, dismiss);
    return blurWebActiveElement.mock.calls.length;
  });
}

describe("useSidebarKeyboardDismiss", () => {
  beforeEach(() => {
    hardwareKeyboard = false;
  });

  // The whole point, and the one case a gutted hook body passes silently.
  it("blurs on the render that opens the drawer, and only that one", () => {
    expect(blursPerRender([{ open: false }, { open: true }, { open: true }])).toEqual([0, 1, 1]);
  });

  // Mounting already open is the drawer's default, and a hook that seeds its
  // watcher with `true` instead of `open` reads the first real open as a
  // continuation and never blurs at all.
  it("does not blur on a mount that is already open, and still blurs the next one", () => {
    expect(blursPerRender([{ open: true }, { open: false }, { open: true }])).toEqual([0, 0, 1]);
  });

  // An empty dependency array passes every sequence that opens on the first
  // render, so the sequence has to start closed to catch it.
  it("re-runs on later renders rather than only on mount", () => {
    expect(
      blursPerRender([{ open: false }, { open: false }, { open: true }]),
      "a hook keyed on nothing never sees the third render",
    ).toEqual([0, 0, 1]);
  });

  // `blurWebActiveElement` as the default argument is the only link from the
  // hook to the real keyboard, and the shell passes no third argument.
  it("defaults to the real blur when the caller passes none", () => {
    expect(blursPerRender([{ open: false }, { open: true }])).toEqual([0, 1]);
  });

  it("uses the dismiss it is handed instead, when handed one", () => {
    const dismiss = vi.fn();
    expect(blursPerRender([{ open: false }, { open: true }], dismiss)).toEqual([0, 0]);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("asks whether a hardware keyboard is attached, and obeys the answer", () => {
    hardwareKeyboard = true;
    expect(blursPerRender([{ open: false }, { open: true }])).toEqual([0, 0]);
  });

  it("never blurs for the persistent sidebar", () => {
    expect(
      blursPerRender([
        { open: false, presentation: "persistent" },
        { open: true, presentation: "persistent" },
      ]),
    ).toEqual([0, 0]);
  });
});
