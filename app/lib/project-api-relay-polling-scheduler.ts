export const PROJECT_API_RELAY_POLL_INTERVAL_MS = 2000;

export function startProjectApiRelayPoll(
  refresh: () => Promise<void> | void,
  intervalMs = PROJECT_API_RELAY_POLL_INTERVAL_MS,
): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(run, intervalMs);
  };

  const run = () => {
    timer = null;
    void Promise.resolve(refresh())
      .catch((err) => {
        console.warn("project API relay poll failed:", err);
      })
      .finally(schedule);
  };

  schedule();
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export function createSerializedProjectApiRefresh(
  refresh: () => Promise<void> | void,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let rerunRequested = false;

  const run = async (): Promise<void> => {
    do {
      rerunRequested = false;
      await refresh();
    } while (rerunRequested);
  };

  return async () => {
    if (inFlight) {
      rerunRequested = true;
      return inFlight;
    }
    inFlight = run().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
