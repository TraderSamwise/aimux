export function agentOutputFeedRequestStartLines({
  liveStartLine,
  snapshotStartLine,
}: {
  liveStartLine: number;
  snapshotStartLine?: number;
}): { snapshotStartLine: number; streamStartLine: number } {
  return {
    snapshotStartLine: snapshotStartLine ?? liveStartLine,
    streamStartLine: liveStartLine,
  };
}
