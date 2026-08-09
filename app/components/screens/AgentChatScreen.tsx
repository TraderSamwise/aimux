import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Platform, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import Animated, { runOnJS, useAnimatedReaction, useAnimatedStyle } from "react-native-reanimated";
import type { LayoutChangeEvent } from "react-native";
import { useLocalSearchParams, usePathname, useRouter } from "expo-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  ArrowUp,
  ChevronLeft,
  Columns2,
  MessageSquare,
  Plus,
  SlidersHorizontal,
  Square,
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
import { ComposerControl, COMPOSER_CONTROL_LABEL_WIDTH } from "@/components/ComposerControl";
import { useAuth } from "@/lib/auth";
import { agentActivityLabel } from "@/lib/activity-label";
import { blurWebActiveElement } from "@/lib/blur-web-active-element";
import {
  createShareInvite,
  getLivePaneOutput,
  getShare,
  leaveShare,
  listShares,
  removeShareParticipant,
  interruptLivePane,
  sendLivePaneInput,
  uploadImageAttachment,
  type SharedSessionSummary,
} from "@/lib/api";
import { pickImageAttachment, type PickedImageAttachment } from "@/lib/image-picker";
import { getComposerSendText, shouldSubmitComposerKey } from "@/lib/composer-protocol";
import { cn } from "@/lib/utils";
import { singleRouteParam } from "@/lib/route-params";
import { formatTerminalOutputForDisplay } from "@/lib/terminal-output";
import { serviceProjectsTranscript, toChatMessages } from "@/lib/transcript-view";
import { useRouteProject } from "@/lib/use-route-project";
import { worktreeIdentity } from "@/lib/worktree-tone";
import { useKeyboardInset } from "@/lib/use-keyboard-inset";
import { parentViewHrefForPath } from "@/lib/view-location";
import { isTransientRequestError } from "@/lib/request-errors";
import {
  activityFamily,
  activityTextFamily,
  applyOutputSnapshotAtom,
  lastErrorFamily,
  outputAnsiFamily,
  outputBufferFamily,
  transcriptFamily,
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
const CHAT_OUTPUT_SNAPSHOT_POLL_MS = 1500;
// Icon inks, matching secondary-foreground / primary-foreground in the dark theme.
const CONTROL_INK = "#fafafa";
const CONTROL_ON_BRAND = "#18181b";

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
  const applyOutputSnapshot = useSetAtom(applyOutputSnapshotAtom);
  const output = useAtomValue(outputBufferFamily(sessionKey));
  const outputAnsi = useAtomValue(outputAnsiFamily(sessionKey));
  const transcript = useAtomValue(transcriptFamily(sessionKey));
  const activity = useAtomValue(activityFamily(sessionKey));
  const activityText = useAtomValue(activityTextFamily(sessionKey));
  const lastError = useAtomValue(lastErrorFamily(sessionKey));
  const setLastError = useSetAtom(lastErrorFamily(sessionKey));
  const relayConfigured = useAtomValue(relayConfiguredAtom);
  const relayStatus = useAtomValue(relayStatusAtom);
  const [activeShare, setActiveShare] = useAtom(activeSharedSessionAtom);
  const { getToken } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const { width, height: windowHeight } = useWindowDimensions();
  const [token, setToken] = useState<string | null>(null);
  const [sharePanelOpen, setSharePanelOpen] = useState(false);
  const [managePanelOpen, setManagePanelOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);
  const [shareSummary, setShareSummary] = useState<SharedSessionSummary | null>(null);
  const [shareAction, setShareAction] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingImageAttachment[]>([]);
  const [sendBusy, setSendBusy] = useState(false);
  const [interruptBusy, setInterruptBusy] = useState(false);
  const [composerWidth, setComposerWidth] = useState(0);
  const [composerFocused, setComposerFocused] = useState(false);
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
  // The composer rides the keyboard on the UI thread, so no re-render per frame and
  // nothing else in the tree animates alongside it.
  const keyboardStyle = useAnimatedStyle(() => ({ paddingBottom: keyboardInset.value }));
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

  /**
   * Driven by the runtime's own activity state, not by whether bytes arrived.
   * Undefined means the service does not report it — not that the agent is idle
   * — so nothing is claimed in that case.
   */
  const activityLabel = useMemo(
    () => agentActivityLabel(activity, activityText),
    [activity, activityText],
  );

  const wideControls = composerWidth >= COMPOSER_CONTROL_LABEL_WIDTH;
  const heartbeatReady = !relayConfigured || relayStatus === "connected";
  const endpointHost = serviceEndpoint?.host ?? null;
  const endpointPort = serviceEndpoint?.port ?? null;

  const refreshOutputSnapshot = useCallback(async () => {
    if (!endpointHost || !endpointPort || !sessionId || !heartbeatReady || routeSessionMissing) {
      return;
    }
    const result = await getLivePaneOutput(
      { host: endpointHost, port: endpointPort },
      sessionId,
      -120,
      { token },
    );
    if (!serviceProjectsTranscript(result.messages)) {
      // Not an empty pane — a daemon older than this app, which does not
      // project the transcript at all. Rendering it as empty would look like a
      // conversation that vanished.
      setLastError(
        "This aimux daemon is older than the app and does not send a transcript. Restart it to pick up the new build.",
      );
      return;
    }
    applyOutputSnapshot({
      sessionId: result.sessionId,
      output: result.output,
      messages: result.messages,
      activity: result.activity,
      activityText: result.activityText,
      attention: result.attention,
    });
  }, [
    applyOutputSnapshot,
    endpointHost,
    endpointPort,
    heartbeatReady,
    routeSessionMissing,
    sessionId,
    setLastError,
    token,
  ]);

  useEffect(() => {
    if (!endpointHost || !endpointPort || !sessionId || !heartbeatReady || routeSessionMissing) {
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const tick = async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      try {
        await refreshOutputSnapshot();
      } catch {
        // Relay/SSE connection state is surfaced elsewhere; snapshot polling is best-effort.
      } finally {
        inFlight = false;
      }
    };

    void tick();
    const timer = setInterval(() => {
      void tick();
    }, CHAT_OUTPUT_SNAPSHOT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    endpointHost,
    endpointPort,
    heartbeatReady,
    refreshOutputSnapshot,
    routeSessionMissing,
    sessionId,
  ]);

  const parsedMessages = useMemo<ChatMessage[]>(
    () => toChatMessages(transcript, sessionKey),
    [transcript, sessionKey],
  );
  const visibleLastError = lastError && !isTransientRequestError(lastError) ? lastError : null;

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

  const scrollToLatest = useCallback(() => {
    scrollRef.current?.scrollToEnd({ animated: false });
  }, []);

  // Keep the newest message in view as the keyboard eats the viewport. Reacting to
  // the shared value rather than to state, since the inset no longer re-renders.
  useAnimatedReaction(
    () => keyboardInset.value > 0,
    (covered, previous) => {
      if (covered && covered !== previous) runOnJS(scrollToLatest)();
    },
  );

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
  const terminalLines = useMemo(
    () =>
      formatTerminalOutputForDisplay(outputAnsi || output, {
        dividerWidth: terminalDividerWidth,
      }),
    [outputAnsi, output, terminalDividerWidth],
  );
  const restoreBlockedReason =
    session &&
    (session.status === "offline" || session.status === "exited") &&
    session.restoreState === "blocked"
      ? (session.restoreBlockedReason ?? "Resume is unavailable for this session.")
      : null;
  // The worktree leads, as it does in Exposé: it is what the session is, where the
  // generated id is only how it is addressed. The tone comes from the project's
  // ordered worktree list so the colour agrees with the sidebar and the TUI.
  const worktree = routeSessionMissing
    ? undefined
    : worktreeIdentity(worktreeGroups, {
        path: session?.worktreePath,
        name: session?.worktreeName,
      });
  const headerTone = worktree?.tone;
  const sessionTitle = routeSessionMissing
    ? "Agent unavailable"
    : worktree?.name || session?.label || sessionId || "Unknown session";
  const sessionToolLabel = routeSessionMissing ? "" : (session?.command ?? "");
  // Status and branch, then the id last: the id is the only part that never helps
  // you tell two of these apart at a glance, but it is still what you quote in a
  // bug report, so it stays reachable rather than gone.
  const sessionSubtitle = routeSessionMissing
    ? `${sessionId} · not found`
    : [session?.status ?? "unknown", worktree?.branch, sessionId].filter(Boolean).join(" · ");
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
            sessionId: sessionKey,
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
      void refreshOutputSnapshot().catch(() => {});
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

  /**
   * Interrupt is offered unconditionally rather than only while we believe the
   * agent is busy. It is a single ESC, which an idle tool ignores, so gating it
   * on our guess about busy-ness only makes it unavailable exactly when the
   * guess is wrong.
   */
  async function handleInterrupt() {
    if (!endpointHost || !endpointPort || !sessionId || interruptBusy) return;
    setInterruptBusy(true);
    setSendError(null);
    try {
      await interruptLivePane({ host: endpointHost, port: endpointPort }, sessionId, { token });
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Could not interrupt the agent.");
    } finally {
      setInterruptBusy(false);
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
    blurWebActiveElement();
    if (router.canGoBack()) router.back();
    else router.replace(parentViewHrefForPath(pathname, projectPath));
  }

  const terminalPane = (
    <View className="flex-1 bg-card" onLayout={handleTerminalPaneLayout}>
      <ScrollView ref={terminalScrollRef} className="flex-1 px-4 py-3" horizontal={false}>
        <Text className="text-xs text-muted-foreground mb-2">Live output</Text>
        {terminalLines.map((spans, index) => (
          // One Text per row, spans nested inside it: RN only composes styles
          // through nesting, and a row is also the unit the pane wraps at.
          <Text key={`row-${index}`} className="text-secondary-foreground text-xs font-mono">
            {spans.length === 0
              ? " "
              : spans.map((span, spanIndex) => (
                  <Text key={`span-${spanIndex}`} style={span.style}>
                    {span.text}
                  </Text>
                ))}
          </Text>
        ))}
      </ScrollView>
    </View>
  );

  return (
    // Animated.View carries plain styles only; NativeWind does not interop it.
    <Animated.View style={[{ flex: 1 }, keyboardStyle]}>
      <View className="flex-1 bg-background" style={{ flex: 1 }}>
        <View
          className="flex-1"
          style={Platform.OS === "web" ? { flexDirection: "row" } : undefined}
        >
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
              {headerTone ? (
                <View
                  className="mr-2.5 self-stretch rounded-full"
                  style={{ width: 3, backgroundColor: headerTone }}
                />
              ) : null}
              <View className="flex-1">
                <View className="flex-row items-baseline gap-1.5">
                  <Text className="text-base font-semibold text-foreground" numberOfLines={1}>
                    {sessionTitle}
                  </Text>
                  {sessionToolLabel ? (
                    <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                      {sessionToolLabel}
                    </Text>
                  ) : null}
                </View>
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
                      onPress={() => setManagePanelOpen((open) => !open)}
                      accessibilityLabel="Manage agent"
                      accessibilityState={{ expanded: managePanelOpen }}
                      className={cn(
                        "h-8 flex-row items-center gap-1.5 rounded-md border px-2.5 mr-2",
                        managePanelOpen ? "border-primary bg-accent" : "border-border",
                      )}
                    >
                      <SlidersHorizontal
                        size={14}
                        color={managePanelOpen ? "#e4e4e7" : "#a1a1aa"}
                      />
                      <Text className="text-xs text-foreground">Manage</Text>
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
            {/*
            Closed by default. These are settings, and pinning them above every
            conversation cost the chat ~250px on every screen for controls with
            no recorded use.
          */}
            {session && managePanelOpen ? (
              <View style={{ flexShrink: 0, maxHeight: Math.round(windowHeight * 0.6) }}>
                <ScrollView>
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
                </ScrollView>
              </View>
            ) : null}
            {sharePanelOpen ? (
              <View className="border-b border-border bg-card px-4 py-3" style={{ flexShrink: 0 }}>
                {activeShare ? (
                  <View className="flex-row items-center justify-between gap-3">
                    <View className="flex-1">
                      <Text className="text-sm font-medium text-foreground">
                        Shared session view
                      </Text>
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
                        {visibleLastError ? (
                          <Text className="text-xs text-destructive my-2">{visibleLastError}</Text>
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
                  {/*
                  One card holding the message and the controls that act on it, so
                  the composer reads as a single object rather than a field with
                  things parked either side of it. The controls sit under the text
                  because that is where the width is: flanking them costs a third
                  of a phone screen, and the text is the part that needs it.
                */}
                  <View
                    onLayout={(event: LayoutChangeEvent) =>
                      setComposerWidth(event.nativeEvent.layout.width)
                    }
                    className={cn(
                      "gap-2 rounded-2xl border bg-card px-2.5 pb-2 pt-2.5",
                      // The card is the object here, so the card shows focus. The
                      // field's own ring would draw a second rounded rect inside it.
                      composerFocused ? "border-ring" : "border-border",
                    )}
                  >
                    <Input
                      nativeID={composerFieldId}
                      accessibilityLabel="Message the agent"
                      onFocus={() => setComposerFocused(true)}
                      onBlur={() => setComposerFocused(false)}
                      value={draft}
                      onChangeText={setDraft}
                      onKeyPress={handleComposerKeyPress}
                      placeholder="Ask the agent…"
                      multiline
                      // One row at rest. `multiline` alone renders a two-row textarea
                      // on the web, so the card opens a line taller than it needs.
                      numberOfLines={1}
                      editable={!sendBusy}
                      // The card draws the border and the ground now, so the field
                      // itself is only text.
                      className="h-auto max-h-40 min-h-6 rounded-none border-0 bg-transparent px-1 py-0 text-sm"
                      textAlignVertical="top"
                    />
                    <View className="flex-row items-center gap-2">
                      <ComposerControl
                        wide={wideControls}
                        label="Attach"
                        accessibilityLabel="Attach an image"
                        icon={<Plus size={17} color={CONTROL_INK} />}
                        disabled={sendBusy || pendingAttachments.length >= MAX_PENDING_ATTACHMENTS}
                        onPress={handleAttachImage}
                      />
                      <View className="flex-1 px-1">
                        {activityLabel ? (
                          <Text className="text-xs text-muted-foreground">{activityLabel}</Text>
                        ) : null}
                      </View>
                      {/*
                      Always offered, never revealed only while we think the agent
                      is busy. Interrupt is a single ESC, which an idle tool
                      ignores, so gating it on that guess only makes it
                      unavailable exactly when the guess is wrong.
                    */}
                      <ComposerControl
                        wide={wideControls}
                        label="Stop"
                        accessibilityLabel="Interrupt the agent"
                        // Filled, because a stop is a stop and an outline reads as
                        // a checkbox at this size.
                        icon={<Square size={13} color={CONTROL_INK} fill={CONTROL_INK} />}
                        disabled={interruptBusy}
                        onPress={handleInterrupt}
                      />
                      <ComposerControl
                        wide={wideControls}
                        brand
                        label="Send"
                        accessibilityLabel="Send the message"
                        icon={<ArrowUp size={18} color={CONTROL_ON_BRAND} />}
                        disabled={!canSendMessage}
                        onPress={handleSendMessage}
                      />
                    </View>
                  </View>
                </View>
              </>
            )}
          </View>
        </View>
      </View>
    </Animated.View>
  );
}
