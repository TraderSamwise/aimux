import type { DesktopSession } from "@/lib/desktop-state";
import { type AppStatusKind, agentStatusKind } from "@/lib/status-tone";

export interface AgentState {
  label: string;
  kind: AppStatusKind;
  pill: boolean;
}

// Which families read as active. A pill is loud, so it is for work in flight
// and for an ask; a quiet word is for everything settled.
const PILL_KINDS = new Set<AppStatusKind>(["working", "needs", "error", "blocked"]);

// Server-side words arrive lowercase ("needs answer"); rows here are sentence
// case. Only the first letter, so "needs answer" does not become "Needs Answer"
// and diverge from the same word on every other surface.
function sentenceCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// What an agent row says about an agent, and in which tone.
//
// A lib rather than a helper beside the row: it is a pure function over the
// payload, and it is read by the cross-surface test that compares this answer
// against the project service's. Importing it from the component would have
// dragged fifteen React Native mocks into that test.
//
// The word is the project service's answer, read off the payload. The tone is
// still this surface's own mapping, and deliberately so -- see below.
//
// The word used to be derived here from `session.status`, reaching
// `status === "running" -> "Running"` without ever consulting `activity`. So an
// agent that had finished its turn and was sitting at an empty prompt read as
// "Running" while the service had already called it `ready`. The dot beside
// that word was correct the whole time, because `agentStatusKind` is the one
// thing here that does look at `activity` -- a word and a dot disagreeing
// inside one row.
//
// The precedence the old chain spelled out is not gone, it is upstream:
// `derive_session_semantics` puts a transient pending action ahead of
// attention, and attention ahead of the runtime status, which is the order the
// comment here used to claim to mirror.
//
// The tone is NOT taken from `semantic.user.label`, though that reads like the
// obvious next step. `runtime_lifecycle` only names `creating`, `starting`,
// `stopping` and `graveyarding`, so every other in-flight action -- renaming,
// moving, resurrecting -- falls through to `ready`. Mapping the tone from that
// label would paint a renaming agent as settled and undo the guarantee
// `transient-state.cross-surface.test.ts` exists to hold. `statusLabel` is
// unaffected because it prefers the pending action directly.
export function deriveAgentState(session: DesktopSession): AgentState {
  const kind = agentStatusKind(session);
  const served = session.semantic?.presentation?.statusLabel?.trim();
  // `exited` is the one distinction the shared word drops -- the service folds
  // it into `offline`, while the TUI row still says "Exited" -- so it is read
  // off the status rather than quietly renamed. Carrying it in the shared label
  // is the better fix and changes rendered TUI strings.
  //
  // `unknown` rather than a blank cell or a guess: the service attaches
  // `semantic` to every session unconditionally, so an absent word is a broken
  // payload and should be visible as one.
  const label = session.status === "exited" ? "Exited" : sentenceCase(served || "unknown");
  // A pending action stays a quiet word, as it was. It is already loud: the row
  // carries the action's own text, and the tone is the working cyan.
  return { label, kind, pill: !session.pendingAction && PILL_KINDS.has(kind) };
}
