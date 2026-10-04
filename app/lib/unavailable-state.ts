import type {
  DaemonProjectReadError,
  PreviewCaptureMarker,
  ProjectOperationFailure,
  TmuxLiveWindowQueryUnavailable,
  TmuxUnavailableMarker,
} from "../../src/project-api-contract";

export function formatOperationFailure(failure: ProjectOperationFailure): string {
  const title = stringField(failure.title) || stringField(failure.operation) || "operation failed";
  const message = stringField(failure.message);
  return [operationFailureTarget(failure), title, message].filter(Boolean).join(": ");
}

/// What the dashboard and the sidebar put on their failure card.
///
/// One failure gets its own title, because "Project state has an operation
/// failure" says nothing a person can act on while the sentence that does --
/// "Failed to graveyard worktree fix-chat" -- sat buried in the detail line.
/// The title the project service wrote already names its target, so repeating
/// it here produced the worktree's name three times in one card.
///
/// Several failures get a count and their titles, which is what the CLI's own
/// card lists. Both surfaces are reading one ledger; this is only how it reads.
export function operationFailureTitle(failure: ProjectOperationFailure): string {
  return stringField(failure.title) || stringField(failure.operation) || "Operation failed";
}

/// Which thing failed, as the project service derived it.
///
/// Not a chain of its own. This file held two different orders -- one reaching
/// for the path before the id, one after -- so a failed agent launch could be
/// measured by one and printed by the other, naming the repository in one place
/// and the agent in another. The service now puts a single `target` on the
/// record and both surfaces render that.
export function operationFailureTarget(failure: ProjectOperationFailure): string {
  return stringField(failure.target);
}

export function summarizeOperationFailures(
  failures: readonly ProjectOperationFailure[] | undefined,
): { title: string; detail: string } | null {
  const visible = failures?.filter((failure) => Boolean(formatOperationFailure(failure))) ?? [];
  if (visible.length === 0) return null;
  if (visible.length === 1) {
    const [failure] = visible;
    const title = operationFailureTitle(failure);
    const message = stringField(failure.message);
    // No `|| formatOperationFailure(..)` fallback. That fallback prepends the
    // target unconditionally, so a record whose title already names its target
    // and carries no message printed the name twice -- the exact doubling
    // `redundantTarget` exists to prevent. A title with nothing to add to it
    // gets an empty detail, which is the honest answer.
    return {
      title,
      detail: [redundantTarget(failure) ? "" : operationFailureTarget(failure), message]
        .filter(Boolean)
        .join(": "),
    };
  }
  return {
    title: `Project state has ${visible.length} operation failures`,
    detail: visible.slice(0, 3).map(operationFailureRow).join(" · "),
  };
}

export function formatDaemonProjectReadError(error: DaemonProjectReadError): string {
  if (typeof error === "string") return error;
  const project =
    stringField(error.projectName) || stringField(error.projectRoot) || stringField(error.root);
  const machine = stringField(error.machineName);
  const message = stringField(error.error) || stringField(error.message) || "project read failed";
  const subject = project && machine ? `${project} on ${machine}` : project || machine;
  return subject ? `${subject}: ${message}` : message;
}

export function formatTmuxUnavailable(
  marker: TmuxUnavailableMarker | TmuxLiveWindowQueryUnavailable | undefined,
  fallback = "tmux unavailable",
): string | null {
  if (!marker) return null;
  return stringField(marker.error) || stringField(marker.message) || fallback;
}

export function formatPreviewCaptureUnavailable(
  marker: PreviewCaptureMarker | undefined,
): string | null {
  if (!marker) return null;
  return marker.error ? `Could not read pane: ${marker.error}` : "Could not read pane";
}

/// One row of the multi-failure card, matching what the CLI card puts on a row.
///
/// The CLI lists `title · target` for every row; this listed titles alone, so
/// three failed graveyards read as the same sentence three times with nothing
/// saying which worktrees they were. Reverting the single-failure path to its
/// old format passed the cross-surface test, which is how that stayed hidden.
export function operationFailureRow(failure: ProjectOperationFailure): string {
  const title = operationFailureTitle(failure);
  if (redundantTarget(failure)) return title;
  const target = operationFailureTarget(failure);
  return target ? `${title} · ${target}` : title;
}

/// Whether the title already names the target, so repeating it would read as
/// the worktree's name twice in one line.
///
/// An absent target is not a named one. The previous `title.includes(target)`
/// said it was, because `includes("")` is true -- a record with nothing to name
/// took the right branch for the wrong reason.
function redundantTarget(failure: ProjectOperationFailure): boolean {
  const target = operationFailureTarget(failure);
  return target.length > 0 && operationFailureTitle(failure).includes(target);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
