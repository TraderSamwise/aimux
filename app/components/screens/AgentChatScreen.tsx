import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  AppState,
  Image,
  Platform,
  Pressable,
  ScrollView,
  Text as RNText,
  TextInput,
  useWindowDimensions,
  View,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
  type TextInputContentSizeChangeEventData,
} from "react-native";
import type { LayoutChangeEvent } from "react-native";
import {
  KeyboardChatScrollView,
  KeyboardGestureArea,
  KeyboardStickyView,
} from "react-native-keyboard-controller";
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
import { useColorScheme } from "nativewind";
import { useFocusEffect, useLocalSearchParams, usePathname, useRouter } from "expo-router";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  CircleAlert,
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
import { Input, NO_BROWSER_FOCUS_RING } from "@/components/ui/input";
import { MessageBlock } from "@/components/MessageBlock";
import { ComposerControl, COMPOSER_CONTROL_LABEL_WIDTH } from "@/components/ComposerControl";
import { AttachmentDropZone } from "@/components/AttachmentDropZone";
import { useAuth, useUser } from "@/lib/auth";
import { agentActivityLabel, shouldShimmerAgentActivityLabel } from "@/lib/activity-label";
import { blurWebActiveElement } from "@/lib/blur-web-active-element";
import {
  createShareInvite,
  getLivePaneOutput,
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
  getComposerSendText,
  userMessageAcknowledgesComposerSend,
  shouldSubmitComposerKey,
} from "@/lib/composer-protocol";
import {
  CHAT_OUTPUT_CAPTURE_START_LINE,
  CHAT_OUTPUT_MAX_CAPTURE_START_LINE,
  nextChatOutputCaptureStartLine,
} from "@/lib/chat-output-constants";
import {
  DEFAULT_CHAT_SCROLL_END_THRESHOLD,
  commandForCurrentIntent,
  composerPresentation,
  createChatScrollPolicyState,
  isAnchoredToEnd,
  onContentChange,
  onGeometryChange,
  onUserScroll,
  onUserScrollBegin,
  type ChatScrollCommand,
  type ChatScrollPolicyState,
} from "@/lib/chat-scroll-model";
import { agentOutputModeForVisiblePane } from "@/lib/chat-loading";
import { useAgentOutputFeed } from "@/lib/use-agent-output-feed";
import { cn } from "@/lib/utils";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { DesktopSession } from "@/lib/desktop-state";
import { singleRouteParam } from "@/lib/route-params";
import {
  activeSessionsFromShareSummaries,
  mergeActiveSharedSessions,
  sharedSessionsEqual,
} from "@/lib/shared-sessions";
import { formatTerminalOutputForDisplay } from "@/lib/terminal-output";
import { toChatMessages } from "@/lib/transcript-view";
import { useRouteProject } from "@/lib/use-route-project";
import { useRouteShare } from "@/lib/use-route-share";
import { resolveSharedChatActor } from "@/lib/shared-chat-actor";
import { worktreeIdentity, worktreeTone } from "@/lib/worktree-tone";
import { parentViewHrefForPath } from "@/lib/view-location";
import { isTransientRequestError } from "@/lib/request-errors";
import { resolveChromeBottomInset } from "@/lib/native-safe-area";
import {
  activityFamily,
  activityTextFamily,
  applyOutputSnapshotAtom,
  clearLocalInterruptHoldAtom,
  lastErrorFamily,
  markOutputInterruptedAtom,
  outputAnsiFamily,
  outputAvailableFamily,
  outputBufferFamily,
  transcriptFamily,
} from "@/stores/chat";
import { desktopStateFamily, worktreeGroupsFamily } from "@/stores/desktopState";
import { selectedSessionIdAtom } from "@/stores/projects";
import { relayConfiguredAtom, relayStatusAtom } from "@/stores/relay";
import {
  acceptedSharedSessionsAtom,
  activeSharedSessionAtom,
  agentOutputViewModeAtom,
  type ActiveSharedSession,
  type AgentOutputViewMode,
} from "@/stores/settings";
import { appChromeCollapsedAtom } from "@/stores/ui";
import type { ChatMessage, HistoryPart } from "@/lib/events";

const SPLIT_VIEW_MIN_WIDTH = 900;
const NARROW_TERMINAL_DIVIDER_WIDTH = Platform.OS === "web" ? 36 : 24;
const WIDE_TERMINAL_DIVIDER_WIDTH = Platform.OS === "web" ? 96 : 36;
const MIN_TERMINAL_DIVIDER_WIDTH = 24;
const TERMINAL_HORIZONTAL_PADDING = 32;
const TERMINAL_FONT_SIZE = Platform.OS === "web" ? 11.6 : 10.8;
const TERMINAL_LINE_HEIGHT = Platform.OS === "web" ? 15.4 : 14.4;
const TERMINAL_TEXT_STYLE = { fontSize: TERMINAL_FONT_SIZE, lineHeight: TERMINAL_LINE_HEIGHT };
const APPROX_TERMINAL_CHAR_WIDTH = 7.2;
const CHAT_SCROLL_HORIZONTAL_PADDING = 32;
const CHAT_ASSISTANT_BUBBLE_MAX_RATIO = 0.9;
const CHAT_MESSAGE_BUBBLE_HORIZONTAL_PADDING = 24;
const CHAT_DIVIDER_APPROX_CHAR_WIDTH = Platform.OS === "web" ? 9.6 : 12.4;
const CHAT_DIVIDER_WIDTH_SAFETY = Platform.OS === "web" ? 4 : 6;
const MIN_CHAT_DIVIDER_WIDTH = 16;
const MAX_CHAT_DIVIDER_WIDTH = Platform.OS === "web" ? 72 : 24;
const MAX_PENDING_ATTACHMENTS = 4;
const CHAT_HISTORY_LOAD_SCROLL_THRESHOLD = 120;
const SCROLL_BOTTOM_EPSILON = DEFAULT_CHAT_SCROLL_END_THRESHOLD;
const SCROLL_BOTTOM_SETTLE_FRAMES = 3;
const COMPOSER_INPUT_FONT_SIZE = 14;
const COMPOSER_INPUT_LINE_HEIGHT = 20;
const COMPOSER_INPUT_VERTICAL_PADDING = 6;
const COMPOSER_INPUT_MIN_HEIGHT = COMPOSER_INPUT_LINE_HEIGHT + COMPOSER_INPUT_VERTICAL_PADDING * 2;
const COMPOSER_INPUT_MAX_HEIGHT =
  COMPOSER_INPUT_LINE_HEIGHT * 3 + COMPOSER_INPUT_VERTICAL_PADDING * 2;
const COMPOSER_INPUT_HORIZONTAL_PADDING = 4;
const COMPOSER_FOOTER_ESTIMATED_HEIGHT = 132;
const COMPOSER_SCROLL_SAFETY_PADDING = 44;
const COMPOSER_HIDE_ANIMATION_MS = 160;
const COMPOSER_SEND_ACK_TIMEOUT_MS = 10_000;
const FOOTER_LABEL_SHIMMER_DURATION_MS = 1700;
/** How much of the label the travelling highlight covers, as a fraction of its width. */
const FOOTER_LABEL_SHIMMER_BAND = 0.3;
/** muted-foreground → foreground, per theme (see app/global.css). */
const FOOTER_LABEL_SHIMMER_COLORS = {
  dark: { base: "#a1a1aa", highlight: "#fafafa" },
  light: { base: "#71717a", highlight: "#09090b" },
} as const;
const MIN_HEADER_ACTIONS_WIDTH = 156;
const MOBILE_CHROME_COLLAPSE_MAX_WIDTH = 639;
const CHROME_COLLAPSE_ANIMATION_MS = 140;
const CHROME_HIDE_SCROLL_DIRECTION_THRESHOLD = 8;
const CHROME_REVEAL_SCROLL_DIRECTION_THRESHOLD = 1;
const SCROLL_GESTURE_IDLE_RELEASE_MS = 240;
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

function nextAgentOutputViewMode(
  current: AgentOutputViewMode,
  canUseSplitView: boolean,
): AgentOutputViewMode {
  if (!canUseSplitView) return current === "terminal" ? "chat" : "terminal";
  if (current === "chat") return "split";
  if (current === "split") return "terminal";
  return "chat";
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

type InitialTranscriptStatus = "idle" | "loading" | "timed-out";

const composerDraftsByKey = new Map<string, ComposerDraftSnapshot>();

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

type ScrollPaneKey = "chat" | "terminal";

type ScrollToHandle = {
  scrollTo: (options: { animated?: boolean; x?: number; y?: number }) => void;
};

type UserScrollState = {
  active: boolean;
  dragging: boolean;
  momentum: boolean;
};

function isMultiplexedShare(summary: SharedSessionSummary | null): boolean {
  if (!summary) return false;
  if (summary.mode === "multi") return true;
  return (
    summary.participants.some(
      (participant) => participant.role !== "owner" && participant.status === "active",
    ) || summary.invites.some((invite) => invite.status === "pending")
  );
}

function createScrollPaneState(pane: ScrollPaneKey): ChatScrollPolicyState {
  return createChatScrollPolicyState({
    geometry: { endBuffer: 0 },
    pane,
  });
}

function createUserScrollState(): UserScrollState {
  return {
    active: false,
    dragging: false,
    momentum: false,
  };
}

function isOffsetPinnedToBottom(state: ChatScrollPolicyState) {
  return isAnchoredToEnd({
    geometry: state.geometry,
    metrics: state.metrics,
    threshold: SCROLL_BOTTOM_EPSILON,
  });
}

export default function ChatScreen() {
  const params = useLocalSearchParams<{
    focusToken?: string | string[];
    ownerUserId?: string | string[];
    sessionId?: string | string[];
    shareId?: string | string[];
  }>();
  const routeFocusToken = singleRouteParam(params.focusToken);
  const routeOwnerUserId = singleRouteParam(params.ownerUserId);
  const sessionId = singleRouteParam(params.sessionId);
  const routeShareId = singleRouteParam(params.shareId);
  const sessionKey = sessionId ?? "";
  const { project, projectPath, endpoint: serviceEndpoint } = useRouteProject();
  const stateProjectPath = projectPath ?? "";
  const desktopState = useAtomValue(desktopStateFamily(stateProjectPath));
  const worktreeGroups = useAtomValue(worktreeGroupsFamily(stateProjectPath));
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const applyOutputSnapshot = useSetAtom(applyOutputSnapshotAtom);
  const markOutputInterrupted = useSetAtom(markOutputInterruptedAtom);
  const clearLocalInterruptHold = useSetAtom(clearLocalInterruptHoldAtom);
  const output = useAtomValue(outputBufferFamily(sessionKey));
  const outputAnsi = useAtomValue(outputAnsiFamily(sessionKey));
  const outputAvailable = useAtomValue(outputAvailableFamily(sessionKey));
  const transcript = useAtomValue(transcriptFamily(sessionKey));
  const activity = useAtomValue(activityFamily(sessionKey));
  const activityText = useAtomValue(activityTextFamily(sessionKey));
  const lastError = useAtomValue(lastErrorFamily(sessionKey));
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
  const safeAreaInsets = useSafeAreaInsets();
  const appVisible = useAppVisible();
  const bottomInset = resolveChromeBottomInset(safeAreaInsets.bottom);
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
  const [pendingComposerAck, setPendingComposerAck] = useState<PendingComposerAck | null>(null);
  const [acceptedComposerMessages, setAcceptedComposerMessages] = useState<
    AcceptedComposerMessage[]
  >([]);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [sendBusy, setSendBusy] = useState(false);
  const [composerWidth, setComposerWidth] = useState(0);
  const [composerFocused, setComposerFocused] = useState(false);
  const [composerLayoutHeight, setComposerLayoutHeight] = useState(
    COMPOSER_FOOTER_ESTIMATED_HEIGHT,
  );
  const [composerInputContentHeight, setComposerInputContentHeight] =
    useState(COMPOSER_INPUT_MIN_HEIGHT);
  const [sendError, setSendError] = useState<string | null>(null);
  const [chatPaneWidth, setChatPaneWidth] = useState<number | null>(null);
  const [terminalPaneWidth, setTerminalPaneWidth] = useState<number | null>(null);
  const [lastConnectedEndpoint, setLastConnectedEndpoint] = useState<{
    endpoint: ServiceEndpoint;
    projectPath: string;
  } | null>(null);
  const [agentOutputViewMode, setAgentOutputViewMode] = useAtom(agentOutputViewModeAtom);
  const [, setAppChromeCollapsed] = useAtom(appChromeCollapsedAtom);
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
  const composerFocusedRef = useRef(false);
  const scrollRef = useRef<ScrollToHandle | null>(null);
  const terminalScrollRef = useRef<ScrollToHandle | null>(null);
  const transcriptCaptureStartLineRef = useRef(CHAT_OUTPUT_CAPTURE_START_LINE);
  const olderTranscriptLoadingRef = useRef(false);
  const historyPrependPendingRef = useRef(false);
  const [transcriptCaptureStartLine, setTranscriptCaptureStartLine] = useState(
    CHAT_OUTPUT_CAPTURE_START_LINE,
  );
  const [olderTranscriptLoading, setOlderTranscriptLoading] = useState(false);
  const [olderTranscriptExhausted, setOlderTranscriptExhausted] = useState(false);
  const composerHiddenRef = useRef(false);
  const [composerHideProgress] = useState(() => new Animated.Value(0));
  const [chatChromeCollapsed, setChatChromeCollapsedState] = useState(false);
  const chatChromeCollapsedRef = useRef(false);
  const chatHeaderCollapseProgress = useSharedValue(0);
  const [chatHeaderHeight, setChatHeaderHeight] = useState(72);
  const composerScrollReserve = useSharedValue(
    COMPOSER_FOOTER_ESTIMATED_HEIGHT + COMPOSER_SCROLL_SAFETY_PADDING,
  );
  const keyboardScrollFrozen = useSharedValue(false);
  const [composerInteractive, setComposerInteractive] = useState(true);
  const scrollPolicyStateRef = useRef<Record<ScrollPaneKey, ChatScrollPolicyState>>({
    chat: createScrollPaneState("chat"),
    terminal: createScrollPaneState("terminal"),
  });
  const scrollInitializedRef = useRef<Record<ScrollPaneKey, boolean>>({
    chat: false,
    terminal: false,
  });
  const programmaticScrollRef = useRef<Record<ScrollPaneKey, boolean>>({
    chat: false,
    terminal: false,
  });
  const pendingBottomPinRef = useRef<Record<ScrollPaneKey, boolean>>({
    chat: false,
    terminal: false,
  });
  const userScrollStateRef = useRef<Record<ScrollPaneKey, UserScrollState>>({
    chat: createUserScrollState(),
    terminal: createUserScrollState(),
  });
  const userScrollIdleTimerRef = useRef<
    Record<ScrollPaneKey, ReturnType<typeof setTimeout> | null>
  >({
    chat: null,
    terminal: null,
  });
  const chatChromeGestureRef = useRef<
    Record<ScrollPaneKey, { lastOffset: number; revealedDuringGesture: boolean }>
  >({
    chat: { lastOffset: 0, revealedDuringGesture: false },
    terminal: { lastOffset: 0, revealedDuringGesture: false },
  });
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
    transcriptCaptureStartLineRef.current = CHAT_OUTPUT_CAPTURE_START_LINE;
    olderTranscriptLoadingRef.current = false;
    historyPrependPendingRef.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the history window is scoped to the selected conversation
    setTranscriptCaptureStartLine(CHAT_OUTPUT_CAPTURE_START_LINE);
    setOlderTranscriptLoading(false);
    setOlderTranscriptExhausted(false);
  }, [sessionKey]);

  useEffect(() => {
    const previousKey = activeComposerDraftKeyRef.current;
    if (previousKey && previousKey !== composerDraftKey) {
      rememberComposerDraft(previousKey, composerDraftSnapshotRef.current);
    }

    activeComposerDraftKeyRef.current = composerDraftKey;
    const saved = composerDraftKey ? composerDraftsByKey.get(composerDraftKey) : undefined;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the composer is re-seeded from the draft store when the conversation changes
    setDraft(saved?.draft ?? "");
    setPendingAttachments(saved?.pendingAttachments ? [...saved.pendingAttachments] : []);
    setComposerInputContentHeight(saved?.inputContentHeight ?? COMPOSER_INPUT_MIN_HEIGHT);
    setPendingComposerAck(null);
    setAcceptedComposerMessages([]);
    setSendBusy(false);
    composerInputRef.current?.blur();
    composerFocusedRef.current = false;
    setComposerFocused(false);
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
  const composerInputHeight = Math.min(
    COMPOSER_INPUT_MAX_HEIGHT,
    Math.max(COMPOSER_INPUT_MIN_HEIGHT, composerInputContentHeight),
  );
  const composerInputOverflowHeight = composerInputContentHeight;
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
  const canShowTerminal = outputAvailable || Boolean(output);
  const usesNativeKeyboardController = Platform.OS !== "web";
  const viewportWidth =
    Platform.OS === "web" && typeof window !== "undefined" ? window.innerWidth : width;
  const canCollapseChatChrome = viewportWidth <= MOBILE_CHROME_COLLAPSE_MAX_WIDTH;
  const useScrollableNativeHeader = Platform.OS !== "web";
  const canUseSplitView = viewportWidth >= SPLIT_VIEW_MIN_WIDTH;
  const effectiveAgentOutputViewMode =
    agentOutputViewMode === "split" && !canUseSplitView ? "chat" : agentOutputViewMode;
  const showSplit = canUseSplitView && canShowTerminal && agentOutputViewMode === "split";
  const showTerminalOnly = canShowTerminal && effectiveAgentOutputViewMode === "terminal";
  const terminalViewVisible = showSplit || showTerminalOnly;
  const agentOutputMode = agentOutputModeForVisiblePane({ terminalViewVisible });

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

  const { initialStatus: visibleInitialTranscriptStatus, refreshOutputSnapshot } =
    useAgentOutputFeed({
      appVisible,
      enabled: heartbeatReady && !routeSessionMissing,
      endpoint: serviceEndpoint ?? null,
      mode: agentOutputMode,
      sessionId,
      startLine: transcriptCaptureStartLine,
      token,
    });

  const parsedMessages = useMemo<ChatMessage[]>(
    () =>
      toChatMessages(transcript, sessionKey, {
        shared: isSharedConversation,
      }),
    [transcript, sessionKey, isSharedConversation],
  );
  const visibleLastError = lastError && !isTransientRequestError(lastError) ? lastError : null;

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

  const loadOlderTranscriptHistory = useCallback(async () => {
    if (
      olderTranscriptLoadingRef.current ||
      olderTranscriptExhausted ||
      transcriptCaptureStartLineRef.current <= CHAT_OUTPUT_MAX_CAPTURE_START_LINE ||
      !endpointHost ||
      !endpointPort ||
      !sessionId ||
      !heartbeatReady ||
      routeSessionMissing ||
      allMessages.length === 0
    ) {
      return;
    }
    const previousStartLine = transcriptCaptureStartLineRef.current;
    const nextStartLine = nextChatOutputCaptureStartLine(previousStartLine);
    olderTranscriptLoadingRef.current = true;
    setOlderTranscriptLoading(true);
    try {
      const result = await getLivePaneOutput(
        { host: endpointHost, port: endpointPort },
        sessionId,
        nextStartLine,
        { token, mode: "chat", purpose: "history" },
      );
      if (result.sessionId !== sessionId) return;
      const resultStartLine =
        typeof result.startLine === "number" ? result.startLine : nextStartLine;
      if (resultStartLine >= previousStartLine) {
        setOlderTranscriptExhausted(true);
        return;
      }
      transcriptCaptureStartLineRef.current = resultStartLine;
      historyPrependPendingRef.current = true;
      setTranscriptCaptureStartLine(resultStartLine);
      applyOutputSnapshot({
        sessionId: result.sessionId,
        output: result.output,
        outputAnsi: result.outputAnsi,
        outputAvailable: result.outputAvailable,
        startLine: resultStartLine,
        messages: result.messages,
        activity: result.activity,
        activityText: result.activityText,
        attention: result.attention,
      });
      if (
        nextStartLine <= CHAT_OUTPUT_MAX_CAPTURE_START_LINE ||
        result.outputStartLineClamped ||
        resultStartLine <= CHAT_OUTPUT_MAX_CAPTURE_START_LINE
      ) {
        setOlderTranscriptExhausted(true);
      }
    } catch {
      // Transient relay/service errors are surfaced elsewhere; keep the cursor unchanged so retry can work.
    } finally {
      olderTranscriptLoadingRef.current = false;
      setOlderTranscriptLoading(false);
    }
  }, [
    allMessages.length,
    applyOutputSnapshot,
    endpointHost,
    endpointPort,
    heartbeatReady,
    olderTranscriptExhausted,
    routeSessionMissing,
    sessionId,
    token,
  ]);

  const userMessageCount = useMemo(
    () => allMessages.reduce((count, message) => count + (message.role === "user" ? 1 : 0), 0),
    [allMessages],
  );
  const composerSendAcknowledged = pendingComposerAck
    ? userMessageAcknowledgesComposerSend(allMessages, pendingComposerAck)
    : false;
  const hasMoreTranscriptHistory =
    transcriptCaptureStartLine > CHAT_OUTPUT_MAX_CAPTURE_START_LINE && !olderTranscriptExhausted;
  const composerAwaitingAck = pendingComposerAck !== null && !pendingComposerAck.timedOut;

  const handleComposerFocusChange = useCallback((focused: boolean) => {
    composerFocusedRef.current = focused;
    setComposerFocused(focused);
  }, []);

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

  const composerHideDistance = Math.max(composerLayoutHeight, COMPOSER_FOOTER_ESTIMATED_HEIGHT);
  const visibleComposerScrollReserve = composerLayoutHeight + COMPOSER_SCROLL_SAFETY_PADDING;
  const composerVisibilityStyle = useMemo(
    () => ({
      opacity: composerHideProgress.interpolate({
        inputRange: [0, 1],
        outputRange: [1, 0],
      }),
      transform: [
        {
          translateY: composerHideProgress.interpolate({
            inputRange: [0, 1],
            outputRange: [0, composerHideDistance],
          }),
        },
      ],
    }),
    [composerHideDistance, composerHideProgress],
  );
  const chatHeaderVisibilityStyle = useAnimatedStyle(() => {
    const progress = chatHeaderCollapseProgress.value;
    return {
      height: chatHeaderHeight * (1 - progress),
      opacity: progress < 0.7 ? 1 - (progress / 0.7) * 0.92 : (0.08 * (1 - progress)) / 0.3,
      transform: [{ translateY: -chatHeaderHeight * progress }],
    };
  }, [chatHeaderHeight]);
  const setNativeComposerHidden = useCallback(
    (hidden: boolean, options?: { preserveReserve?: boolean }) => {
      if (!usesNativeKeyboardController) return;
      const preserveReserve = Boolean(options?.preserveReserve);
      const hiddenChanged = composerHiddenRef.current !== hidden;
      if (!hiddenChanged && preserveReserve) return;
      if (!hiddenChanged) {
        // eslint-disable-next-line react-hooks/immutability
        composerScrollReserve.value = withTiming(hidden ? 0 : visibleComposerScrollReserve, {
          duration: COMPOSER_HIDE_ANIMATION_MS,
        });
        return;
      }
      composerHiddenRef.current = hidden;
      if (!hidden) setComposerInteractive(true);
      composerHideProgress.stopAnimation();
      if (!preserveReserve) {
        composerScrollReserve.value = withTiming(hidden ? 0 : visibleComposerScrollReserve, {
          duration: COMPOSER_HIDE_ANIMATION_MS,
        });
      }
      Animated.timing(composerHideProgress, {
        duration: COMPOSER_HIDE_ANIMATION_MS,
        toValue: hidden ? 1 : 0,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished && hidden) setComposerInteractive(false);
      });
    },
    [
      composerHideProgress,
      composerScrollReserve,
      usesNativeKeyboardController,
      visibleComposerScrollReserve,
    ],
  );
  useEffect(() => {
    if (!usesNativeKeyboardController) return;
    // eslint-disable-next-line react-hooks/immutability
    composerScrollReserve.value = withTiming(
      composerHiddenRef.current ? 0 : visibleComposerScrollReserve,
      {
        duration: COMPOSER_HIDE_ANIMATION_MS,
      },
    );
  }, [composerScrollReserve, usesNativeKeyboardController, visibleComposerScrollReserve]);
  const cycleAgentOutputViewMode = useCallback(() => {
    setAgentOutputViewMode((current) => nextAgentOutputViewMode(current, canUseSplitView));
  }, [canUseSplitView, setAgentOutputViewMode]);
  const terminalToggleLabel = canUseSplitView
    ? "Cycle chat, split, and terminal views"
    : "Toggle chat and terminal views";
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
  const chatContentWidth = Math.max(
    0,
    (chatPaneWidth ?? viewportWidth) - CHAT_SCROLL_HORIZONTAL_PADDING,
  );
  const chatBubbleTextWidth = Math.max(
    0,
    chatContentWidth * CHAT_ASSISTANT_BUBBLE_MAX_RATIO - CHAT_MESSAGE_BUBBLE_HORIZONTAL_PADDING,
  );
  const chatDividerWidth = Math.max(
    MIN_CHAT_DIVIDER_WIDTH,
    Math.min(
      MAX_CHAT_DIVIDER_WIDTH,
      Math.floor(chatBubbleTextWidth / CHAT_DIVIDER_APPROX_CHAR_WIDTH) - CHAT_DIVIDER_WIDTH_SAFETY,
    ),
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
  const effectiveInitialTranscriptStatus =
    visibleInitialTranscriptStatus !== "idle" &&
    allMessages.length === 0 &&
    !output &&
    !outputAvailable &&
    !restoreBlockedReason &&
    !sendError &&
    !visibleLastError
      ? visibleInitialTranscriptStatus
      : "idle";
  const showInitialTranscriptOverlay = effectiveInitialTranscriptStatus !== "idle";
  const visibleInitialTranscriptNoticeStatus = "idle";
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
    !composerAwaitingAck &&
    !ownerShareStatusPending &&
    (composerSendText || hasPendingAttachments),
  );

  const getScrollRef = useCallback(
    (pane: ScrollPaneKey) => (pane === "chat" ? scrollRef : terminalScrollRef),
    [],
  );

  const setChatChromeCollapsed = useCallback(
    (collapsed: boolean) => {
      const next = canCollapseChatChrome ? collapsed : false;
      if (chatChromeCollapsedRef.current === next) return;
      chatChromeCollapsedRef.current = next;
      setChatChromeCollapsedState(next);
      setAppChromeCollapsed(next);
    },
    [canCollapseChatChrome, setAppChromeCollapsed],
  );

  useEffect(() => {
    if (canCollapseChatChrome) return;
    setChatChromeCollapsed(false);
  }, [canCollapseChatChrome, setChatChromeCollapsed]);

  useEffect(() => {
    chatHeaderCollapseProgress.value = withTiming(chatChromeCollapsed ? 1 : 0, {
      duration: CHROME_COLLAPSE_ANIMATION_MS,
      easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
    });
  }, [chatChromeCollapsed, chatHeaderCollapseProgress]);

  useEffect(() => {
    return () => setChatChromeCollapsed(false);
  }, [setChatChromeCollapsed]);

  const applyScrollCommand = useCallback(
    (pane: ScrollPaneKey, command: ChatScrollCommand) => {
      if (command.kind !== "scroll-to") return;
      const ref = getScrollRef(pane).current;
      if (!ref) return;
      programmaticScrollRef.current[pane] = true;
      ref.scrollTo({ y: Math.max(0, command.offset), animated: command.animated });
      requestAnimationFrame(() => {
        programmaticScrollRef.current[pane] = false;
        if (isOffsetPinnedToBottom(scrollPolicyStateRef.current[pane])) {
          pendingBottomPinRef.current[pane] = false;
        }
      });
    },
    [getScrollRef],
  );

  const isUserScrollActive = useCallback((pane: ScrollPaneKey) => {
    return userScrollStateRef.current[pane].active;
  }, []);

  const syncNativeComposerForPane = useCallback(
    (pane: ScrollPaneKey) => {
      if (!usesNativeKeyboardController) return;
      const state = scrollPolicyStateRef.current[pane];
      const presentation = composerPresentation({
        input: composerFocusedRef.current ? "focused" : "blurred",
        state,
      });
      const hidden = presentation === "scrolled-away";
      setNativeComposerHidden(hidden, {
        preserveReserve: hidden && isUserScrollActive(pane),
      });
    },
    [isUserScrollActive, setNativeComposerHidden, usesNativeKeyboardController],
  );

  const applyPaneScrollPosition = useCallback(
    (pane: ScrollPaneKey) => {
      if (isUserScrollActive(pane)) return;
      const state = scrollPolicyStateRef.current[pane];
      if (state.metrics.viewportLength <= 0) return;
      const transition = commandForCurrentIntent(state, { animated: false });
      scrollPolicyStateRef.current[pane] = transition.state;
      scrollInitializedRef.current[pane] = true;
      applyScrollCommand(pane, transition.command);
      syncNativeComposerForPane(pane);
    },
    [applyScrollCommand, isUserScrollActive, syncNativeComposerForPane],
  );

  const settlePaneAfterMetricChange = useCallback(
    (pane: ScrollPaneKey) => {
      if (isUserScrollActive(pane)) return;
      const state = scrollPolicyStateRef.current[pane];
      if (state.metrics.viewportLength <= 0) return;
      let remainingFrames = SCROLL_BOTTOM_SETTLE_FRAMES;
      const settle = () => {
        if (isUserScrollActive(pane)) return;
        const latestState = scrollPolicyStateRef.current[pane];
        if (latestState.metrics.viewportLength <= 0) return;
        if (latestState.intent.kind === "anchored-to-end" || pendingBottomPinRef.current[pane])
          applyPaneScrollPosition(pane);
        remainingFrames -= 1;
        if (remainingFrames > 0) requestAnimationFrame(settle);
      };
      requestAnimationFrame(settle);
    },
    [applyPaneScrollPosition, isUserScrollActive],
  );

  const handleScrollLayout = useCallback(
    (pane: ScrollPaneKey, event: LayoutChangeEvent) => {
      const state = scrollPolicyStateRef.current[pane];
      const wasPinned =
        !scrollInitializedRef.current[pane] ||
        state.intent.kind === "anchored-to-end" ||
        isOffsetPinnedToBottom(state);
      scrollPolicyStateRef.current[pane] = {
        ...state,
        intent: wasPinned ? { kind: "anchored-to-end" } : state.intent,
        metrics: {
          ...state.metrics,
          viewportLength: Math.max(0, event.nativeEvent.layout.height),
        },
      };
      if (wasPinned && !isUserScrollActive(pane)) {
        pendingBottomPinRef.current[pane] = true;
      }
      settlePaneAfterMetricChange(pane);
    },
    [isUserScrollActive, settlePaneAfterMetricChange],
  );

  const handleScrollContentSizeChange = useCallback(
    (pane: ScrollPaneKey, contentHeight: number) => {
      const state = scrollPolicyStateRef.current[pane];
      const wasPinned =
        !scrollInitializedRef.current[pane] ||
        state.intent.kind === "anchored-to-end" ||
        isOffsetPinnedToBottom(state);
      const isHistoryPrepend = pane === "chat" && historyPrependPendingRef.current;
      if (pane === "chat" && historyPrependPendingRef.current) {
        historyPrependPendingRef.current = false;
      }
      const transition = onContentChange({
        contentLength: Math.max(0, contentHeight),
        reason: isHistoryPrepend ? "prepend-at-start" : "append-at-end",
        state: {
          ...state,
          intent: wasPinned ? { kind: "anchored-to-end" } : state.intent,
        },
      });
      scrollPolicyStateRef.current[pane] = transition.state;
      scrollInitializedRef.current[pane] = true;
      if (wasPinned) {
        pendingBottomPinRef.current[pane] = true;
      }
      if (!isUserScrollActive(pane) || isHistoryPrepend) {
        applyScrollCommand(pane, transition.command);
      }
      syncNativeComposerForPane(pane);
      settlePaneAfterMetricChange(pane);
    },
    [
      applyScrollCommand,
      isUserScrollActive,
      settlePaneAfterMetricChange,
      syncNativeComposerForPane,
    ],
  );

  const handleScrollContentInsetChange = useCallback(
    (pane: ScrollPaneKey, contentInsetBottom: number) => {
      const state = scrollPolicyStateRef.current[pane];
      const wasPinned =
        !scrollInitializedRef.current[pane] ||
        state.intent.kind === "anchored-to-end" ||
        isOffsetPinnedToBottom(state);
      const transition = onGeometryChange({
        geometry: {
          composerHeight: Math.max(0, contentInsetBottom),
        },
        state: {
          ...state,
          intent: wasPinned ? { kind: "anchored-to-end" } : state.intent,
        },
      });
      scrollPolicyStateRef.current[pane] = transition.state;
      if (wasPinned && !isUserScrollActive(pane)) {
        pendingBottomPinRef.current[pane] = true;
      }
      if (!isUserScrollActive(pane)) {
        applyScrollCommand(pane, transition.command);
      }
      syncNativeComposerForPane(pane);
      settlePaneAfterMetricChange(pane);
    },
    [
      applyScrollCommand,
      isUserScrollActive,
      settlePaneAfterMetricChange,
      syncNativeComposerForPane,
    ],
  );

  const clearScrollIdleTimer = useCallback((pane: ScrollPaneKey) => {
    const idleTimer = userScrollIdleTimerRef.current[pane];
    if (idleTimer) clearTimeout(idleTimer);
    userScrollIdleTimerRef.current[pane] = null;
  }, []);

  const scheduleScrollIdleRelease = useCallback(
    (pane: ScrollPaneKey) => {
      clearScrollIdleTimer(pane);
      userScrollIdleTimerRef.current[pane] = setTimeout(() => {
        const state = userScrollStateRef.current[pane];
        if (state.dragging || state.momentum) return;
        userScrollStateRef.current[pane] = createUserScrollState();
        keyboardScrollFrozen.value = false;
        userScrollIdleTimerRef.current[pane] = null;
        syncNativeComposerForPane(pane);
      }, SCROLL_GESTURE_IDLE_RELEASE_MS);
    },
    [clearScrollIdleTimer, keyboardScrollFrozen, syncNativeComposerForPane],
  );

  const markUserScrollActive = useCallback(
    (pane: ScrollPaneKey, key: "dragging" | "momentum") => {
      clearScrollIdleTimer(pane);
      pendingBottomPinRef.current[pane] = false;
      // eslint-disable-next-line react-hooks/immutability
      keyboardScrollFrozen.value = true;
      if (usesNativeKeyboardController && key === "dragging") {
        composerInputRef.current?.blur();
        composerFocusedRef.current = false;
        setComposerFocused(false);
      }
      scrollPolicyStateRef.current[pane] = onUserScrollBegin(scrollPolicyStateRef.current[pane]);
      userScrollStateRef.current[pane] = {
        ...userScrollStateRef.current[pane],
        active: true,
        [key]: true,
      };
    },
    [clearScrollIdleTimer, keyboardScrollFrozen, usesNativeKeyboardController],
  );

  const handleScroll = useCallback(
    (pane: ScrollPaneKey, event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const offsetY = Math.max(0, contentOffset.y);
      const state = scrollPolicyStateRef.current[pane];
      const userActive = isUserScrollActive(pane);
      const programmaticScroll = programmaticScrollRef.current[pane];
      const nextMetrics = {
        contentLength: Math.max(0, contentSize.height),
        contentOffset: offsetY,
        viewportLength: Math.max(0, layoutMeasurement.height),
      };
      const withMetrics = {
        ...state,
        metrics: nextMetrics,
      };
      const preservePendingPin = pendingBottomPinRef.current[pane] && !userActive;
      const missedUserScroll =
        scrollInitializedRef.current[pane] &&
        !userActive &&
        !preservePendingPin &&
        !composerFocusedRef.current &&
        !isAnchoredToEnd({
          geometry: withMetrics.geometry,
          metrics: nextMetrics,
          threshold: SCROLL_BOTTOM_EPSILON,
        });
      const nextAnchored = isAnchoredToEnd({
        geometry: withMetrics.geometry,
        metrics: nextMetrics,
        threshold: SCROLL_BOTTOM_EPSILON,
      });

      if (programmaticScroll) {
        scrollPolicyStateRef.current[pane] = withMetrics;
        scrollInitializedRef.current[pane] = true;
        programmaticScrollRef.current[pane] = false;
        pendingBottomPinRef.current[pane] = false;
        if (nextAnchored) {
          chatChromeGestureRef.current[pane] = {
            lastOffset: offsetY,
            revealedDuringGesture: false,
          };
          setChatChromeCollapsed(false);
        }
        syncNativeComposerForPane(pane);
        return;
      }

      if (userActive || missedUserScroll) {
        const chromeGesture = chatChromeGestureRef.current[pane];
        const scrollDelta = offsetY - chromeGesture.lastOffset;
        if (nextAnchored) {
          chromeGesture.revealedDuringGesture = false;
          setChatChromeCollapsed(false);
        } else if (scrollDelta >= CHROME_REVEAL_SCROLL_DIRECTION_THRESHOLD) {
          chromeGesture.revealedDuringGesture = true;
          setChatChromeCollapsed(false);
        } else if (
          scrollDelta <= -CHROME_HIDE_SCROLL_DIRECTION_THRESHOLD &&
          !chromeGesture.revealedDuringGesture
        ) {
          setChatChromeCollapsed(true);
        }
        chromeGesture.lastOffset = offsetY;
        const stateForUserScroll = missedUserScroll ? onUserScrollBegin(withMetrics) : withMetrics;
        const scrolledState = onUserScroll({
          metrics: nextMetrics,
          state: preservePendingPin
            ? { ...stateForUserScroll, intent: { kind: "anchored-to-end" } }
            : stateForUserScroll,
          threshold: SCROLL_BOTTOM_EPSILON,
        });
        scrollPolicyStateRef.current[pane] = scrolledState;
        scrollInitializedRef.current[pane] = true;
        syncNativeComposerForPane(pane);
      } else {
        scrollPolicyStateRef.current[pane] = withMetrics;
        scrollInitializedRef.current[pane] = true;
        if (nextAnchored) {
          chatChromeGestureRef.current[pane] = {
            lastOffset: offsetY,
            revealedDuringGesture: false,
          };
          setChatChromeCollapsed(false);
        }
        if (withMetrics.intent.kind === "anchored-to-end" || pendingBottomPinRef.current[pane]) {
          const transition = commandForCurrentIntent(withMetrics, { animated: false });
          applyScrollCommand(pane, transition.command);
        }
        syncNativeComposerForPane(pane);
      }

      if (
        pane === "chat" &&
        hasMoreTranscriptHistory &&
        (userActive || missedUserScroll) &&
        offsetY <= CHAT_HISTORY_LOAD_SCROLL_THRESHOLD
      ) {
        void loadOlderTranscriptHistory();
      }

      if (userActive) scheduleScrollIdleRelease(pane);
    },
    [
      applyScrollCommand,
      hasMoreTranscriptHistory,
      isUserScrollActive,
      loadOlderTranscriptHistory,
      scheduleScrollIdleRelease,
      setChatChromeCollapsed,
      syncNativeComposerForPane,
    ],
  );

  const handleScrollBeginDrag = useCallback(
    (pane: ScrollPaneKey) => {
      chatChromeGestureRef.current[pane] = {
        lastOffset: scrollPolicyStateRef.current[pane].metrics.contentOffset,
        revealedDuringGesture: false,
      };
      markUserScrollActive(pane, "dragging");
    },
    [markUserScrollActive],
  );

  const handleMomentumScrollBegin = useCallback(
    (pane: ScrollPaneKey) => {
      if (!userScrollStateRef.current[pane].active) {
        chatChromeGestureRef.current[pane] = {
          lastOffset: scrollPolicyStateRef.current[pane].metrics.contentOffset,
          revealedDuringGesture: false,
        };
      }
      markUserScrollActive(pane, "momentum");
    },
    [markUserScrollActive],
  );

  const handleScrollEnd = useCallback(
    (pane: ScrollPaneKey, key: "dragging" | "momentum") => {
      userScrollStateRef.current[pane] = {
        ...userScrollStateRef.current[pane],
        [key]: false,
      };
      scheduleScrollIdleRelease(pane);
    },
    [scheduleScrollIdleRelease],
  );

  const resetScrollPanesToBottom = useCallback(() => {
    setChatChromeCollapsed(false);
    for (const pane of ["chat", "terminal"] as const) {
      const idleTimer = userScrollIdleTimerRef.current[pane];
      if (idleTimer) clearTimeout(idleTimer);
      userScrollIdleTimerRef.current[pane] = null;
    }
    scrollPolicyStateRef.current = {
      chat: createScrollPaneState("chat"),
      terminal: createScrollPaneState("terminal"),
    };
    scrollInitializedRef.current = {
      chat: false,
      terminal: false,
    };
    programmaticScrollRef.current = {
      chat: false,
      terminal: false,
    };
    pendingBottomPinRef.current = {
      chat: false,
      terminal: false,
    };
    userScrollStateRef.current = {
      chat: createUserScrollState(),
      terminal: createUserScrollState(),
    };
    chatChromeGestureRef.current = {
      chat: { lastOffset: 0, revealedDuringGesture: false },
      terminal: { lastOffset: 0, revealedDuringGesture: false },
    };
    // eslint-disable-next-line react-hooks/immutability
    keyboardScrollFrozen.value = false;
    requestAnimationFrame(() => {
      setNativeComposerHidden(false);
      applyPaneScrollPosition("chat");
      applyPaneScrollPosition("terminal");
    });
  }, [
    applyPaneScrollPosition,
    keyboardScrollFrozen,
    setChatChromeCollapsed,
    setNativeComposerHidden,
  ]);

  useEffect(() => {
    resetScrollPanesToBottom();
  }, [resetScrollPanesToBottom, routeFocusToken, sessionKey]);

  useFocusEffect(
    useCallback(() => {
      resetScrollPanesToBottom();
      return () => setChatChromeCollapsed(false);
    }, [resetScrollPanesToBottom, setChatChromeCollapsed]),
  );

  useEffect(() => {
    if (composerFocused) {
      requestAnimationFrame(() => setNativeComposerHidden(false));
      return;
    }
    requestAnimationFrame(() => {
      syncNativeComposerForPane(showTerminalOnly ? "terminal" : "chat");
    });
  }, [composerFocused, setNativeComposerHidden, showTerminalOnly, syncNativeComposerForPane]);

  useEffect(() => {
    if (
      scrollPolicyStateRef.current.chat.intent.kind === "anchored-to-end" &&
      !isUserScrollActive("chat")
    ) {
      pendingBottomPinRef.current.chat = true;
    }
    requestAnimationFrame(() => {
      if (
        scrollPolicyStateRef.current.chat.intent.kind === "anchored-to-end" &&
        !isUserScrollActive("chat")
      ) {
        applyPaneScrollPosition("chat");
      }
      if (
        scrollPolicyStateRef.current.terminal.intent.kind === "anchored-to-end" &&
        !isUserScrollActive("terminal")
      ) {
        applyPaneScrollPosition("terminal");
      }
    });
  }, [allMessages, applyPaneScrollPosition, isUserScrollActive, output]);

  useEffect(() => {
    requestAnimationFrame(() => {
      if (showSplit) {
        applyPaneScrollPosition("chat");
        applyPaneScrollPosition("terminal");
        return;
      }
      applyPaneScrollPosition(showTerminalOnly ? "terminal" : "chat");
    });
  }, [applyPaneScrollPosition, showSplit, showTerminalOnly]);

  useEffect(() => {
    const idleTimers = userScrollIdleTimerRef.current;
    return () => {
      for (const pane of ["chat", "terminal"] as const) {
        const idleTimer = idleTimers[pane];
        if (idleTimer) clearTimeout(idleTimer);
      }
    };
  }, []);

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
    setComposerInputContentHeight(
      Math.max(COMPOSER_INPUT_MIN_HEIGHT, Math.ceil(event.nativeEvent.contentSize.height)),
    );
  }

  function handleDraftChange(text: string) {
    setDraft(text);
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

  const composerFooter = (
    <View
      onLayout={(event: LayoutChangeEvent) => {
        const height = Math.ceil(event.nativeEvent.layout.height);
        setComposerLayoutHeight((current) => (current === height ? current : height));
      }}
      className="border-t border-border bg-background px-3 py-3"
      style={{
        flexShrink: 0,
        paddingBottom: usesNativeKeyboardController ? bottomInset : undefined,
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
            onFocusChange={handleComposerFocusChange}
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
                  editable={!sendBusy && !composerAwaitingAck}
                  scrollEnabled={composerInputOverflowHeight > COMPOSER_INPUT_MAX_HEIGHT}
                  className="text-sm text-foreground"
                  style={[
                    NO_BROWSER_FOCUS_RING,
                    {
                      height: composerInputHeight,
                      fontSize: COMPOSER_INPUT_FONT_SIZE,
                      lineHeight: COMPOSER_INPUT_LINE_HEIGHT,
                      paddingHorizontal: COMPOSER_INPUT_HORIZONTAL_PADDING,
                      paddingTop: COMPOSER_INPUT_VERTICAL_PADDING,
                      paddingBottom: COMPOSER_INPUT_VERTICAL_PADDING,
                      opacity: sendBusy || composerAwaitingAck ? 0.55 : 1,
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

  const terminalPane = (
    <View className="flex-1 bg-card" onLayout={handleTerminalPaneLayout}>
      <KeyboardManagedScrollView
        composerBottomPadding={0}
        keyboardContentPadding={usesNativeKeyboardController ? composerScrollReserve : undefined}
        keyboardOffset={bottomInset}
        keyboardScrollFrozen={keyboardScrollFrozen}
        pane="terminal"
        scrollViewRef={terminalScrollRef}
        showLiveOutputLabel
        onMomentumScrollBegin={handleMomentumScrollBegin}
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEnd={handleScrollEnd}
        onContentInsetChange={handleScrollContentInsetChange}
        onContentSizeChange={handleScrollContentSizeChange}
        onLayout={handleScrollLayout}
        onScroll={handleScroll}
      >
        <TerminalContent terminalLines={terminalLines} />
      </KeyboardManagedScrollView>
    </View>
  );

  const nativeStickyComposer = (
    <KeyboardStickyView
      pointerEvents={composerInteractive ? "box-none" : "none"}
      style={{
        bottom: 0,
        left: 0,
        position: "absolute",
        right: 0,
        zIndex: 10,
      }}
    >
      <Animated.View
        pointerEvents={composerInteractive ? "auto" : "none"}
        style={composerVisibilityStyle}
      >
        {composerFooter}
      </Animated.View>
    </KeyboardStickyView>
  );

  const disconnectedPane = (
    <View className="flex-1 bg-background p-4">
      <Text className="text-sm text-muted-foreground">
        Project service disconnected. Your draft is still here; sending will resume when the service
        reconnects.
      </Text>
    </View>
  );

  const chatScroller = displayServiceEndpoint ? (
    <KeyboardManagedScrollView
      composerBottomPadding={0}
      contentContainerStyle={{ flexGrow: 1 }}
      keyboardContentPadding={usesNativeKeyboardController ? composerScrollReserve : undefined}
      keyboardOffset={bottomInset}
      keyboardScrollFrozen={keyboardScrollFrozen}
      pane="chat"
      scrollViewRef={scrollRef}
      onMomentumScrollBegin={handleMomentumScrollBegin}
      onScrollBeginDrag={handleScrollBeginDrag}
      onScrollEnd={handleScrollEnd}
      onContentInsetChange={handleScrollContentInsetChange}
      onContentSizeChange={handleScrollContentSizeChange}
      onLayout={handleScrollLayout}
      onScroll={handleScroll}
    >
      <TranscriptContent
        dividerWidth={chatDividerWidth}
        initialTranscriptStatus={visibleInitialTranscriptNoticeStatus}
        messages={allMessages}
        olderTranscriptExhausted={olderTranscriptExhausted}
        olderTranscriptLoading={olderTranscriptLoading}
        restoreBlockedReason={restoreBlockedReason}
        sendError={sendError}
        serviceEndpoint={displayServiceEndpoint}
        visibleLastError={visibleLastError}
      />
    </KeyboardManagedScrollView>
  ) : (
    disconnectedPane
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
            <Reanimated.View
              pointerEvents={chatChromeCollapsed ? "none" : "auto"}
              style={[{ flexShrink: 0, overflow: "hidden" }, chatHeaderVisibilityStyle]}
            >
              <View
                className="border-b border-border px-4 py-3 flex-row items-center justify-between"
                onLayout={(event) => {
                  const nextHeight = Math.ceil(event.nativeEvent.layout.height);
                  if (nextHeight > 0) setChatHeaderHeight(nextHeight);
                }}
              >
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
                      {session ? (
                        <Pressable
                          onPress={cycleAgentOutputViewMode}
                          disabled={!canShowTerminal}
                          accessibilityLabel={terminalToggleLabel}
                          className="h-8 w-8 items-center justify-center rounded-md border border-border mr-2 disabled:opacity-40"
                        >
                          {showSplit ? (
                            <Columns2 size={15} color="#a1a1aa" />
                          ) : showTerminalOnly ? (
                            <SquareTerminal size={15} color="#a1a1aa" />
                          ) : (
                            <MessageSquare size={15} color="#a1a1aa" />
                          )}
                        </Pressable>
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
                          <Pressable
                            onPress={cycleAgentOutputViewMode}
                            disabled={!canShowTerminal}
                            accessibilityLabel={terminalToggleLabel}
                            className="h-8 w-8 items-center justify-center rounded-md border border-border mr-2 disabled:opacity-40"
                          >
                            {showSplit ? (
                              <Columns2 size={15} color="#a1a1aa" />
                            ) : showTerminalOnly ? (
                              <SquareTerminal size={15} color="#a1a1aa" />
                            ) : (
                              <MessageSquare size={15} color="#a1a1aa" />
                            )}
                          </Pressable>
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
            </Reanimated.View>
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
              <View className="flex-1" style={{ position: "relative" }}>
                <KeyboardGestureArea
                  interpolator="ios"
                  style={{ flex: 1 }}
                  textInputNativeID={CHAT_INPUT_NATIVE_ID}
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
                      <View
                        className="flex-1"
                        onLayout={(event: LayoutChangeEvent) =>
                          setChatPaneWidth(event.nativeEvent.layout.width)
                        }
                        style={{ position: "relative" }}
                      >
                        {chatScroller}
                        {showInitialTranscriptOverlay ? (
                          <InitialTranscriptOverlay status={effectiveInitialTranscriptStatus} />
                        ) : null}
                      </View>
                    )}
                  </View>
                  {usesNativeKeyboardController ? nativeStickyComposer : composerFooter}
                </KeyboardGestureArea>
              </View>
            )}
          </View>
        </View>
      </View>
    </View>
  );
}

function ComposerFocusShell({
  children,
  dragging,
  onFocusChange,
  onLayout,
  sending = false,
}: {
  children: (handlers: { onBlur: () => void; onFocus: () => void }) => React.ReactNode;
  dragging?: boolean;
  onFocusChange?: (focused: boolean) => void;
  onLayout: (event: LayoutChangeEvent) => void;
  sending?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const onFocus = useCallback(() => {
    setFocused(true);
    onFocusChange?.(true);
  }, [onFocusChange]);
  const onBlur = useCallback(() => {
    setFocused(false);
    onFocusChange?.(false);
  }, [onFocusChange]);
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

  // Per-character colour is what makes this a highlight travelling through the
  // text rather than a second copy of it sliding across.
  const characters = Array.from(label);
  return (
    <Text
      className="text-xs"
      numberOfLines={1}
      accessibilityLabel={label}
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

function KeyboardManagedScrollView({
  children,
  composerBottomPadding,
  contentContainerStyle,
  keyboardContentPadding,
  keyboardOffset = 0,
  keyboardScrollFrozen,
  onMomentumScrollBegin,
  onContentSizeChange,
  onContentInsetChange,
  onLayout,
  onScroll,
  onScrollBeginDrag,
  onScrollEnd,
  pane,
  scrollViewRef,
  showLiveOutputLabel = false,
}: {
  children: React.ReactNode;
  composerBottomPadding: number;
  contentContainerStyle?: React.ComponentProps<typeof ScrollView>["contentContainerStyle"];
  keyboardContentPadding?: SharedValue<number>;
  keyboardOffset?: number;
  keyboardScrollFrozen?: SharedValue<boolean>;
  onMomentumScrollBegin: (pane: ScrollPaneKey) => void;
  onContentSizeChange: (pane: ScrollPaneKey, contentHeight: number) => void;
  onContentInsetChange?: (pane: ScrollPaneKey, contentInsetBottom: number) => void;
  onLayout: (pane: ScrollPaneKey, event: LayoutChangeEvent) => void;
  onScroll: (pane: ScrollPaneKey, event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onScrollBeginDrag: (pane: ScrollPaneKey) => void;
  onScrollEnd: (pane: ScrollPaneKey, key: "dragging" | "momentum") => void;
  pane: ScrollPaneKey;
  scrollViewRef: React.RefObject<ScrollToHandle | null>;
  showLiveOutputLabel?: boolean;
}) {
  const content = (
    <>
      {showLiveOutputLabel ? (
        <Text className="text-xs text-muted-foreground mb-2">Live output</Text>
      ) : null}
      {children}
    </>
  );
  const measuredContent =
    Platform.OS === "web" ? (
      <View
        onLayout={(event: LayoutChangeEvent) =>
          onContentSizeChange(pane, event.nativeEvent.layout.height)
        }
      >
        {content}
      </View>
    ) : (
      content
    );
  const commonProps = {
    automaticallyAdjustKeyboardInsets: false,
    className: showLiveOutputLabel ? "flex-1 px-4 py-3" : "flex-1 px-4 py-2",
    contentContainerStyle: [
      contentContainerStyle,
      composerBottomPadding > 0 ? { paddingBottom: composerBottomPadding } : null,
    ],
    contentInsetAdjustmentBehavior: "never" as const,
    horizontal: false,
    keyboardDismissMode: Platform.OS === "ios" ? ("interactive" as const) : ("none" as const),
    keyboardShouldPersistTaps: "handled" as const,
    onContentSizeChange: (_: number, contentHeight: number) =>
      onContentSizeChange(pane, contentHeight),
    onLayout: (event: LayoutChangeEvent) => onLayout(pane, event),
    onMomentumScrollBegin: () => onMomentumScrollBegin(pane),
    onMomentumScrollEnd: () => onScrollEnd(pane, "momentum"),
    onScrollBeginDrag: () => onScrollBeginDrag(pane),
    onScrollEndDrag: () => onScrollEnd(pane, "dragging"),
    onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => onScroll(pane, event),
    scrollEventThrottle: 16,
  };

  if (Platform.OS !== "web" && keyboardContentPadding) {
    return (
      <KeyboardChatScrollView
        ref={scrollViewRef as React.RefObject<never>}
        {...commonProps}
        applyWorkaroundForContentInsetHitTestBug
        extraContentPadding={keyboardContentPadding}
        freeze={keyboardScrollFrozen}
        keyboardLiftBehavior="whenAtEnd"
        offset={keyboardOffset}
        onContentInsetChange={
          onContentInsetChange
            ? (insets: { bottom: number }) => onContentInsetChange(pane, insets.bottom)
            : undefined
        }
      >
        {content}
      </KeyboardChatScrollView>
    );
  }

  return (
    <ScrollView ref={scrollViewRef as React.RefObject<ScrollView>} {...commonProps}>
      {measuredContent}
    </ScrollView>
  );
}

const TerminalContent = React.memo(function TerminalContent({
  terminalLines,
}: {
  terminalLines: ReturnType<typeof formatTerminalOutputForDisplay>;
}) {
  return (
    <>
      {terminalLines.map((spans, index) => (
        <Text
          key={`row-${index}`}
          className="text-secondary-foreground font-mono"
          style={TERMINAL_TEXT_STYLE}
        >
          {spans.length === 0
            ? " "
            : spans.map((span, spanIndex) => (
                <RNText key={`span-${spanIndex}`} style={[TERMINAL_TEXT_STYLE, span.style]}>
                  {span.text}
                </RNText>
              ))}
        </Text>
      ))}
    </>
  );
});

function transcriptMessageRenderKey(
  message: ChatMessage,
  index: number,
  seen: Map<string, number>,
) {
  const baseKey = message.id ?? message.clientMessageId ?? `idx-${index}`;
  const occurrence = seen.get(baseKey) ?? 0;
  seen.set(baseKey, occurrence + 1);
  return occurrence === 0 ? baseKey : `${baseKey}:dup-${occurrence}:idx-${index}`;
}

const TranscriptContent = React.memo(function TranscriptContent({
  messages,
  dividerWidth,
  initialTranscriptStatus,
  olderTranscriptExhausted,
  olderTranscriptLoading,
  restoreBlockedReason,
  sendError,
  serviceEndpoint,
  visibleLastError,
}: {
  messages: ChatMessage[];
  dividerWidth: number;
  initialTranscriptStatus: InitialTranscriptStatus;
  olderTranscriptExhausted: boolean;
  olderTranscriptLoading: boolean;
  restoreBlockedReason: string | null;
  sendError: string | null;
  serviceEndpoint: ServiceEndpoint;
  visibleLastError: string | null;
}) {
  const messageKeyCounts = new Map<string, number>();
  return (
    <>
      {olderTranscriptLoading && messages.length > 0 ? <TranscriptHistoryLoadingRow /> : null}
      {!olderTranscriptLoading && olderTranscriptExhausted && messages.length > 0 ? (
        <TranscriptHistoryExhaustedRow />
      ) : null}
      {initialTranscriptStatus !== "idle" ? (
        <InitialTranscriptNotice status={initialTranscriptStatus} />
      ) : null}
      {messages.map((message, idx) => (
        <MessageBlock
          key={transcriptMessageRenderKey(message, idx, messageKeyCounts)}
          dividerWidth={dividerWidth}
          message={message}
          serviceEndpoint={serviceEndpoint}
        />
      ))}
      {restoreBlockedReason ? (
        <View className="self-start max-w-[90%] rounded-lg border border-border bg-card px-3 py-2 my-1">
          <Text className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            Resume unavailable
          </Text>
          <Text className="mt-1 text-sm text-card-foreground">{restoreBlockedReason}</Text>
        </View>
      ) : null}
      {visibleLastError ? (
        <Text className="text-xs text-destructive my-2">{visibleLastError}</Text>
      ) : null}
      {sendError ? <Text className="text-xs text-destructive my-2">{sendError}</Text> : null}
    </>
  );
});

function TranscriptHistoryLoadingRow() {
  return (
    <View className="my-2 self-center flex-row items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
      <ActivityIndicator size="small" color="#a1a1aa" />
      <Text className="text-xs text-muted-foreground">Loading older history...</Text>
    </View>
  );
}

function TranscriptHistoryExhaustedRow() {
  return (
    <View className="my-2 self-center rounded-lg border border-border bg-card px-3 py-2">
      <Text className="text-xs text-muted-foreground">Start of available chat history</Text>
    </View>
  );
}

function InitialTranscriptOverlay({ status }: { status: InitialTranscriptStatus }) {
  if (status === "idle") return null;
  const loading = status === "loading";
  return (
    <View
      pointerEvents="none"
      className="absolute inset-0 items-center justify-center px-4"
      style={{ zIndex: 1 }}
    >
      <View className="flex-row items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 shadow-sm">
        {loading ? <ActivityIndicator size="small" color="#a1a1aa" /> : null}
        <Text className="text-sm text-muted-foreground">
          {loading
            ? "Loading transcript history..."
            : "Transcript history is still loading. New output will appear as it arrives."}
        </Text>
      </View>
    </View>
  );
}

function InitialTranscriptNotice({ status }: { status: InitialTranscriptStatus }) {
  if (status === "timed-out") {
    return (
      <View className="my-2 self-start rounded-lg border border-border bg-card px-3 py-2">
        <Text className="text-sm text-muted-foreground">
          Transcript history is still loading. New output will appear as it arrives.
        </Text>
      </View>
    );
  }
  return null;
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
