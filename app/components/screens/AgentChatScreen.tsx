import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Image,
  InteractionManager,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  useWindowDimensions,
  View,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
  type TextInputContentSizeChangeEventData,
} from "react-native";
import type { LayoutChangeEvent } from "react-native";
import { useFocusEffect, useLocalSearchParams, usePathname, useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { useColorScheme } from "nativewind";
import { KeyboardChatScrollView, KeyboardStickyView } from "react-native-keyboard-controller";
import Reanimated, {
  Easing as ReanimatedEasing,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  CircleAlert,
  Plus,
  SlidersHorizontal,
  Square,
  UserPlus,
  X,
} from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { AgentActions } from "@/components/agent-actions";
import { AgentManagementPanel } from "@/components/agent-management-panel";
import { TeammatePanel } from "@/components/teammate-panel";
import { Button } from "@/components/ui/button";
import { Input, NO_BROWSER_FOCUS_RING } from "@/components/ui/input";
import { MessageBlock } from "@/components/MessageBlock";
import { ComposerControl, COMPOSER_CONTROL_LABEL_WIDTH } from "@/components/ComposerControl";
import { AttachmentDropZone } from "@/components/AttachmentDropZone";
import { useAuth, useUser } from "@/lib/auth";
import { agentActivityLabel, shouldShimmerAgentActivityLabel } from "@/lib/activity-label";
import { blurWebActiveElement } from "@/lib/blur-web-active-element";
import {
  createShareInvite,
  getShare,
  leaveShare,
  listShares,
  removeShareParticipant,
  revokeShareInvite,
  interruptLivePane,
  sendLivePaneInput,
  uploadAttachment,
  type ShareInvite,
  type ShareParticipant,
  type SharedSessionSummary,
} from "@/lib/api";
import {
  attachmentsFromClipboardData,
  clipboardDataHasFile,
  pickAttachments,
  pickedAttachmentDataBase64,
  releasePickedAttachment,
  type ClipboardFileSource,
  type PickedAttachment,
} from "@/lib/image-picker";
import {
  COMPOSER_SEND_TIMEOUT_MESSAGE,
  formatComposerSendFailure,
  normalizeComposerDraft,
  shouldSubmitComposerKey,
  userMessageAcknowledgesComposerSend,
} from "@/lib/composer-protocol";
import {
  chatCommandForContentChange,
  chatCommandForInitialLayout,
  chatCommandForNavigationFocus,
  chatPolicyAfterNavigationFocus,
  chatPolicyAfterUserScroll,
  createChatScrollPolicy,
  type ChatScrollCommand,
  type ChatScrollMetrics,
  type ChatScrollPolicy,
} from "@/lib/chat-scroll-policy";
import { CHAT_OUTPUT_CAPTURE_START_LINE } from "@/lib/chat-output-constants";
import { useAgentOutputFeed } from "@/lib/use-agent-output-feed";
import { cn } from "@/lib/utils";
import { resolveChromeBottomInset } from "@/lib/native-safe-area";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { DesktopSession } from "@/lib/desktop-state";
import { singleRouteParam } from "@/lib/route-params";
import {
  activeSessionsFromShareSummaries,
  mergeActiveSharedSessions,
  sharedSessionsEqual,
} from "@/lib/shared-sessions";
import { toChatMessages } from "@/lib/transcript-view";
import { useRouteProject } from "@/lib/use-route-project";
import { useRouteShare } from "@/lib/use-route-share";
import { resolveSharedChatActor } from "@/lib/shared-chat-actor";
import { worktreeIdentity, worktreeTone } from "@/lib/worktree-tone";
import { parentViewHrefForPath } from "@/lib/view-location";
import { useKeyboardVisible } from "@/lib/use-keyboard-visible";
import { isTransientRequestError } from "@/lib/request-errors";
import {
  activityFamily,
  activityTextFamily,
  clearLocalInterruptHoldAtom,
  markOutputInterruptedAtom,
  transcriptFamily,
} from "@/stores/chat";
import { desktopStateFamily, worktreeGroupsFamily } from "@/stores/desktopState";
import { selectedSessionIdAtom } from "@/stores/projects";
import { relayConfiguredAtom, relayStatusAtom } from "@/stores/relay";
import {
  acceptedSharedSessionsAtom,
  activeSharedSessionAtom,
  type ActiveSharedSession,
} from "@/stores/settings";
import type { ChatMessage, HistoryPart } from "@/lib/events";

const MAX_PENDING_ATTACHMENTS = 4;
const CHAT_SCROLL_HORIZONTAL_PADDING = 32;
const CHAT_ASSISTANT_BUBBLE_MAX_RATIO = 0.9;
const CHAT_DIVIDER_APPROX_CHAR_WIDTH = Platform.OS === "web" ? 9.6 : 12.4;
const CHAT_DIVIDER_WIDTH_SAFETY = Platform.OS === "web" ? 4 : 6;
const MIN_CHAT_DIVIDER_WIDTH = 16;
const MAX_CHAT_DIVIDER_WIDTH = Platform.OS === "web" ? 72 : 24;
type ChatScrollHandle = Pick<ScrollView, "scrollToEnd">;
const COMPOSER_INPUT_FONT_SIZE = 14;
const COMPOSER_INPUT_LINE_HEIGHT = 20;
const COMPOSER_INPUT_MAX_LINES = 4;
const COMPOSER_INPUT_VERTICAL_PADDING = 6;
const COMPOSER_INPUT_HEIGHT_SLOP = 4;
const COMPOSER_INPUT_MIN_HEIGHT = COMPOSER_INPUT_LINE_HEIGHT + COMPOSER_INPUT_VERTICAL_PADDING * 2;
const COMPOSER_INPUT_MAX_HEIGHT =
  COMPOSER_INPUT_LINE_HEIGHT * COMPOSER_INPUT_MAX_LINES +
  COMPOSER_INPUT_VERTICAL_PADDING * 2 +
  COMPOSER_INPUT_HEIGHT_SLOP;
const COMPOSER_INPUT_HORIZONTAL_PADDING = 4;
const COMPOSER_FOOTER_VERTICAL_PADDING = 12;
const COMPOSER_SEND_ACK_TIMEOUT_MS = 10_000;
const FOOTER_LABEL_SHIMMER_DURATION_MS = 1700;
/** How much of the label the travelling highlight covers, as a fraction of its width. */
const FOOTER_LABEL_SHIMMER_BAND = 0.3;
/** muted-foreground -> foreground, per theme (see app/global.css). */
const FOOTER_LABEL_SHIMMER_COLORS = {
  dark: { base: "#a1a1aa", highlight: "#fafafa" },
  light: { base: "#71717a", highlight: "#09090b" },
} as const;
const MIN_HEADER_ACTIONS_WIDTH = 156;
const CHAT_INPUT_NATIVE_ID = "aimux-chat-input";
const COMPOSER_WEB_INPUT_PROPS =
  Platform.OS === "web"
    ? ({
        "data-1p-ignore": "true",
        "data-form-type": "other",
        "data-lpignore": "true",
        "data-protonpass-ignore": "true",
        name: "aimux-agent-message",
        spellCheck: false,
      } as unknown as Partial<React.ComponentProps<typeof TextInput>>)
    : {};
// Icon inks, matching secondary-foreground / primary-foreground in the dark theme.
const CONTROL_INK = "#fafafa";
const CONTROL_ON_BRAND = "#18181b";

function isAppVisible(): boolean {
  if (Platform.OS === "web") {
    const documentLike = (
      globalThis as {
        document?: {
          visibilityState?: string;
        };
      }
    ).document;
    return documentLike?.visibilityState !== "hidden";
  }
  return AppState.currentState !== "background" && AppState.currentState !== "inactive";
}

function useAppVisible(): boolean {
  const [visible, setVisible] = useState(isAppVisible);

  useEffect(() => {
    if (Platform.OS === "web") {
      const documentLike = (
        globalThis as {
          document?: {
            addEventListener?: (event: "visibilitychange", listener: () => void) => void;
            removeEventListener?: (event: "visibilitychange", listener: () => void) => void;
          };
        }
      ).document;
      if (!documentLike?.addEventListener || !documentLike.removeEventListener) return;
      const update = () => setVisible(isAppVisible());
      documentLike.addEventListener("visibilitychange", update);
      return () => documentLike.removeEventListener?.("visibilitychange", update);
    }

    const subscription = AppState.addEventListener("change", () => setVisible(isAppVisible()));
    return () => subscription.remove();
  }, []);

  return visible;
}

function basenamePath(path?: string | null): string | null {
  const normalized = path?.trim().replace(/[\\/]+$/, "");
  if (!normalized) return null;
  return normalized.split(/[\\/]/).filter(Boolean).pop() ?? normalized;
}

function formatRelativeShareTime(value?: string): string {
  if (!value) return "not connected";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "seen";
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 90) return "connected now";
  if (seconds < 3600) return `last seen ${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `last seen ${Math.floor(seconds / 3600)}h ago`;
  return `last seen ${Math.floor(seconds / 86400)}d ago`;
}

function formatShareParticipantStatus(participant: ShareParticipant): string {
  if (participant.status === "removed") return "removed";
  if (participant.role === "owner") return "owner";
  return formatRelativeShareTime(participant.lastSeenAt ?? participant.joinedAt);
}

function formatShareInviteStatus(invite: ShareInvite): string {
  if (invite.status === "pending") {
    const expiryTime = Date.parse(invite.expiresAt);
    const expiry = Number.isFinite(expiryTime)
      ? new Date(expiryTime).toLocaleDateString()
      : "unknown";
    return `pending · expires ${expiry}`;
  }
  if (invite.status === "accepted") return "accepted";
  if (invite.status === "revoked") return "revoked";
  return invite.status;
}

type PendingAttachment = PickedAttachment & {
  uploadedAttachmentId?: string;
};

type ComposerDraftSnapshot = {
  draft: string;
  inputContentHeight: number;
  pendingAttachments: PendingAttachment[];
};

type PendingComposerAck = {
  attachmentCount: number;
  attachmentIds: string[];
  baselineUserMessageCount: number;
  id: number;
  text: string;
  attachmentFilenames: string[];
  showTimeoutError: boolean;
  timedOut: boolean;
};

type AcceptedComposerMessage = {
  baselineMessageCount: number;
  clientMessageId: string;
  message: ChatMessage;
  pending: PendingComposerAck;
  settled?: boolean;
};

const composerDraftsByKey = new Map<string, ComposerDraftSnapshot>();

function hasComposerDraftContent(text: string): boolean {
  return /\S/.test(text);
}

function composerInputHeightForContentHeight(contentHeight: number): number {
  const measured = Number.isFinite(contentHeight) ? Math.ceil(contentHeight) : 0;
  return Math.min(
    COMPOSER_INPUT_MAX_HEIGHT,
    Math.max(COMPOSER_INPUT_MIN_HEIGHT, measured + COMPOSER_INPUT_HEIGHT_SLOP),
  );
}

function composerContentHeightForDraft(draft: string, contentHeight: number): number {
  return draft.length === 0 ? COMPOSER_INPUT_MIN_HEIGHT : contentHeight;
}

function rememberComposerDraft(key: string | null, snapshot: ComposerDraftSnapshot) {
  if (!key) return;
  if (snapshot.draft.length === 0 && snapshot.pendingAttachments.length === 0) {
    composerDraftsByKey.delete(key);
    return;
  }
  composerDraftsByKey.set(key, {
    ...snapshot,
    pendingAttachments: [...snapshot.pendingAttachments],
  });
}

function releasePendingAttachmentPreviews(attachments: readonly PickedAttachment[]) {
  for (const attachment of attachments) {
    releasePickedAttachment(attachment);
  }
}

function attachmentHistoryPartsFromUploads(
  attachments: readonly PendingAttachment[],
  sessionKey: string,
): HistoryPart[] {
  let imageCount = 1;
  let fileCount = 1;
  return attachments
    .filter((attachment) => Boolean(attachment.uploadedAttachmentId))
    .map((attachment): HistoryPart => {
      const attachmentId = attachment.uploadedAttachmentId!;
      const contentUrl = `/attachments/${attachmentId}/content?sessionId=${encodeURIComponent(sessionKey)}`;
      if (attachment.kind === "image" || attachment.mimeType.startsWith("image/")) {
        return {
          type: "image_reference",
          label: `[image #${imageCount++}]`,
          attachmentId,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          contentUrl,
        };
      }
      return {
        type: "attachment_reference",
        label: `[file #${fileCount++}]`,
        attachmentId,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        kind: attachment.kind,
        contentUrl,
      };
    });
}

function buildAcceptedComposerMessage(opts: {
  attachments: readonly PendingAttachment[];
  clientMessageId: string;
  sessionKey: string;
  text: string;
}): ChatMessage {
  const parts: HistoryPart[] = [];
  const text = opts.text.trim();
  if (text) parts.push({ type: "text", text });
  parts.push(...attachmentHistoryPartsFromUploads(opts.attachments, opts.sessionKey));
  return {
    clientMessageId: opts.clientMessageId,
    id: opts.clientMessageId,
    role: "user",
    parts,
    text,
  };
}

function messageAcknowledgesPendingComposerMessage(
  message: ChatMessage,
  pending: PendingComposerAck,
): boolean {
  return userMessageAcknowledgesComposerSend([message], {
    ...pending,
    baselineUserMessageCount: 0,
  });
}

function acceptedComposerMatchIndex(
  messages: readonly ChatMessage[],
  pending: PendingComposerAck,
  replacedIndexes?: ReadonlySet<number>,
): number {
  let userIndex = -1;
  return messages.findIndex((message, index) => {
    if (replacedIndexes?.has(index) || message.role !== "user") return false;
    userIndex += 1;
    return (
      userIndex >= pending.baselineUserMessageCount &&
      messageAcknowledgesPendingComposerMessage(message, pending)
    );
  });
}

function mergeAcceptedComposerMessage(parsed: ChatMessage, accepted: ChatMessage): ChatMessage {
  const acceptedParts = accepted.parts ?? [];
  const parsedParts = parsed.parts ?? [];
  const acceptedTextParts = acceptedParts.filter((part) => part.type === "text");
  const acceptedAttachmentParts = acceptedParts.filter((part) => part.type !== "text");
  const parsedAttachmentParts = parsedParts.filter(
    (part) => part.type === "image_reference" || part.type === "attachment_reference",
  );
  return {
    ...accepted,
    id: parsed.id ?? accepted.id,
    latest: parsed.latest,
    parts: [
      ...acceptedTextParts,
      ...(parsedAttachmentParts.length > 0 ? parsedAttachmentParts : acceptedAttachmentParts),
    ],
  };
}

function mergeAcceptedComposerMessages(
  parsedMessages: readonly ChatMessage[],
  acceptedMessages: readonly AcceptedComposerMessage[],
): ChatMessage[] {
  if (acceptedMessages.length === 0) return [...parsedMessages];
  const next = [...parsedMessages];
  const replacedIndexes = new Set<number>();
  let inserted = 0;

  for (const accepted of acceptedMessages) {
    const replacement = accepted.message;
    const matchIndex = acceptedComposerMatchIndex(next, accepted.pending, replacedIndexes);
    if (matchIndex >= 0) {
      next[matchIndex] = mergeAcceptedComposerMessage(next[matchIndex]!, replacement);
      replacedIndexes.add(matchIndex);
      continue;
    }

    if (accepted.settled) continue;
    const insertAt = Math.min(accepted.baselineMessageCount + inserted, next.length);
    next.splice(insertAt, 0, replacement);
    inserted += 1;
  }

  return next;
}

function isMultiplexedShare(summary: SharedSessionSummary | null): boolean {
  if (!summary) return false;
  if (summary.mode === "multi") return true;
  return (
    summary.participants.some(
      (participant) => participant.role !== "owner" && participant.status === "active",
    ) || summary.invites.some((invite) => invite.status === "pending")
  );
}

export default function ChatScreen() {
  const params = useLocalSearchParams<{
    focusToken?: string | string[];
    ownerUserId?: string | string[];
    sessionId?: string | string[];
    shareId?: string | string[];
  }>();
  const routeOwnerUserId = singleRouteParam(params.ownerUserId);
  const sessionId = singleRouteParam(params.sessionId);
  const routeShareId = singleRouteParam(params.shareId);
  const sessionKey = sessionId ?? "";
  const { project, projectPath, endpoint: serviceEndpoint } = useRouteProject();
  const stateProjectPath = projectPath ?? "";
  const desktopState = useAtomValue(desktopStateFamily(stateProjectPath));
  const worktreeGroups = useAtomValue(worktreeGroupsFamily(stateProjectPath));
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const markOutputInterrupted = useSetAtom(markOutputInterruptedAtom);
  const clearLocalInterruptHold = useSetAtom(clearLocalInterruptHoldAtom);
  const transcript = useAtomValue(transcriptFamily(sessionKey));
  const activity = useAtomValue(activityFamily(sessionKey));
  const activityText = useAtomValue(activityTextFamily(sessionKey));
  const relayConfigured = useAtomValue(relayConfiguredAtom);
  const relayStatus = useAtomValue(relayStatusAtom);
  const activeShare = useRouteShare();
  const setLegacyActiveShare = useSetAtom(activeSharedSessionAtom);
  const setAcceptedShares = useSetAtom(acceptedSharedSessionsAtom);
  const { getToken } = useAuth();
  const { user } = useUser();
  const router = useRouter();
  const pathname = usePathname();
  const { width, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible(Platform.OS !== "web");
  const appVisible = useAppVisible();
  const [token, setToken] = useState<string | null>(null);
  const [sharePanelOpen, setSharePanelOpen] = useState(false);
  const [shareDetailsExpanded, setShareDetailsExpanded] = useState(false);
  const [managePanelOpen, setManagePanelOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteStatus, setInviteStatus] = useState<string | null>(null);
  const [shareSummary, setShareSummary] = useState<SharedSessionSummary | null>(null);
  const [shareSummaryCheckedKey, setShareSummaryCheckedKey] = useState<string | null>(null);
  const [shareAction, setShareAction] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [draftHasContent, setDraftHasContent] = useState(false);
  const [pendingComposerAck, setPendingComposerAck] = useState<PendingComposerAck | null>(null);
  const [acceptedComposerMessages, setAcceptedComposerMessages] = useState<
    AcceptedComposerMessage[]
  >([]);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [sendBusy, setSendBusy] = useState(false);
  const [composerWidth, setComposerWidth] = useState(0);
  const [composerInputContentHeight, setComposerInputContentHeight] =
    useState(COMPOSER_INPUT_MIN_HEIGHT);
  const [sendError, setSendError] = useState<string | null>(null);
  const [lastConnectedEndpoint, setLastConnectedEndpoint] = useState<{
    endpoint: ServiceEndpoint;
    projectPath: string;
  } | null>(null);
  const activeShareForRoute =
    activeShare && activeShare.sessionId === sessionId ? activeShare : null;
  const isCanonicalSharedRoute = Boolean(
    pathname.startsWith("/shares/") && routeOwnerUserId && routeShareId && sessionId,
  );
  const isSharedSessionView = Boolean(activeShareForRoute);
  const isSharedConversation =
    isCanonicalSharedRoute || isSharedSessionView || isMultiplexedShare(shareSummary);
  const canUseOwnerControls = !isSharedSessionView;
  const userEmail =
    user?.primaryEmailAddress?.emailAddress?.trim() ||
    user?.emailAddresses?.[0]?.emailAddress?.trim() ||
    undefined;
  const userName = user?.fullName?.trim() || user?.username?.trim() || userEmail || undefined;
  const currentShareParticipant = useMemo(() => {
    if (!shareSummary) return null;
    return (
      shareSummary.participants.find(
        (participant) =>
          participant.status === "active" &&
          (participant.userId === user?.id ||
            (userEmail ? participant.email === userEmail : false)),
      ) ?? null
    );
  }, [shareSummary, user?.id, userEmail]);
  const sharedChatActor = useMemo(
    () =>
      resolveSharedChatActor({
        currentParticipant: currentShareParticipant,
        displayName: userName,
        email: userEmail,
        isCanonicalSharedRoute,
        isSharedConversation,
        routeOwnerUserId,
        userId: user?.id,
      }),
    [
      currentShareParticipant,
      isCanonicalSharedRoute,
      isSharedConversation,
      routeOwnerUserId,
      user?.id,
      userEmail,
      userName,
    ],
  );
  const visibleShareInvites = useMemo(
    () => shareSummary?.invites.filter((invite) => invite.status !== "accepted") ?? [],
    [shareSummary],
  );
  const sharedChatDisplayName = currentShareParticipant?.displayName ?? userName ?? "guest";
  const sharedChatParticipantCount = shareSummary?.participants.length;
  const currentUserIsShareOwner = Boolean(
    user?.id &&
    (shareSummary?.ownerUserId === user.id ||
      activeShareForRoute?.ownerUserId === user.id ||
      (isCanonicalSharedRoute && routeOwnerUserId === user.id)),
  );
  const canManageShare = Boolean(
    shareSummary?.ownerUserId && user?.id === shareSummary.ownerUserId,
  );
  const shouldLoadShareSummary = Boolean(
    token &&
    sessionId &&
    (isCanonicalSharedRoute ||
      activeShareForRoute ||
      sharePanelOpen ||
      (relayConfigured && project?.path)),
  );
  const shareSummaryRequestKey = useMemo(
    () =>
      token && sessionId
        ? isCanonicalSharedRoute && routeOwnerUserId && routeShareId
          ? `share:${routeOwnerUserId}:${routeShareId}:${sessionId}`
          : activeShareForRoute
            ? `share:${activeShareForRoute.ownerUserId}:${activeShareForRoute.shareId}:${sessionId}`
            : relayConfigured && project?.path
              ? `owner:${project.path}:${sessionId}`
              : null
        : null,
    [
      activeShareForRoute,
      isCanonicalSharedRoute,
      project?.path,
      relayConfigured,
      routeOwnerUserId,
      routeShareId,
      sessionId,
      token,
    ],
  );
  const ownerShareStatusPending = Boolean(
    !isSharedSessionView &&
    relayConfigured &&
    token &&
    project?.path &&
    sessionId &&
    shareSummaryRequestKey &&
    shareSummaryCheckedKey !== shareSummaryRequestKey,
  );
  const sendBusyRef = useRef(false);
  const composerInputRef = useRef<TextInput | null>(null);
  const chatScrollRef = useRef<ChatScrollHandle | null>(null);
  const chatScrollMetricsRef = useRef<ChatScrollMetrics>({
    contentHeight: 0,
    offsetY: 0,
    viewportHeight: 0,
  });
  const chatScrollPolicyRef = useRef<ChatScrollPolicy>(createChatScrollPolicy());
  const chatScrollFrameRef = useRef<number | null>(null);
  const chatInitialLayoutKeyRef = useRef<string | null>(null);
  const activeComposerDraftKeyRef = useRef<string | null>(null);
  const sendOperationIdRef = useRef(0);
  const interruptInFlightRef = useRef(false);
  const composerDraftSnapshotRef = useRef<ComposerDraftSnapshot>({
    draft: "",
    inputContentHeight: COMPOSER_INPUT_MIN_HEIGHT,
    pendingAttachments: [],
  });
  const session = sessionId
    ? (desktopState?.sessions.find((s) => s.id === sessionId) ??
      (activeShareForRoute ? sessionFromActiveShare(activeShareForRoute) : null))
    : null;
  const routeSessionMissing = Boolean(
    sessionId && desktopState && !session && !activeShareForRoute,
  );
  const canManageTeammates =
    canUseOwnerControls &&
    session !== null &&
    session.status !== "offline" &&
    session.status !== "exited";
  const composerDraftKey = useMemo(() => {
    if (!sessionId) return null;
    if (activeShareForRoute) {
      return [
        "share",
        activeShareForRoute.ownerUserId,
        activeShareForRoute.shareId,
        activeShareForRoute.projectRoot,
        sessionId,
      ].join(":");
    }
    if (stateProjectPath) return ["project", stateProjectPath, sessionId].join(":");
    return ["session", sessionId].join(":");
  }, [activeShareForRoute, sessionId, stateProjectPath]);

  useEffect(() => {
    composerDraftSnapshotRef.current = {
      draft,
      inputContentHeight: composerInputContentHeight,
      pendingAttachments,
    };
  }, [composerInputContentHeight, draft, pendingAttachments]);

  useEffect(() => {
    const previousKey = activeComposerDraftKeyRef.current;
    if (previousKey && previousKey !== composerDraftKey) {
      rememberComposerDraft(previousKey, composerDraftSnapshotRef.current);
    }

    activeComposerDraftKeyRef.current = composerDraftKey;
    const saved = composerDraftKey ? composerDraftsByKey.get(composerDraftKey) : undefined;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the composer is re-seeded from the draft store when the conversation changes
    setDraft(saved?.draft ?? "");
    setDraftHasContent(hasComposerDraftContent(saved?.draft ?? ""));
    setPendingAttachments(saved?.pendingAttachments ? [...saved.pendingAttachments] : []);
    setComposerInputContentHeight(saved?.inputContentHeight ?? COMPOSER_INPUT_MIN_HEIGHT);
    setPendingComposerAck(null);
    setAcceptedComposerMessages([]);
    setSendBusy(false);
    composerInputRef.current?.blur();
    sendBusyRef.current = false;
    setSendError(null);
  }, [composerDraftKey]);

  useEffect(() => {
    return () => {
      rememberComposerDraft(activeComposerDraftKeyRef.current, composerDraftSnapshotRef.current);
    };
  }, []);

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

  useEffect(() => {
    if (!isSharedSessionView) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a shared view opens straight into the share panel
    setManagePanelOpen(false);
    setSharePanelOpen(true);
  }, [isSharedSessionView]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset expansion when switching shares
    setShareDetailsExpanded(false);
  }, [activeShare?.shareId, sessionId]);

  /**
   * Driven by the runtime's own activity state, not by whether bytes arrived.
   * Undefined means the service does not report it — not that the agent is idle
   * — so nothing is claimed in that case.
   */
  const activityLabel = useMemo(
    () => agentActivityLabel(activity, activityText),
    [activity, activityText],
  );
  const activityLabelShimmer = shouldShimmerAgentActivityLabel(activity, activityLabel);

  const wideControls = composerWidth >= COMPOSER_CONTROL_LABEL_WIDTH;
  const compactHeaderActions = width < 430;
  const headerActionsMaxWidth =
    Platform.OS === "web" ? undefined : Math.max(MIN_HEADER_ACTIONS_WIDTH, width * 0.52);
  const effectiveComposerInputContentHeight = composerContentHeightForDraft(
    draft,
    composerInputContentHeight,
  );
  const composerInputScrollEnabled =
    effectiveComposerInputContentHeight > COMPOSER_INPUT_MAX_HEIGHT - COMPOSER_INPUT_HEIGHT_SLOP;
  const composerInputHeight = composerInputHeightForContentHeight(
    effectiveComposerInputContentHeight,
  );
  const composerExtraContentPadding = useSharedValue(0);
  const composerFooterBottomPadding =
    Platform.OS === "web" || keyboardVisible
      ? COMPOSER_FOOTER_VERTICAL_PADDING
      : COMPOSER_FOOTER_VERTICAL_PADDING + resolveChromeBottomInset(insets.bottom);
  const heartbeatReady = isSharedSessionView || !relayConfigured || relayStatus === "connected";
  const endpointHost = serviceEndpoint?.host ?? null;
  const endpointPort = serviceEndpoint?.port ?? null;
  const displayServiceEndpoint =
    serviceEndpoint ??
    (lastConnectedEndpoint?.projectPath === stateProjectPath
      ? lastConnectedEndpoint.endpoint
      : null);
  const serviceDisconnected =
    !routeSessionMissing && !serviceEndpoint && Boolean(displayServiceEndpoint);
  const useScrollableNativeHeader = Platform.OS !== "web";
  const chatBubbleMaxWidth = Math.max(
    260,
    Math.floor((width - CHAT_SCROLL_HORIZONTAL_PADDING) * CHAT_ASSISTANT_BUBBLE_MAX_RATIO),
  );

  useEffect(() => {
    composerExtraContentPadding.value = Math.max(
      0,
      composerInputHeight - COMPOSER_INPUT_MIN_HEIGHT,
    );
  }, [composerExtraContentPadding, composerInputHeight]);
  const chatDividerWidth = Math.max(
    MIN_CHAT_DIVIDER_WIDTH,
    Math.min(
      MAX_CHAT_DIVIDER_WIDTH,
      Math.floor(
        (chatBubbleMaxWidth - CHAT_SCROLL_HORIZONTAL_PADDING) / CHAT_DIVIDER_APPROX_CHAR_WIDTH -
          CHAT_DIVIDER_WIDTH_SAFETY,
      ),
    ),
  );

  const cancelPendingChatScroll = useCallback(() => {
    if (chatScrollFrameRef.current === null) return;
    cancelAnimationFrame(chatScrollFrameRef.current);
    chatScrollFrameRef.current = null;
  }, []);

  const executeChatScrollCommand = useCallback(
    (command: ChatScrollCommand) => {
      if (command.kind === "none") return;
      cancelPendingChatScroll();
      chatScrollFrameRef.current = requestAnimationFrame(() => {
        chatScrollFrameRef.current = null;
        if (
          command.reason !== "initial" &&
          command.reason !== "navigation" &&
          chatScrollPolicyRef.current.intent !== "pinned"
        ) {
          return;
        }
        chatScrollRef.current?.scrollToEnd({ animated: command.animated });
      });
    },
    [cancelPendingChatScroll],
  );

  useEffect(() => cancelPendingChatScroll, [cancelPendingChatScroll]);

  useFocusEffect(
    useCallback(() => {
      chatInitialLayoutKeyRef.current = sessionId ?? null;
      chatScrollPolicyRef.current = chatPolicyAfterNavigationFocus();
      const interaction = InteractionManager.runAfterInteractions(() => {
        executeChatScrollCommand(chatCommandForNavigationFocus());
      });
      return () => interaction.cancel();
    }, [executeChatScrollCommand, sessionId]),
  );

  const handleChatLayout = useCallback(
    (event: LayoutChangeEvent) => {
      chatScrollMetricsRef.current = {
        ...chatScrollMetricsRef.current,
        viewportHeight: event.nativeEvent.layout.height,
      };
      const layoutKey = sessionId ?? "unscoped";
      if (chatInitialLayoutKeyRef.current !== layoutKey) {
        chatInitialLayoutKeyRef.current = layoutKey;
        executeChatScrollCommand(chatCommandForInitialLayout());
        return;
      }
      executeChatScrollCommand(chatCommandForContentChange(chatScrollPolicyRef.current));
    },
    [executeChatScrollCommand, sessionId],
  );

  const handleChatContentSizeChange = useCallback(
    (_contentWidth: number, contentHeight: number) => {
      chatScrollMetricsRef.current = {
        ...chatScrollMetricsRef.current,
        contentHeight,
      };
      executeChatScrollCommand(chatCommandForContentChange(chatScrollPolicyRef.current));
    },
    [executeChatScrollCommand],
  );

  const handleChatScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const metrics: ChatScrollMetrics = {
        contentHeight: event.nativeEvent.contentSize.height,
        offsetY: event.nativeEvent.contentOffset.y,
        viewportHeight: event.nativeEvent.layoutMeasurement.height,
      };
      chatScrollMetricsRef.current = metrics;
      const nextPolicy = chatPolicyAfterUserScroll(chatScrollPolicyRef.current, metrics);
      if (nextPolicy.intent === "reading") {
        cancelPendingChatScroll();
      }
      chatScrollPolicyRef.current = nextPolicy;
    },
    [cancelPendingChatScroll],
  );

  useEffect(() => {
    if (!endpointHost || !endpointPort) return;
    const timer = setTimeout(() => {
      setLastConnectedEndpoint((current) => {
        if (
          current?.projectPath === stateProjectPath &&
          current.endpoint.host === endpointHost &&
          current.endpoint.port === endpointPort
        ) {
          return current;
        }
        return {
          endpoint: { host: endpointHost, port: endpointPort },
          projectPath: stateProjectPath,
        };
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [endpointHost, endpointPort, stateProjectPath]);

  const { refreshOutputSnapshot } = useAgentOutputFeed({
    appVisible,
    enabled: heartbeatReady && !routeSessionMissing,
    endpoint: serviceEndpoint ?? null,
    mode: "chat",
    sessionId,
    startLine: CHAT_OUTPUT_CAPTURE_START_LINE,
    token,
  });

  const parsedMessages = useMemo<ChatMessage[]>(
    () =>
      toChatMessages(transcript, sessionKey, {
        shared: isSharedConversation,
      }),
    [transcript, sessionKey, isSharedConversation],
  );
  const allMessages = useMemo<ChatMessage[]>(() => {
    return mergeAcceptedComposerMessages(parsedMessages, acceptedComposerMessages);
  }, [acceptedComposerMessages, parsedMessages]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- parsed transcript updates settle local accepted composer echoes
    setAcceptedComposerMessages((current) => {
      let changed = false;
      const next = current.flatMap((accepted) => {
        const hasParsedMatch = acceptedComposerMatchIndex(parsedMessages, accepted.pending) >= 0;
        if (hasParsedMatch && !accepted.settled) {
          changed = true;
          return [{ ...accepted, settled: true }];
        }
        if (!hasParsedMatch && accepted.settled) {
          changed = true;
          return [];
        }
        return [accepted];
      });
      return changed ? next : current;
    });
  }, [parsedMessages]);

  const userMessageCount = useMemo(
    () => allMessages.reduce((count, message) => count + (message.role === "user" ? 1 : 0), 0),
    [allMessages],
  );
  const composerSendAcknowledged = pendingComposerAck
    ? userMessageAcknowledgesComposerSend(allMessages, pendingComposerAck)
    : false;
  const composerAwaitingAck = pendingComposerAck !== null && !pendingComposerAck.timedOut;

  useEffect(() => {
    if (!pendingComposerAck) return;
    if (!composerSendAcknowledged) return;
    const draftStillMatches = draft === pendingComposerAck.text;
    const attachmentsStillMatch =
      pendingAttachments.length === pendingComposerAck.attachmentFilenames.length &&
      pendingAttachments.every(
        (attachment, index) =>
          attachment.filename === pendingComposerAck.attachmentFilenames[index],
      );

    if (draftStillMatches && attachmentsStillMatch) {
      releasePendingAttachmentPreviews(pendingAttachments);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- terminal transcript ack clears only the matched pending send
      setDraft("");
      setDraftHasContent(false);
      setPendingAttachments([]);
      setComposerInputContentHeight(COMPOSER_INPUT_MIN_HEIGHT);
    }
    setSendError(null);
    setPendingComposerAck(null);
    if (draftStillMatches && attachmentsStillMatch && composerDraftKey) {
      composerDraftsByKey.delete(composerDraftKey);
    }
  }, [composerDraftKey, composerSendAcknowledged, draft, pendingAttachments, pendingComposerAck]);

  useEffect(() => {
    if (!pendingComposerAck) return;
    if (pendingComposerAck.timedOut) return;
    const pendingId = pendingComposerAck.id;
    const timer = setTimeout(() => {
      setPendingComposerAck((current) => {
        if (current?.id !== pendingId) return current;
        if (current.showTimeoutError) setSendError(COMPOSER_SEND_TIMEOUT_MESSAGE);
        return { ...current, timedOut: true };
      });
    }, COMPOSER_SEND_ACK_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [pendingComposerAck]);

  // The worktree leads, as it does in Exposé: it is what the session is, where the
  // generated id is only how it is addressed. The tone comes from the project's
  // ordered worktree list so the colour agrees with the sidebar and the TUI.
  const sessionWorktreePath = session?.worktreePath ?? null;
  const isMainCheckoutSession =
    Boolean(
      sessionWorktreePath &&
      desktopState?.mainCheckoutPath &&
      sessionWorktreePath === desktopState.mainCheckoutPath,
    ) ||
    (!sessionWorktreePath && Boolean(desktopState?.mainCheckoutInfo));
  const fallbackWorktreeName =
    session?.worktreeName ??
    (isMainCheckoutSession ? (desktopState?.mainCheckoutInfo?.name ?? "Main Checkout") : null) ??
    basenamePath(sessionWorktreePath);
  const fallbackWorktreeBranch =
    session?.worktreeBranch ??
    (isMainCheckoutSession ? desktopState?.mainCheckoutInfo?.branch : undefined);
  const worktree = routeSessionMissing
    ? undefined
    : worktreeIdentity(worktreeGroups, {
        path: sessionWorktreePath ?? undefined,
        name: fallbackWorktreeName ?? undefined,
        projectRoot: stateProjectPath,
      });
  const projectHeaderName =
    project?.name ?? basenamePath(stateProjectPath) ?? basenamePath(sessionWorktreePath);
  const headerTone =
    worktree?.tone ??
    (isMainCheckoutSession
      ? worktreeTone({
          path: sessionWorktreePath ?? desktopState?.mainCheckoutPath,
          name: fallbackWorktreeName ?? undefined,
          projectRoot: stateProjectPath,
          projectName: projectHeaderName,
        })
      : undefined);
  const headerWorktreeName = worktree?.name ?? fallbackWorktreeName;
  const headerWorktreeBranch = worktree?.branch ?? fallbackWorktreeBranch;
  const sessionTitle = routeSessionMissing
    ? "Agent unavailable"
    : [projectHeaderName, headerWorktreeName].filter(Boolean).join(" / ") ||
      session?.label ||
      sessionId ||
      "Unknown session";
  const sessionToolLabel =
    routeSessionMissing || compactHeaderActions ? "" : (session?.command ?? "");
  // Status and branch, then the id last: the id is the only part that never helps
  // you tell two of these apart at a glance, but it is still what you quote in a
  // bug report, so it stays reachable rather than gone.
  const sessionSubtitle = routeSessionMissing
    ? `${sessionId} · not found`
    : [headerWorktreeBranch, session?.status ?? "unknown", session?.command, sessionId]
        .filter(Boolean)
        .join(" · ");
  const composerSendText =
    draftHasContent && serviceEndpoint && sessionId && !routeSessionMissing && !sendBusy
      ? draft
      : null;
  const hasPendingAttachments = pendingAttachments.length > 0;
  const canSendMessage = Boolean(
    serviceEndpoint &&
    sessionId &&
    session &&
    !sendBusy &&
    !composerAwaitingAck &&
    !ownerShareStatusPending &&
    (composerSendText || hasPendingAttachments),
  );

  async function handleSendMessage() {
    const text = normalizeComposerDraft(composerSendText ?? "") ?? "";
    const attachments = [...pendingAttachments];
    if (
      !serviceEndpoint ||
      !sessionId ||
      !session ||
      ownerShareStatusPending ||
      sendBusyRef.current ||
      composerAwaitingAck ||
      (!text && attachments.length === 0)
    ) {
      return;
    }
    sendBusyRef.current = true;
    const sendOperationId = sendOperationIdRef.current + 1;
    sendOperationIdRef.current = sendOperationId;
    const sendComposerDraftKey = composerDraftKey;
    clearLocalInterruptHold(sessionId);
    const baselineUserMessageCount = userMessageCount;
    const baselineMessageCount = allMessages.length;
    setSendBusy(true);
    setSendError(null);
    const sendStillOwnsActiveComposer = () =>
      sendOperationIdRef.current === sendOperationId &&
      activeComposerDraftKeyRef.current === sendComposerDraftKey;
    try {
      for (let idx = 0; idx < attachments.length; idx += 1) {
        const attachment = attachments[idx];
        if (attachment.uploadedAttachmentId) continue;
        const uploaded = await uploadAttachment(
          serviceEndpoint,
          {
            kind: attachment.kind,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            dataBase64: await pickedAttachmentDataBase64(attachment),
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
        ...(sharedChatActor ? { sharedChatActor } : {}),
      });
      const acceptedPending: PendingComposerAck = {
        attachmentCount: attachments.length,
        attachmentIds: attachments
          .map((attachment) => attachment.uploadedAttachmentId)
          .filter((id): id is string => Boolean(id)),
        attachmentFilenames: attachments.map((attachment) => attachment.filename),
        baselineUserMessageCount,
        id: Date.now(),
        showTimeoutError: false,
        text,
        timedOut: false,
      };
      const clientMessageId = `composer:${sessionKey}:${acceptedPending.id}`;
      const acceptedMessage = buildAcceptedComposerMessage({
        attachments,
        clientMessageId,
        sessionKey,
        text,
      });
      releasePendingAttachmentPreviews(attachments);
      if (!sendStillOwnsActiveComposer()) {
        if (sendComposerDraftKey) composerDraftsByKey.delete(sendComposerDraftKey);
        return;
      }
      setAcceptedComposerMessages((current) =>
        [
          ...current,
          {
            baselineMessageCount,
            clientMessageId,
            message: acceptedMessage,
            pending: acceptedPending,
          },
        ].slice(-20),
      );
      setDraft("");
      setDraftHasContent(false);
      setPendingAttachments([]);
      setComposerInputContentHeight(COMPOSER_INPUT_MIN_HEIGHT);
      setPendingComposerAck(null);
      if (sendComposerDraftKey) composerDraftsByKey.delete(sendComposerDraftKey);
      void refreshOutputSnapshot().catch(() => {});
    } catch (err) {
      if (!sendStillOwnsActiveComposer()) {
        if (sendComposerDraftKey) {
          rememberComposerDraft(sendComposerDraftKey, {
            draft: text,
            inputContentHeight: composerInputContentHeight,
            pendingAttachments: attachments,
          });
        } else {
          releasePendingAttachmentPreviews(attachments);
        }
        return;
      }
      setPendingComposerAck(
        isTransientRequestError(err)
          ? {
              attachmentCount: attachments.length,
              attachmentIds: attachments
                .map((attachment) => attachment.uploadedAttachmentId)
                .filter((id): id is string => Boolean(id)),
              attachmentFilenames: attachments.map((attachment) => attachment.filename),
              baselineUserMessageCount,
              id: Date.now(),
              showTimeoutError: true,
              text,
              timedOut: true,
            }
          : null,
      );
      setDraft(text);
      setDraftHasContent(hasComposerDraftContent(text));
      setPendingAttachments(attachments);
      setSendError(formatComposerSendFailure(err));
    } finally {
      if (sendOperationIdRef.current === sendOperationId) {
        sendBusyRef.current = false;
        setSendBusy(false);
      }
    }
  }

  async function handleAttachAttachment() {
    if (sendBusy || sendBusyRef.current || composerAwaitingAck) return;
    setSendError(null);
    try {
      const remainingSlots = MAX_PENDING_ATTACHMENTS - pendingAttachments.length;
      if (remainingSlots <= 0) {
        setSendError(`Attach up to ${MAX_PENDING_ATTACHMENTS} files.`);
        return;
      }
      const picked = await pickAttachments({ selectionLimit: remainingSlots });
      appendPendingAttachments(picked);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleDropAttachments(attachments: PickedAttachment[]) {
    if (sendBusy || sendBusyRef.current || composerAwaitingAck) {
      releasePendingAttachmentPreviews(attachments);
      return;
    }
    setSendError(null);
    appendPendingAttachments(attachments);
  }

  async function handleComposerPaste(event: {
    clipboardData?: ClipboardFileSource | null;
    nativeEvent?: { clipboardData?: ClipboardFileSource | null };
    preventDefault?: () => void;
  }) {
    if (Platform.OS !== "web" || sendBusy || sendBusyRef.current || composerAwaitingAck) return;
    const clipboardData = event.clipboardData ?? event.nativeEvent?.clipboardData;
    if (!clipboardDataHasFile(clipboardData)) return;
    event.preventDefault?.();
    setSendError(null);
    try {
      const attachments = await attachmentsFromClipboardData(clipboardData);
      if (attachments.length === 0) {
        setSendError("Pasted files are not supported.");
        return;
      }
      appendPendingAttachments(attachments);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    }
  }

  function appendPendingAttachments(attachments: PickedAttachment[]) {
    if (attachments.length === 0) return;
    const slots = MAX_PENDING_ATTACHMENTS - pendingAttachments.length;
    if (slots <= 0) {
      releasePendingAttachmentPreviews(attachments);
      setSendError(`Attach up to ${MAX_PENDING_ATTACHMENTS} files.`);
      return;
    }
    const accepted = attachments.slice(0, slots);
    releasePendingAttachmentPreviews(attachments.slice(slots));
    setPendingAttachments((current) => [...current, ...accepted]);
    setSendError(
      accepted.length < attachments.length
        ? `Attach up to ${MAX_PENDING_ATTACHMENTS} files.`
        : null,
    );
  }

  function removePendingAttachment(id: string) {
    setPendingAttachments((current) => {
      releasePendingAttachmentPreviews(current.filter((attachment) => attachment.id === id));
      return current.filter((attachment) => attachment.id !== id);
    });
  }

  /**
   * Interrupt is offered unconditionally rather than only while we believe the
   * agent is busy. It is a single ESC, which an idle tool ignores, so gating it
   * on our guess about busy-ness only makes it unavailable exactly when the
   * guess is wrong.
   */
  async function handleInterrupt() {
    if (!endpointHost || !endpointPort || !sessionId) return;
    markOutputInterrupted(sessionId);
    if (interruptInFlightRef.current) return;
    interruptInFlightRef.current = true;
    setSendError(null);
    try {
      await interruptLivePane({ host: endpointHost, port: endpointPort }, sessionId, { token });
      void refreshOutputSnapshot("interrupt").catch(() => {});
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Could not interrupt the agent.");
    } finally {
      interruptInFlightRef.current = false;
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

  function handleComposerContentSizeChange(
    event: NativeSyntheticEvent<TextInputContentSizeChangeEventData>,
  ) {
    const nextHeight = Math.max(
      COMPOSER_INPUT_MIN_HEIGHT,
      Math.ceil(event.nativeEvent.contentSize.height),
    );
    setComposerInputContentHeight((current) => (current === nextHeight ? current : nextHeight));
  }

  function handleDraftChange(text: string) {
    setDraft(text);
    const nextHasContent = hasComposerDraftContent(text);
    setDraftHasContent((current) => (current === nextHasContent ? current : nextHasContent));
    if (!text) setComposerInputContentHeight(COMPOSER_INPUT_MIN_HEIGHT);
    if (sendError) setSendError(null);
  }

  const composerPasteProps =
    Platform.OS === "web"
      ? ({ onPaste: handleComposerPaste } as Record<string, unknown>)
      : undefined;

  useEffect(() => {
    if (!shouldLoadShareSummary) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing a stale summary is the effect's whole job
      if (!activeShareForRoute && !sharePanelOpen) setShareSummary(null);
      return;
    }
    let cancelled = false;
    async function refreshShareSummary() {
      if (!token || !sessionId) return;
      if ((isCanonicalSharedRoute && routeOwnerUserId && routeShareId) || activeShareForRoute) {
        const ownerUserId = routeOwnerUserId ?? activeShareForRoute!.ownerUserId;
        const shareId = routeShareId ?? activeShareForRoute!.shareId;
        const result = await getShare(ownerUserId, shareId, { token });
        if (!cancelled) {
          setShareSummary(result.share);
          const [acceptedShare] = activeSessionsFromShareSummaries([result.share]);
          if (acceptedShare) {
            setAcceptedShares((current) => {
              const next = mergeActiveSharedSessions(current, acceptedShare);
              return sharedSessionsEqual(current, next) ? current : next;
            });
            setLegacyActiveShare(acceptedShare);
          }
          setShareSummaryCheckedKey(shareSummaryRequestKey);
        }
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
        setShareSummaryCheckedKey(shareSummaryRequestKey);
      }
    }
    void refreshShareSummary().catch((err) => {
      if (!cancelled) setShareSummaryCheckedKey(shareSummaryRequestKey);
      if (!cancelled && sharePanelOpen) {
        setInviteStatus(err instanceof Error ? err.message : String(err));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [
    activeShareForRoute,
    isCanonicalSharedRoute,
    project?.path,
    routeOwnerUserId,
    routeShareId,
    sessionId,
    setAcceptedShares,
    setLegacyActiveShare,
    sharePanelOpen,
    shareSummaryRequestKey,
    shouldLoadShareSummary,
    token,
  ]);

  async function handleSendInvite() {
    const email = inviteEmail.trim();
    if (activeShare || !project?.path || !sessionId || !email || inviteBusy) return;
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
    if (!canManageShare || !token || !shareSummary || shareAction) return;
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

  async function handleRevokeInvite(inviteId: string, email: string) {
    if (!canManageShare || !token || !shareSummary || shareAction) return;
    const actionKey = `invite:${inviteId}`;
    setShareAction(actionKey);
    setInviteStatus(null);
    try {
      const result = await revokeShareInvite(shareSummary.ownerUserId, shareSummary.id, inviteId, {
        token,
      });
      setShareSummary(result.share);
      setInviteStatus(`Invite revoked for ${email}.`);
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
      setAcceptedShares((shares) =>
        shares.filter(
          (share) =>
            share.ownerUserId !== activeShare.ownerUserId || share.shareId !== activeShare.shareId,
        ),
      );
      setLegacyActiveShare(null);
      setShareSummary(null);
      router.replace("/shares");
    } catch (err) {
      setInviteStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setShareAction(null);
    }
  }

  function goBack() {
    blurWebActiveElement();
    if (isSharedSessionView) {
      router.replace("/shares");
      return;
    }
    if (router.canGoBack()) router.back();
    else router.replace(parentViewHrefForPath(pathname, projectPath));
  }

  const composerFooterContent = (
    <View
      className="border-t border-border bg-background px-3 py-3"
      style={{
        flexShrink: 0,
        paddingBottom: composerFooterBottomPadding,
      }}
    >
      {pendingAttachments.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-2">
          <View className="flex-row gap-2">
            {pendingAttachments.map((attachment) => (
              <View
                key={attachment.id}
                className="w-24 rounded-md border border-border bg-card p-1"
              >
                {attachment.kind === "image" || attachment.mimeType.startsWith("image/") ? (
                  <Image
                    source={{ uri: attachment.previewUri }}
                    className="h-14 w-full rounded"
                    resizeMode="cover"
                  />
                ) : (
                  <View className="h-14 w-full items-center justify-center rounded bg-muted px-1">
                    <Text className="text-center text-[10px] font-semibold uppercase text-muted-foreground">
                      {attachment.kind}
                    </Text>
                  </View>
                )}
                <Text className="mt-1 text-[10px] text-muted-foreground" numberOfLines={1}>
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
      One card holding the message and the controls that act on it, so the
      composer reads as a single object rather than a field with things parked
      either side of it. The controls sit under the text because that is where
      the width is: flanking them costs a third of a phone screen, and the text
      is the part that needs it.
    */}
      <AttachmentDropZone
        disabled={
          sendBusy || composerAwaitingAck || pendingAttachments.length >= MAX_PENDING_ATTACHMENTS
        }
        onDropAttachments={handleDropAttachments}
        onDropRejected={setSendError}
        onPasteAttachments={handleDropAttachments}
        onPasteRejected={setSendError}
      >
        {({ dragging }) => (
          <ComposerFocusShell
            dragging={dragging}
            sending={sendBusy || composerAwaitingAck}
            onLayout={(event: LayoutChangeEvent) =>
              setComposerWidth(event.nativeEvent.layout.width)
            }
          >
            {({ onBlur, onFocus }) => (
              <>
                <TextInput
                  ref={composerInputRef}
                  accessibilityLabel="Message the agent"
                  nativeID={CHAT_INPUT_NATIVE_ID}
                  autoComplete="off"
                  autoCapitalize="sentences"
                  importantForAutofill="no"
                  inputMode="text"
                  textContentType="none"
                  onFocus={onFocus}
                  onBlur={onBlur}
                  value={draft}
                  onChangeText={handleDraftChange}
                  onKeyPress={handleComposerKeyPress}
                  {...COMPOSER_WEB_INPUT_PROPS}
                  {...composerPasteProps}
                  onContentSizeChange={handleComposerContentSizeChange}
                  placeholder="Ask the agent…"
                  placeholderTextColor="#71717a"
                  multiline
                  lineBreakStrategyIOS="standard"
                  editable={!sendBusy && !composerAwaitingAck}
                  scrollEnabled={composerInputScrollEnabled}
                  textBreakStrategy="balanced"
                  className="w-full text-sm text-foreground"
                  style={[
                    NO_BROWSER_FOCUS_RING,
                    {
                      alignSelf: "stretch",
                      flexGrow: 0,
                      flexShrink: 1,
                      fontSize: COMPOSER_INPUT_FONT_SIZE,
                      height: composerInputHeight,
                      lineHeight: COMPOSER_INPUT_LINE_HEIGHT,
                      maxWidth: "100%",
                      maxHeight: COMPOSER_INPUT_MAX_HEIGHT,
                      minHeight: COMPOSER_INPUT_MIN_HEIGHT,
                      minWidth: 0,
                      paddingHorizontal: COMPOSER_INPUT_HORIZONTAL_PADDING,
                      paddingTop: COMPOSER_INPUT_VERTICAL_PADDING,
                      paddingBottom: COMPOSER_INPUT_VERTICAL_PADDING,
                      opacity: sendBusy || composerAwaitingAck ? 0.55 : 1,
                      width: "100%",
                    },
                  ]}
                  textAlignVertical="top"
                />
                <View className="flex-row items-center gap-2">
                  <ComposerControl
                    wide={wideControls}
                    label="Attach"
                    accessibilityLabel="Attach a file"
                    icon={<Plus size={17} color={CONTROL_INK} />}
                    disabled={
                      sendBusy ||
                      composerAwaitingAck ||
                      pendingAttachments.length >= MAX_PENDING_ATTACHMENTS
                    }
                    onPress={handleAttachAttachment}
                  />
                  <View className="min-w-0 flex-1 px-1">
                    {sendError ? (
                      <View className="min-w-0 flex-row items-center gap-1.5">
                        <CircleAlert size={13} color="#f87171" />
                        <Text className="min-w-0 flex-1 text-xs text-destructive" numberOfLines={1}>
                          {sendError}
                        </Text>
                      </View>
                    ) : sendBusy || composerAwaitingAck ? (
                      <View className="min-w-0 flex-row items-center gap-1.5">
                        <ActivityIndicator size="small" color="#a1a1aa" />
                        <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                          Sending...
                        </Text>
                      </View>
                    ) : activityLabel ? (
                      <ActivityFooterLabel label={activityLabel} shimmer={activityLabelShimmer} />
                    ) : null}
                  </View>
                  {/*
                  Always offered, never revealed only while we think the agent is
                  busy. Interrupt is a single ESC, which an idle tool ignores, so
                  gating it on that guess only makes it unavailable exactly when
                  the guess is wrong.
                */}
                  {!isSharedSessionView ? (
                    <ComposerControl
                      wide={wideControls}
                      label="Stop"
                      accessibilityLabel="Interrupt the agent"
                      // Filled, because a stop is a stop and an outline reads as
                      // a checkbox at this size.
                      icon={<Square size={13} color={CONTROL_INK} fill={CONTROL_INK} />}
                      onPress={handleInterrupt}
                    />
                  ) : null}
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
              </>
            )}
          </ComposerFocusShell>
        )}
      </AttachmentDropZone>
    </View>
  );
  const composerFooter =
    Platform.OS === "web" ? (
      composerFooterContent
    ) : (
      <KeyboardStickyView style={{ flexShrink: 0 }}>{composerFooterContent}</KeyboardStickyView>
    );

  return (
    <View style={{ flex: 1 }}>
      <View className="flex-1 bg-background" style={{ flex: 1 }}>
        <View
          className="flex-1"
          style={Platform.OS === "web" ? { flexDirection: "row" } : undefined}
        >
          {Platform.OS !== "web" ? null /* sidebar lives in (main)/_layout on web */ : null}
          <View className="flex-1">
            <View style={{ flexShrink: 0 }}>
              <View className="border-b border-border px-4 py-3 flex-row items-center justify-between">
                {useScrollableNativeHeader ? (
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    style={{ flex: 1, minWidth: 0 }}
                    contentContainerStyle={{ alignItems: "center", paddingRight: 8 }}
                    keyboardShouldPersistTaps="handled"
                  >
                    <View className="flex-row items-center">
                      <Pressable
                        onPress={goBack}
                        accessibilityLabel="Back"
                        className="mr-3 h-8 w-8 items-center justify-center rounded-md border border-border active:bg-accent"
                      >
                        <ChevronLeft size={16} color="#a1a1aa" />
                      </Pressable>
                      {headerTone ? (
                        <View
                          className="mr-2.5 h-12 rounded-full"
                          style={{ width: 3, backgroundColor: headerTone }}
                        />
                      ) : null}
                      <View
                        className="mr-2"
                        style={{ width: Math.max(210, Math.min(300, width * 0.48)) }}
                      >
                        <View className="flex-row items-baseline gap-1.5">
                          <Text
                            className="text-base font-semibold text-foreground"
                            numberOfLines={1}
                            ellipsizeMode="middle"
                            style={[
                              { minWidth: 0, flexShrink: 1 },
                              headerTone ? { color: headerTone } : null,
                            ]}
                          >
                            {sessionTitle}
                          </Text>
                          {sessionToolLabel ? (
                            <Text
                              className="text-xs text-muted-foreground"
                              numberOfLines={1}
                              style={{ flexShrink: 0 }}
                            >
                              {sessionToolLabel}
                            </Text>
                          ) : null}
                        </View>
                        <Text
                          className="text-xs text-muted-foreground"
                          numberOfLines={1}
                          ellipsizeMode="middle"
                        >
                          {sessionSubtitle}
                        </Text>
                      </View>
                      {session && canUseOwnerControls ? (
                        <>
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
                              "h-8 flex-row items-center gap-1.5 rounded-md border mr-2 px-2.5",
                              managePanelOpen ? "border-primary bg-accent" : "border-border",
                            )}
                          >
                            <SlidersHorizontal
                              size={14}
                              color={managePanelOpen ? "#e4e4e7" : "#a1a1aa"}
                            />
                            <Text className="text-xs text-foreground">Manage</Text>
                          </Pressable>
                        </>
                      ) : null}
                      {session && canUseOwnerControls ? (
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
                          className="h-8 justify-center px-1"
                        >
                          <Text className="text-sm text-primary">Plan</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  </ScrollView>
                ) : (
                  <>
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
                    <View className="flex-1" style={{ minWidth: 0 }}>
                      <View className="flex-row items-baseline gap-1.5" style={{ minWidth: 0 }}>
                        <Text
                          className="text-base font-semibold text-foreground"
                          numberOfLines={1}
                          ellipsizeMode="middle"
                          style={[
                            { minWidth: 0, flexShrink: 1 },
                            headerTone ? { color: headerTone } : null,
                          ]}
                        >
                          {sessionTitle}
                        </Text>
                        {sessionToolLabel && !compactHeaderActions ? (
                          <Text
                            className="text-xs text-muted-foreground"
                            numberOfLines={1}
                            style={{ minWidth: 0, flexShrink: 1 }}
                          >
                            {sessionToolLabel}
                          </Text>
                        ) : null}
                      </View>
                      <Text
                        className="text-xs text-muted-foreground"
                        numberOfLines={1}
                        ellipsizeMode="middle"
                      >
                        {sessionSubtitle}
                      </Text>
                    </View>
                    {session ? (
                      <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        style={{ flexShrink: 0, maxWidth: headerActionsMaxWidth, minWidth: 0 }}
                        contentContainerStyle={{ alignItems: "center" }}
                      >
                        <View className="flex-row items-center">
                          {canUseOwnerControls ? (
                            <>
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
                                  "h-8 flex-row items-center gap-1.5 rounded-md border mr-2 px-2.5",
                                  managePanelOpen ? "border-primary bg-accent" : "border-border",
                                )}
                              >
                                <SlidersHorizontal
                                  size={14}
                                  color={managePanelOpen ? "#e4e4e7" : "#a1a1aa"}
                                />
                                <Text className="text-xs text-foreground">Manage</Text>
                              </Pressable>
                            </>
                          ) : null}
                          {canUseOwnerControls ? (
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
                              className="h-8 justify-center px-1"
                            >
                              <Text className="text-sm text-primary">Plan</Text>
                            </Pressable>
                          ) : null}
                        </View>
                      </ScrollView>
                    ) : null}
                  </>
                )}
              </View>
            </View>
            {/*
            Closed by default. These are settings, and pinning them above every
            conversation cost the chat ~250px on every screen for controls with
            no recorded use.
          */}
            {session && managePanelOpen && canUseOwnerControls ? (
              <View style={{ flexShrink: 0, maxHeight: Math.round(windowHeight * 0.6) }}>
                <ScrollView>
                  {compactHeaderActions && !useScrollableNativeHeader ? (
                    <View className="border-b border-border bg-card px-4 py-3">
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
              <View
                className={cn("border-b border-border bg-card px-4", activeShare ? "py-2" : "py-3")}
                style={{ flexShrink: 0 }}
              >
                {activeShare ? (
                  <>
                    <View className="flex-row items-center justify-between gap-3">
                      <Pressable
                        onPress={() => setShareDetailsExpanded((expanded) => !expanded)}
                        accessibilityRole="button"
                        accessibilityLabel="Toggle shared chat details"
                        accessibilityState={{ expanded: shareDetailsExpanded }}
                        className="flex-1 flex-row items-center gap-2 active:opacity-70"
                      >
                        <ChevronDown
                          size={16}
                          color="#a1a1aa"
                          style={{
                            transform: [{ rotate: shareDetailsExpanded ? "0deg" : "-90deg" }],
                          }}
                        />
                        <View className="flex-1">
                          <Text className="text-xs font-semibold uppercase tracking-widest text-foreground">
                            Shared chat
                          </Text>
                          <Text className="mt-1 text-xs text-muted-foreground" numberOfLines={1}>
                            Replying as {sharedChatDisplayName}
                            {sharedChatParticipantCount
                              ? ` · ${sharedChatParticipantCount} participant${
                                  sharedChatParticipantCount === 1 ? "" : "s"
                                }`
                              : ""}
                          </Text>
                        </View>
                      </Pressable>
                      {!currentUserIsShareOwner ? (
                        <Button
                          size="sm"
                          variant="outline"
                          label={shareAction ? "Leaving..." : "Leave"}
                          disabled={!token || Boolean(shareAction)}
                          onPress={handleLeaveShare}
                        />
                      ) : null}
                    </View>
                  </>
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
                {shareSummary && (!activeShare || shareDetailsExpanded) ? (
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
                            {participant.role} · {formatShareParticipantStatus(participant)}
                            {participant.email ? ` · ${participant.email}` : ""}
                          </Text>
                        </View>
                        {canManageShare &&
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
                    {canManageShare && visibleShareInvites.length > 0 ? (
                      <View className="mt-3">
                        <Text className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                          Invites
                        </Text>
                        {visibleShareInvites.map((invite) => (
                          <View
                            key={invite.id}
                            className="mt-2 flex-row items-center justify-between gap-3"
                          >
                            <View className="flex-1">
                              <Text className="text-sm text-foreground" numberOfLines={1}>
                                {invite.email}
                              </Text>
                              <Text className="text-xs text-muted-foreground" numberOfLines={1}>
                                {formatShareInviteStatus(invite)}
                              </Text>
                            </View>
                            {invite.status === "pending" ? (
                              <Button
                                size="sm"
                                variant="outline"
                                label={
                                  shareAction === `invite:${invite.id}` ? "Revoking..." : "Revoke"
                                }
                                disabled={!token || Boolean(shareAction)}
                                onPress={() => handleRevokeInvite(invite.id, invite.email)}
                              />
                            ) : null}
                          </View>
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
            {serviceDisconnected ? (
              <View
                className="border-b border-border bg-card/80 px-4 py-2"
                style={{ flexShrink: 0 }}
              >
                <Text className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  Reconnecting
                </Text>
                <Text className="mt-1 text-xs text-muted-foreground" numberOfLines={1}>
                  Project service disconnected. Composer state is preserved.
                </Text>
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
            ) : !displayServiceEndpoint ? (
              <View className="flex-1 p-4">
                <Text className="text-sm text-muted-foreground">
                  Project service not running. Start the project host to view this session.
                </Text>
              </View>
            ) : (
              <View className="flex-1 bg-background">
                <AgentChatTranscript
                  messages={allMessages}
                  onContentSizeChange={handleChatContentSizeChange}
                  onLayout={handleChatLayout}
                  onScroll={handleChatScroll}
                  ref={chatScrollRef}
                  serviceEndpoint={displayServiceEndpoint}
                  dividerWidth={chatDividerWidth}
                  extraContentPadding={composerExtraContentPadding}
                />
                {composerFooter}
              </View>
            )}
          </View>
        </View>
      </View>
    </View>
  );
}

const AgentChatTranscript = React.forwardRef<
  ChatScrollHandle,
  {
    dividerWidth: number;
    extraContentPadding?: SharedValue<number>;
    messages: readonly ChatMessage[];
    onContentSizeChange: (contentWidth: number, contentHeight: number) => void;
    onLayout: (event: LayoutChangeEvent) => void;
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
    serviceEndpoint: ServiceEndpoint;
  }
>(function AgentChatTranscript(
  {
    dividerWidth,
    extraContentPadding,
    messages,
    onContentSizeChange,
    onLayout,
    onScroll,
    serviceEndpoint,
  },
  ref,
) {
  const content =
    messages.length === 0 ? null : (
      <View className="w-full gap-1">
        {messages.map((message, index) => (
          <View
            key={message.id ?? message.clientMessageId ?? `message:${index}`}
            style={{ flexShrink: 0 }}
          >
            <MessageBlock
              dividerWidth={dividerWidth}
              message={message}
              serviceEndpoint={serviceEndpoint}
            />
          </View>
        ))}
      </View>
    );
  const contentContainerStyle = {
    flexGrow: 1,
    justifyContent: "flex-end" as const,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 18,
  };

  if (Platform.OS !== "web") {
    return (
      <KeyboardChatScrollView
        ref={ref as React.Ref<React.ElementRef<typeof KeyboardChatScrollView>>}
        className="flex-1 bg-background"
        contentContainerStyle={contentContainerStyle}
        extraContentPadding={extraContentPadding}
        keyboardDismissMode="interactive"
        keyboardLiftBehavior="whenAtEnd"
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={onContentSizeChange}
        onLayout={onLayout}
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator
      >
        {content}
      </KeyboardChatScrollView>
    );
  }

  return (
    <ScrollView
      ref={ref as React.Ref<ScrollView>}
      className="flex-1 bg-background"
      contentContainerStyle={contentContainerStyle}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      onContentSizeChange={onContentSizeChange}
      onLayout={onLayout}
      onScroll={onScroll}
      scrollEventThrottle={16}
      showsVerticalScrollIndicator
    >
      {content}
    </ScrollView>
  );
});

function ComposerFocusShell({
  children,
  dragging,
  onLayout,
  sending = false,
}: {
  children: (handlers: { onBlur: () => void; onFocus: () => void }) => React.ReactNode;
  dragging?: boolean;
  onLayout: (event: LayoutChangeEvent) => void;
  sending?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const onFocus = useCallback(() => {
    setFocused(true);
  }, []);
  const onBlur = useCallback(() => {
    setFocused(false);
  }, []);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onLayout(event);
    },
    [onLayout],
  );

  return (
    <View
      onLayout={handleLayout}
      className={cn(
        "gap-2 overflow-hidden rounded-2xl border bg-card px-2.5 pb-2 pt-2.5",
        // The card is the object here, so the card shows focus. The field's own
        // ring would draw a second rounded rect inside it.
        dragging
          ? "border-primary bg-accent"
          : sending
            ? "border-primary/40 bg-card"
            : focused
              ? "border-ring"
              : "border-border",
      )}
    >
      {sending ? (
        <View
          pointerEvents="none"
          style={{
            bottom: 0,
            left: 0,
            position: "absolute",
            top: 0,
            width: 3,
            backgroundColor: "rgba(125, 211, 252, 0.75)",
          }}
        />
      ) : null}
      {children({ onBlur, onFocus })}
    </View>
  );
}

function sessionFromActiveShare(activeShare: ActiveSharedSession): DesktopSession {
  const worktreeName = activeShare.projectRoot.split("/").filter(Boolean).pop() || "Shared project";
  return {
    id: activeShare.sessionId,
    command: "shared",
    toolConfigKey: "shared",
    status: "running",
    worktreePath: activeShare.projectRoot,
    worktreeName,
    label: "Shared session",
  };
}

function ActivityFooterLabel({ label, shimmer }: { label: string; shimmer: boolean }) {
  const { colorScheme } = useColorScheme();
  const palette = FOOTER_LABEL_SHIMMER_COLORS[colorScheme === "light" ? "light" : "dark"];
  const sweep = useSharedValue(0);

  useEffect(() => {
    if (!shimmer) {
      sweep.value = 0;
      return;
    }
    sweep.value = 0;
    sweep.value = withRepeat(
      withTiming(1, {
        duration: FOOTER_LABEL_SHIMMER_DURATION_MS,
        easing: ReanimatedEasing.linear,
      }),
      -1,
      false,
    );
    return () => {
      sweep.value = 0;
    };
  }, [shimmer, sweep]);

  if (!shimmer) {
    return (
      <Text className="text-xs text-muted-foreground" numberOfLines={1}>
        {label}
      </Text>
    );
  }

  const characters = Array.from(label);
  return (
    <Text
      accessibilityLabel={label}
      className="text-xs"
      numberOfLines={1}
      style={{ color: palette.base }}
    >
      {characters.map((character, index) => (
        <ActivityFooterLabelCharacter
          key={`${index}-${character}`}
          character={character}
          palette={palette}
          phase={characters.length > 1 ? index / (characters.length - 1) : 0}
          sweep={sweep}
        />
      ))}
    </Text>
  );
}

function ActivityFooterLabelCharacter({
  character,
  palette,
  phase,
  sweep,
}: {
  character: string;
  palette: { base: string; highlight: string };
  phase: number;
  sweep: SharedValue<number>;
}) {
  const animatedStyle = useAnimatedStyle(() => {
    const center = sweep.value * (1 + 2 * FOOTER_LABEL_SHIMMER_BAND) - FOOTER_LABEL_SHIMMER_BAND;
    const distance = Math.abs(phase - center);
    const intensity = Math.max(0, 1 - distance / FOOTER_LABEL_SHIMMER_BAND);
    return { color: interpolateColor(intensity, [0, 1], [palette.base, palette.highlight]) };
  }, [palette.base, palette.highlight, phase]);

  return (
    <Reanimated.Text style={[{ fontSize: 12, lineHeight: 16 }, animatedStyle]}>
      {character}
    </Reanimated.Text>
  );
}
