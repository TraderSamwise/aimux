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
  const target =
    stringField(failure.worktreeName) ||
    stringField(failure.worktreePath) ||
    stringField(failure.targetId);
  return [target, title, message].filter(Boolean).join(": ");
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

/// Which thing failed, by the same chain the CLI card uses.
///
/// Derived rather than assumed out of the title. Most titles the project
/// service writes happen to name their target, but not all: a failed agent
/// launch writes "Failed to create codex agent" with no worktree name and the
/// session id as the target, and reading it out of the title would have shown
/// the CLI a target and the app nothing.
export function operationFailureTarget(failure: ProjectOperationFailure): string {
  return (
    stringField(failure.worktreeName) ||
    stringField(failure.targetId) ||
    stringField(failure.worktreePath)
  );
}

export function summarizeOperationFailures(
  failures: readonly ProjectOperationFailure[] | undefined,
): { title: string; detail: string } | null {
  const visible = failures?.filter((failure) => Boolean(formatOperationFailure(failure))) ?? [];
  if (visible.length === 0) return null;
  if (visible.length === 1) {
    const [failure] = visible;
    const title = operationFailureTitle(failure);
    const target = operationFailureTarget(failure);
    const message = stringField(failure.message);
    return {
      title,
      detail:
        [title.includes(target) ? "" : target, message].filter(Boolean).join(": ") ||
        formatOperationFailure(failure),
    };
  }
  return {
    title: `Project state has ${visible.length} operation failures`,
    detail: visible.slice(0, 3).map(operationFailureTitle).join(" · "),
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

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
