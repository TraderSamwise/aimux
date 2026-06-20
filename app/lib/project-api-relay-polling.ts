import { useEffect } from "react";
import { useAtomValue } from "jotai";
import { env } from "./env";
import { startProjectApiRelayPoll } from "./project-api-relay-polling-scheduler";
import { relayStatusAtom } from "@/stores/relay";
import { activeSharedSessionAtom } from "@/stores/settings";

export {
  PROJECT_API_RELAY_POLL_INTERVAL_MS,
  startProjectApiRelayPoll,
} from "./project-api-relay-polling-scheduler";

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
