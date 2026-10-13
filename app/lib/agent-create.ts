import type { WorktreeBucket } from "@/lib/desktop-state";

/**
 * What creating a worktree or an agent means, derived once.
 *
 * The Project screen's two panels each had their own copy of these rules, and
 * the sidebar is about to become a third caller. A rule that lives next to one
 * renderer agrees with the others only by luck.
 */

/** The runtimes an agent can be launched as. */
export const AGENT_TOOL_CHOICES = ["claude", "codex", "aider"] as const;

export type AgentToolChoice = (typeof AGENT_TOOL_CHOICES)[number];

/** A worktree an agent can be launched into. */
export interface AgentWorktreeChoice {
  key: string;
  label: string;
  path: string;
}

/**
 * The worktrees that can host a new agent.
 *
 * The main checkout is excluded because it is offered separately, as its own
 * choice. The rest are excluded because launching into them cannot work:
 * `isSupervisorLane` is a synthetic bucket rather than a checkout,
 * `pathMissing` is a worktree whose directory is gone, and `pending` or
 * `removing` is one mid-flight in either direction.
 */
export function creatableWorktreeChoices(groups: WorktreeBucket[]): AgentWorktreeChoice[] {
  return groups
    .filter(
      (group) =>
        !group.isMainCheckout &&
        !group.isSupervisorLane &&
        !group.pathMissing &&
        !group.pending &&
        !group.removing &&
        Boolean(group.path),
    )
    .map((group) => ({ key: group.key, label: group.name, path: group.path as string }));
}

/**
 * Whether a path is still one of the choices.
 *
 * A worktree can be removed while a form sits open, and sending its path would
 * launch into something that is no longer there. `null` means the main
 * checkout, which is always a choice.
 */
export function isSelectableWorktreePath(
  choices: AgentWorktreeChoice[],
  path: string | null,
): boolean {
  return path === null || choices.some((choice) => choice.path === path);
}

/**
 * Whether the route will accept this as a worktree name.
 *
 * The client half of `name is required`: the route trims and refuses an empty
 * name. Git decides the rest at create time, and its complaint is better than
 * a guess made here about what it will accept.
 */
export function worktreeNameIsCreatable(name: string): boolean {
  return name.trim().length > 0;
}

/**
 * What a creation changed, so every list showing it refreshes.
 *
 * Spawning an agent moves the agent list, the topology, the team and the
 * coordination worklist as well as the worktree it landed in; a creation that
 * refreshes only what the caller happens to be looking at leaves the other
 * surfaces stale until something else kicks them.
 */
export const CREATION_REFRESH_VIEWS: readonly string[] = [
  "agents",
  "project-observability",
  "topology",
  "coordination-worklist",
  "team",
  "worktrees",
];
