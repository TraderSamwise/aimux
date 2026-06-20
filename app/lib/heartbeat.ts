// EventSource client for the per-project metadata server's /events stream.
//
// The polyfill (event-source-polyfill) handles transport reconnection internally —
// we don't layer manual retry on top. We only intervene on permanent failures
// (e.g., non-retriable 4xx) by stopping reconnects and surfacing via onError.

import { EventSourcePolyfill } from "event-source-polyfill";
import { getServiceUrl, type ServiceEndpoint } from "@/lib/daemon-url";
import { PROJECT_API_EVENT_NAMES, PROJECT_API_ROUTES } from "../../src/project-api-contract";
import type {
  AgentOutputEvent,
  AlertEvent,
  ReadyEvent,
  ProjectUpdateEvent,
  StreamErrorEvent,
  StreamEvent,
} from "@/lib/events";

export interface HeartbeatOptions {
  serviceEndpoint: ServiceEndpoint;
  sessionId: string | null;
  startLine?: number;
  intervalMs?: number;
  token?: string | null;
  onEvent: (event: StreamEvent) => void;
  onError?: (error: Error) => void;
}

export interface HeartbeatHandle {
  stop: () => void;
}

const SSE_EVENT_NAMES = [
  PROJECT_API_EVENT_NAMES.ready,
  PROJECT_API_EVENT_NAMES.alert,
  PROJECT_API_EVENT_NAMES.agentOutput,
  PROJECT_API_EVENT_NAMES.projectUpdate,
  PROJECT_API_EVENT_NAMES.error,
] as const;

export function startHeartbeat(options: HeartbeatOptions): HeartbeatHandle {
  const { serviceEndpoint, sessionId, startLine, intervalMs, token, onEvent, onError } = options;

  const params = new URLSearchParams();
  if (sessionId) params.set("sessionId", sessionId);
  if (startLine !== undefined) params.set("startLine", String(startLine));
  if (intervalMs !== undefined) params.set("intervalMs", String(intervalMs));
  const qs = params.toString();
  const url = `${getServiceUrl(serviceEndpoint)}${PROJECT_API_ROUTES.events}${qs ? `?${qs}` : ""}`;

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  // heartbeatTimeout: how long we tolerate silence on the wire before the polyfill
  // tears down and reconnects. Server sends `: keepalive\n\n` every 15s; pick 30s.
  const es = new EventSourcePolyfill(url, {
    headers,
    heartbeatTimeout: 30_000,
    withCredentials: false,
  });

  let stopped = false;

  function dispatch(name: string, ev: MessageEvent) {
    if (stopped) return;
    let payload: unknown;
    try {
      payload = JSON.parse(ev.data);
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    // Synthesize the typed event with `type: <name>` field.
    const typed = { ...(payload as object), type: name } as StreamEvent;
    onEvent(typed);
  }

  // event-source-polyfill's typed addEventListener accepts only the built-in EventSource
  // event names; cast to bypass that restriction so we can listen to custom events.
  // bind(es) is required because the polyfill's addEventListener uses `this._listeners`
  // internally — calling the bare function reference loses the EventSource instance.
  const addListener = es.addEventListener.bind(es) as unknown as (
    name: string,
    handler: (ev: MessageEvent) => void,
  ) => void;
  for (const name of SSE_EVENT_NAMES) {
    addListener(name, (ev) => dispatch(name, ev));
  }

  es.onerror = (event) => {
    if (stopped) return;
    // The polyfill auto-reconnects on connection errors. We only surface
    // permanent failures (HTTP errors with a status set on the event by the
    // polyfill) so the caller can decide whether to give up.
    const status = (event as unknown as { status?: number }).status;
    if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) {
      es.close();
      stopped = true;
      onError?.(new Error(`heartbeat request failed (status ${status})`));
    }
    // For transient failures, let the polyfill keep trying.
  };

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      es.close();
    },
  };
}

// Re-exports so callers can type-narrow without importing from events directly.
export type { AgentOutputEvent, AlertEvent, ReadyEvent, ProjectUpdateEvent, StreamErrorEvent, StreamEvent };
