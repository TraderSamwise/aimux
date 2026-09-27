import type { ServiceEndpoint } from "@/lib/daemon-url";

export interface SessionViewedMarkContext {
  sessionId?: string | null;
  endpoint: ServiceEndpoint | null;
  token?: string | null;
  // A shared receiver is a guest in someone else's project and must not clear
  // the owner's unread state.
  sharedView: boolean;
}

export interface SessionViewedMark {
  // One key per (session, endpoint, token). Entering the same agent again with
  // the same context is the same view and must not re-post; switching agents,
  // reconnecting to a different service, or signing in again is a new one.
  key: string;
  sessionId: string;
}

const SEPARATOR = "\u0000";

// Returns null when there is nothing to mark, so a caller cannot post an empty
// session id or write into a project it is only a guest in.
export function sessionViewedMark(context: SessionViewedMarkContext): SessionViewedMark | null {
  const sessionId = context.sessionId?.trim();
  if (!sessionId || context.sharedView || !context.endpoint) return null;
  return {
    key: [
      sessionId,
      context.endpoint.host,
      String(context.endpoint.port),
      context.token ?? "",
    ].join(SEPARATOR),
    sessionId,
  };
}
