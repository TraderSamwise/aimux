import { useSyncExternalStore } from "react";

// "prompted just now" is computed from Date.now(), so it only advances when
// something re-renders it. The list used to re-render on every poll, which kept
// these labels honest by accident and cost a full render of every row. Now that
// the list holds still, the labels need a clock of their own -- one shared
// ticker, subscribed to by the small text nodes that show a relative time, so a
// minute passing costs those nodes and nothing else.

const TICK_MS = 30_000;

let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function start(): void {
  if (timer) return;
  timer = setInterval(() => {
    now = Date.now();
    for (const listener of listeners) listener();
  }, TICK_MS);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function snapshot(): number {
  return now;
}

// Server rendering has no clock to tick; a stable value keeps hydration quiet.
function serverSnapshot(): number {
  return 0;
}

/**
 * Re-renders the caller about twice a minute. Use it only in the leaf that
 * renders a relative time, never in a row or a list.
 */
export function useRecencyClock(): number {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

export const RECENCY_CLOCK_TICK_MS = TICK_MS;

// The store behind the hook. Exported so its contract -- advances on a tick,
// notifies subscribers, stops its timer when the last one leaves -- can be
// tested without a renderer.
export const recencyClockStore = { subscribe, snapshot };
