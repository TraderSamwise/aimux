import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { env } from "./env";
import { relayStatusAtom } from "@/stores/relay";
import { activeSharedSessionAtom } from "@/stores/settings";

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
