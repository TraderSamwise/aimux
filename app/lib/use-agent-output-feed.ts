import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSetAtom } from "jotai";

import {
  initialAgentOutputFeedLoadedState,
  initialAgentOutputFeedTimedOutState,
  type InitialAgentOutputFeedState,
  type InitialAgentOutputFeedStatus,
} from "@/lib/agent-output-feed-state";
import { getLivePaneOutput, type AgentOutputResponse } from "@/lib/api";
import { paneOutputSnapshotHasVisibleTranscript } from "@/lib/chat-loading";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { AgentOutputEvent, StreamEvent } from "@/lib/events";
import { startHeartbeat } from "@/lib/heartbeat";
import { getErrorMessage } from "@/lib/request-errors";
import { serviceProjectsTranscript } from "@/lib/transcript-view";
import { applyOutputEventAtom, applyOutputSnapshotAtom, lastErrorFamily } from "@/stores/chat";
import type { LivePaneOutputInput } from "../../src/project-api-contract";

export type AgentOutputFeedMode = "full" | "chat";
export type AgentOutputFeedPurpose = NonNullable<LivePaneOutputInput["purpose"]>;

const INITIAL_OUTPUT_TIMEOUT_MS = 12_000;
const STREAM_OUTPUT_INTERVAL_MS = 500;
const FALLBACK_POLL_MS = 1_500;
const STREAM_RESYNC_MS = 10_000;

export type AgentOutputFeedInput = {
  appVisible: boolean;
  enabled: boolean;
  endpoint: ServiceEndpoint | null;
  mode: AgentOutputFeedMode;
  sessionId: string | null | undefined;
  startLine: number;
  token: string | null;
};

export type AgentOutputFeed = {
  initialStatus: InitialAgentOutputFeedStatus;
  refreshOutputSnapshot: (purpose?: AgentOutputFeedPurpose) => Promise<boolean>;
};

function outputFeedKey(input: {
  endpoint: ServiceEndpoint | null;
  mode: AgentOutputFeedMode;
  sessionId: string | null | undefined;
}) {
  if (!input.endpoint || !input.sessionId) return "";
  return `${input.endpoint.host}:${input.endpoint.port}:${input.sessionId}:${input.mode}`;
}

export function useAgentOutputFeed({
  appVisible,
  enabled,
  endpoint,
  mode,
  sessionId,
  startLine,
  token,
}: AgentOutputFeedInput): AgentOutputFeed {
  const applyOutputSnapshot = useSetAtom(applyOutputSnapshotAtom);
  const applyOutputEvent = useSetAtom(applyOutputEventAtom);
  const setLastError = useSetAtom(lastErrorFamily(sessionId ?? ""));
  const endpointHost = endpoint?.host ?? null;
  const endpointPort = endpoint?.port ?? null;
  const stableEndpoint = useMemo(
    () => (endpointHost && endpointPort ? { host: endpointHost, port: endpointPort } : null),
    [endpointHost, endpointPort],
  );
  const feedKey = outputFeedKey({ endpoint: stableEndpoint, mode, sessionId });
  const streamFailedRef = useRef(false);
  const lastStreamOutputAtRef = useRef(0);
  const lastHttpOutputAtRef = useRef(0);
  const [initialStatusState, setInitialStatusState] = useState<InitialAgentOutputFeedState>({
    key: "",
    status: "idle",
  });

  const applySnapshotResult = useCallback(
    (result: AgentOutputResponse) => {
      if (result.sessionId !== sessionId) return false;
      if (!serviceProjectsTranscript(result.messages)) {
        setLastError(
          "This aimux daemon is older than the app and does not send a transcript. Restart it to pick up the new build.",
        );
        return false;
      }
      applyOutputSnapshot({
        sessionId: result.sessionId,
        output: result.output,
        outputAnsi: result.outputAnsi,
        outputAvailable: result.outputAvailable,
        startLine: result.startLine,
        messages: result.messages,
        activity: result.activity,
        activityText: result.activityText,
        attention: result.attention,
      });
      return paneOutputSnapshotHasVisibleTranscript(result);
    },
    [applyOutputSnapshot, sessionId, setLastError],
  );

  const applyStreamOutput = useCallback(
    (event: AgentOutputEvent) => {
      if (event.sessionId !== sessionId) return false;
      if (!serviceProjectsTranscript(event.messages)) {
        setLastError(
          "This aimux daemon is older than the app and does not send a transcript. Restart it to pick up the new build.",
        );
        return false;
      }
      lastStreamOutputAtRef.current = Date.now();
      streamFailedRef.current = false;
      applyOutputEvent(event);
      return paneOutputSnapshotHasVisibleTranscript(event);
    },
    [applyOutputEvent, sessionId, setLastError],
  );

  const refreshOutputSnapshot = useCallback(
    async (purpose: AgentOutputFeedPurpose = "poll"): Promise<boolean> => {
      if (!enabled || !stableEndpoint || !sessionId) return false;
      const result = await getLivePaneOutput(stableEndpoint, sessionId, startLine, {
        token,
        mode,
        purpose,
      });
      lastHttpOutputAtRef.current = Date.now();
      return applySnapshotResult(result);
    },
    [applySnapshotResult, enabled, mode, sessionId, stableEndpoint, startLine, token],
  );

  useEffect(() => {
    if (!enabled || !stableEndpoint || !sessionId || !appVisible) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- disabled feeds have no pending initial output request
      setInitialStatusState({ key: "", status: "idle" });
      return;
    }

    let cancelled = false;
    let fallbackTimer: ReturnType<typeof setInterval> | null = null;
    let initialTimeout: ReturnType<typeof setTimeout> | null = null;
    let inFlightFallback = false;
    let streamHandle: { stop: () => void } | null = null;

    const markLoaded = () => {
      if (cancelled) return;
      if (initialTimeout) {
        clearTimeout(initialTimeout);
        initialTimeout = null;
      }
      setInitialStatusState((current) => initialAgentOutputFeedLoadedState(current, feedKey));
    };

    const runFallbackPoll = async (purpose: AgentOutputFeedPurpose = "poll") => {
      if (cancelled || inFlightFallback) return;
      inFlightFallback = true;
      try {
        const hasVisibleTranscript = await refreshOutputSnapshot(purpose);
        if (hasVisibleTranscript) markLoaded();
      } catch (error) {
        if (streamFailedRef.current) setLastError(getErrorMessage(error));
      } finally {
        inFlightFallback = false;
      }
    };

    streamFailedRef.current = false;
    lastStreamOutputAtRef.current = 0;
    lastHttpOutputAtRef.current = 0;
    setInitialStatusState({ key: feedKey, status: "loading" });
    initialTimeout = setTimeout(() => {
      if (cancelled) return;
      setInitialStatusState((current) => initialAgentOutputFeedTimedOutState(current, feedKey));
    }, INITIAL_OUTPUT_TIMEOUT_MS);

    streamHandle = startHeartbeat({
      serviceEndpoint: stableEndpoint,
      sessionId,
      startLine,
      intervalMs: STREAM_OUTPUT_INTERVAL_MS,
      mode,
      purpose: "stream",
      token,
      onEvent: (event: StreamEvent) => {
        if (cancelled) return;
        if (event.type === "ready") {
          streamFailedRef.current = false;
          return;
        }
        if (event.type === "agent_output") {
          const hasVisibleTranscript = applyStreamOutput(event);
          if (hasVisibleTranscript) markLoaded();
          return;
        }
        if (event.type === "error" && event.sessionId === sessionId) {
          streamFailedRef.current = true;
          setLastError(event.error);
        }
      },
      onError: (error) => {
        if (cancelled) return;
        streamFailedRef.current = true;
        setLastError(getErrorMessage(error));
      },
    });

    void runFallbackPoll("initial");
    fallbackTimer = setInterval(() => {
      const now = Date.now();
      const lastStreamOutputAt = lastStreamOutputAtRef.current;
      const lastHttpOutputAt = lastHttpOutputAtRef.current;
      const needsFallback =
        streamFailedRef.current ||
        (lastStreamOutputAt === 0 && now - lastHttpOutputAt >= STREAM_RESYNC_MS) ||
        (lastStreamOutputAt > 0 && now - lastStreamOutputAt >= STREAM_RESYNC_MS);
      if (needsFallback) void runFallbackPoll(streamFailedRef.current ? "poll" : "stream");
    }, FALLBACK_POLL_MS);

    return () => {
      cancelled = true;
      streamHandle?.stop();
      if (fallbackTimer) clearInterval(fallbackTimer);
      if (initialTimeout) clearTimeout(initialTimeout);
    };
  }, [
    appVisible,
    applyStreamOutput,
    enabled,
    feedKey,
    mode,
    refreshOutputSnapshot,
    sessionId,
    setLastError,
    stableEndpoint,
    startLine,
    token,
  ]);

  const initialStatus = initialStatusState.key === feedKey ? initialStatusState.status : "idle";

  return { initialStatus, refreshOutputSnapshot };
}
