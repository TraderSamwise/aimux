/**
 * Which agent to reopen when the app comes back, if any.
 *
 * The project is already remembered -- `selectedProjectKeyAtom` is durable --
 * so opening the app lands on the right checkout and then stops, at a list,
 * with no way to know which agent you were reading. This decides that last
 * step.
 *
 * It is a decision rather than an effect because of the one way it can be
 * wrong: reopening the agent EVERY time the project screen mounts would throw
 * the user back into the chat they just backed out of. It may happen once per
 * launch, which is what `alreadyReopened` is.
 */
export interface ReopenLastAgentInput {
  /** The session id remembered for the project now open, if there is one. */
  remembered: string | null | undefined;
  /** The agents the project service currently lists. */
  listedSessionIds: readonly string[];
  /** Whether this launch has already had its one reopen. */
  alreadyReopened: boolean;
  /** An agent the user has named in the URL outranks anything remembered. */
  routeSessionId?: string | null;
}

export function lastAgentToReopen(input: ReopenLastAgentInput): string | null {
  // A route the user arrived on is their own answer -- a notification tap, a
  // shared link, a deep link -- and nothing remembered may redirect it.
  if (input.routeSessionId) return null;
  if (input.alreadyReopened) return null;
  const remembered = input.remembered?.trim();
  if (!remembered) return null;
  // An agent that is gone is not somewhere to send anyone: the chat would open
  // on "Agent unavailable", which is a worse first screen than the list.
  if (!input.listedSessionIds.includes(remembered)) return null;
  return remembered;
}

/**
 * The remembered agent for one project.
 *
 * Keyed by project, because reopening project B into project A's agent is
 * worse than not reopening at all -- and Sam has the same checkout on two
 * machines, which is why the key is a project key rather than a path.
 */
export function rememberedAgentForProject(
  memory: Readonly<Record<string, string>>,
  projectKey: string | null | undefined,
): string | null {
  if (!projectKey) return null;
  return memory[projectKey]?.trim() || null;
}

/**
 * The memory after a selection.
 *
 * Only a real selection is recorded. The transient selection is cleared to
 * `null` whenever the open project changes, and forgetting the agent at that
 * moment would defeat the whole point: the next launch is exactly when the
 * memory is read.
 */
export function rememberAgentForProject(
  memory: Readonly<Record<string, string>>,
  projectKey: string | null | undefined,
  sessionId: string | null | undefined,
): Record<string, string> {
  const id = sessionId?.trim();
  if (!projectKey || !id) return memory as Record<string, string>;
  if (memory[projectKey] === id) return memory as Record<string, string>;
  return { ...memory, [projectKey]: id };
}

/**
 * Whether this launch has had its one reopen.
 *
 * Module state rather than a store atom, deliberately: it must NOT survive a
 * relaunch, and it must not be something a screen can forget to reset. A cold
 * start gets a fresh module.
 */
let reopened = false;

export function reopenedLastAgentThisLaunch(): boolean {
  return reopened;
}

export function markLastAgentReopened(): void {
  reopened = true;
}

/** Tests only: a launch is a fresh module everywhere else. */
export function resetLastAgentReopenedForTest(): void {
  reopened = false;
}
