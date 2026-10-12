import type { DesktopSession } from "@/lib/desktop-state";

/** What a goal's kind resolves to, after the fallbacks. */
export type AgentGoalKind = "agent" | "user" | "tokens";

type GoalSession = Pick<DesktopSession, "loop" | "tokenSpend">;

/**
 * Which kind a goal actually is, with the two fallbacks the Rust rule applies.
 *
 * An unknown word falls back CLOSED so a newer build's user-managed goal is
 * never shown as the agent's to end, and a token kind whose budget did not
 * survive is not a free-for-all either. Derived here once because the label,
 * the loops list and the agent panel's toggle all need the same answer.
 */
export function agentGoalKind(session: GoalSession): AgentGoalKind {
  const kind = session.loop?.goalKind ?? "agent";
  if (kind === "tokens") return agentGoalBudget(session) === null ? "user" : "tokens";
  return kind === "agent" ? "agent" : "user";
}

/** A budget only counts if it survived as a positive number. */
export function agentGoalBudget(session: GoalSession): number | null {
  const budget = session.loop?.tokenBudget;
  return typeof budget === "number" && budget > 0 ? budget : null;
}

/**
 * Whether handing the goal over is offered at all.
 *
 * Sam may hand a RUNNING goal either way -- the route takes it from him -- so
 * the only kind that declines is a token budget, because its kind is its
 * budget and relabelling it would silently discard the number.
 */
export function agentGoalKindIsChangeable(kind: AgentGoalKind): boolean {
  return kind !== "tokens";
}

/**
 * How a goal reads at a glance.
 *
 * A user-managed goal was previously indistinguishable from an agent-managed
 * one until a refusal arrived, which is exactly when it is least useful to
 * find out. Derived once here because the loops list and the agent panel both
 * show it, and a second copy of the rule would drift.
 */
export function agentGoalLabel(session: GoalSession): string {
  if (!session.loop?.active) return "Not in a loop";
  const goal = session.loop.goal?.trim();
  const kind = agentGoalKind(session);
  if (kind === "tokens") {
    const budget = agentGoalBudget(session) ?? 0;
    const spend = session.tokenSpend;
    const standing =
      typeof spend?.billed === "number"
        ? `${spend.billed.toLocaleString()} of ${budget.toLocaleString()} tokens`
        : // Said, not shown as zero: aider and shell report no usage at all.
          "spend not measured";
    return goal ? `${goal} — ${standing}` : standing;
  }
  const prefix = kind === "user" ? "Yours to close" : null;
  if (!goal) return prefix ? `${prefix}, no goal set` : "Watching without a goal";
  return prefix ? `${prefix}: ${goal}` : goal;
}
