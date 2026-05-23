import React, { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Columns2, MessageSquare } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { ChatComposer } from "@/components/ChatComposer";
import { MessageBlock } from "@/components/MessageBlock";
import { useAuth } from "@/lib/auth";
import { startHeartbeat } from "@/lib/heartbeat";
import { getAgentHistory, getAgentOutput } from "@/lib/api";
import {
  messagesFromParsedAgentOutput,
  pendingPromptAlreadyRendered,
} from "@/lib/parsed-transcript";
import { singleRouteParam } from "@/lib/route-params";
import {
  chatHistoryFamily,
  ingestEventAtom,
  lastErrorFamily,
  outputBufferFamily,
  parsedOutputFamily,
  pendingMessagesFamily,
  setHistoryAtom,
} from "@/stores/chat";
import {
  projectsAtom,
  selectedProjectAtom,
  selectedSessionIdAtom,
  selectProjectAtom,
} from "@/stores/projects";
import { relayConfiguredAtom, relayStatusAtom } from "@/stores/relay";
import { chatTerminalSplitAtom } from "@/stores/settings";
import type { ChatMessage } from "@/lib/events";

const RELAY_CHAT_POLL_INTERVAL_MS = 2000;

export default function ChatScreen() {
  const params = useLocalSearchParams<{ sessionId?: string | string[] }>();
  const sessionId = singleRouteParam(params.sessionId);
  const sessionKey = sessionId ?? "";
  const project = useAtomValue(selectedProjectAtom);
  const projects = useAtomValue(projectsAtom);
  const selectProject = useSetAtom(selectProjectAtom);
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const ingestEvent = useSetAtom(ingestEventAtom);
  const setHistory = useSetAtom(setHistoryAtom);
  const history = useAtomValue(chatHistoryFamily(sessionKey));
  const pendingMessages = useAtomValue(pendingMessagesFamily(sessionKey));
  const output = useAtomValue(outputBufferFamily(sessionKey));
  const setOutput = useSetAtom(outputBufferFamily(sessionKey));
  const parsedOutput = useAtomValue(parsedOutputFamily(sessionKey));
  const setParsedOutput = useSetAtom(parsedOutputFamily(sessionKey));
  const lastError = useAtomValue(lastErrorFamily(sessionKey));
  const relayConfigured = useAtomValue(relayConfiguredAtom);
  const relayStatus = useAtomValue(relayStatusAtom);
  const { getToken } = useAuth();
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [showTerminalSplit, setShowTerminalSplit] = useAtom(chatTerminalSplitAtom);
  const scrollRef = useRef<ScrollView>(null);
  const terminalScrollRef = useRef<ScrollView>(null);

  // Keep selectedSessionId in the projects store in sync with the route param so the sidebar highlights it.
  useEffect(() => {
    if (!sessionId) return;
    selectSession(sessionId);
  }, [sessionId, selectSession]);

  // The route is the source of truth on refresh/deep link. If persisted project
  // state points elsewhere, recover the project that owns this session.
  useEffect(() => {
    if (!sessionId || projects.length === 0) return;
    if (project?.sessions.some((session) => session.id === sessionId)) return;
    const owner = projects.find((candidate) =>
      candidate.sessions.some((session) => session.id === sessionId),
    );
    if (owner) {
      selectProject(owner.path);
      selectSession(sessionId);
    }
  }, [sessionId, projects, project, selectProject, selectSession]);

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
  const relayReady = !relayConfigured || relayStatus === "connected";
  const useRelayPolling = relayConfigured && relayStatus === "connected";

  // Initial history fetch
  useEffect(() => {
    if (!serviceEndpoint || !sessionId || !relayReady) return;
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
  }, [serviceEndpoint?.host, serviceEndpoint?.port, sessionId, token, relayReady, setHistory]);

  // Subscribe to /events for local sessions. Hosted/relay deployments cannot
  // reach the project service EventSource directly, so they poll through the
  // relay-aware API in the effect below.
  useEffect(() => {
    if (!serviceEndpoint || !sessionId || useRelayPolling || relayConfigured) return;
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
  }, [
    serviceEndpoint?.host,
    serviceEndpoint?.port,
    sessionId,
    token,
    ingestEvent,
    useRelayPolling,
    relayConfigured,
  ]);

  // Relay-mode live updates use request/response polling. This keeps the MVP
  // working over the existing Durable Object relay without requiring an SSE
  // streaming bridge.
  useEffect(() => {
    if (!serviceEndpoint || !sessionId || !useRelayPolling) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      if (cancelled) return;
      try {
        const [historyResult, outputResult] = await Promise.all([
          getAgentHistory(serviceEndpoint!, sessionId!, 50, { token }),
          getAgentOutput(serviceEndpoint!, sessionId!, undefined, { token }),
        ]);
        if (cancelled) return;
        setHistory({ sessionId: sessionId!, messages: historyResult.messages ?? [] });
        setOutput(outputResult.output ?? "");
        setParsedOutput(outputResult.parsed ?? null);
      } catch (err) {
        if (!cancelled) console.warn("relay chat poll failed:", err);
      }
      if (cancelled) return;
      timer = setTimeout(poll, RELAY_CHAT_POLL_INTERVAL_MS);
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // serviceEndpoint is read inside the poll loop; host/port primitives keep
    // this effect stable across project-list reconciles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    serviceEndpoint?.host,
    serviceEndpoint?.port,
    sessionId,
    token,
    useRelayPolling,
    setHistory,
    setOutput,
    setParsedOutput,
  ]);

  const parsedMessages = useMemo(() => messagesFromParsedAgentOutput(parsedOutput), [parsedOutput]);

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
    if (parsedMessages.length > 0) {
      return [
        ...parsedMessages,
        ...pending.filter((message) => !pendingPromptAlreadyRendered(message, parsedMessages)),
      ];
    }
    return [...history, ...pending].sort((a, b) =>
      String(a.ts ?? "").localeCompare(String(b.ts ?? "")),
    );
  }, [history, parsedMessages, pendingMessages]);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [allMessages.length, output]);

  useEffect(() => {
    terminalScrollRef.current?.scrollToEnd({ animated: false });
  }, [output, showTerminalSplit]);

  const session = sessionId ? (project?.sessions.find((s) => s.id === sessionId) ?? null) : null;
  const canShowTerminalSplit = Platform.OS === "web" && Boolean(output);
  const showSplit = canShowTerminalSplit && showTerminalSplit;

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
            <View className="flex-row items-center">
              {Platform.OS === "web" ? (
                <Pressable
                  onPress={() => setShowTerminalSplit((current) => !current)}
                  disabled={!canShowTerminalSplit}
                  accessibilityLabel={showSplit ? "Show chat only" : "Show split terminal view"}
                  className="h-8 w-8 items-center justify-center rounded-md border border-border mr-2 disabled:opacity-40"
                >
                  {showSplit ? (
                    <MessageSquare size={15} color="#a1a1aa" />
                  ) : (
                    <Columns2 size={15} color="#a1a1aa" />
                  )}
                </Pressable>
              ) : null}
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
          </View>

          {!serviceEndpoint ? (
            <View className="p-4">
              <Text className="text-sm text-muted-foreground">
                Project service not running. Start the project host to enable chat.
              </Text>
            </View>
          ) : (
            <>
              <View className="flex-1" style={showSplit ? { flexDirection: "row" } : undefined}>
                {showSplit ? (
                  <View className="flex-1 border-r border-border bg-card">
                    <ScrollView
                      ref={terminalScrollRef}
                      className="flex-1 px-4 py-3"
                      horizontal={false}
                    >
                      <Text className="text-xs text-muted-foreground mb-2">Live output</Text>
                      <Text className="text-secondary-foreground text-xs font-mono">{output}</Text>
                    </ScrollView>
                  </View>
                ) : null}
                <View className="flex-1">
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
                    {output && parsedMessages.length === 0 && !showSplit ? (
                      <View className="self-start max-w-[90%] rounded-lg bg-secondary px-3 py-2 my-1">
                        <Text className="text-xs text-muted-foreground mb-1">Live output</Text>
                        <Text className="text-secondary-foreground text-xs font-mono">
                          {output}
                        </Text>
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
                </View>
              </View>
            </>
          )}
        </View>
      </View>
    </View>
  );
}
