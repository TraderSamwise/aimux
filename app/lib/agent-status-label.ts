import type { DesktopSession } from "@/lib/desktop-state";
import {
  type AppStatusKind,
  normalizeAppStatusKind,
  pendingActionLabel,
  pendingActionStatusKind,
} from "@/lib/status-tone";

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
// payload, and it is read by the cross-surface tests that compare this answer
// against the project service's. Importing it from the component would have
// dragged fifteen React Native mocks into those tests.
//
// Both the word and the tone are the project service's answer. The word is
// `presentation.statusLabel`; the tone is `user.label` put through the app's
// own palette mapping. This row used to derive both from `session.status`, and
// reached `status === "running" -> "Running"` without consulting `activity`, so
// an agent that had finished its turn and was sitting at an empty prompt read
// as "Running" while the service had already called it `ready`.
//
// A pending action is answered before either, and that order is the whole
// reason this is not simply `user.label` for both. `runtime_lifecycle` names
// only `creating`, `starting`, `stopping` and `graveyarding`, so every other
// in-flight action -- renaming, moving, resurrecting -- falls through to
// `ready`, and a renaming agent would be toned as settled. `statusLabel` is
// unaffected because it prefers the pending action directly, which is why the
// word needs no such guard and the tone does.
//
// Taking the tone from `user.label` rather than from the raw fields is what
// fixes two states where the word and the dot disagreed: `status: "waiting"`
// (the daemon starting an agent, which the service calls `working`) and an idle
// agent with a task still assigned (`next_step`, an ask, which no combination
// of status, activity and attention can see).
export function deriveAgentState(session: DesktopSession): AgentState {
  // An action in flight is answered from the action, word and tone both, and
  // not from the payload. It is the one fact the client knows first: the
  // optimistic overlay in `stores/lifecycleTransitions.ts` pushes a brand-new
  // session with a `pendingAction` and NO `semantic` at all, and spreads an
  // existing one keeping the `semantic` it had before the action started. An
  // earlier revision took only the tone from here and left the word to
  // `statusLabel`, so creating an agent read "Unknown" and renaming one read
  // "Ready" while it was being renamed.
  const action = session.pendingAction?.trim();
  if (action) {
    // Quiet, as it was. The word is already the loud part.
    return { label: pendingActionLabel(action), kind: pendingActionStatusKind(), pill: false };
  }

  const kind = normalizeAppStatusKind(session.semantic?.user?.label) ?? "offline";
  const served = session.semantic?.presentation?.statusLabel?.trim();
  // No carve-out for `exited`. An earlier revision had one, on the theory that
  // the service folds `exited` into `offline` while the TUI row says "Exited" --
  // but `dashboard_session_status` only ever emits `running`, `idle`, `waiting`
  // or `offline` for a session. `exited` comes from `dashboard_service_status`,
  // and services do not come through here. The branch could not fire, and its
  // comment claimed a divergence that does not exist.
  //
  // `unknown` rather than a blank cell or a guess: the service attaches
  // `semantic` to every session unconditionally, so an absent word is a broken
  // payload and should be visible as one.
  const label = sentenceCase(served || "unknown");
  return { label, kind, pill: PILL_KINDS.has(kind) };
}

/// The service's word for a session, lowercase as it arrives.
///
/// For a surface that wants the word inline rather than as a row's status
/// cell -- a feed subtitle, a loop list line. `session.status` is the process
/// state, not the agent's, and reading it is how "running" ended up beside an
/// agent that had finished its turn.
export function servedStatusWord(session: DesktopSession): string {
  // The action first, for the same reason the row answers it first: an
  // optimistically created session has a `pendingAction` and no `semantic`, and
  // "unknown" in a feed subtitle is worse than the word for what is happening.
  //
  // Lowercased, because `pendingActionLabel` is Title case and this function's
  // callers put it in the same column as the served word -- the loops list read
  // "wt · ready" above "wt · Renaming".
  const action = session.pendingAction?.trim();
  if (action) return pendingActionLabel(action).toLowerCase();
  return session.semantic?.presentation?.statusLabel?.trim() || "unknown";
}
