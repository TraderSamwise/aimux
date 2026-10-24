import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { useAtomValue, useAtom } from "jotai";
import { MessageSquare, RefreshCw } from "lucide-react-native";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { listShares } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  activeSessionsFromShareSummaries,
  mergeActiveSharedSessions,
  sharedSessionsEqual,
  shouldApplySharedSessionHydrate,
} from "@/lib/shared-sessions";
import { sharedChatHref, useRouteShare } from "@/lib/use-route-share";
import {
  settingsReadStateAtom,
  acceptedSharedSessionsAtom,
  type ActiveSharedSession,
} from "@/stores/settings";

export default function SharedChatsScreen() {
  const router = useRouter();
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  const [shares, setShares] = useAtom(acceptedSharedSessionsAtom);
  const activeShare = useRouteShare();
  const displayedShares = mergeActiveSharedSessions(shares, activeShare);
  const setSharesRef = useRef(setShares);
  const preservedEmptyHydrateRef = useRef(false);
  const settingsReadState = useAtomValue(settingsReadStateAtom);
  const [hasHydrated, setHasHydrated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // A read that FAILED is its own answer, and it is derived rather than
  // stored: `loading` starts true and only the fetch clears it, so skipping
  // the fetch left a permanent "Loading shared chats..." -- a wrapper
  // reporting a storage error as still loading, with the refresh button
  // disabled so there was no way out of it.
  const storageUnreadable = settingsReadState === "failed";
  const visibleError =
    error ??
    (storageUnreadable
      ? "This device cannot read its stored shared chats. Check your browser's site-data settings, or open aimux on another device."
      : null);
  const visibleLoading = loading && !storageUnreadable;

  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  useEffect(() => {
    setSharesRef.current = setShares;
  }, [setShares]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const token = await getTokenRef.current();
      if (!token) throw new Error("Sign in is required.");
      const result = await listShares({ token });
      const relayShares = activeSessionsFromShareSummaries(result.shares);
      setSharesRef.current((current) => {
        const preserveEmptyOnce =
          relayShares.length === 0 && current.length > 0 && !preservedEmptyHydrateRef.current;
        if (!shouldApplySharedSessionHydrate(current, relayShares, { preserveEmptyOnce })) {
          preservedEmptyHydrateRef.current = true;
          return current;
        }
        if (relayShares.length > 0) preservedEmptyHydrateRef.current = false;
        return sharedSessionsEqual(current, relayShares) ? current : relayShares;
      });
      setHasHydrated(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Not until the stored settings have been read. `refresh` WRITES the shares
  // it fetched and then calls `setHasHydrated(true)`, which switches off the
  // loading state -- so a held write left this screen presenting the default
  // empty list as a loaded one: "nobody has shared anything" when the truth
  // was "not read yet".
  //
  // A read that FAILED is its own answer and must not read as "still
  // loading": nothing is coming, the fetched list could not be stored anyway,
  // and the refresh button is disabled -- so the screen says what happened
  // rather than spinning for the rest of the session.
  useEffect(() => {
    if (settingsReadState !== "read") return;
    const timer = setTimeout(() => void refresh(), 0);
    return () => clearTimeout(timer);
  }, [refresh, settingsReadState]);

  return (
    <Page>
      <PageHeader
        eyebrow="Shared"
        title="Shared chats"
        subtitle="Chats shared with this account"
        actions={
          <Button
            variant="outline"
            size="icon"
            onPress={() => void refresh()}
            disabled={loading || settingsReadState !== "read"}
          >
            <RefreshCw size={18} color="#fafafa" />
          </Button>
        }
      />

      {visibleError ? (
        <PageStateCard
          className="mb-4"
          tone="warning"
          title="Shared chats failed"
          body={visibleError}
        />
      ) : null}

      {displayedShares.length === 0 && !hasHydrated && visibleLoading ? (
        <PageStateCard
          title="Loading shared chats..."
          body="Checking chats shared with this account."
        />
      ) : displayedShares.length === 0 && !visibleLoading && !visibleError ? (
        <PageStateCard
          title="No shared chats"
          body="Accepted shared chat invites will appear here."
        />
      ) : (
        <View className="gap-3">
          {displayedShares.map((share) => (
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
