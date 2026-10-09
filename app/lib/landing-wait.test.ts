import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/// The smallest React that can run this hook, because this app has no
/// effect-running renderer and a source match cannot tell a real timer from
/// `setExpired(true)` on the first render -- which removes the wait entirely.
/// State and effects by call order, effects re-run only on a dependency change.
type Slot = { value: unknown };

let slots: Slot[] = [];
let effects: { cleanup: (() => void) | void; deps: unknown[] | undefined; run: () => void }[] = [];
let slotCursor = 0;
let effectCursor = 0;
let rerender: () => void = () => {};

vi.mock("react", () => ({
  useState: <T>(initial: T) => {
    const slot = (slots[slotCursor] ??= { value: initial });
    slotCursor += 1;
    return [
      slot.value as T,
      (next: T) => {
        slot.value = next;
        rerender();
      },
    ] as const;
  },
  useEffect: (run: () => void, deps?: unknown[]) => {
    const previous = effects[effectCursor];
    const changed =
      !previous ||
      previous.deps === undefined ||
      deps === undefined ||
      deps.some((value, index) => value !== previous.deps?.[index]);
    if (changed) previous?.cleanup?.();
    const slot = { cleanup: previous?.cleanup, deps, run };
    effects[effectCursor] = slot;
    effectCursor += 1;
    if (changed) slot.cleanup = run() as (() => void) | void;
  },
}));

const { useLandingWaitExpired, RELAY_LANDING_WAIT_MS } = await import("@/lib/initial-main-route");

function mount<T>(render: () => T) {
  slots = [];
  effects = [];
  let last: T;
  const run = () => {
    slotCursor = 0;
    effectCursor = 0;
    last = render();
    return last;
  };
  rerender = () => void run();
  run();
  return {
    value: () => last,
    unmount: () => effects.forEach((effect) => effect.cleanup?.()),
  };
}

/// The hook call lives in an anonymous callback, which is the shape
/// `react-hooks/rules-of-hooks` accepts in a harness -- a named wrapper is
/// either "not a hook" or "a hook called from a non-hook", both errors.
function mountWait(waitMs?: number) {
  const harness = mount(() => useLandingWaitExpired(waitMs));
  return { expired: harness.value, unmount: harness.unmount };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useLandingWaitExpired", () => {
  // The whole point: the landing decision must be allowed to wait, and a hook
  // that reports expired immediately is the bounce this series removed.
  it("has not expired on the render that mounts it", () => {
    expect(mountWait().expired()).toBe(false);
  });

  it("expires once the budget has passed, and not before", () => {
    const harness = mountWait();
    vi.advanceTimersByTime(RELAY_LANDING_WAIT_MS - 1);
    expect(harness.expired(), "one millisecond short").toBe(false);
    vi.advanceTimersByTime(1);
    expect(harness.expired()).toBe(true);
  });

  // A screen that unmounts while waiting must not leave a timer to fire into
  // a dead component.
  it("clears its timer on unmount", () => {
    const harness = mountWait();
    harness.unmount();
    vi.advanceTimersByTime(RELAY_LANDING_WAIT_MS * 2);
    expect(harness.expired()).toBe(false);
    expect(vi.getTimerCount(), "nothing left armed").toBe(0);
  });

  // Arming it per decision rather than per mount would restart the clock on
  // every re-render, so a relay that never answers would never time out.
  it("does not restart the clock when the hook re-runs", () => {
    const harness = mountWait();
    vi.advanceTimersByTime(RELAY_LANDING_WAIT_MS - 10);
    rerender();
    rerender();
    vi.advanceTimersByTime(10);
    expect(harness.expired(), "the original deadline still stands").toBe(true);
  });

  it("is six seconds, which the relay's own retry backoff needs", () => {
    expect(RELAY_LANDING_WAIT_MS).toBe(6_000);
  });
});
