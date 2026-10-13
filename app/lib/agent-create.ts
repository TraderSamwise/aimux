import type { WorktreeBucket } from "@/lib/desktop-state";

/**
 * What creating a worktree or an agent means, derived once.
 *
 * The Project screen's two panels each had their own copy of these rules, and
 * the sidebar is about to become a third caller. A rule that lives next to one
 * renderer agrees with the others only by luck.
 */

/**
 * The runtimes an agent can be launched as.
 *
 * KNOWN INCOMPLETE. Tools are configured per project -- each with an `enabled`
 * flag, and custom ones are allowed -- and the TUI builds its picker from that
 * config. The app cannot: the project service exposes no route that lists
 * them. So this offers the three built-ins, which means a disabled tool is
 * still offered and a custom one is not. Having the wrong list in one place is
 * what makes it one fix rather than three; the fix is a tools route, and it is
 * not in this change.
 */
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
 * The worktrees that can be removed.
 *
 * A different rule from `creatableWorktreeChoices`, not the same one with a
 * filter on top: removal additionally requires the worktree to be empty, and
 * it deliberately KEEPS one whose directory is gone -- that is a worktree you
 * particularly want to be able to remove, while it is the last place you can
 * launch an agent into.
 */
export function removableWorktreeChoices(groups: WorktreeBucket[]): AgentWorktreeChoice[] {
  return groups
    .filter(
      (group) =>
        !group.isMainCheckout &&
        !group.isSupervisorLane &&
        !group.pending &&
        !group.removing &&
        group.sessions.length === 0 &&
        group.services.length === 0 &&
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
 * What spawning an agent changed, so every list showing it refreshes.
 *
 * An agent moves the agent list, the topology, the team and the coordination
 * worklist as well as the worktree it landed in; refreshing only what the
 * caller happens to be looking at leaves the other surfaces stale until
 * something else kicks them.
 */
export const AGENT_CREATION_REFRESH_VIEWS: readonly string[] = [
  "agents",
  "project-observability",
  "topology",
  "coordination-worklist",
  "team",
  "worktrees",
];

/**
 * What creating a worktree changed. A different set, not the same one: a
 * worktree shows up in the library and graveyard views and touches no agent,
 * team or coordination state. Sending the agent list for both is how the
 * sidebar and the Project screen started to disagree about what to refresh.
 */
export const WORKTREE_CREATION_REFRESH_VIEWS: readonly string[] = [
  "worktrees",
  "project-observability",
  "topology",
  "library",
  "graveyard",
];

/**
 * Whether the create button does anything yet.
 *
 * Kept out of the dialog so the one decision that can waste a request, or
 * send a blank name the route will refuse, is testable without a renderer.
 * An agent needs no name -- its tool and worktree both have defaults -- so
 * only a worktree creation waits on typing.
 */
export function canSubmitCreation(input: {
  kind: "agent" | "worktree";
  hasEndpoint: boolean;
  busy: boolean;
  name: string;
}): boolean {
  if (!input.hasEndpoint || input.busy) return false;
  return input.kind === "agent" || worktreeNameIsCreatable(input.name);
}
