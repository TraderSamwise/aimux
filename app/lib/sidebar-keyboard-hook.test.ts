import { beforeEach, describe, expect, it, vi } from "vitest";

/// Hooks with no renderer to run them are where this feature can quietly die:
/// the gates beside this one drive the pure parts, so the ref seeding, the
/// effects, the dependency arrays and the listener wiring were covered by
/// nothing. This is the smallest React that can execute them -- state and refs
/// by call order, effects re-run only when a dependency actually changes, which
/// is the one React rule these hooks depend on.
type Slot = { value: unknown };
type EffectSlot = { cleanup: (() => void) | void; deps: unknown[] | undefined; run: () => void };

const slots: Slot[] = [];
const effects: EffectSlot[] = [];
let slotCursor = 0;
let effectCursor = 0;
let rerender: () => void = () => {};

vi.mock("react", () => ({
  useState: <T>(initial: T | (() => T)) => {
    const slot = (slots[slotCursor] ??= {
      value: typeof initial === "function" ? (initial as () => T)() : initial,
    });
    slotCursor += 1;
    // A real setter schedules a render; here it writes the slot and the test
    // renders again, which is the same ordering for a hook that only reads.
    return [
      slot.value as T,
      (next: T | ((previous: T) => T)) => {
        slot.value = typeof next === "function" ? (next as (p: T) => T)(slot.value as T) : next;
        rerender();
      },
    ] as const;
  },
  useRef: <T>(initial: T) => {
    const slot = (slots[slotCursor] ??= { value: { current: initial } });
    slotCursor += 1;
    return slot.value as { current: T };
  },
  useMemo: <T>(factory: () => T, deps: unknown[]) => {
    const slot = (slots[slotCursor] ??= { value: { deps: undefined, result: undefined } });
    slotCursor += 1;
    const memo = slot.value as { deps: unknown[] | undefined; result: T };
    if (!memo.deps || deps.some((value, index) => value !== memo.deps?.[index])) {
      memo.deps = deps;
      memo.result = factory();
    }
    return memo.result;
  },
  useEffect: (run: () => void, deps?: unknown[]) => {
    const previous = effects[effectCursor];
    const changed =
      !previous ||
      previous.deps === undefined ||
      deps === undefined ||
      deps.length !== previous.deps.length ||
      deps.some((value, index) => value !== previous.deps?.[index]);
    if (changed) previous?.cleanup?.();
    const slot: EffectSlot = { cleanup: previous?.cleanup, deps, run };
    effects[effectCursor] = slot;
    effectCursor += 1;
    if (changed) slot.cleanup = run() as (() => void) | void;
  },
}));

const blurWebActiveElement = vi.fn();
vi.mock("@/lib/blur-web-active-element", () => ({
  blurWebActiveElement: () => blurWebActiveElement(),
}));

let hardwareKeyboard = false;
vi.mock("@/lib/hardware-keyboard", () => ({
  SOFT_KEYBOARD_MIN_OCCLUSION_PX: 120,
  useHasHardwareKeyboard: () => hardwareKeyboard,
}));

let platformOS = "ios";
const keyboardListeners = new Map<string, (event: unknown) => void>();
let keyboardMetrics: { height: number } | undefined;
const removedListeners: string[] = [];
vi.mock("react-native", () => ({
  Keyboard: {
    addListener: (event: string, handler: (payload: unknown) => void) => {
      keyboardListeners.set(event, handler);
      return {
        remove: () => {
          removedListeners.push(event);
          keyboardListeners.delete(event);
        },
      };
    },
    metrics: () => keyboardMetrics,
  },
  Platform: {
    get OS() {
      return platformOS;
    },
  },
}));

const { useSidebarKeyboardDismiss } = await import("@/lib/sidebar-keyboard-dismiss");
const { useSidebarListInset } = await import("@/lib/use-keyboard-visible");

function mount<T>(render: () => T): { last: () => T; render: (next?: () => T) => T } {
  slots.length = 0;
  effects.length = 0;
  keyboardListeners.clear();
  removedListeners.length = 0;
  let current = render;
  let last: T;
  const run = (next?: () => T): T => {
    if (next) current = next;
    slotCursor = 0;
    effectCursor = 0;
    last = current();
    return last;
  };
  rerender = () => run();
  run();
  return { last: () => last, render: run };
}

type Render = { open: boolean; presentation?: "drawer" | "persistent" };

/// Replays renders through the mounted hook, returning the blur count after
/// each one. Render 0 is the mount, which by definition opened nothing.
function blursPerRender(renders: Render[], dismiss?: () => void): number[] {
  blurWebActiveElement.mockClear();
  const counts: number[] = [];
  let next: Render = renders[0];
  const harness = mount(() => {
    useSidebarKeyboardDismiss(next.open, next.presentation ?? "drawer", dismiss);
    return blurWebActiveElement.mock.calls.length;
  });
  counts.push(harness.last());
  for (const render of renders.slice(1)) {
    next = render;
    counts.push(harness.render());
  }
  return counts;
}

describe("useSidebarKeyboardDismiss", () => {
  beforeEach(() => {
    hardwareKeyboard = false;
    platformOS = "ios";
  });

  // The whole point, and the one case a gutted hook body passes silently.
  it("blurs on the render that opens the drawer, and only that one", () => {
    expect(blursPerRender([{ open: false }, { open: true }, { open: true }])).toEqual([0, 1, 1]);
  });

  // Mounting already open is the drawer's default, and a hook that seeds its
  // watcher with `false` reads that first render as an opening.
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

  // Unpinned in both directions before this: hardcoding the veto false, and
  // inverting it, each killed the feature with every other gate green.
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

describe("useSidebarListInset", () => {
  beforeEach(() => {
    platformOS = "ios";
    keyboardMetrics = undefined;
  });

  // Replacing the hook's body with a constant `{ paddingBottom: 0 }` cut every
  // sidebar off behind the keyboard while the arithmetic tests stayed green.
  it("gives back the strip the keyboard covers", () => {
    const harness = mount(() => useSidebarListInset());
    expect(harness.last(), "nothing is covered before the keyboard arrives").toEqual({
      paddingBottom: 0,
    });

    keyboardListeners.get("keyboardWillChangeFrame")?.({
      endCoordinates: { height: 336, screenY: 520 },
    });
    expect(harness.last(), "the covered strip becomes padding").toEqual({ paddingBottom: 336 });

    keyboardListeners.get("keyboardWillHide")?.({});
    expect(harness.last(), "and goes back when the keyboard leaves").toEqual({ paddingBottom: 0 });
  });

  // Mounting while the keyboard is already up is reachable -- the shell swaps
  // which sidebar it renders -- and waiting for an event leaves that mount a
  // keyboard's worth of rows short.
  it("reads the keyboard already up at mount", () => {
    keyboardMetrics = { height: 291 };
    const harness = mount(() => useSidebarListInset());
    expect(harness.last()).toEqual({ paddingBottom: 291 });
  });

  it("subscribes to the frame event, and unsubscribes", () => {
    const harness = mount(() => useSidebarListInset());
    expect([...keyboardListeners.keys()].sort()).toEqual([
      "keyboardWillChangeFrame",
      "keyboardWillHide",
    ]);
    effects.forEach((effect) => effect.cleanup?.());
    expect(removedListeners.sort(), "both listeners removed").toEqual([
      "keyboardWillChangeFrame",
      "keyboardWillHide",
    ]);
    expect(harness.last()).toEqual({ paddingBottom: 0 });
  });

  // Under Android's edge-to-edge the window resizes for the keyboard, so
  // padding on top of that would push the list up twice.
  it("pads nothing on Android, where the window resizes instead", () => {
    platformOS = "android";
    keyboardMetrics = { height: 291 };
    const harness = mount(() => useSidebarListInset());
    expect(harness.last()).toEqual({ paddingBottom: 0 });
    expect(keyboardListeners.size, "and subscribes to nothing").toBe(0);
  });
});
