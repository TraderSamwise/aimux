import type { AgentActivityState } from "@/lib/events";

/**
 * What to say a session is doing, one line, or nothing.
 *
 * The tool's own words are better than ours — "Jitterbugging… (2m 23s)" says
 * what is happening and for how long, where "Working…" only repeats what the
 * spinner already implied. But they are only better while a turn is actually
 * running: the pane keeps its last spinner frame painted after the turn ends, so
 * a pane sitting on an approval prompt still reads "Brewing…" when the thing the
 * operator needs to see is that it is waiting on them.
 *
 * Hence the enum decides, and the text only fills in the running case. An
 * unreported activity yields nothing at all rather than a guess, because absence
 * means the service does not report it — not that the agent is idle.
 */
export function agentActivityLabel(
  activity: AgentActivityState | undefined,
  activityText: string,
): string | null {
  switch (activity) {
    case "running":
      return activityText || "Working…";
    case "waiting":
      return "Waiting for input";
    case "error":
      return "Stopped on an error";
    case "interrupted":
      return "Interrupted";
    default:
      return null;
  }
}

export function shouldShimmerAgentActivityLabel(
  activity: AgentActivityState | undefined,
  label: string | null,
): boolean {
  return activity === "running" && Boolean(label);
}
