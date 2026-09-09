export type ChatViewportShareScope = {
  ownerUserId: string;
  projectRoot: string;
  shareId: string;
};

export function chatViewportKeyForRoute({
  focusToken,
  projectPath,
  sessionKey,
  share,
}: {
  focusToken?: string | null;
  projectPath?: string | null;
  sessionKey: string;
  share?: ChatViewportShareScope | null;
}): string {
  const scopeKey = share
    ? ["share", share.ownerUserId, share.shareId, share.projectRoot].join(":")
    : projectPath
      ? `project:${projectPath}`
      : "session";
  return [scopeKey, sessionKey, focusToken].filter(Boolean).join(":");
}
