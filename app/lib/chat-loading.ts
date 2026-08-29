export type PaneOutputSnapshotContent = {
  messages?: readonly unknown[];
  output?: string | null;
  outputAnsi?: string | null;
  outputAvailable?: boolean | null;
};

export function paneOutputSnapshotHasVisibleTranscript(result: PaneOutputSnapshotContent): boolean {
  return Boolean(
    (Array.isArray(result.messages) && result.messages.length > 0) ||
    result.output?.length ||
    result.outputAnsi?.length ||
    result.outputAvailable,
  );
}
