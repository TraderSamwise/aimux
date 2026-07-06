import { useCallback, useLayoutEffect, useRef } from "react";

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

export function useSerializedProjectApiRefresh(
  refresh: () => Promise<void> | void,
): () => Promise<void> {
  const refreshRef = useRef(refresh);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const rerunRequestedRef = useRef(false);

  useLayoutEffect(() => {
    refreshRef.current = refresh;
  }, [refresh]);

  return useCallback(async () => {
    if (inFlightRef.current) {
      rerunRequestedRef.current = true;
      return inFlightRef.current;
    }

    const run = async () => {
      do {
        rerunRequestedRef.current = false;
        await refreshRef.current();
      } while (rerunRequestedRef.current);
    };

    inFlightRef.current = run().finally(() => {
      inFlightRef.current = null;
    });
    return inFlightRef.current;
  }, []);
}
