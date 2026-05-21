import React, { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Text } from "@/components/ui/text";
import { ChatComposer } from "@/components/ChatComposer";
import { MessageBlock } from "@/components/MessageBlock";
import { useAuth } from "@/lib/auth";
import { startHeartbeat } from "@/lib/heartbeat";
import { getAgentHistory } from "@/lib/api";
import { singleRouteParam } from "@/lib/route-params";
import {
  chatHistoryFamily,
  ingestEventAtom,
  lastErrorFamily,
  outputBufferFamily,
  pendingMessagesFamily,
  setHistoryAtom,
} from "@/stores/chat";
import { selectedProjectAtom, selectedSessionIdAtom } from "@/stores/projects";
import type { ChatMessage } from "@/lib/events";

export default function ChatScreen() {
  const params = useLocalSearchParams<{ sessionId?: string | string[] }>();
  const sessionId = singleRouteParam(params.sessionId);
  const sessionKey = sessionId ?? "";
  const project = useAtomValue(selectedProjectAtom);
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const ingestEvent = useSetAtom(ingestEventAtom);
  const setHistory = useSetAtom(setHistoryAtom);
  const history = useAtomValue(chatHistoryFamily(sessionKey));
  const pendingMessages = useAtomValue(pendingMessagesFamily(sessionKey));
  const output = useAtomValue(outputBufferFamily(sessionKey));
  const lastError = useAtomValue(lastErrorFamily(sessionKey));
  const { getToken } = useAuth();
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  // Keep selectedSessionId in the projects store in sync with the route param so the sidebar highlights it.
  useEffect(() => {
    if (!sessionId) return;
    selectSession(sessionId);
  }, [sessionId, selectSession]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const t = await getToken();
        if (!cancelled) setToken(t);
      } catch {
        if (!cancelled) setToken(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken]);

  const serviceEndpoint = project?.serviceEndpoint ?? null;

  // Initial history fetch
  useEffect(() => {
    if (!serviceEndpoint || !sessionId) return;
    let cancelled = false;
    setLoadingHistory(true);
    getAgentHistory(serviceEndpoint, sessionId, 50, { token })
      .then((res) => {
        if (cancelled) return;
        setHistory({ sessionId, messages: res.messages ?? [] });
      })
      .catch((err) => {
        if (!cancelled) console.warn("history fetch failed:", err);
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serviceEndpoint?.host, serviceEndpoint?.port, sessionId, token, setHistory]);

  // Subscribe to /events for this session
  useEffect(() => {
    if (!serviceEndpoint || !sessionId) return;
    const handle = startHeartbeat({
      serviceEndpoint,
      sessionId,
      token,
      onEvent: (event) => {
        ingestEvent(event);
      },
      onError: (err) => {
        console.warn("heartbeat error:", err);
      },
    });
    return () => handle.stop();
  }, [serviceEndpoint?.host, serviceEndpoint?.port, sessionId, token, ingestEvent]);

  const allMessages = useMemo<ChatMessage[]>(() => {
    const pending = pendingMessages.map((p) => ({
      id: `pending-${p.clientMessageId}`,
      clientMessageId: p.clientMessageId,
      role: "user" as const,
      ts: p.ts,
      parts: p.parts,
      deliveryState: p.deliveryState,
      deliveryError: p.deliveryError,
    }));
    return [...history, ...pending].sort((a, b) =>
      String(a.ts ?? "").localeCompare(String(b.ts ?? "")),
    );
  }, [history, pendingMessages]);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [allMessages.length, output]);

  const session = sessionId ? (project?.sessions.find((s) => s.id === sessionId) ?? null) : null;

  return (
    <View className="flex-1 bg-background">
      <View className="flex-1" style={Platform.OS === "web" ? { flexDirection: "row" } : undefined}>
        {Platform.OS !== "web" ? null /* sidebar lives in (main)/_layout on web */ : null}
        <View className="flex-1">
          <View className="border-b border-border px-4 py-3 flex-row items-center justify-between">
            <View className="flex-1">
              <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
                {session?.label || sessionId || "Unknown session"}
              </Text>
              <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                {session?.tool ?? ""} · {session?.status ?? "unknown"}
              </Text>
            </View>
            <Pressable
              onPress={() =>
                sessionId
                  ? router.push({
                      pathname: "/(main)/plans/[sessionId]",
                      params: { sessionId },
                    })
                  : undefined
              }
            >
              <Text className="text-sm text-primary">Plan</Text>
            </Pressable>
          </View>

          {!serviceEndpoint ? (
            <View className="p-4">
              <Text className="text-sm text-muted-foreground">
                Project service not running. Start the project host to enable chat.
              </Text>
            </View>
          ) : (
            <>
              <ScrollView ref={scrollRef} className="flex-1 px-4 py-2">
                {loadingHistory && allMessages.length === 0 ? (
                  <Text className="text-sm text-muted-foreground">Loading history…</Text>
                ) : null}
                {allMessages.map((m, idx) => (
                  <MessageBlock
                    key={m.id ?? m.clientMessageId ?? `idx-${idx}`}
                    message={m}
                    serviceEndpoint={serviceEndpoint}
                  />
                ))}
                {output ? (
                  <View className="self-start max-w-[90%] rounded-lg bg-secondary px-3 py-2 my-1">
                    <Text className="text-xs text-muted-foreground mb-1">Live output</Text>
                    <Text className="text-secondary-foreground text-xs font-mono">{output}</Text>
                  </View>
                ) : null}
                {lastError ? (
                  <Text className="text-xs text-destructive my-2">{lastError}</Text>
                ) : null}
              </ScrollView>
              {sessionId ? (
                <ChatComposer
                  serviceEndpoint={serviceEndpoint}
                  sessionId={sessionId}
                  token={token}
                />
              ) : null}
            </>
          )}
        </View>
      </View>
    </View>
  );
}
