import type { LinearTask, LinearTasksResponse } from "@/lib/api";

/**
 * What the Linear task panel should show.
 *
 * `notAsked` and `failed` are separate because they are different facts and a
 * person acts on each differently: nothing was configured, versus Linear was
 * asked and could not answer. Folding them into one "no tasks" would be the
 * worst of the three, since a project nobody is working on and a project
 * nobody could reach look identical.
 */
export type LinearTasksView =
  | { kind: "loading" }
  /** No Linear account, or no token. Nothing was asked, and this is why. */
  | { kind: "notAsked"; reason: string }
  /** Linear was asked and the ask failed. */
  | { kind: "failed"; reason: string }
  /** Linear answered. `tasks` may legitimately be empty. */
  | { kind: "tasks"; project?: string; tasks: LinearTask[]; problems: string[] };

export function linearTasksView(report: LinearTasksResponse | null): LinearTasksView {
  if (report == null) return { kind: "loading" };

  // `checked` is what separates "we did not look" from "we looked and it
  // failed", and the service sets it deliberately for exactly that reason.
  if (report.checked !== true) {
    return {
      kind: "notAsked",
      reason: report.reason ?? report.error ?? "Linear was not asked.",
    };
  }

  // Asked, and the whole ask failed. A per-issue problem is NOT this: those
  // arrive alongside real tasks and belong in the list below.
  if (report.tasks == null) {
    return {
      kind: "failed",
      reason: report.error ?? report.reason ?? "Linear could not be read.",
    };
  }

  return {
    kind: "tasks",
    ...(report.project == null ? {} : { project: report.project }),
    tasks: report.tasks,
    problems: report.problems ?? [],
  };
}

/**
 * The status to show for one task.
 *
 * Mirrors the service's rule rather than re-deriving it: an unrecognised
 * Linear state is SAID, never shown as `pending` and never left blank. A blank
 * reads as "nothing yet", which is the one thing it definitely does not mean.
 */
export function taskStatusLabel(task: LinearTask): string {
  if (task.status != null && task.status !== "") return task.status;
  const unknown = task.statusUnknown;
  if (unknown != null && unknown !== "") return `state unknown (${unknown})`;
  return "state unknown";
}

/** Who has it, or that nobody does. Both are real answers. */
export function taskAssigneeLabel(task: LinearTask): string {
  return task.assignee != null && task.assignee !== "" ? task.assignee : "unassigned";
}

/**
 * How many tasks somebody is actively working.
 *
 * Counts `accepted` only, which is what the service maps Linear's `started`
 * onto. A count that also included `pending` would answer a different question
 * than "is anything being worked on".
 */
export function activeTaskCount(tasks: LinearTask[]): number {
  return tasks.filter((task) => task.status === "accepted").length;
}
