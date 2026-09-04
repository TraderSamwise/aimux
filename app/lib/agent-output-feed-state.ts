export type InitialAgentOutputFeedStatus = "idle" | "loading" | "timed-out";

export type InitialAgentOutputFeedState = {
  key: string;
  status: InitialAgentOutputFeedStatus;
};

export function initialAgentOutputFeedLoadedState(
  current: InitialAgentOutputFeedState,
  key: string,
): InitialAgentOutputFeedState {
  return current.key === key ? { key, status: "idle" } : current;
}

export function initialAgentOutputFeedTimedOutState(
  current: InitialAgentOutputFeedState,
  key: string,
): InitialAgentOutputFeedState {
  return current.key === key && current.status === "loading"
    ? { key, status: "timed-out" }
    : current;
}
