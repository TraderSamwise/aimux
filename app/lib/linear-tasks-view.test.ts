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
    expect(taskStatusLabel({ id: "a", status: "accepted" })).toBe("accepted");
  });

  it("says nobody has it rather than leaving a gap", () => {
    expect(taskAssigneeLabel({ id: "a" })).toBe("unassigned");
    expect(taskAssigneeLabel({ id: "a", assignee: "" })).toBe("unassigned");
    expect(taskAssigneeLabel({ id: "a", assignee: "Sam S." })).toBe("Sam S.");
  });

  /**
   * "Is anything being worked on" counts `accepted` only. Including `pending`
   * would answer a different question, and an unknown state is not evidence
   * of work either.
   */
  it("counts only the tasks somebody is actually working", () => {
    const tasks = [
      { id: "a", status: "accepted" },
      { id: "b", status: "accepted" },
      { id: "c", status: "pending" },
      { id: "d", status: "completed" },
      { id: "e", statusUnknown: "somethingNew" },
    ];
    expect(activeTaskCount(tasks)).toBe(2);
    expect(activeTaskCount([])).toBe(0);
  });
});
