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

export function summarizeOperationFailures(
  failures: readonly ProjectOperationFailure[] | undefined,
): { title: string; detail: string } | null {
  const visible = failures?.map(formatOperationFailure).filter(Boolean) ?? [];
  if (visible.length === 0) return null;
  const title =
    visible.length === 1
      ? "Project state has an operation failure"
      : `Project state has ${visible.length} operation failures`;
  return {
    title,
    detail: visible.slice(0, 3).join(" · "),
  };
}

export function formatDaemonProjectReadError(error: DaemonProjectReadError): string {
  if (typeof error === "string") return error;
  const project =
    stringField(error.projectName) || stringField(error.projectRoot) || stringField(error.root);
  const message = stringField(error.error) || stringField(error.message) || "project read failed";
  return project ? `${project}: ${message}` : message;
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
