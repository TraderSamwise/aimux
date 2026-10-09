import { beforeEach, describe, expect, it, vi } from "vitest";

/// Hooks with no renderer to run them are where this feature can quietly die:
/// the gates beside this one drive the pure parts, so the state, the effects,
/// the dependency arrays and the listener wiring were covered by nothing. This
/// is the smallest React that can execute them.
///
/// Three rules it keeps, because mutations hid behind each: slots belong to an
/// INSTANCE, not the module, so module-level state cannot pass as per-mount
/// state; a render that consumes a different number of hooks throws, as React
/// does, so a conditional hook cannot pass; and effects re-run only when a
/// dependency actually changes, with the previous cleanup called first.
type Instance = {
  effects: { cleanup: (() => void) | void; deps: unknown[] | undefined; run: () => void }[];
  effectCursor: number;
  hookCount: number | null;
  pending: boolean;
  renders?: () => void;
  slotCursor: number;
  slots: { value: unknown }[];
};

let current: Instance | null = null;

function instance(): Instance {
  if (!current) throw new Error("a hook was called outside a render");
  return current;
}

function slot<T>(make: () => T): { value: T } {
  const self = instance();
  const existing = (self.slots[self.slotCursor] ??= { value: make() });
  self.slotCursor += 1;
  return existing as { value: T };
}

vi.mock("react", () => ({
  useState: <T>(initial: T | (() => T)) => {
    const self = instance();
    const held = slot(() => (typeof initial === "function" ? (initial as () => T)() : initial));
    // A real setter schedules a render; here it writes the slot and re-renders,
    // which is the same ordering for hooks that only read their arguments.
    return [
      held.value,
      (next: T | ((previous: T) => T)) => {
        held.value = typeof next === "function" ? (next as (p: T) => T)(held.value) : next;
        // React schedules; it does not re-enter render. Calling back in from
        // an effect's own `setState` would nest a render inside a render and
        // double this instance's hook count.
        if (current) self.pending = true;
        else self.renders?.();
      },
    ] as const;
  },
  useRef: <T>(initial: T) => slot(() => ({ current: initial })).value,
  useMemo: <T>(factory: () => T, deps: unknown[]) => {
    const memo = slot<{ deps: unknown[] | undefined; result: T | undefined }>(() => ({
      deps: undefined,
      result: undefined,
    })).value;
    if (!memo.deps || deps.some((value, index) => value !== memo.deps?.[index])) {
      memo.deps = deps;
      memo.result = factory();
    }
    return memo.result as T;
  },
  useEffect: (run: () => void, deps?: unknown[]) => {
    const self = instance();
    const previous = self.effects[self.effectCursor];
    const changed =
      !previous ||
      previous.deps === undefined ||
      deps === undefined ||
      deps.length !== previous.deps.length ||
      deps.some((value, index) => value !== previous.deps?.[index]);
    if (changed) previous?.cleanup?.();
    const slotted = { cleanup: previous?.cleanup, deps, run };
    self.effects[self.effectCursor] = slotted;
    self.effectCursor += 1;
    if (changed) slotted.cleanup = run() as (() => void) | void;
  },
}));

const blurWebActiveElement = vi.fn();
vi.mock("@/lib/blur-web-active-element", () => ({
  blurWebActiveElement: () => blurWebActiveElement(),
}));

let hardwareKeyboard = false;
vi.mock("@/lib/hardware-keyboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hardware-keyboard")>()),
  useHasHardwareKeyboard: () => hardwareKeyboard,
}));

let platformOS = "ios";
let windowWidth = 1200;
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
  useWindowDimensions: () => ({ height: 800, width: windowWidth }),
}));

const { useSidebarKeyboardDismiss } = await import("@/lib/sidebar-keyboard-dismiss");
const { useSidebarListInset } = await import("@/lib/use-keyboard-visible");

type Mounted<T> = { last: () => T; render: () => T; unmount: () => void };

function mount<T>(render: () => T): Mounted<T> {
  const self: Instance = {
    effectCursor: 0,
    effects: [],
    hookCount: null,
    pending: false,
    slotCursor: 0,
    slots: [],
  };
  let last: T;
  const renderOnce = () => {
    const previous = current;
    current = self;
    self.slotCursor = 0;
    self.effectCursor = 0;
    try {
      last = render();
    } finally {
      current = previous;
    }
    const consumed = self.slotCursor + self.effectCursor;
    // React's own rule, and the one a conditional hook breaks. Without it a
    // guard above a hook call is free here and crashes in the app.
    if (self.hookCount !== null && self.hookCount !== consumed) {
      throw new Error(`rendered ${consumed} hooks, expected ${self.hookCount}`);
    }
    self.hookCount = consumed;
  };
  const run = (): T => {
    renderOnce();
    let guard = 0;
    while (self.pending) {
      self.pending = false;
      if ((guard += 1) > 20) throw new Error("render loop did not settle");
      renderOnce();
    }
    return last;
  };
  self.renders = () => void run();
  run();
  return {
    last: () => last,
    render: run,
    unmount: () => self.effects.forEach((effect) => effect.cleanup?.()),
  };
}

type Render = { dismiss?: () => void; open: boolean; presentation?: "drawer" | "persistent" };

/// Replays renders through one mounted hook, returning the blur count after
/// each. Render 0 is the mount, which by definition opened nothing.
function blursPerRender(renders: Render[]): number[] {
  blurWebActiveElement.mockClear();
  let next = renders[0];
  const harness = mount(() => {
    useSidebarKeyboardDismiss(next.open, next.presentation ?? "drawer", next.dismiss);
    return blurWebActiveElement.mock.calls.length;
  });
  const counts = [harness.last()];
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
    expect(
      blursPerRender([
        { dismiss, open: false },
        { dismiss, open: true },
      ]),
    ).toEqual([0, 0]);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  // A `dismiss` missing from the dependency array leaves the effect holding
  // the first one it was given, so a caller that swaps it is ignored.
  it("uses the dismiss it was handed most recently", () => {
    const first = vi.fn();
    const second = vi.fn();
    blursPerRender([
      { dismiss: first, open: false },
      { dismiss: second, open: true },
    ]);
    expect(first, "the superseded one must not be called").not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
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

  // `presentation` missing from the dependency array leaves the effect holding
  // the mount's value, so a rotation is read with the wrong one -- and this is
  // the rotation the edge rule exists for, driven through the hook this time.
  it("reads the presentation of the render it is running for", () => {
    expect(
      blursPerRender([
        { open: false, presentation: "persistent" },
        { open: true, presentation: "persistent" },
        { open: true, presentation: "drawer" },
        { open: false, presentation: "drawer" },
        { open: true, presentation: "drawer" },
      ]),
      "the rotation opened nothing; the last render did",
    ).toEqual([0, 0, 0, 0, 1]);
  });

  // Two mounted shells must not share one watcher. A module-level watcher
  // passed every single-instance sequence.
  it("keeps one mount's state out of another's", () => {
    blurWebActiveElement.mockClear();
    let firstOpen = false;
    let secondOpen = false;
    const first = mount(() => useSidebarKeyboardDismiss(firstOpen, "drawer"));
    const second = mount(() => useSidebarKeyboardDismiss(secondOpen, "drawer"));
    expect(blurWebActiveElement).toHaveBeenCalledTimes(0);

    firstOpen = true;
    first.render();
    expect(blurWebActiveElement, "the first shell opened").toHaveBeenCalledTimes(1);

    secondOpen = true;
    second.render();
    expect(
      blurWebActiveElement,
      "and the second one's own opening is not swallowed by the first",
    ).toHaveBeenCalledTimes(2);
  });
});

describe("useSidebarListInset", () => {
  beforeEach(() => {
    platformOS = "ios";
    keyboardMetrics = undefined;
    windowWidth = 1200;
    keyboardListeners.clear();
    removedListeners.length = 0;
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
    expect(mount(() => useSidebarListInset()).last()).toEqual({ paddingBottom: 291 });
  });

  it("subscribes to the frame event, and unsubscribes", () => {
    const harness = mount(() => useSidebarListInset());
    expect([...keyboardListeners.keys()].sort()).toEqual([
      "keyboardWillChangeFrame",
      "keyboardWillHide",
    ]);
    harness.unmount();
    expect(removedListeners.sort(), "both listeners removed").toEqual([
      "keyboardWillChangeFrame",
      "keyboardWillHide",
    ]);
  });

  // The drawer dismisses the keyboard instead, so padding it is dead weight
  // that snaps to zero mid-slide and re-lays out a list in motion.
  it("pads nothing below the persistent breakpoint", () => {
    windowWidth = 430;
    keyboardMetrics = { height: 291 };
    expect(mount(() => useSidebarListInset()).last()).toEqual({ paddingBottom: 0 });
  });

  // Under Android's edge-to-edge the window resizes for the keyboard, so
  // padding on top of that would push the list up twice.
  it("pads nothing on Android, where the window resizes instead", () => {
    platformOS = "android";
    keyboardMetrics = { height: 291 };
    expect(mount(() => useSidebarListInset()).last()).toEqual({ paddingBottom: 0 });
    expect(keyboardListeners.size, "and subscribes to nothing").toBe(0);
  });
});

describe("useSidebarListInset on web", () => {
  const listeners = new Map<string, () => void>();
  let viewport: { height: number; scale: number } | undefined;

  beforeEach(() => {
    platformOS = "web";
    windowWidth = 1200;
    listeners.clear();
    viewport = { height: 415, scale: 1 };
    vi.stubGlobal("window", {
      addEventListener: () => {},
      innerHeight: 768,
      removeEventListener: () => {},
      visualViewport: {
        addEventListener: (event: string, handler: () => void) => listeners.set(event, handler),
        get height() {
          return viewport?.height ?? 0;
        },
        removeEventListener: (event: string) => listeners.delete(event),
        get scale() {
          return viewport?.scale ?? 1;
        },
      },
    });
  });

  // iPad Safari in landscape is 1024pt, so it draws the PERSISTENT sidebar,
  // and its keyboard overlays the page without resizing the layout viewport.
  it("measures the gap between the two viewports", () => {
    expect(mount(() => useSidebarListInset()).last()).toEqual({ paddingBottom: 353 });
  });

  // The one expression that can be wrong by hundreds of pixels, and it had no
  // test: `visualViewport.height` is CSS pixels of the ZOOMED region, so at 2x
  // the same uncovered strip reports 207.5. Dividing would pad 664.
  it("scales the visual viewport before subtracting", () => {
    viewport = { height: 207.5, scale: 2 };
    expect(mount(() => useSidebarListInset()).last()).toEqual({ paddingBottom: 353 });
  });

  it("pads nothing when no keyboard is covering the page", () => {
    viewport = { height: 768, scale: 1 };
    expect(mount(() => useSidebarListInset()).last()).toEqual({ paddingBottom: 0 });
  });

  it("follows the viewport as the keyboard arrives and leaves", () => {
    viewport = { height: 768, scale: 1 };
    const harness = mount(() => useSidebarListInset());
    expect(harness.last()).toEqual({ paddingBottom: 0 });

    viewport = { height: 415, scale: 1 };
    listeners.get("resize")?.();
    expect(harness.last()).toEqual({ paddingBottom: 353 });

    viewport = { height: 768, scale: 1 };
    listeners.get("resize")?.();
    expect(harness.last()).toEqual({ paddingBottom: 0 });
  });

  it("unsubscribes from the viewport", () => {
    mount(() => useSidebarListInset()).unmount();
    expect([...listeners.keys()], "the resize listener is removed").toEqual([]);
  });
});
