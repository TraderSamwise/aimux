import { describe, expect, it } from "vitest";
import { machineTargets, selectableMachines } from "@/lib/machine-targets";

describe("which machines a per-machine control may address", () => {
  it("is loading until a report arrives", () => {
    expect(machineTargets(null)).toEqual({ kind: "loading" });
  });

  /**
   * ABSENT IS NOT EMPTY, and this is the distinction the helper exists for.
   * No `machines` key means this machine could not find out which machines
   * exist; an empty array means the relay said there are none. Collapsing them
   * would show a one-machine fleet to somebody whose fleet is unreachable.
   */
  it("keeps an unknown fleet apart from an empty one", () => {
    const unknown = machineTargets({ ok: false, error: "the relay is down" });
    expect(unknown).toEqual({ kind: "unknown", reason: "the relay is down" });

    const empty = machineTargets({ ok: true, machines: [] });
    expect(empty).toEqual({ kind: "known", targets: [] });
  });

  it("falls back to its own sentence when the report gave no reason", () => {
    const unknown = machineTargets({ ok: false });
    expect(unknown.kind).toBe("unknown");
    if (unknown.kind !== "unknown") throw new Error("expected unknown");
    expect(unknown.reason).toContain("could not find out");
  });

  /**
   * A FAILED MACHINE IS LISTED AND NOT SELECTABLE. Hiding it would make the
   * fleet look smaller than it is — the fleet report's own rule is that every
   * machine stays in it — but offering a control the relay will refuse is
   * worse than offering none, so it is shown with the reason it gave.
   */
  it("lists a machine that did not answer but will not let a control address it", () => {
    const targets = machineTargets({
      ok: true,
      machines: [
        { machineId: "mbp", ok: true },
        { machineId: "mini", ok: false, error: "relay timeout" },
      ],
    });
    expect(targets).toEqual({
      kind: "known",
      targets: [
        { machineId: "mbp", reachable: true },
        { machineId: "mini", reachable: false, reason: "relay timeout" },
      ],
    });
    expect(selectableMachines(targets).map((target) => target.machineId)).toEqual(["mbp"]);
  });

  /** A machine with no error still says why, from its status. */
  it("describes a silent machine by its status", () => {
    const targets = machineTargets({
      ok: true,
      machines: [
        { machineId: "a", ok: false, status: 503 },
        { machineId: "b", ok: false },
      ],
    });
    if (targets.kind !== "known") throw new Error("expected known");
    expect(targets.targets[0].reason).toBe("answered 503");
    expect(targets.targets[1].reason).toBe("no answer");
  });

  /**
   * A MISSING `ok` MUST NOT READ AS REACHABLE. A machine that never reported
   * is not a machine that reported success, and a truthy check would let a
   * control address one that cannot answer.
   */
  it("treats a machine with no ok field as unreachable", () => {
    const targets = machineTargets({
      ok: true,
      machines: [{ machineId: "ghost" } as never],
    });
    if (targets.kind !== "known") throw new Error("expected known");
    expect(targets.targets[0].reachable).toBe(false);
    expect(selectableMachines(targets)).toEqual([]);
  });

  it("offers nothing to act on while loading or unknown", () => {
    expect(selectableMachines({ kind: "loading" })).toEqual([]);
    expect(selectableMachines({ kind: "unknown", reason: "x" })).toEqual([]);
  });
});
