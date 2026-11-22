import { describe, expect, it } from "vitest";
import {
  activeTaskCount,
  linearTasksView,
  taskAssigneeLabel,
  taskStatusLabel,
} from "@/lib/linear-tasks-view";

describe("the Linear task panel's view", () => {
  it("is loading until a report arrives", () => {
    expect(linearTasksView(null)).toEqual({ kind: "loading" });
  });

  /**
   * THE DISTINCTION THE VIEW EXISTS FOR. "We did not look" and "we looked and
   * it failed" are different facts a person acts on differently, and folding
   * either into "no tasks" is the worst outcome: a project nobody is working
   * on and a project nobody could reach would look identical.
   */
  it("keeps not-asked apart from a failed ask and from an empty project", () => {
    const notAsked = linearTasksView({
      ok: false,
      checked: false,
      reason: "No Linear project is configured.",
    });
    expect(notAsked).toEqual({
      kind: "notAsked",
      reason: "No Linear project is configured.",
    });

    const failed = linearTasksView({ ok: false, checked: true, error: "Linear returned 503" });
    expect(failed).toEqual({ kind: "failed", reason: "Linear returned 503" });

    const empty = linearTasksView({ ok: true, checked: true, project: "Aimux", tasks: [] });
    expect(empty).toEqual({ kind: "tasks", project: "Aimux", tasks: [], problems: [] });
  });

  it("explains itself when the report gave no reason", () => {
    const notAsked = linearTasksView({ ok: false, checked: false });
    if (notAsked.kind !== "notAsked") throw new Error("expected notAsked");
    expect(notAsked.reason).toBe("Linear was not asked.");

    const failed = linearTasksView({ ok: false, checked: true });
    if (failed.kind !== "failed") throw new Error("expected failed");
    expect(failed.reason).toBe("Linear could not be read.");
  });

  /**
   * A PER-ISSUE PROBLEM IS NOT A FAILED ASK. Those arrive beside real tasks,
   * so the panel must still show the work — the service deliberately reports
   * both rather than discarding either.
   */
  it("shows tasks even when some issues could not be described", () => {
    const view = linearTasksView({
      ok: false,
      checked: true,
      project: "Aimux",
      tasks: [{ id: "a", identifier: "AIM-1", status: "pending" }],
      problems: ["Linear issue AIM-2 arrived with no title"],
    });
    expect(view.kind).toBe("tasks");
    if (view.kind !== "tasks") throw new Error("expected tasks");
    expect(view.tasks).toHaveLength(1);
    expect(view.problems).toEqual(["Linear issue AIM-2 arrived with no title"]);
  });

  /**
   * THE RENDERER'S HALF OF THE UNKNOWN-STATE RULE, which the service refuses
   * to guess. A blank here reads as "nothing yet", which is the one thing an
   * unrecognised state definitely does not mean.
   */
  it("says an unknown state out loud and never shows it as pending or blank", () => {
    expect(taskStatusLabel({ id: "a", statusUnknown: "somethingNew" })).toBe(
      "state unknown (somethingNew)",
    );
    expect(taskStatusLabel({ id: "a", statusUnknown: "" })).toBe("state unknown");
    expect(taskStatusLabel({ id: "a" })).toBe("state unknown");
    // And a real status is shown as itself.
    expect(taskStatusLabel({ id: "a", status: "in_progress" })).toBe("in_progress");
  });

  it("says nobody has it rather than leaving a gap", () => {
    expect(taskAssigneeLabel({ id: "a" })).toBe("unassigned");
    expect(taskAssigneeLabel({ id: "a", assignee: "" })).toBe("unassigned");
    expect(taskAssigneeLabel({ id: "a", assignee: "Sam S." })).toBe("Sam S.");
  });

  /**
   * "Is anything being worked on" counts `in_progress` only. Including
   * `pending` would answer a different question, and an unknown state is not
   * evidence of work either.
   *
   * THE WORD MATTERS AND IT WAS WRONG. This counted `accepted`, which neither
   * the local task engine nor the Linear mapper has ever produced -- the
   * engine writes `in_progress` from `route_task_accept`. A count keyed on a
   * word nothing emits is silently always zero.
   */
  /**
   * THE GATE THAT WOULD HAVE CAUGHT IT. Every status word this view treats
   * specially has to be one the service actually emits, and the service's
   * words come from the task routes: `pending`, `in_progress`, `blocked`,
   * `done`, `canceled`. A count keyed on anything else is dead code that
   * reads as a real answer -- silently always zero.
   */
  it("only treats status words the task routes actually write as meaningful", () => {
    const taskStatuses = ["pending", "in_progress", "blocked", "done", "canceled"];
    // The word the count keys on must be one of them, and must actually
    // count -- which is what proves the key is live rather than merely
    // present in the list.
    expect(taskStatuses).toContain("in_progress");
    expect(activeTaskCount([{ id: "a", status: "in_progress" }])).toBe(1);
    // And every real word renders as itself, so none reads as unknown.
    for (const status of taskStatuses) {
      expect(taskStatusLabel({ id: "a", status })).toBe(status);
    }
  });

  it("counts only the tasks somebody is actually working", () => {
    // `in_progress` and `done`, which are the words the task routes write --
    // not `accepted` and `completed`, which this test used before and which
    // neither the local engine nor the Linear mapper ever produces.
    const tasks = [
      { id: "a", status: "in_progress" },
      { id: "b", status: "in_progress" },
      { id: "c", status: "pending" },
      { id: "d", status: "done" },
      { id: "e", statusUnknown: "somethingNew" },
    ];
    expect(activeTaskCount(tasks)).toBe(2);
    expect(activeTaskCount([])).toBe(0);
  });
});
