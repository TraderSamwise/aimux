import { useCallback, useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { env } from "./env";
import { startProjectApiRelayPoll } from "./project-api-relay-polling-scheduler";
import { relayStatusAtom } from "@/stores/relay";
import { activeSharedSessionAtom } from "@/stores/settings";

export {
  createSerializedProjectApiRefresh,
  PROJECT_API_RELAY_POLL_INTERVAL_MS,
  startProjectApiRelayPoll,
} from "./project-api-relay-polling-scheduler";

export function useSerializedProjectApiRefresh(
  refresh: () => Promise<void> | void,
): () => Promise<void> {
  const refreshRef = useRef(refresh);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const rerunRequestedRef = useRef(false);

  useEffect(() => {
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

export function useProjectApiRelayPolling(
  endpointKey: string | null,
  refresh: () => Promise<void> | void,
): void {
  const relayUrl = env.AIMUX_RELAY_URL;
  const relayStatus = useAtomValue(relayStatusAtom);
  const hasActiveShare = Boolean(useAtomValue(activeSharedSessionAtom));
  const relayReady = relayUrl ? relayStatus === "connected" : hasActiveShare;

  useEffect(() => {
    if (!endpointKey || !relayReady) return;
    const poll = startProjectApiRelayPoll(refresh);
    return poll.stop;
  }, [endpointKey, refresh, relayReady]);
}
