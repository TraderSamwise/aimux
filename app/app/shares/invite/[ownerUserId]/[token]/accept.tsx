import React, { useMemo, useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSetAtom } from "jotai";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { acceptShareInvite } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { singleRouteParam } from "@/lib/route-params";
import { selectedProjectPathAtom, selectedSessionIdAtom } from "@/stores/projects";
import { activeSharedSessionAtom } from "@/stores/settings";

export default function AcceptShareInviteScreen() {
  const params = useLocalSearchParams<{
    ownerUserId?: string | string[];
    token?: string | string[];
  }>();
  const ownerUserId = singleRouteParam(params.ownerUserId);
  const inviteToken = singleRouteParam(params.token);
  const { isSignedIn, isLoaded, getToken } = useAuth();
  const setActiveShare = useSetAtom(activeSharedSessionAtom);
  const setSelectedProject = useSetAtom(selectedProjectPathAtom);
  const setSelectedSession = useSetAtom(selectedSessionIdAtom);
  const router = useRouter();
  const [status, setStatus] = useState<"idle" | "accepting" | "accepted" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const invitePath =
    ownerUserId && inviteToken ? `/shares/invite/${ownerUserId}/${inviteToken}/accept` : null;

  const canAccept = useMemo(
    () => Boolean(isLoaded && isSignedIn && ownerUserId && inviteToken && status !== "accepting"),
    [isLoaded, isSignedIn, ownerUserId, inviteToken, status],
  );

  async function acceptInvite() {
    if (!ownerUserId || !inviteToken || status === "accepting") return;
    setStatus("accepting");
    setMessage(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Sign in is required to accept this invite.");
      const result = await acceptShareInvite(ownerUserId, inviteToken, { token });
      const endpoint = result.share.serviceEndpoint;
      if (!endpoint) throw new Error("Invite is missing project connection metadata.");
      const activeShare = {
        shareId: result.share.id,
        ownerUserId: result.share.ownerUserId,
        projectRoot: result.share.projectRoot,
        sessionId: result.share.sessionId,
        serviceEndpoint: endpoint,
        acceptedAt: new Date().toISOString(),
      };
      setActiveShare(activeShare);
      setSelectedProject(activeShare.projectRoot);
      setSelectedSession(activeShare.sessionId);
      setStatus("accepted");
      setMessage("Invite accepted.");
      router.replace({
        pathname: "/agent/[sessionId]/chat",
        params: { sessionId: activeShare.sessionId },
      });
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <View className="flex-1 bg-background p-6 justify-center">
      <View className="rounded-lg border border-border bg-card p-5">
        <Text className="text-2xl font-semibold text-foreground">Shared session invite</Text>
        <Text className="text-sm text-muted-foreground mt-2">
          {isSignedIn
            ? "Accepting this invite will connect aimux to the owner shared session."
            : "Sign in to accept this invite."}
        </Text>
        {message ? <Text className="text-sm text-muted-foreground mt-4">{message}</Text> : null}
        {!isSignedIn && isLoaded ? (
          <Button
            className="mt-5"
            label="Sign in"
            onPress={() =>
              router.push({
                pathname: "/sign-in",
                params: invitePath ? { redirect: invitePath } : {},
              })
            }
          />
        ) : (
          <Button
            className="mt-5"
            label={
              status === "accepting"
                ? "Accepting..."
                : status === "accepted"
                  ? "Accepted"
                  : "Accept invite"
            }
            disabled={!canAccept}
            onPress={acceptInvite}
          />
        )}
      </View>
    </View>
  );
}
