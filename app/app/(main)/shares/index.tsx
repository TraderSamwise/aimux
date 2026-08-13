import React, { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { useAtom } from "jotai";
import { MessageSquare, RefreshCw } from "lucide-react-native";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { listShares } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { sharedChatHref } from "@/lib/use-route-share";
import { acceptedSharedSessionsAtom, type ActiveSharedSession } from "@/stores/settings";

export default function SharedChatsScreen() {
  const router = useRouter();
  const { getToken } = useAuth();
  const [shares, setShares] = useAtom(acceptedSharedSessionsAtom);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getToken();
      if (!token) throw new Error("Sign in is required.");
      const result = await listShares({ token });
      setShares(
        result.shares
          .filter((share) => share.serviceEndpoint)
          .map((share) => ({
            shareId: share.id,
            ownerUserId: share.ownerUserId,
            projectRoot: share.projectRoot,
            sessionId: share.sessionId,
            serviceEndpoint: share.serviceEndpoint!,
            acceptedAt: share.updatedAt || share.createdAt,
          })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [getToken, setShares]);

  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  return (
    <Page>
      <PageHeader
        eyebrow="Shared"
        title="Shared chats"
        subtitle="Chats shared with this account"
        actions={
          <Button variant="outline" size="icon" onPress={() => void refresh()} disabled={loading}>
            <RefreshCw size={18} color="#fafafa" />
          </Button>
        }
      />

      {error ? (
        <PageStateCard className="mb-4" tone="warning" title="Shared chats failed" body={error} />
      ) : null}

      {shares.length === 0 && !loading ? (
        <PageStateCard
          title="No shared chats"
          body="Accepted shared chat invites will appear here."
        />
      ) : (
        <View className="gap-3">
          {shares.map((share) => (
            <SharedChatRow
              key={`${share.ownerUserId}:${share.shareId}`}
              share={share}
              onPress={() => router.push(sharedChatHref(share))}
            />
          ))}
        </View>
      )}
    </Page>
  );
}

function SharedChatRow({ share, onPress }: { share: ActiveSharedSession; onPress: () => void }) {
  const projectName = share.projectRoot.split("/").filter(Boolean).pop() || "Shared project";
  return (
    <Pressable onPress={onPress}>
      <Card className="rounded-lg p-4">
        <View className="flex-row items-start gap-3">
          <View className="mt-0.5 rounded-md bg-sky-500/15 p-2">
            <MessageSquare size={18} color="#38bdf8" />
          </View>
          <View className="min-w-0 flex-1">
            <Text className="text-[15px] font-semibold text-foreground">{projectName}</Text>
            <Text
              className="mt-1 font-mono text-[12px] text-muted-foreground"
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {share.projectRoot}
            </Text>
            <Text className="mt-2 font-mono text-[12px] text-muted-foreground">
              {share.sessionId}
            </Text>
          </View>
          <Text className="font-mono text-[12px] text-sky-400">shared</Text>
        </View>
      </Card>
    </Pressable>
  );
}
