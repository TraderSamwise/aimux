import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
} from "react-native";
import type { LayoutChangeEvent } from "react-native";
import { useLocalSearchParams, usePathname, useRouter } from "expo-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  ChevronLeft,
  Columns2,
  MessageSquare,
  SquareTerminal,
  UserPlus,
} from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MessageBlock } from "@/components/MessageBlock";
import { useAuth } from "@/lib/auth";
import { startHeartbeat } from "@/lib/heartbeat";
import {
  createShareInvite,
  getAgentOutput,
  getShare,
  leaveShare,
  listShares,
  removeShareParticipant,
  sendAgentInput,
  type SharedSessionSummary,
} from "@/lib/api";
import { messagesFromParsedAgentOutput } from "@/lib/parsed-transcript";
import { getComposerSendText, shouldSubmitComposerKey } from "@/lib/composer-protocol";
import { singleRouteParam } from "@/lib/route-params";
import { formatTerminalOutputForDisplay } from "@/lib/terminal-output";
import { parentViewHrefForPath } from "@/lib/view-location";
import {
  ingestEventAtom,
  lastErrorFamily,
  outputBufferFamily,
  parsedOutputFamily,
} from "@/stores/chat";
import { desktopStateFamily } from "@/stores/desktopState";
import { selectedProjectAtom, selectedSessionIdAtom } from "@/stores/projects";
import { relayConfiguredAtom, relayStatusAtom } from "@/stores/relay";
import { activeSharedSessionAtom, chatTerminalSplitAtom } from "@/stores/settings";
import type { ChatMessage } from "@/lib/events";

const RELAY_CHAT_POLL_INTERVAL_MS = 2000;
const SPLIT_VIEW_MIN_WIDTH = 900;
const NARROW_TERMINAL_DIVIDER_WIDTH = 36;
const WIDE_TERMINAL_DIVIDER_WIDTH = 96;
const MIN_TERMINAL_DIVIDER_WIDTH = 24;
const TERMINAL_HORIZONTAL_PADDING = 32;
const APPROX_TERMINAL_CHAR_WIDTH = 8;

export default function ChatScreen() {
  const params = useLocalSearchParams<{ sessionId?: string | string[] }>();
  const sessionId = singleRouteParam(params.sessionId);
  const sessionKey = sessionId ?? "";
  const project = useAtomValue(selectedProjectAtom);
  const desktopState = useAtomValue(desktopStateFamily(project?.path ?? ""));
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const ingestEvent = useSetAtom(ingestEventAtom);
  const output = useAtomValue(outputBufferFamily(sessionKey));
  const setOutput = useSetAtom(outputBufferFamily(sessionKey));
  const parsedOutput = useAtomValue(parsedOutputFamily(sessionKey));
  const setParsedOutput = useSetAtom(parsedOutputFamily(sessionKey));
  const lastError = useAtomValue(lastErrorFamily(sessionKey));
  const relayConfigured = useAtomValue(relayConfiguredAtom);
  const relayStatus = useAtomValue(relayStatusAtom);
  const [activeShare, setActiveShare] = useAtom(activeSharedSessionAtom);
  const { getToken } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { width } = useWindowDimensions();
  const [token, setToken] = useState<string | null>(null);
  const [sharePanelOpen, setSharePanelOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);
  const [shareSummary, setShareSummary] = useState<SharedSessionSummary | null>(null);
  const [shareAction, setShareAction] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [terminalPaneWidth, setTerminalPaneWidth] = useState<number | null>(null);
  const [showTerminalSplit, setShowTerminalSplit] = useAtom(chatTerminalSplitAtom);
  const scrollRef = useRef<ScrollView>(null);
  const terminalScrollRef = useRef<ScrollView>(null);

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
  const useRelayPolling = relayConfigured && relayStatus === "connected";

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
  }, [serviceEndpoint, sessionId, token, ingestEvent, useRelayPolling, relayConfigured]);

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
        const outputResult = await getAgentOutput(serviceEndpoint!, sessionId!, undefined, {
          token,
        });
        if (cancelled) return;
        setOutput(outputResult.output ?? "");
        setParsedOutput(outputResult.parsed ?? null);
      } catch (err) {
        if (!cancelled) console.warn("relay transcript poll failed:", err);
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
    setOutput,
    setParsedOutput,
  ]);

  const parsedMessages = useMemo(() => messagesFromParsedAgentOutput(parsedOutput), [parsedOutput]);

  const allMessages = useMemo<ChatMessage[]>(() => {
    return parsedMessages;
  }, [parsedMessages]);

  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [allMessages.length, output]);

  useEffect(() => {
    terminalScrollRef.current?.scrollToEnd({ animated: false });
  }, [output, showTerminalSplit]);

  const session = sessionId
    ? (desktopState?.sessions.find((s) => s.id === sessionId) ?? null)
    : null;
  const canShowTerminal = Boolean(output);
  const viewportWidth =
    Platform.OS === "web" && typeof window !== "undefined" ? window.innerWidth : width;
  const canUseSplitView = Platform.OS === "web" && viewportWidth >= SPLIT_VIEW_MIN_WIDTH;
  const showSplit = canUseSplitView && canShowTerminal && showTerminalSplit;
  const showTerminalOnly = !canUseSplitView && canShowTerminal && showTerminalSplit;
  const terminalToggleLabel =
    showSplit || showTerminalOnly ? "Show transcript view" : "Show terminal view";
  const measuredDividerWidth = terminalPaneWidth
    ? Math.max(
        MIN_TERMINAL_DIVIDER_WIDTH,
        Math.floor((terminalPaneWidth - TERMINAL_HORIZONTAL_PADDING) / APPROX_TERMINAL_CHAR_WIDTH),
      )
    : null;
  const terminalDividerWidth = Math.min(
    canUseSplitView ? WIDE_TERMINAL_DIVIDER_WIDTH : NARROW_TERMINAL_DIVIDER_WIDTH,
    measuredDividerWidth ??
      (canUseSplitView ? WIDE_TERMINAL_DIVIDER_WIDTH : NARROW_TERMINAL_DIVIDER_WIDTH),
  );
  const terminalOutput = useMemo(
    () =>
      formatTerminalOutputForDisplay(output, {
        dividerWidth: terminalDividerWidth,
      }),
    [output, terminalDividerWidth],
  );
  const composerSendText = getComposerSendText({
    draft,
    hasServiceEndpoint: Boolean(serviceEndpoint),
    hasSessionId: Boolean(sessionId),
    sendBusy,
  });

  function handleTerminalPaneLayout(event: LayoutChangeEvent) {
    setTerminalPaneWidth(event.nativeEvent.layout.width);
  }

  async function handleSendMessage() {
    const text = composerSendText;
    if (!serviceEndpoint || !sessionId || !text) return;
    setDraft("");
    setSendBusy(true);
    setSendError(null);
    try {
      await sendAgentInput(serviceEndpoint, sessionId, text, { token });
    } catch (err) {
      setDraft(text);
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSendBusy(false);
    }
  }

  function handleComposerKeyPress(event: {
    nativeEvent: {
      key?: string;
      shiftKey?: boolean;
      ctrlKey?: boolean;
      metaKey?: boolean;
      altKey?: boolean;
    };
    preventDefault?: () => void;
  }) {
    if (Platform.OS !== "web") return;
    if (shouldSubmitComposerKey(event.nativeEvent)) {
      event.preventDefault?.();
      void handleSendMessage();
    }
  }

  useEffect(() => {
    if (!sharePanelOpen) return;
    let cancelled = false;
    async function refreshShareSummary() {
      if (!token || !sessionId) return;
      if (activeShare?.sessionId === sessionId) {
        const result = await getShare(activeShare.ownerUserId, activeShare.shareId, { token });
        if (!cancelled) setShareSummary(result.share);
        return;
      }
      if (!project?.path) return;
      const result = await listShares({ token });
      if (!cancelled) {
        setShareSummary(
          result.shares.find(
            (share) => share.projectRoot === project.path && share.sessionId === sessionId,
          ) ?? null,
        );
      }
    }
    void refreshShareSummary().catch((err) => {
      if (!cancelled) setInviteStatus(err instanceof Error ? err.message : String(err));
    });
    return () => {
      cancelled = true;
    };
  }, [activeShare, project, sessionId, sharePanelOpen, token]);

  async function handleSendInvite() {
    const email = inviteEmail.trim();
    if (!project?.path || !sessionId || !email || inviteBusy) return;
    if (!token) {
      setInviteStatus("Sign in is required to send invites.");
      return;
    }
    setInviteBusy(true);
    setInviteStatus(null);
    try {
      const result = await createShareInvite(project.path, sessionId, email, serviceEndpoint, {
        token,
      });
      setShareSummary(result.share);
      setInviteEmail("");
      setInviteStatus(
        result.emailDelivered
          ? `Invite sent to ${result.invite.email}.`
          : `Invite created for ${result.invite.email}; email delivery is not configured.`,
      );
    } catch (err) {
      setInviteStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setInviteBusy(false);
    }
  }

  async function handleRemoveParticipant(participantUserId: string) {
    if (!token || !shareSummary || shareAction) return;
    setShareAction(participantUserId);
    setInviteStatus(null);
    try {
      const result = await removeShareParticipant(
        shareSummary.ownerUserId,
        shareSummary.id,
        participantUserId,
        {
          token,
        },
      );
      setShareSummary(result.share);
      setInviteStatus("Participant removed.");
    } catch (err) {
      setInviteStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setShareAction(null);
    }
  }

  async function handleLeaveShare() {
    if (!token || !activeShare || shareAction) return;
    setShareAction(activeShare.shareId);
    setInviteStatus(null);
    try {
      await leaveShare(activeShare.ownerUserId, activeShare.shareId, { token });
      setActiveShare(null);
      setShareSummary(null);
      router.replace("/");
    } catch (err) {
      setInviteStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setShareAction(null);
    }
  }

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace(parentViewHrefForPath(pathname, project?.path));
  }

  const terminalPane = (
    <View className="flex-1 bg-card" onLayout={handleTerminalPaneLayout}>
      <ScrollView ref={terminalScrollRef} className="flex-1 px-4 py-3" horizontal={false}>
        <Text className="text-xs text-muted-foreground mb-2">Live output</Text>
        <Text className="text-secondary-foreground text-xs font-mono">{terminalOutput}</Text>
      </ScrollView>
    </View>
  );

  return (
    <View className="flex-1 bg-background">
      <View className="flex-1" style={Platform.OS === "web" ? { flexDirection: "row" } : undefined}>
        {Platform.OS !== "web" ? null /* sidebar lives in (main)/_layout on web */ : null}
        <View className="flex-1">
          <View className="border-b border-border px-4 py-3 flex-row items-center justify-between">
            <Pressable
              onPress={goBack}
              accessibilityLabel="Back"
              className="mr-3 h-8 w-8 items-center justify-center rounded-md border border-border active:bg-accent"
            >
              <ChevronLeft size={16} color="#a1a1aa" />
            </Pressable>
            <View className="flex-1">
              <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
                {session?.label || sessionId || "Unknown session"}
              </Text>
              <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                {session?.command ?? ""} · {session?.status ?? "unknown"}
              </Text>
            </View>
            <View className="flex-row items-center">
              <Pressable
                onPress={() => setSharePanelOpen((open) => !open)}
                accessibilityLabel="Invite collaborator"
                className="h-8 w-8 items-center justify-center rounded-md border border-border mr-2"
              >
                <UserPlus size={15} color="#a1a1aa" />
              </Pressable>
              <Pressable
                onPress={() => setShowTerminalSplit((current) => !current)}
                disabled={!canShowTerminal}
                accessibilityLabel={terminalToggleLabel}
                className="h-8 w-8 items-center justify-center rounded-md border border-border mr-2 disabled:opacity-40"
              >
                {showSplit || showTerminalOnly ? (
                  <MessageSquare size={15} color="#a1a1aa" />
                ) : canUseSplitView ? (
                  <Columns2 size={15} color="#a1a1aa" />
                ) : (
                  <SquareTerminal size={15} color="#a1a1aa" />
                )}
              </Pressable>
              <Pressable
                onPress={() =>
                  sessionId
                    ? router.push({
                        pathname: "/plans/[sessionId]",
                        params: { sessionId },
                      })
                    : undefined
                }
              >
                <Text className="text-sm text-primary">Plan</Text>
              </Pressable>
            </View>
          </View>
          {sharePanelOpen ? (
            <View className="border-b border-border bg-card px-4 py-3">
              {activeShare ? (
                <View className="flex-row items-center justify-between gap-3">
                  <View className="flex-1">
                    <Text className="text-sm font-medium text-foreground">Shared session view</Text>
                    <Text className="text-xs text-muted-foreground mt-1" numberOfLines={1}>
                      Connected to {activeShare.ownerUserId}
                    </Text>
                  </View>
                  <Button
                    size="sm"
                    variant="outline"
                    label={shareAction ? "Leaving..." : "Leave"}
                    disabled={!token || Boolean(shareAction)}
                    onPress={handleLeaveShare}
                  />
                </View>
              ) : (
                <View className="flex-row items-center gap-2">
                  <Input
                    value={inviteEmail}
                    onChangeText={setInviteEmail}
                    placeholder="Email address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    className="flex-1 h-9 text-sm"
                  />
                  <Button
                    size="sm"
                    label={inviteBusy ? "Sending..." : "Invite"}
                    disabled={
                      inviteBusy ||
                      !relayConfigured ||
                      !token ||
                      !project?.path ||
                      !sessionId ||
                      !inviteEmail.trim()
                    }
                    onPress={handleSendInvite}
                  />
                </View>
              )}
              {shareSummary ? (
                <View className="mt-3 border-t border-border pt-3">
                  <Text className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    Participants
                  </Text>
                  {shareSummary.participants.map((participant) => (
                    <View
                      key={participant.userId}
                      className="mt-2 flex-row items-center justify-between gap-3"
                    >
                      <View className="flex-1">
                        <Text className="text-sm text-foreground" numberOfLines={1}>
                          {participant.displayName}
                        </Text>
                        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                          {participant.role} · {participant.status}
                          {participant.email ? ` · ${participant.email}` : ""}
                        </Text>
                      </View>
                      {!activeShare &&
                      participant.role !== "owner" &&
                      participant.status === "active" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          label={shareAction === participant.userId ? "Removing..." : "Remove"}
                          disabled={!token || Boolean(shareAction)}
                          onPress={() => handleRemoveParticipant(participant.userId)}
                        />
                      ) : null}
                    </View>
                  ))}
                  {!activeShare &&
                  shareSummary.invites.some((invite) => invite.status === "pending") ? (
                    <View className="mt-3">
                      <Text className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                        Pending invites
                      </Text>
                      {shareSummary.invites
                        .filter((invite) => invite.status === "pending")
                        .map((invite) => (
                          <Text
                            key={invite.id}
                            className="text-xs text-muted-foreground mt-2"
                            numberOfLines={1}
                          >
                            {invite.email}
                          </Text>
                        ))}
                    </View>
                  ) : null}
                </View>
              ) : null}
              {!relayConfigured ? (
                <Text className="text-xs text-muted-foreground mt-2">
                  Remote mode is required for shared session invites.
                </Text>
              ) : !token ? (
                <Text className="text-xs text-muted-foreground mt-2">
                  Sign in is required to send invites.
                </Text>
              ) : inviteStatus ? (
                <Text className="text-xs text-muted-foreground mt-2">{inviteStatus}</Text>
              ) : null}
            </View>
          ) : null}

          {!serviceEndpoint ? (
            <View className="p-4">
              <Text className="text-sm text-muted-foreground">
                Project service not running. Start the project host to view this session.
              </Text>
            </View>
          ) : (
            <KeyboardAvoidingView
              className="flex-1"
              behavior={Platform.OS === "ios" ? "padding" : undefined}
              style={{ flex: 1 }}
            >
              <View
                className="flex-1"
                style={showSplit ? { flex: 1, flexDirection: "row" } : { flex: 1 }}
              >
                {showSplit ? (
                  <View className="flex-1 border-r border-border">{terminalPane}</View>
                ) : null}
                {showTerminalOnly ? (
                  <View className="flex-1">{terminalPane}</View>
                ) : (
                  <View className="flex-1">
                    <ScrollView ref={scrollRef} className="flex-1 px-4 py-2">
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
                      {sendError ? (
                        <Text className="text-xs text-destructive my-2">{sendError}</Text>
                      ) : null}
                    </ScrollView>
                  </View>
                )}
              </View>
              <View
                className="border-t border-border bg-background px-3 py-3"
                style={{ flexShrink: 0 }}
              >
                <View className="flex-row items-end gap-2">
                  <Input
                    value={draft}
                    onChangeText={setDraft}
                    onKeyPress={handleComposerKeyPress}
                    placeholder="Message the agent..."
                    multiline
                    editable={!sendBusy}
                    className="min-h-11 max-h-32 flex-1 py-2 text-sm"
                    textAlignVertical="top"
                  />
                  <Button
                    label={sendBusy ? "Sending..." : "Send"}
                    disabled={!composerSendText}
                    onPress={handleSendMessage}
                    className="h-11 px-4"
                  />
                </View>
              </View>
            </KeyboardAvoidingView>
          )}
        </View>
      </View>
    </View>
  );
}
