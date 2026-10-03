export type ChatViewportShareScope = {
  ownerUserId: string;
  projectRoot: string;
  shareId: string;
};

export function chatViewportKeyForRoute({
  focusToken,
  machineId,
  projectPath,
  sessionKey,
  share,
}: {
  focusToken?: string | null;
  // Which host's copy of the project. Two machines holding the same checkout
  // have the same path and the same agent names, so leaving the machine out
  // keeps one viewport mounted across a host switch and carries the other
  // host's scroll position and paged-back history start line into it.
  machineId?: string | null;
  projectPath?: string | null;
  sessionKey: string;
  share?: ChatViewportShareScope | null;
}): string {
  const scopeKey = share
    ? ["share", share.ownerUserId, share.shareId, share.projectRoot].join(":")
    : projectPath
      ? ["project", machineId ?? "", projectPath].join(":")
      : "session";
  return [scopeKey, sessionKey, focusToken].filter(Boolean).join(":");
}
