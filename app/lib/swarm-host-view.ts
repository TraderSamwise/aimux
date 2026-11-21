import type { SwarmHostResponse } from "@/lib/api";

/**
 * What the swarm host panel should show.
 *
 * Four outcomes, and `unclaimed` is the one that must not be confused with
 * `unreadable`: an unreadable pin may already name a machine, so telling
 * somebody nobody holds it invites the second swarm overseer the daemon
 * refuses to start. Two of them would each be talking to the same overseers
 * with nothing able to tell whose instruction was whose.
 */
export type SwarmHostView =
  | { kind: "unreadable"; reason: string }
  | { kind: "loading" }
  | { kind: "here" }
  | { kind: "elsewhere"; host: string }
  | { kind: "unclaimed" };

export function swarmHostView(report: SwarmHostResponse | null): SwarmHostView {
  if (report == null) return { kind: "loading" };
  if (report.ok !== true) {
    return {
      kind: "unreadable",
      reason: report.error ?? "The swarm host could not be read.",
    };
  }
  // `thisMachine` is read BEFORE `host`, because the route sends a null host
  // for the machine that holds the pin -- naming itself would be redundant.
  // `thisMachine` is read FIRST, and that ordering is load-bearing even though
  // the route does not currently exercise it: it sends a null host for the
  // machine that holds the pin, so today either order gives the same answer.
  // A report that named the host AND said it was this machine would be
  // "elsewhere" under the other order, which is the one thing it certainly is
  // not -- so the order is fixed here and gated, rather than left to depend on
  // the route never changing.
  if (report.thisMachine === true) return { kind: "here" };
  const host = report.host;
  if (typeof host === "string" && host.length > 0) return { kind: "elsewhere", host };
  return { kind: "unclaimed" };
}

/** Whether this machine may claim the pin by starting a swarm overseer. */
export function canClaimSwarmHost(view: SwarmHostView): boolean {
  // Only from `unclaimed`. `elsewhere` would be a second overseer, and
  // `unreadable` might be one too -- the daemon refuses both, and offering a
  // button that is going to be refused is worse than not offering it.
  return view.kind === "unclaimed";
}
