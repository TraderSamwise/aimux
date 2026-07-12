import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import type { LayoutChangeEvent } from "react-native";
import { useLocalSearchParams, usePathname, useRouter } from "expo-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  ChevronLeft,
  Columns2,
  MessageSquare,
  Paperclip,
  SquareTerminal,
  UserPlus,
  X,
} from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { AgentActions } from "@/components/agent-actions";
import { AgentManagementPanel } from "@/components/agent-management-panel";
import { TeammatePanel } from "@/components/teammate-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MessageBlock } from "@/components/MessageBlock";
import { useAuth } from "@/lib/auth";
import { startHeartbeat } from "@/lib/heartbeat";
import { blurWebActiveElement } from "@/lib/blur-web-active-element";
import {
  createShareInvite,
  getShare,
  leaveShare,
  listShares,
  removeShareParticipant,
  sendLivePaneInput,
  uploadImageAttachment,
  type SharedSessionSummary,
} from "@/lib/api";
import { pickImageAttachment, type PickedImageAttachment } from "@/lib/image-picker";
import { messagesFromParsedAgentOutput } from "@/lib/parsed-transcript";
import { getComposerSendText, shouldSubmitComposerKey } from "@/lib/composer-protocol";
import { singleRouteParam } from "@/lib/route-params";
import { formatTerminalOutputForDisplay } from "@/lib/terminal-output";
import { useRouteProject } from "@/lib/use-route-project";
import { useKeyboardInset } from "@/lib/use-keyboard-visible";
import { parentViewHrefForPath } from "@/lib/view-location";
import {
  ingestEventAtom,
  lastErrorFamily,
  outputBufferFamily,
  parsedOutputFamily,
} from "@/stores/chat";
import { desktopStateFamily, worktreeGroupsFamily } from "@/stores/desktopState";
import { selectedSessionIdAtom } from "@/stores/projects";
import { relayConfiguredAtom, relayStatusAtom } from "@/stores/relay";
import { activeSharedSessionAtom, chatTerminalSplitAtom } from "@/stores/settings";
import type { ChatMessage } from "@/lib/events";

const SPLIT_VIEW_MIN_WIDTH = 900;
const NARROW_TERMINAL_DIVIDER_WIDTH = 36;
const WIDE_TERMINAL_DIVIDER_WIDTH = 96;
const MIN_TERMINAL_DIVIDER_WIDTH = 24;
const TERMINAL_HORIZONTAL_PADDING = 32;
const APPROX_TERMINAL_CHAR_WIDTH = 8;
const MAX_PENDING_ATTACHMENTS = 4;
const CHAT_SCROLL_LOAD_SETTLE_MS = 700;
const CHAT_HEARTBEAT_RECONNECT_MS = 3000;

type PendingImageAttachment = PickedImageAttachment & {
  uploadedAttachmentId?: string;
};

export default function ChatScreen() {
  const params = useLocalSearchParams<{ sessionId?: string | string[] }>();
  const sessionId = singleRouteParam(params.sessionId);
  const sessionKey = sessionId ?? "";
  const composerFieldId = `agent-${sessionKey.replace(/[^A-Za-z0-9_-]/g, "-")}-message`;
  const { project, projectPath, endpoint: serviceEndpoint } = useRouteProject();
  const stateProjectPath = projectPath ?? "";
  const desktopState = useAtomValue(desktopStateFamily(stateProjectPath));
  const worktreeGroups = useAtomValue(worktreeGroupsFamily(stateProjectPath));
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const ingestEvent = useSetAtom(ingestEventAtom);
  const output = useAtomValue(outputBufferFamily(sessionKey));
  const parsedOutput = useAtomValue(parsedOutputFamily(sessionKey));
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
  const [pendingAttachments, setPendingAttachments] = useState<PendingImageAttachment[]>([]);
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [terminalPaneWidth, setTerminalPaneWidth] = useState<number | null>(null);
  const [showTerminalSplit, setShowTerminalSplit] = useAtom(chatTerminalSplitAtom);
  const sendBusyRef = useRef(false);
  const scrollRef = useRef<ScrollView>(null);
  const terminalScrollRef = useRef<ScrollView>(null);
  const activeScrollSessionRef = useRef<string | null>(null);
  const canAnimateActiveScrollRef = useRef(false);
  const enableScrollAnimationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardInset = useKeyboardInset();
  const chatKeyboardInset = Platform.OS === "ios" ? keyboardInset : 0;
  const session = sessionId
    ? (desktopState?.sessions.find((s) => s.id === sessionId) ?? null)
    : null;
  const routeSessionMissing = Boolean(sessionId && desktopState && !session);
  const canManageTeammates =
    session !== null && session.status !== "offline" && session.status !== "exited";

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

  const endpointKey = serviceEndpoint ? `${serviceEndpoint.host}:${serviceEndpoint.port}` : null;
  const heartbeatReady = !relayConfigured || relayStatus === "connected";

  useEffect(() => {
    if (!serviceEndpoint || !sessionId || !heartbeatReady) return;
    if (!session || session.status === "offline" || session.status === "exited") return;
    const endpoint = serviceEndpoint;
    const activeSessionId = sessionId;
    let cancelled = false;
    let handle: { stop: () => void } | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function scheduleReconnect() {
      if (cancelled || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        handle?.stop();
        handle = null;
        connect();
      }, CHAT_HEARTBEAT_RECONNECT_MS);
    }

    function connect() {
      handle = startHeartbeat({
        serviceEndpoint: endpoint,
        sessionId: activeSessionId,
        token,
        onEvent: (event) => {
          ingestEvent(event);
        },
        onError: (err) => {
          if (cancelled) return;
          console.warn("heartbeat error:", getErrorMessage(err));
          scheduleReconnect();
        },
      });
    }

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      handle?.stop();
    };
    // serviceEndpoint object identity changes during project-list reconciles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpointKey, sessionId, token, ingestEvent, heartbeatReady, session?.status]);

  const parsedMessages = useMemo(() => messagesFromParsedAgentOutput(parsedOutput), [parsedOutput]);

  const allMessages = useMemo<ChatMessage[]>(() => {
    return parsedMessages;
  }, [parsedMessages]);

  const scheduleScrollAnimationEnable = useCallback((nextSessionKey: string) => {
    if (enableScrollAnimationTimerRef.current) {
      clearTimeout(enableScrollAnimationTimerRef.current);
    }
    enableScrollAnimationTimerRef.current = setTimeout(() => {
      if (activeScrollSessionRef.current === nextSessionKey) {
        canAnimateActiveScrollRef.current = true;
      }
      enableScrollAnimationTimerRef.current = null;
    }, CHAT_SCROLL_LOAD_SETTLE_MS);
  }, []);

  useEffect(() => {
    return () => {
      if (enableScrollAnimationTimerRef.current) {
        clearTimeout(enableScrollAnimationTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    activeScrollSessionRef.current = sessionKey;
    canAnimateActiveScrollRef.current = false;
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
  }, [sessionKey]);

  useEffect(() => {
    const isSameSession = activeScrollSessionRef.current === sessionKey;
    const animated = isSameSession && canAnimateActiveScrollRef.current;
    scrollRef.current?.scrollToEnd({ animated });
    activeScrollSessionRef.current = sessionKey;
    if (!animated) {
      canAnimateActiveScrollRef.current = false;
      scheduleScrollAnimationEnable(sessionKey);
    }
  }, [scheduleScrollAnimationEnable, sessionKey, allMessages.length, output]);

  useEffect(() => {
    if (!chatKeyboardInset) return;
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
  }, [chatKeyboardInset]);

  useEffect(() => {
    terminalScrollRef.current?.scrollToEnd({ animated: false });
  }, [output, showTerminalSplit]);

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
  const restoreBlockedReason =
    session &&
    (session.status === "offline" || session.status === "exited") &&
    session.restoreState === "blocked"
      ? (session.restoreBlockedReason ?? "Resume is unavailable for this session.")
      : null;
  const sessionTitle = routeSessionMissing
    ? "Agent unavailable"
    : session?.label || sessionId || "Unknown session";
  const sessionSubtitle = routeSessionMissing
    ? `${sessionId} · not found`
    : `${session?.command ?? ""} · ${session?.status ?? "unknown"}`;
  const composerSendText = getComposerSendText({
    draft,
    hasServiceEndpoint: Boolean(serviceEndpoint),
    hasSessionId: Boolean(sessionId && !routeSessionMissing),
    sendBusy,
  });
  const hasPendingAttachments = pendingAttachments.length > 0;
  const canSendMessage = Boolean(
    serviceEndpoint &&
    sessionId &&
    session &&
    !sendBusy &&
    (composerSendText || hasPendingAttachments),
  );

  function handleTerminalPaneLayout(event: LayoutChangeEvent) {
    setTerminalPaneWidth(event.nativeEvent.layout.width);
  }

  async function handleSendMessage() {
    const text = composerSendText ?? "";
    const attachments = [...pendingAttachments];
    if (
      !serviceEndpoint ||
      !sessionId ||
      !session ||
      sendBusyRef.current ||
      (!text && attachments.length === 0)
    ) {
      return;
    }
    sendBusyRef.current = true;
    setDraft("");
    setPendingAttachments([]);
    setSendBusy(true);
    setSendError(null);
    try {
      for (let idx = 0; idx < attachments.length; idx += 1) {
        const attachment = attachments[idx];
        if (attachment.uploadedAttachmentId) continue;
        const uploaded = await uploadImageAttachment(
          serviceEndpoint,
          {
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            dataBase64: attachment.dataBase64,
          },
          { token },
        );
        attachments[idx] = {
          ...attachment,
          uploadedAttachmentId: uploaded.attachment.id,
        };
      }
      await sendLivePaneInput(serviceEndpoint, sessionId, text, {
        token,
        attachmentIds: attachments
          .map((attachment) => attachment.uploadedAttachmentId)
          .filter((id): id is string => Boolean(id)),
      });
    } catch (err) {
      setDraft(text);
      setPendingAttachments(attachments);
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      sendBusyRef.current = false;
      setSendBusy(false);
    }
  }

  async function handleAttachImage() {
    if (sendBusy || sendBusyRef.current) return;
    if (pendingAttachments.length >= MAX_PENDING_ATTACHMENTS) {
      setSendError(`Attach up to ${MAX_PENDING_ATTACHMENTS} images.`);
      return;
    }
    setSendError(null);
    try {
      const picked = await pickImageAttachment();
      if (!picked) return;
      setPendingAttachments((current) => [...current, picked]);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    }
  }

  function removePendingAttachment(id: string) {
    setPendingAttachments((current) => current.filter((attachment) => attachment.id !== id));
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
    blurWebActiveElement();
    if (router.canGoBack()) router.back();
    else router.replace(parentViewHrefForPath(pathname, projectPath));
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
    <View className="flex-1 bg-background" style={{ flex: 1, paddingBottom: chatKeyboardInset }}>
      <View className="flex-1" style={Platform.OS === "web" ? { flexDirection: "row" } : undefined}>
        {Platform.OS !== "web" ? null /* sidebar lives in (main)/_layout on web */ : null}
        <View className="flex-1">
          <View
            className="border-b border-border px-4 py-3 flex-row items-center justify-between"
            style={{ flexShrink: 0 }}
          >
            <Pressable
              onPress={goBack}
              accessibilityLabel="Back"
              className="mr-3 h-8 w-8 items-center justify-center rounded-md border border-border active:bg-accent"
            >
              <ChevronLeft size={16} color="#a1a1aa" />
            </Pressable>
            <View className="flex-1">
              <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
                {sessionTitle}
              </Text>
              <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                {sessionSubtitle}
              </Text>
            </View>
            <View className="flex-row items-center">
              {session ? (
                <View className="mr-2">
                  <AgentActions
                    session={session}
                    projectPath={stateProjectPath}
                    endpoint={serviceEndpoint}
                    token={token}
                    compact
                    mainCheckoutPath={desktopState?.mainCheckoutPath}
                    onKilled={goBack}
                  />
                </View>
              ) : null}
              {session ? (
                <>
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
                    onPress={() => {
                      blurWebActiveElement();
                      router.push({
                        pathname: "/plans/[sessionId]",
                        params: {
                          sessionId: session.id,
                          ...(projectPath ? { project: projectPath } : {}),
                        },
                      });
                    }}
                  >
                    <Text className="text-sm text-primary">Plan</Text>
                  </Pressable>
                </>
              ) : null}
            </View>
          </View>
          {session ? (
            <>
              <AgentManagementPanel
                key={`${session.id}:management`}
                session={session}
                endpoint={serviceEndpoint}
                token={token}
                projectPath={stateProjectPath}
                groups={worktreeGroups}
              />
              {canManageTeammates ? (
                <TeammatePanel
                  key={`${session.id}:teammates`}
                  session={session}
                  endpoint={serviceEndpoint}
                  token={token}
                  projectPath={stateProjectPath}
                />
              ) : null}
            </>
          ) : null}
          {sharePanelOpen ? (
            <View className="border-b border-border bg-card px-4 py-3" style={{ flexShrink: 0 }}>
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

          {routeSessionMissing ? (
            <View className="flex-1 p-4">
              <View className="rounded-lg border border-border bg-card p-4">
                <Text className="text-base font-semibold text-foreground">
                  Agent no longer exists.
                </Text>
                <Text className="mt-2 text-sm text-muted-foreground">
                  This agent was removed from the project. Return to the project dashboard to pick
                  another agent.
                </Text>
                <Button className="mt-4 self-start" label="Back to project" onPress={goBack} />
              </View>
            </View>
          ) : !serviceEndpoint ? (
            <View className="flex-1 p-4">
              <Text className="text-sm text-muted-foreground">
                Project service not running. Start the project host to view this session.
              </Text>
            </View>
          ) : (
            <>
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
                    <ScrollView
                      ref={scrollRef}
                      className="flex-1 px-4 py-2"
                      contentContainerStyle={{ flexGrow: 1 }}
                      keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "none"}
                      keyboardShouldPersistTaps="handled"
                    >
                      {allMessages.map((m, idx) => (
                        <MessageBlock
                          key={m.id ?? m.clientMessageId ?? `idx-${idx}`}
                          message={m}
                          serviceEndpoint={serviceEndpoint}
                        />
                      ))}
                      {restoreBlockedReason ? (
                        <View className="self-start max-w-[90%] rounded-lg border border-border bg-card px-3 py-2 my-1">
                          <Text className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                            Resume unavailable
                          </Text>
                          <Text className="mt-1 text-sm text-card-foreground">
                            {restoreBlockedReason}
                          </Text>
                        </View>
                      ) : null}
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
                {pendingAttachments.length > 0 ? (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-2">
                    <View className="flex-row gap-2">
                      {pendingAttachments.map((attachment) => (
                        <View
                          key={attachment.id}
                          className="w-24 rounded-md border border-border bg-card p-1"
                        >
                          <Image
                            source={{ uri: attachment.previewUri }}
                            className="h-14 w-full rounded"
                            resizeMode="cover"
                          />
                          <Text
                            className="mt-1 text-[10px] text-muted-foreground"
                            numberOfLines={1}
                          >
                            {attachment.filename}
                          </Text>
                          <Pressable
                            onPress={() => removePendingAttachment(attachment.id)}
                            accessibilityLabel={`Remove ${attachment.filename}`}
                            className="absolute right-1 top-1 h-5 w-5 items-center justify-center rounded-full bg-background/90"
                          >
                            <X size={12} color="#a1a1aa" />
                          </Pressable>
                        </View>
                      ))}
                    </View>
                  </ScrollView>
                ) : null}
                <View className="flex-row items-end gap-2">
                  <Input
                    nativeID={composerFieldId}
                    accessibilityLabel="Message the agent"
                    value={draft}
                    onChangeText={setDraft}
                    onKeyPress={handleComposerKeyPress}
                    placeholder="Message the agent..."
                    multiline
                    editable={!sendBusy}
                    className="min-h-11 max-h-32 flex-1 py-2 text-sm"
                    textAlignVertical="top"
                  />
                  <Pressable
                    onPress={handleAttachImage}
                    disabled={sendBusy}
                    accessibilityLabel="Attach image"
                    className="h-11 w-11 items-center justify-center rounded-md border border-border disabled:opacity-40"
                  >
                    <Paperclip size={17} color="#a1a1aa" />
                  </Pressable>
                  <Button
                    label={sendBusy ? "Sending..." : "Send"}
                    disabled={!canSendMessage}
                    onPress={handleSendMessage}
                    className="h-11 px-4"
                  />
                </View>
              </View>
            </>
          )}
        </View>
      </View>
    </View>
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
