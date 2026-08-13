import type { ShareParticipant, SharedChatActorInput } from "@/lib/api";

export interface ResolveSharedChatActorInput {
  currentParticipant?: ShareParticipant | null;
  displayName?: string;
  email?: string;
  isCanonicalSharedRoute: boolean;
  isSharedConversation: boolean;
  routeOwnerUserId?: string;
  userId?: string;
}

export function resolveSharedChatActor({
  currentParticipant,
  displayName,
  email,
  isCanonicalSharedRoute,
  isSharedConversation,
  routeOwnerUserId,
  userId,
}: ResolveSharedChatActorInput): SharedChatActorInput | undefined {
  if (!isSharedConversation) return undefined;
  const role =
    currentParticipant?.role ??
    (routeOwnerUserId && userId === routeOwnerUserId ? "owner" : undefined);
  if (isCanonicalSharedRoute) {
    return {
      role: role === "owner" ? "owner" : "guest",
      displayName: currentParticipant?.displayName ?? displayName ?? "shared guest",
      email: currentParticipant?.email ?? email,
    };
  }
  return {
    role: role === "guest" ? "guest" : "owner",
    displayName: currentParticipant?.displayName ?? displayName ?? "chat owner",
    email: currentParticipant?.email ?? email,
  };
}
