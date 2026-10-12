import type { DesktopSession } from "@/lib/desktop-state";

/**
 * How a goal reads at a glance.
 *
 * A user-managed goal was previously indistinguishable from an agent-managed
 * one until a refusal arrived, which is exactly when it is least useful to
 * find out. Derived once here because the loops list and the agent panel both
 * show it, and a second copy of the rule would drift.
 */
export function agentGoalLabel(session: Pick<DesktopSession, "loop" | "tokenSpend">): string {
  const loop = session.loop;
  if (!loop?.active) return "Not in a loop";
  const goal = loop.goal?.trim();
  const kind = loop.goalKind ?? "agent";
  if (kind === "tokens") {
    const budget = loop.tokenBudget;
    const spend = session.tokenSpend;
    const standing =
      typeof spend?.billed === "number" && typeof budget === "number"
        ? `${spend.billed.toLocaleString()} of ${budget.toLocaleString()} tokens`
        : // Said, not shown as zero: aider and shell report no usage at all.
          "spend not measured";
    return goal ? `${goal} — ${standing}` : standing;
  }
  // Only the kind that changes what the reader can do is called out.
  const prefix = kind === "user" ? "Yours to close" : null;
  if (!goal) return prefix ? `${prefix}, no goal set` : "Watching without a goal";
  return prefix ? `${prefix}: ${goal}` : goal;
}
