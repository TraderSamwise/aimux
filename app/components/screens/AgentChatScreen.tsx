import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  AppState,
  Image,
  InteractionManager,
  Platform,
  Pressable,
  ScrollView,
  Text as RNText,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import type { LayoutChangeEvent } from "react-native";
import { agentStateKey, projectStateKey, type AgentStateKey } from "@/lib/project-key";
import { useFocusEffect, useLocalSearchParams, usePathname, useRouter } from "expo-router";
import { useAtom, useAtomValue, useSetAtom, useStore } from "jotai";
import { useColorScheme } from "nativewind";
import { KeyboardChatScrollView, KeyboardStickyView } from "react-native-keyboard-controller";

import { SubagentBadge } from "@/components/SubagentBadge";
import { RuntimeBrandMark } from "@/components/RuntimeBrandMark";
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
  Clock,
  CircleAlert,
  Columns2,
  MessageSquareText,
  Plus,
  SlidersHorizontal,
  Square,
  Terminal,
  UserPlus,
  X,
} from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { AgentActions } from "@/components/agent-actions";
import { AgentManagementPanel } from "@/components/agent-management-panel";
import { TeammatePanel } from "@/components/teammate-panel";
import { ChatChromeMotion } from "@/components/ChatChromeMotion";
import { ChatNewMessagesBadge } from "@/components/ChatNewMessagesBadge";
import { Button } from "@/components/ui/button";
import { Input, NO_BROWSER_FOCUS_RING } from "@/components/ui/input";
import { MessageBlock } from "@/components/MessageBlock";
import { ComposerControl, COMPOSER_CONTROL_LABEL_WIDTH } from "@/components/ComposerControl";
import { AttachmentDropZone } from "@/components/AttachmentDropZone";
import {
  CHAT_RECONNECTING_PANEL_RESERVE,
  CHAT_SESSION_HEADER_HEIGHT,
  chatControlPanelReserveHeight,
  chatOverlayPanelReserveHeight,
  chatTopBarReserveHeight,
  chatTranscriptTopReserveHeight,
} from "@/lib/chat-chrome-layout";
import { useAuth, useUser } from "@/lib/auth";
import { agentActivityLabel, shouldShimmerAgentActivityLabel } from "@/lib/activity-label";
import { blurWebActiveElement } from "@/lib/blur-web-active-element";
import { registerChatComposerFocus } from "@/lib/chat-composer-focus";
import {
  chatKeyboardIntent,
  createChatKeyboardEdgeWatcher,
  recordChatKeyboardHidden,
  recordComposerFocusIntent,
  shouldFocusComposerOnOpen,
} from "@/lib/chat-keyboard-intent";
import {
  createShareInvite,
  getShare,
  leaveShare,
  listShares,
  markNotificationsRead,
  markSessionSeen,
  removeShareParticipant,
  revokeShareInvite,
  interruptLivePane,
  sendLivePaneInput,
  uploadAttachment,
  type ShareInvite,
  type ShareParticipant,
  type SharedSessionSummary,
} from "@/lib/api";
import { sessionViewedMark } from "@/lib/session-viewed";
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
  composerFooterState,
  heldNoticeDurationMs,
  type ComposerFooterState,
} from "@/lib/composer-footer";
import {
  COMPOSER_SEND_TIMEOUT_MESSAGE,
  formatComposerSendFailure,
  normalizeComposerDraft,
  shouldSubmitComposerKey,
  userMessageAcknowledgesComposerSend,
  type ComposerKeyEventLike,
} from "@/lib/composer-protocol";
import {
  COMPOSER_ECHO_CONFIRMATION_TIMEOUT_MS,
  mergeAcceptedComposerEchoes,
  type AcceptedComposerEcho,
} from "@/lib/composer-echo";
import {
  sendDeliveryStateAfterResponse,
  formatLivePaneInputResponseRefusal,
  formatPostActionTranscriptRefreshResult,
} from "@/lib/input-delivery";
import {
  chatCommandForContentChange,
  chatCommandForInitialLayout,
  chatScrollCommandRunsWhileUnpinned,
  chatScrollEndOffset,
  chatCommandForKeyboardChange,
  chatCommandForNavigationFocus,
  chatChromeAfterUserScroll,
  chatPolicyAfterNavigationFocus,
  chatPolicyAfterUserScroll,
  createChatScrollChromeState,
  createChatScrollPolicy,
  type ChatScrollChromeState,
  type ChatScrollCommand,
  type ChatScrollMetrics,
  type ChatScrollPolicy,
  type ChatScrollReason,
} from "@/lib/chat-scroll-policy";
import {
  chatVisibleTranscriptForLiveChange,
  chatVisibleTranscriptForPinned,
  chatVisibleTranscriptMessages,
  type ChatVisibleTranscript,
} from "@/lib/chat-visible-transcript";
import { chatFrozenNewMessageCount } from "@/lib/chat-new-message-badge";
import { canUseChatSplitView, chatOutputPaneVisibility } from "@/lib/chat-output-mode";
import { chatViewportKeyForRoute } from "@/lib/chat-viewport-key";
import {
  CHAT_OUTPUT_CAPTURE_START_LINE,
  CHAT_OUTPUT_MAX_CAPTURE_START_LINE,
} from "@/lib/chat-output-constants";
import {
  agentOutputModeForVisiblePane,
  chatTranscriptPlaceholderState,
  type ChatTranscriptPlaceholderState,
} from "@/lib/chat-loading";
import { formatTerminalOutputForDisplay } from "@/lib/terminal-output";
import {
  terminalScrollStateAfterUserScroll,
  terminalVisibleOutputForLiveChange,
  terminalVisibleOutputForPinned,
} from "@/lib/terminal-visible-output";
import { useAgentOutputFeed } from "@/lib/use-agent-output-feed";
import type { AgentOutputFeedPurpose } from "@/lib/use-agent-output-feed";
import { cn } from "@/lib/utils";
import { resolveChromeBottomInset, resolveChromeTopInset } from "@/lib/native-safe-area";
import { useResponsiveViewport } from "@/lib/responsive-viewport";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { DesktopSession } from "@/lib/desktop-state";
import { singleRouteParam } from "@/lib/route-params";
import {
  activeSessionsFromShareSummaries,
  mergeActiveSharedSessions,
  sharedSessionsEqual,
} from "@/lib/shared-sessions";
import { attachmentTooLargeMessage, firstOversizedAttachment } from "@/lib/attachment-limits";
import { chatHistoryAtFloor, chatHistoryFloorNotice } from "@/lib/chat-history-floor";
import {
  type ChatHistoryPagerResolution,
  chatHistoryPagerResolved,
  chatHistoryPagerScrolled,
  chatHistoryPagerState,
} from "@/lib/chat-history-pager";
import { toChatMessages } from "@/lib/transcript-view";
import { useRouteProject } from "@/lib/use-route-project";
import { useRouteShare } from "@/lib/use-route-share";
import {
  setNativeChatComposerFocused,
  subscribeNativeAppCommands,
} from "@/lib/native-app-commands";
import { resolveSharedChatActor } from "@/lib/shared-chat-actor";
import { worktreeIdentity, worktreeTone } from "@/lib/worktree-tone";
import { buildMainTabHref } from "@/lib/main-tabs";
import { useHasHardwareKeyboard } from "@/lib/hardware-keyboard";
import { useKeyboardVisible } from "@/lib/use-keyboard-visible";
import { isTransientRequestError } from "@/lib/request-errors";
import {
  activityFamily,
  activityTextFamily,
  clearLocalInterruptHoldAtom,
  lastErrorFamily,
  outputAnsiFamily,
  outputAvailableFamily,
  outputBufferFamily,
  markOutputInterruptedAtom,
  transcriptFamily,
  transcriptStartLineFamily,
} from "@/stores/chat";
import { desktopStateFamily, worktreeGroupsFamily } from "@/stores/desktopState";
import { selectedSessionIdAtom } from "@/stores/projects";
import { relayConfiguredAtom, relayStatusAtom } from "@/stores/relay";
import { markNotificationRecordsReadLocalAtom } from "@/stores/notifications";
import {
  acceptedSharedSessionsAtom,
  activeSharedSessionAtom,
  agentOutputViewModeAtom,
  type AgentOutputViewMode,
  type ActiveSharedSession,
} from "@/stores/settings";
import { chatChromeVisibleAtom, chatComposerDraftFamily } from "@/stores/ui";
import type { ChatMessage, HistoryPart } from "@/lib/events";

const MAX_PENDING_ATTACHMENTS = 4;
const CHAT_SCROLL_HORIZONTAL_PADDING = 32;
const CHAT_ASSISTANT_BUBBLE_MAX_RATIO = 0.9;
const CHAT_DIVIDER_APPROX_CHAR_WIDTH = Platform.OS === "web" ? 9.6 : 12.4;
const CHAT_DIVIDER_WIDTH_SAFETY = Platform.OS === "web" ? 4 : 6;
const MIN_CHAT_DIVIDER_WIDTH = 16;
const MAX_CHAT_DIVIDER_WIDTH = Platform.OS === "web" ? 72 : 24;
type ChatScrollHandle = Pick<ScrollView, "scrollTo" | "scrollToEnd">;
type ChatSessionViewportHandle = {
  showNewest: () => void;
};
const COMPOSER_INPUT_FONT_SIZE = 14;
const COMPOSER_INPUT_LINE_HEIGHT = 20;
const COMPOSER_INPUT_MAX_LINES = 4;
const COMPOSER_INPUT_VERTICAL_PADDING = 6;
const COMPOSER_INPUT_MIN_HEIGHT = COMPOSER_INPUT_LINE_HEIGHT + COMPOSER_INPUT_VERTICAL_PADDING * 2;
const COMPOSER_INPUT_MAX_HEIGHT =
  COMPOSER_INPUT_LINE_HEIGHT * COMPOSER_INPUT_MAX_LINES + COMPOSER_INPUT_VERTICAL_PADDING * 2;
const COMPOSER_INPUT_HORIZONTAL_PADDING = 4;
const COMPOSER_FOOTER_VERTICAL_PADDING = 12;
const CHAT_COMPOSER_CONTROL_ROW_HEIGHT = 34;
const CHAT_COMPOSER_RESERVE_GAP = 8;
const CHAT_ATTACHMENT_STRIP_RESERVE = 88;
const CHAT_NEW_MESSAGE_BADGE_DEBOUNCE_MS = 180;
const CHAT_NEW_MESSAGE_BADGE_VISIBLE_MS = 3200;
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
  pendingAttachments: PendingAttachment[];
};

type PendingComposerAck = {
  attachmentCount: number;
  attachmentIds: string[];
  baselineUserMessageCount: number;
  id: number;
  text: string;
  attachmentFilenames: string[];
  timedOut: boolean;
};

type AcceptedComposerMessage = AcceptedComposerEcho;

const composerDraftsByKey = new Map<string, ComposerDraftSnapshot>();
type JotaiStore = ReturnType<typeof useStore>;

function hasComposerDraftContent(text: string): boolean {
  return /\S/.test(text);
}

function readComposerDraft(store: JotaiStore, key: string | null): string {
  return key ? store.get(chatComposerDraftFamily(key)) : "";
}

function writeComposerDraft(store: JotaiStore, key: string | null, draft: string) {
  if (!key) return;
  store.set(chatComposerDraftFamily(key), draft);
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
    pendingComposerEcho: true,
    role: "user",
    parts,
    text,
  };
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
    notificationId?: string | string[];
    ownerUserId?: string | string[];
    sessionId?: string | string[];
    shareId?: string | string[];
  }>();
  const routeOwnerUserId = singleRouteParam(params.ownerUserId);
  const routeFocusToken = singleRouteParam(params.focusToken) ?? "";
  const routeNotificationId = singleRouteParam(params.notificationId) ?? "";
  const sessionId = singleRouteParam(params.sessionId);
  const routeShareId = singleRouteParam(params.shareId);
  const sessionKey = sessionId ?? "";
  const {
    project,
    projectPath,
    machineId,
    projectRef,
    endpoint: serviceEndpoint,
  } = useRouteProject();
  const stateProjectPath = projectPath ?? "";
  // Keyed by the pair: two machines' copies of one checkout are two projects.
  const stateProjectKey = projectStateKey(projectRef);
  // A session id is unique within one project service, not across the fleet:
  // the same checkout on two machines can hold an agent of the same name, and
  // their transcripts, streaming state and errors must not be one atom.
  const agentKey = agentStateKey(stateProjectKey, sessionId);
  const desktopState = useAtomValue(desktopStateFamily(stateProjectKey));
  const worktreeGroups = useAtomValue(worktreeGroupsFamily(stateProjectKey));
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const markOutputInterrupted = useSetAtom(markOutputInterruptedAtom);
  const clearLocalInterruptHold = useSetAtom(clearLocalInterruptHoldAtom);
  const setGlobalChatChromeVisible = useSetAtom(chatChromeVisibleAtom);
  const markNotificationsReadLocal = useSetAtom(markNotificationRecordsReadLocalAtom);
  const transcript = useAtomValue(transcriptFamily(agentKey));
  const transcriptLastError = useAtomValue(lastErrorFamily(agentKey));
  const activity = useAtomValue(activityFamily(agentKey));
  const activityText = useAtomValue(activityTextFamily(agentKey));
  const [agentOutputViewMode, setAgentOutputViewMode] = useAtom(agentOutputViewModeAtom);
  const relayConfigured = useAtomValue(relayConfiguredAtom);
  const relayStatus = useAtomValue(relayStatusAtom);
  const activeShare = useRouteShare();
  const setLegacyActiveShare = useSetAtom(activeSharedSessionAtom);
  const setAcceptedShares = useSetAtom(acceptedSharedSessionsAtom);
  const jotaiStore = useStore();
  const { getToken } = useAuth();
  const { user } = useUser();
  const router = useRouter();
  const pathname = usePathname();
  const {
    chatHeaderCompact: compactHeaderActions,
    chatSplitWidth,
    layoutHeight: windowHeight,
    layoutWidth: width,
    sidebarPresentation,
  } = useResponsiveViewport();
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
  const [pendingComposerAck, setPendingComposerAck] = useState<PendingComposerAck | null>(null);
  const [acceptedComposerMessages, setAcceptedComposerMessages] = useState<
    AcceptedComposerMessage[]
  >([]);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [sendBusy, setSendBusy] = useState(false);
  const [composerWidth, setComposerWidth] = useState(0);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendWarning, setSendWarning] = useState<string | null>(null);
  // An accepted send the project service queued rather than delivered. Kept
  // apart from `sendError`: the route returns it with `accepted: true`. The
  // hold duration rides along so the notice retires on its own rather than
  // sitting there claiming "not delivered yet" indefinitely.
  const [heldDelivery, setHeldDelivery] = useState<{
    notice: string;
    holdMs: number | null;
  } | null>(null);
  const [chatChromeVisible, setChatChromeVisible] = useState(true);
  const [composerFocused, setComposerFocused] = useState(false);
  const hasHardwareKeyboard = useHasHardwareKeyboard();
  const [lastConnectedEndpoint, setLastConnectedEndpoint] = useState<{
    endpoint: ServiceEndpoint;
    projectPath: string;
  } | null>(null);
  const activeShareForRoute =
    activeShare && activeShare.sessionId === sessionId ? activeShare : null;
  const chatViewportKey = chatViewportKeyForRoute({
    focusToken: routeFocusToken,
    machineId,
    projectPath: stateProjectPath,
    sessionKey,
    share: activeShareForRoute,
  });
  const isCanonicalSharedRoute = Boolean(
    pathname.startsWith("/shares/") && routeOwnerUserId && routeShareId && sessionId,
  );
  const isSharedSessionView = Boolean(activeShareForRoute);
  const isSharedConversation =
    isCanonicalSharedRoute || isSharedSessionView || isMultiplexedShare(shareSummary);
  const canUseOwnerControls = !isCanonicalSharedRoute && !isSharedSessionView;
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
  const chatViewportRef = useRef<ChatSessionViewportHandle | null>(null);
  const terminalViewportRef = useRef<ChatSessionViewportHandle | null>(null);
  const activeComposerDraftKeyRef = useRef<string | null>(null);
  const composerFocusedRef = useRef(false);
  const screenFocusedRef = useRef(false);
  const nativeChatSendRef = useRef<() => void>(() => {});
  const nativeChatInterruptRef = useRef<() => void>(() => {});
  const routeNotificationLocalReadKeyRef = useRef<string | null>(null);
  const routeNotificationServerReadKeyRef = useRef<string | null>(null);
  const sessionViewedMarkKeyRef = useRef<string | null>(null);
  const sendOperationIdRef = useRef(0);
  const interruptInFlightRef = useRef(false);
  const composerDraftSnapshotRef = useRef<ComposerDraftSnapshot>({
    draft: "",
    pendingAttachments: [],
  });
  const composerDraftTextRef = useRef("");
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([]);
  const sendErrorRef = useRef<string | null>(null);
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
  const canUseSplitView = canUseChatSplitView(chatSplitWidth);
  const {
    chatViewVisible,
    effectiveMode: effectiveAgentOutputViewMode,
    terminalViewVisible,
  } = chatOutputPaneVisibility({
    mode: agentOutputViewMode,
    rawOutputAllowed: canUseOwnerControls,
    width: chatSplitWidth,
  });
  const agentOutputFeedMode = agentOutputModeForVisiblePane({ terminalViewVisible });
  const [chatHistoryFloorReached, setChatHistoryFloorReached] = useState(false);
  // The pager's whole state in one ref: the cursor, the failure count within
  // this gesture, whether a page has arrived, and whether the service has said
  // there is no more. A ref because nothing renders from it -- the transcript
  // comes from the store -- and because a resolved page must read it without
  // an impure React updater.
  const chatHistoryPagerRef = useRef(chatHistoryPagerState());
  const [pendingChatOutputHistoryStartLine, setPendingChatOutputHistoryStartLine] = useState<
    number | null
  >(null);
  const pendingChatOutputHistoryStartLineRef = useRef<number | null>(null);
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
    if (stateProjectKey) return ["project", stateProjectKey, sessionId].join(":");
    return ["session", sessionId].join(":");
  }, [activeShareForRoute, sessionId, stateProjectKey]);

  useEffect(() => {
    // Seeded from the transcript the store already holds for THIS agent, not
    // from the shallow window. Re-entering a session that had been paged to
    // the floor used to restart the cursor at -160 while the store still held
    // the deep transcript, so the next several scroll-ups asked for windows
    // already on screen and changed nothing.
    // Only when a transcript is actually stored for this agent. The start line
    // is the echoed request, the atom outlives the pane it described, and a
    // stream event with no start line clears it -- so on its own it can say
    // "-2000" about history that is no longer there. Tied to content that is
    // on screen, cursor and transcript agree.
    const stored = jotaiStore.get(transcriptStartLineFamily(agentKey));
    const hasTranscript = jotaiStore.get(transcriptFamily(agentKey)).length > 0;
    const seeded = hasTranscript ? stored : undefined;
    chatHistoryPagerRef.current = chatHistoryPagerState(seeded);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- each route/session clears its own floor notice
    setChatHistoryFloorReached(false);
    pendingChatOutputHistoryStartLineRef.current = null;
    setPendingChatOutputHistoryStartLine(null);
  }, [agentKey, jotaiStore]);

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
    composerDraftSnapshotRef.current = {
      draft: composerDraftTextRef.current,
      pendingAttachments,
    };
  }, [pendingAttachments]);

  useEffect(() => {
    sendErrorRef.current = sendError;
  }, [sendError]);

  useEffect(() => {
    const previousKey = activeComposerDraftKeyRef.current;
    if (previousKey && previousKey !== composerDraftKey) {
      rememberComposerDraft(previousKey, {
        draft: readComposerDraft(jotaiStore, previousKey),
        pendingAttachments: pendingAttachmentsRef.current,
      });
    }

    activeComposerDraftKeyRef.current = composerDraftKey;
    const saved = composerDraftKey ? composerDraftsByKey.get(composerDraftKey) : undefined;
    const nextDraft = saved?.draft ?? "";
    writeComposerDraft(jotaiStore, composerDraftKey, nextDraft);
    composerDraftTextRef.current = nextDraft;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the composer is re-seeded from the draft store when the conversation changes
    setPendingAttachments(saved?.pendingAttachments ? [...saved.pendingAttachments] : []);
    setPendingComposerAck(null);
    setAcceptedComposerMessages([]);
    setSendBusy(false);
    sendBusyRef.current = false;
    setSendError(null);
    setSendWarning(null);
    // Carrying it into another agent's composer would strand "Input held, not
    // delivered yet" on a composer that never sent anything.
    setHeldDelivery(null);
  }, [composerDraftKey, jotaiStore]);

  useEffect(() => {
    return () => {
      const activeKey = activeComposerDraftKeyRef.current;
      rememberComposerDraft(activeKey, {
        draft: readComposerDraft(jotaiStore, activeKey),
        pendingAttachments: pendingAttachmentsRef.current,
      });
    };
  }, [jotaiStore]);

  // Keep selectedSessionId in the projects store in sync with the route param so the sidebar highlights it.
  useEffect(() => {
    if (!sessionId) return;
    selectSession(sessionId);
  }, [sessionId, selectSession]);

  useEffect(() => {
    if (!routeNotificationId || !projectPath) return;
    const readKey = `${stateProjectKey}\u0000${routeNotificationId}`;

    if (routeNotificationLocalReadKeyRef.current !== readKey) {
      routeNotificationLocalReadKeyRef.current = readKey;
      markNotificationsReadLocal({ projectStateKey: stateProjectKey, ids: [routeNotificationId] });
    }
    if (!serviceEndpoint) return;
    const serverReadKey = `${readKey}\u0000${token ?? ""}`;
    if (routeNotificationServerReadKeyRef.current === serverReadKey) return;
    routeNotificationServerReadKeyRef.current = serverReadKey;
    void markNotificationsRead(
      serviceEndpoint,
      { id: routeNotificationId },
      { token: token ?? undefined },
    ).catch(() => {
      if (routeNotificationServerReadKeyRef.current === serverReadKey) {
        routeNotificationServerReadKeyRef.current = null;
      }
    });
  }, [
    markNotificationsReadLocal,
    projectPath,
    routeNotificationId,
    serviceEndpoint,
    stateProjectKey,
    token,
  ]);

  // Entering an agent, or switching back to one, is reading it. The terminal
  // does this from the tmux window-change hook; this is the same route, so the
  // count clears identically from either surface.
  useFocusEffect(
    useCallback(() => {
      const mark = sessionViewedMark({
        sessionId,
        endpoint: serviceEndpoint ?? null,
        token,
        sharedView: isSharedSessionView,
      });
      if (!mark || !serviceEndpoint) return;
      if (sessionViewedMarkKeyRef.current === mark.key) return;
      sessionViewedMarkKeyRef.current = mark.key;
      void markSessionSeen(
        serviceEndpoint,
        { session: mark.sessionId },
        { token: token ?? undefined },
      ).catch((error: unknown) => {
        // Let the next focus retry, and say why this one did not land rather
        // than leaving a count on screen with no explanation.
        if (sessionViewedMarkKeyRef.current === mark.key) {
          sessionViewedMarkKeyRef.current = null;
        }
        console.warn(`mark seen failed for ${mark.sessionId}:`, error);
      });
    }, [isSharedSessionView, serviceEndpoint, sessionId, token]),
  );

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
  const headerActionsMaxWidth =
    Platform.OS === "web" ? undefined : Math.max(MIN_HEADER_ACTIONS_WIDTH, width * 0.52);
  const composerFooterBottomPadding =
    Platform.OS === "web" || keyboardVisible
      ? COMPOSER_FOOTER_VERTICAL_PADDING
      : COMPOSER_FOOTER_VERTICAL_PADDING + resolveChromeBottomInset(insets.bottom);
  const displayServiceEndpoint =
    serviceEndpoint ??
    (lastConnectedEndpoint?.projectPath === stateProjectPath
      ? lastConnectedEndpoint.endpoint
      : null);
  const serviceDisconnected =
    !routeSessionMissing && !serviceEndpoint && Boolean(displayServiceEndpoint);
  const showComposerFooter = !routeSessionMissing && Boolean(displayServiceEndpoint);
  const showPairingBanner =
    relayConfigured &&
    relayStatus === "device_pending" &&
    pathname !== "/shares" &&
    !pathname.startsWith("/shares/") &&
    !activeShare;
  const resolvedTopInset = resolveChromeTopInset(insets.top, {
    reserveTopSafeArea: sidebarPresentation !== "persistent",
  });
  const topBarHeight = chatTopBarReserveHeight({
    pairingBannerVisible: showPairingBanner,
    topInset: resolvedTopInset,
  });
  const chatHeaderTopReserve = topBarHeight + CHAT_SESSION_HEADER_HEIGHT;
  const chatOverlayPanelReserve = chatOverlayPanelReserveHeight({
    manageOpen: managePanelOpen,
    serviceDisconnected,
    shareDetailsExpanded: shareDetailsExpanded || !activeShare,
    shareOpen: sharePanelOpen,
    windowHeight,
  });
  const chatControlPanelReserve = chatControlPanelReserveHeight({
    manageOpen: managePanelOpen,
    shareDetailsExpanded: shareDetailsExpanded || !activeShare,
    shareOpen: sharePanelOpen,
    windowHeight,
  });
  const chatControlPanelTopReserve =
    chatHeaderTopReserve + (serviceDisconnected ? CHAT_RECONNECTING_PANEL_RESERVE : 0);
  const chatTopContentReserve = chatTranscriptTopReserveHeight({
    pairingBannerVisible: showPairingBanner,
    panelReserveHeight: chatOverlayPanelReserve,
    topInset: resolvedTopInset,
  });
  const chatBottomContentReserve =
    COMPOSER_FOOTER_VERTICAL_PADDING +
    COMPOSER_INPUT_MAX_HEIGHT +
    CHAT_COMPOSER_RESERVE_GAP +
    CHAT_COMPOSER_CONTROL_ROW_HEIGHT +
    composerFooterBottomPadding +
    (pendingAttachments.length > 0 ? CHAT_ATTACHMENT_STRIP_RESERVE : 0);
  const effectiveChatChromeVisible =
    chatChromeVisible ||
    keyboardVisible ||
    composerFocused ||
    pendingAttachments.length > 0 ||
    sharePanelOpen ||
    managePanelOpen ||
    serviceDisconnected ||
    routeSessionMissing ||
    !displayServiceEndpoint;
  const newMessageBadgeBottomOffset = effectiveChatChromeVisible
    ? chatBottomContentReserve + 10
    : composerFooterBottomPadding + 8;
  const heartbeatReady = isSharedSessionView || !relayConfigured || relayStatus === "connected";
  const endpointHost = serviceEndpoint?.host ?? null;
  const endpointPort = serviceEndpoint?.port ?? null;
  // Part of the address, not a detail of it: the same host and port name a
  // different project service on each machine.
  const endpointMachineId = serviceEndpoint?.machineId ?? null;
  const useScrollableNativeHeader = Platform.OS !== "web";
  const chatBubbleMaxWidth = Math.max(
    260,
    Math.floor((width - CHAT_SCROLL_HORIZONTAL_PADDING) * CHAT_ASSISTANT_BUBBLE_MAX_RATIO),
  );

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

  useEffect(() => {
    if (!endpointHost || !endpointPort) return;
    const timer = setTimeout(() => {
      setLastConnectedEndpoint((current) => {
        if (
          current?.projectPath === stateProjectPath &&
          current.endpoint.host === endpointHost &&
          current.endpoint.port === endpointPort &&
          (current.endpoint.machineId ?? null) === endpointMachineId
        ) {
          return current;
        }
        return {
          endpoint: {
            host: endpointHost,
            port: endpointPort,
            ...(endpointMachineId ? { machineId: endpointMachineId } : {}),
          },
          projectPath: stateProjectPath,
        };
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [endpointHost, endpointMachineId, endpointPort, stateProjectPath]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new chat route starts with chrome visible
    setChatChromeVisible(true);
    setGlobalChatChromeVisible(true);
  }, [chatViewportKey, setGlobalChatChromeVisible]);

  const handleChatChromeVisibleChange = useCallback(
    (visible: boolean) => {
      setChatChromeVisible((current) => (current === visible ? current : visible));
    },
    [setChatChromeVisible],
  );

  useEffect(() => {
    setGlobalChatChromeVisible(effectiveChatChromeVisible);
  }, [effectiveChatChromeVisible, setGlobalChatChromeVisible]);

  useEffect(() => {
    return () => setGlobalChatChromeVisible(true);
  }, [setGlobalChatChromeVisible]);

  const { initialStatus: initialOutputStatus, refreshOutputSnapshot } = useAgentOutputFeed({
    appVisible,
    enabled: heartbeatReady && !routeSessionMissing,
    endpoint: serviceEndpoint ?? null,
    mode: agentOutputFeedMode,
    projectStateKey: stateProjectKey,
    sessionId,
    startLine: CHAT_OUTPUT_CAPTURE_START_LINE,
    token,
  });

  // Coming back from a long background, re-read the deepest tail the service
  // will serve rather than the 160-line default: a shallow window shares no
  // message with the stored transcript, and the lines between were never
  // fetched. `-2000 < currentStartLine` takes the wholesale-replace branch.
  // One place both paging paths decide what a page meant. A React updater has
  // to be pure, so the decision happens here and only the new value goes in.
  //
  // The pager's state lives in a ref and its rules live in
  // `chat-history-pager`, where the sequences can actually be driven: this
  // screen is an Expo Router route no renderer in this app executes, so a gate
  // here can only read source text -- and four mutations survived that,
  // including restoring the original bug verbatim.
  const applyChatHistoryPageOutcome = useCallback((resolution: ChatHistoryPagerResolution) => {
    const next = chatHistoryPagerResolved(chatHistoryPagerRef.current, resolution);
    chatHistoryPagerRef.current = next;
    if (next.floorReached) setChatHistoryFloorReached(true);
  }, []);

  const wasAppVisibleRef = useRef(appVisible);
  useEffect(() => {
    const returned = appVisible && !wasAppVisibleRef.current;
    wasAppVisibleRef.current = appVisible;
    if (!returned) return;
    // The paging cursor has to move with it, or the next scroll up asks for a
    // SHALLOWER window than the one now stored and pages back to it -- but
    // only once the page is actually here. It used to move before this request
    // resolved, and on a resume with no endpoint it moved for a request that
    // was never sent.
    let arrived = false;
    let served: number | undefined;
    void refreshOutputSnapshot("history", {
      startLine: CHAT_OUTPUT_MAX_CAPTURE_START_LINE,
      onSnapshotApplied: (startLine) => {
        arrived = true;
        served = startLine;
      },
    })
      .then(() => {
        applyChatHistoryPageOutcome({
          requestedStartLine: CHAT_OUTPUT_MAX_CAPTURE_START_LINE,
          arrived,
          appliedStartLine: served,
        });
      })
      .catch(() => {});
  }, [appVisible, applyChatHistoryPageOutcome, refreshOutputSnapshot]);

  const requestChatHistoryPage = useCallback(
    (metrics: ChatScrollMetrics) => {
      const scrolled = chatHistoryPagerScrolled(chatHistoryPagerRef.current, {
        metrics,
        ready: chatViewVisible && heartbeatReady && !routeSessionMissing,
        pendingStartLine:
          pendingChatOutputHistoryStartLineRef.current ?? pendingChatOutputHistoryStartLine,
      });
      chatHistoryPagerRef.current = scrolled.state;
      const nextStartLine = scrolled.request;
      if (nextStartLine === null) {
        if (
          chatHistoryAtFloor({
            currentStartLine: scrolled.state.startLine,
            metrics,
            pagedAtLeastOnce: scrolled.state.pagedAtLeastOnce,
          })
        ) {
          setChatHistoryFloorReached(true);
        }
        return;
      }
      pendingChatOutputHistoryStartLineRef.current = nextStartLine;
      setPendingChatOutputHistoryStartLine(nextStartLine);
      // The callback fires only when a snapshot was applied, so never firing
      // means nothing arrived. Firing with no start line means a page DID
      // arrive without one -- the field is optional in the contract.
      let arrived = false;
      let served: number | undefined;
      void refreshOutputSnapshot("history", {
        startLine: nextStartLine,
        onSnapshotApplied: (startLine) => {
          arrived = true;
          served = startLine;
        },
      })
        .then(() => {
          applyChatHistoryPageOutcome({
            requestedStartLine: nextStartLine,
            arrived,
            appliedStartLine: served,
          });
        })
        .catch(() => {
          // History paging is opportunistic; the live feed and explicit Retry
          // own visible errors. The failure still counts against the brake.
          applyChatHistoryPageOutcome({ requestedStartLine: nextStartLine, arrived: false });
        })
        .finally(() => {
          if (pendingChatOutputHistoryStartLineRef.current === nextStartLine) {
            pendingChatOutputHistoryStartLineRef.current = null;
          }
          setPendingChatOutputHistoryStartLine((current) =>
            current === nextStartLine ? null : current,
          );
        });
    },
    [
      applyChatHistoryPageOutcome,
      chatViewVisible,
      heartbeatReady,
      pendingChatOutputHistoryStartLine,
      refreshOutputSnapshot,
      routeSessionMissing,
    ],
  );

  const parsedMessages = useMemo<ChatMessage[]>(
    () =>
      toChatMessages(transcript, sessionKey, {
        shared: isSharedConversation,
      }),
    [transcript, sessionKey, isSharedConversation],
  );
  const transcriptWindowNotice = chatHistoryFloorNotice(chatHistoryFloorReached);
  const parsedMessageCount = parsedMessages.length;
  const parsedUserMessageCount = useMemo(
    () => parsedMessages.reduce((count, message) => count + (message.role === "user" ? 1 : 0), 0),
    [parsedMessages],
  );
  const parsedMessageCountRef = useRef(parsedMessageCount);
  const parsedUserMessageCountRef = useRef(parsedUserMessageCount);
  const allMessages = useMemo<ChatMessage[]>(() => {
    return mergeAcceptedComposerEchoes(parsedMessages, acceptedComposerMessages, {
      nowMs: 0,
      timeoutMs: Number.POSITIVE_INFINITY,
    }).messages;
  }, [acceptedComposerMessages, parsedMessages]);
  const chatPlaceholderState = useMemo(
    () =>
      chatTranscriptPlaceholderState({
        initialStatus: initialOutputStatus,
        lastError: transcriptLastError,
        messageCount: allMessages.length,
      }),
    [allMessages.length, initialOutputStatus, transcriptLastError],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- parsed transcript updates settle local accepted composer echoes
    setAcceptedComposerMessages((current) => {
      const result = mergeAcceptedComposerEchoes(parsedMessages, current, {
        nowMs: Date.now(),
        timeoutMs: COMPOSER_ECHO_CONFIRMATION_TIMEOUT_MS,
      });
      return result.echoes === current ? current : result.echoes;
    });
  }, [parsedMessages]);

  useEffect(() => {
    parsedMessageCountRef.current = parsedMessageCount;
    parsedUserMessageCountRef.current = parsedUserMessageCount;
  }, [parsedMessageCount, parsedUserMessageCount]);

  useEffect(() => {
    const pendingEchoes = acceptedComposerMessages.filter((message) => !message.settled);
    if (pendingEchoes.length === 0) return;
    const now = Date.now();
    const nextExpiryMs = Math.min(
      ...pendingEchoes.map(
        (message) => message.createdAtMs + COMPOSER_ECHO_CONFIRMATION_TIMEOUT_MS,
      ),
    );
    const timer = setTimeout(
      () => {
        setAcceptedComposerMessages((current) => {
          const result = mergeAcceptedComposerEchoes(parsedMessages, current, {
            nowMs: Date.now(),
            timeoutMs: COMPOSER_ECHO_CONFIRMATION_TIMEOUT_MS,
          });
          if (result.droppedExpiredCount > 0) {
            setSendError(COMPOSER_SEND_TIMEOUT_MESSAGE);
          }
          return result.echoes;
        });
      },
      Math.max(0, nextExpiryMs - now),
    );
    return () => clearTimeout(timer);
  }, [acceptedComposerMessages, parsedMessages]);

  const userMessageCount = useMemo(
    () => allMessages.reduce((count, message) => count + (message.role === "user" ? 1 : 0), 0),
    [allMessages],
  );
  const userMessageCountRef = useRef(userMessageCount);
  const composerSendAcknowledged = pendingComposerAck
    ? userMessageAcknowledgesComposerSend(allMessages, pendingComposerAck)
    : false;
  const composerAwaitingAck = pendingComposerAck !== null && !pendingComposerAck.timedOut;
  // A send is confirmed by the message appearing in the transcript, and
  // terminal mode does not mount that pane -- so a send that worked looked
  // exactly like one that did nothing, and the ten-second echo timeout then
  // said "Send not confirmed yet" with nothing on screen to explain it.
  const composerSendPendingEcho = acceptedComposerMessages.some((message) => !message.settled);
  const heldDeliveryNotice = heldDelivery?.notice ?? null;
  // Passes the mode rather than the `chatViewVisible` computed above: a
  // boolean handed in could be hardwired, and in the first cut of this change
  // it was. Same bindings, same render, same pure helper, so the two calls
  // cannot disagree.
  const composerFooterStateValue = composerFooterState({
    activityLabel,
    activityLabelShimmer,
    awaitingEcho: composerSendPendingEcho,
    error: sendError,
    heldNotice: heldDeliveryNotice,
    warningNotice: sendWarning,
    mode: agentOutputViewMode,
    rawOutputAllowed: canUseOwnerControls,
    sending: sendBusy || composerAwaitingAck,
    width: chatSplitWidth,
  });

  useEffect(() => {
    if (!heldDelivery) return;
    const delay = heldNoticeDurationMs({ holdMs: heldDelivery.holdMs });
    if (delay === null) return;
    const timer = setTimeout(() => setHeldDelivery(null), delay);
    return () => clearTimeout(timer);
  }, [heldDelivery]);

  useLayoutEffect(() => {
    userMessageCountRef.current = userMessageCount;
  }, [userMessageCount]);

  useEffect(() => {
    if (!pendingComposerAck) return;
    if (!composerSendAcknowledged) return;
    const draftStillMatches =
      readComposerDraft(jotaiStore, composerDraftKey) === pendingComposerAck.text;
    const attachmentsStillMatch =
      pendingAttachments.length === pendingComposerAck.attachmentFilenames.length &&
      pendingAttachments.every(
        (attachment, index) =>
          attachment.filename === pendingComposerAck.attachmentFilenames[index],
      );

    if (draftStillMatches && attachmentsStillMatch) {
      releasePendingAttachmentPreviews(pendingAttachments);
      writeComposerDraft(jotaiStore, composerDraftKey, "");
      composerDraftTextRef.current = "";
      // eslint-disable-next-line react-hooks/set-state-in-effect -- terminal transcript ack clears only the matched pending send
      setPendingAttachments([]);
    }
    setSendError(null);
    setPendingComposerAck(null);
    if (draftStillMatches && attachmentsStillMatch && composerDraftKey) {
      composerDraftsByKey.delete(composerDraftKey);
    }
  }, [
    composerDraftKey,
    composerSendAcknowledged,
    jotaiStore,
    pendingAttachments,
    pendingComposerAck,
  ]);

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
  // Keep the chat header focused on human context; ids remain in error states.
  const sessionSubtitle = routeSessionMissing
    ? `${sessionId} · not found`
    : [headerWorktreeBranch, session?.status ?? "unknown"].filter(Boolean).join(" · ");
  const hasPendingAttachments = pendingAttachments.length > 0;
  const canSendMessageBase = Boolean(
    serviceEndpoint &&
    sessionId &&
    session &&
    !sendBusy &&
    !composerAwaitingAck &&
    !ownerShareStatusPending,
  );

  const handleSendMessage = useCallback(
    async (options?: { preserveFocus?: boolean }) => {
      const preserveFocus = options?.preserveFocus === true;
      const text = normalizeComposerDraft(readComposerDraft(jotaiStore, composerDraftKey)) ?? "";
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
      // Checked over the whole set before anything is uploaded or the draft is
      // touched. The upload loop below runs inside the send's `try`, so a
      // rejection partway through abandons the send with earlier files already
      // stored on the service -- and the rejection it got was
      // "body exceeds 1048576 bytes", a byte count rather than an answer.
      const oversized = firstOversizedAttachment(attachments);
      if (oversized) {
        setSendError(
          attachmentTooLargeMessage({
            filename: oversized.filename,
            sizeBytes: oversized.sizeBytes ?? 0,
          }),
        );
        return;
      }
      sendBusyRef.current = true;
      const sendOperationId = sendOperationIdRef.current + 1;
      sendOperationIdRef.current = sendOperationId;
      const sendComposerDraftKey = composerDraftKey;
      clearLocalInterruptHold(agentKey);
      const baselineUserMessageCount = userMessageCountRef.current;
      const baselineParsedMessageCount = parsedMessageCountRef.current;
      const baselineParsedUserMessageCount = parsedUserMessageCountRef.current;
      // Whichever pane is on screen. Only the mounted one has a ref, and in
      // split view both are and both should move: sending is an explicit ask
      // to see what happens next, which is why it overrides the freeze that
      // holds output back while a reader has scrolled up.
      chatViewportRef.current?.showNewest();
      terminalViewportRef.current?.showNewest();
      setSendBusy(true);
      setSendError(null);
      setSendWarning(null);
      setHeldDelivery(null);
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
        const sendResponse = await sendLivePaneInput(serviceEndpoint, sessionId, text, {
          token,
          attachmentIds: attachments
            .map((attachment) => attachment.uploadedAttachmentId)
            .filter((id): id is string => Boolean(id)),
          ...(sharedChatActor ? { sharedChatActor } : {}),
        });
        const refusalNotice = formatLivePaneInputResponseRefusal(sendResponse);
        if (refusalNotice) {
          throw new Error(refusalNotice);
        }
        const deliveryState = sendDeliveryStateAfterResponse(sendResponse);
        const clientMessageId = `composer:${sessionKey}:${Date.now()}`;
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
        if (deliveryState.kind !== "none") {
          releasePendingAttachmentPreviews(attachments);
          writeComposerDraft(jotaiStore, sendComposerDraftKey, "");
          composerDraftTextRef.current = "";
          setPendingAttachments([]);
          setPendingComposerAck(null);
          // `sendDeliveryStateAfterResponse` owns the routing: `held` comes
          // back with `accepted: true`, so it is a wait, not a failure.
          if (deliveryState.kind === "held") {
            setHeldDelivery({ holdMs: deliveryState.holdMs, notice: deliveryState.notice });
          } else if (deliveryState.kind === "warning") {
            setSendWarning(deliveryState.notice);
          } else {
            setSendError(deliveryState.text);
          }
          if (sendComposerDraftKey) composerDraftsByKey.delete(sendComposerDraftKey);
          // A refresh failure must not replace the queued-input explanation,
          // which is the one thing the user needs here.
          void refreshOutputSnapshot().catch(() => {});
          return;
        }
        setAcceptedComposerMessages((current) =>
          [
            ...current,
            {
              baselineMessageCount: baselineParsedMessageCount,
              baselineUserMessageCount: baselineParsedUserMessageCount,
              clientMessageId,
              createdAtMs: Date.now(),
              message: acceptedMessage,
            },
          ].slice(-20),
        );
        writeComposerDraft(jotaiStore, sendComposerDraftKey, "");
        composerDraftTextRef.current = "";
        setPendingAttachments([]);
        setPendingComposerAck(null);
        if (sendComposerDraftKey) composerDraftsByKey.delete(sendComposerDraftKey);
        void refreshOutputSnapshot().catch((error) => {
          setSendError(formatPostActionTranscriptRefreshResult("Input sent", error));
        });
      } catch (err) {
        if (!sendStillOwnsActiveComposer()) {
          if (sendComposerDraftKey) {
            rememberComposerDraft(sendComposerDraftKey, {
              draft: text,
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
                text,
                timedOut: true,
              }
            : null,
        );
        writeComposerDraft(jotaiStore, sendComposerDraftKey, text);
        composerDraftTextRef.current = text;
        setPendingAttachments(attachments);
        setSendError(formatComposerSendFailure(err));
      } finally {
        if (sendOperationIdRef.current === sendOperationId) {
          sendBusyRef.current = false;
          setSendBusy(false);
        }
        if (preserveFocus) {
          requestAnimationFrame(() => composerInputRef.current?.focus());
        }
      }
    },
    [
      agentKey,
      clearLocalInterruptHold,
      composerAwaitingAck,
      composerDraftKey,
      jotaiStore,
      ownerShareStatusPending,
      pendingAttachments,
      refreshOutputSnapshot,
      serviceEndpoint,
      session,
      sessionId,
      sessionKey,
      setAcceptedComposerMessages,
      setPendingAttachments,
      setHeldDelivery,
      setPendingComposerAck,
      setSendBusy,
      setSendError,
      setSendWarning,
      sharedChatActor,
      token,
    ],
  );

  const handleSendPress = useCallback(() => {
    void handleSendMessage({ preserveFocus: true });
  }, [handleSendMessage]);

  const appendPendingAttachments = useCallback(
    (attachments: PickedAttachment[]) => {
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
    },
    [pendingAttachments.length, setPendingAttachments, setSendError],
  );

  const handleAttachAttachment = useCallback(async () => {
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
  }, [
    appendPendingAttachments,
    composerAwaitingAck,
    pendingAttachments.length,
    sendBusy,
    setSendError,
  ]);

  const handleDropAttachments = useCallback(
    (attachments: PickedAttachment[]) => {
      if (sendBusy || sendBusyRef.current || composerAwaitingAck) {
        releasePendingAttachmentPreviews(attachments);
        return;
      }
      setSendError(null);
      appendPendingAttachments(attachments);
    },
    [appendPendingAttachments, composerAwaitingAck, sendBusy, setSendError],
  );

  const handleComposerPaste = useCallback(
    async (event: {
      clipboardData?: ClipboardFileSource | null;
      nativeEvent?: { clipboardData?: ClipboardFileSource | null };
      preventDefault?: () => void;
    }) => {
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
    },
    [appendPendingAttachments, composerAwaitingAck, sendBusy, setSendError],
  );

  const removePendingAttachment = useCallback(
    (id: string) => {
      setPendingAttachments((current) => {
        releasePendingAttachmentPreviews(current.filter((attachment) => attachment.id === id));
        return current.filter((attachment) => attachment.id !== id);
      });
    },
    [setPendingAttachments],
  );

  /**
   * Interrupt is offered unconditionally rather than only while we believe the
   * agent is busy. It is a single ESC, which an idle tool ignores, so gating it
   * on our guess about busy-ness only makes it unavailable exactly when the
   * guess is wrong.
   */
  const handleInterrupt = useCallback(async () => {
    if (!endpointHost || !endpointPort || !sessionId) return;
    markOutputInterrupted(agentKey);
    if (interruptInFlightRef.current) return;
    interruptInFlightRef.current = true;
    setSendError(null);
    try {
      await interruptLivePane(
        {
          host: endpointHost,
          port: endpointPort,
          ...(endpointMachineId ? { machineId: endpointMachineId } : {}),
        },
        sessionId,
        { token },
      );
      void refreshOutputSnapshot("interrupt").catch((error) => {
        setSendError(formatPostActionTranscriptRefreshResult("Interrupt sent", error));
      });
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Could not interrupt the agent.");
    } finally {
      interruptInFlightRef.current = false;
    }
  }, [
    endpointHost,
    endpointMachineId,
    endpointPort,
    agentKey,
    markOutputInterrupted,
    refreshOutputSnapshot,
    sessionId,
    setSendError,
    token,
  ]);

  const handleRetryTranscriptLoad = useCallback(
    (purpose: AgentOutputFeedPurpose = "poll") => {
      void refreshOutputSnapshot(purpose, { surfaceError: true }).catch(() => {});
    },
    [refreshOutputSnapshot],
  );

  useEffect(() => {
    nativeChatSendRef.current = () => {
      if (!composerFocusedRef.current) return;
      void handleSendMessage({ preserveFocus: true });
    };
  }, [handleSendMessage]);

  useEffect(() => {
    nativeChatInterruptRef.current = () => {
      if (canUseOwnerControls) void handleInterrupt();
    };
  }, [canUseOwnerControls, handleInterrupt]);

  // The sidebar owes this keyboard back when the drawer closes, a round trip
  // on THIS screen where no focus effect runs. Scoped to focus because the
  // slot holds one composer: on mount, a pushed chat overwrote the one behind.
  useFocusEffect(
    useCallback(() => registerChatComposerFocus(() => composerInputRef.current?.focus()), []),
  );

  useFocusEffect(
    useCallback(() => {
      screenFocusedRef.current = true;
      if (Platform.OS === "web" || !sessionId) {
        return () => {
          screenFocusedRef.current = false;
        };
      }
      const wanted = shouldFocusComposerOnOpen({
        hasComposer: showComposerFooter,
        hasHardwareKeyboard,
        intent: chatKeyboardIntent(),
      });
      if (!wanted) {
        return () => {
          screenFocusedRef.current = false;
        };
      }
      let active = true;
      const task = InteractionManager.runAfterInteractions(() => {
        if (active) composerInputRef.current?.focus();
      });
      return () => {
        screenFocusedRef.current = false;
        active = false;
        task.cancel();
      };
    }, [hasHardwareKeyboard, sessionId, showComposerFooter]),
  );

  useFocusEffect(
    useCallback(() => {
      if (Platform.OS === "web") return undefined;
      const unsubscribe = subscribeNativeAppCommands((command) => {
        if (command === "chatSend") {
          nativeChatSendRef.current();
          return;
        }
        if (command === "chatInterrupt") nativeChatInterruptRef.current();
      });
      return () => {
        composerFocusedRef.current = false;
        setComposerFocused(false);
        setNativeChatComposerFocused(false);
        unsubscribe();
      };
    }, [setComposerFocused]),
  );

  const handleComposerKeyboardEvent = useCallback(
    (
      event: ComposerKeyEventLike & {
        nativeEvent?: ComposerKeyEventLike;
        preventDefault?: () => void;
      },
    ) => {
      if (Platform.OS !== "web") return;
      const keyEvent = {
        key: event.nativeEvent?.key ?? event.key,
        code: event.nativeEvent?.code ?? event.code,
        shiftKey: event.nativeEvent?.shiftKey ?? event.shiftKey,
        ctrlKey: event.nativeEvent?.ctrlKey ?? event.ctrlKey,
        metaKey: event.nativeEvent?.metaKey ?? event.metaKey,
        altKey: event.nativeEvent?.altKey ?? event.altKey,
      };
      if (keyEvent.key === "Escape") {
        event.preventDefault?.();
        if (canUseOwnerControls) void handleInterrupt();
        return;
      }
      if (shouldSubmitComposerKey(keyEvent, hasHardwareKeyboard)) {
        event.preventDefault?.();
        void handleSendMessage({ preserveFocus: true });
      }
    },
    [canUseOwnerControls, handleInterrupt, handleSendMessage, hasHardwareKeyboard],
  );

  const handleComposerDraftChange = useCallback(
    (text: string) => {
      composerDraftTextRef.current = text;
      composerDraftSnapshotRef.current = {
        draft: text,
        pendingAttachments: pendingAttachmentsRef.current,
      };
      if (sendErrorRef.current) setSendError(null);
    },
    [setSendError],
  );

  const composerPasteProps = useMemo(
    () =>
      Platform.OS === "web"
        ? ({ onPaste: handleComposerPaste } as Record<string, unknown>)
        : undefined,
    [handleComposerPaste],
  );

  // Both native platforms route a hardware Enter through their own key handler,
  // which a soft keyboard's return never reaches, and emit `chatSend`. Only web
  // has to decide it here.
  const composerKeyboardProps = useMemo(
    () =>
      Platform.OS === "web"
        ? ({
            onKeyDown: handleComposerKeyboardEvent,
          } as unknown as Partial<React.ComponentProps<typeof TextInput>>)
        : {},
    [handleComposerKeyboardEvent],
  );

  // Android's back gesture hides the keyboard with the composer still focused,
  // so `onBlur` never fires. Both edges: an interactive dismiss the reader
  // abandons fires a hide then a show, and the re-arm is what survives it.
  const [keyboardEdge] = useState(() => createChatKeyboardEdgeWatcher(keyboardVisible));
  useEffect(() => {
    const edge = keyboardEdge(keyboardVisible);
    if (!edge) return;
    const where = { appVisible: isAppVisible(), screenFocused: screenFocusedRef.current };
    if (edge === "hidden") {
      recordChatKeyboardHidden(where);
      return;
    }
    if (composerFocusedRef.current) {
      recordComposerFocusIntent(true, { ...where, hasHardwareKeyboard });
    }
  }, [hasHardwareKeyboard, keyboardEdge, keyboardVisible]);

  const setComposerNativeFocus = useCallback(
    (focused: boolean, updateFocusShell: () => void) => {
      composerFocusedRef.current = focused;
      recordComposerFocusIntent(focused, {
        appVisible: isAppVisible(),
        hasHardwareKeyboard,
        screenFocused: screenFocusedRef.current,
      });
      setComposerFocused((current) => (current === focused ? current : focused));
      setNativeChatComposerFocused(focused);
      updateFocusShell();
    },
    [hasHardwareKeyboard, setComposerFocused],
  );

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
      router.dismissTo("/shares");
      return;
    }
    router.dismissTo(buildMainTabHref("project", projectPath, machineId));
  }

  function toggleSharePanel() {
    setSharePanelOpen((open) => {
      const next = !open;
      if (next) setManagePanelOpen(false);
      return next;
    });
  }

  function toggleManagePanel() {
    setManagePanelOpen((open) => {
      const next = !open;
      if (next) setSharePanelOpen(false);
      return next;
    });
  }

  const composerFooterContent = useMemo(
    () => (
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
              onLayout={(event: LayoutChangeEvent) => {
                const nextWidth = event.nativeEvent.layout.width;
                setComposerWidth((currentWidth) =>
                  currentWidth === nextWidth ? currentWidth : nextWidth,
                );
              }}
            >
              {({ onBlur, onFocus }) => (
                <>
                  <ComposerDraftTextInput
                    ref={composerInputRef}
                    draftKey={composerDraftKey ?? ""}
                    composerKeyboardProps={composerKeyboardProps}
                    composerPasteProps={composerPasteProps}
                    disabled={sendBusy || composerAwaitingAck}
                    onFocus={() => setComposerNativeFocus(true, onFocus)}
                    onBlur={() => setComposerNativeFocus(false, onBlur)}
                    onDraftChange={handleComposerDraftChange}
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
                      <ComposerFooterContentView content={composerFooterStateValue} />
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
                    <ComposerSendControl
                      draftKey={composerDraftKey ?? ""}
                      wide={wideControls}
                      canSendBase={canSendMessageBase}
                      hasPendingAttachments={hasPendingAttachments}
                      onPress={handleSendPress}
                    />
                  </View>
                </>
              )}
            </ComposerFocusShell>
          )}
        </AttachmentDropZone>
      </View>
    ),
    [
      canSendMessageBase,
      composerAwaitingAck,
      composerFooterStateValue,
      composerDraftKey,
      composerFooterBottomPadding,
      composerKeyboardProps,
      composerPasteProps,
      handleAttachAttachment,
      handleComposerDraftChange,
      handleDropAttachments,
      handleInterrupt,
      handleSendPress,
      hasPendingAttachments,
      isSharedSessionView,
      pendingAttachments,
      removePendingAttachment,
      sendBusy,
      setComposerWidth,
      setComposerNativeFocus,
      setSendError,
      wideControls,
    ],
  );
  const composerFooter = useMemo(() => {
    const composerChromeStyle: ViewStyle = {
      bottom: 0,
      left: 0,
      position: "absolute",
      right: 0,
      zIndex: 30,
    };
    return Platform.OS === "web" ? (
      <ChatChromeMotion
        direction="bottom"
        distance={chatBottomContentReserve}
        style={composerChromeStyle}
        visible={effectiveChatChromeVisible}
      >
        {composerFooterContent}
      </ChatChromeMotion>
    ) : (
      <KeyboardStickyView style={composerChromeStyle}>
        <ChatChromeMotion
          direction="bottom"
          distance={chatBottomContentReserve}
          visible={effectiveChatChromeVisible}
        >
          {composerFooterContent}
        </ChatChromeMotion>
      </KeyboardStickyView>
    );
  }, [chatBottomContentReserve, composerFooterContent, effectiveChatChromeVisible]);
  const modeControls = useMemo(
    () =>
      session && canUseOwnerControls ? (
        <AgentOutputModeControl
          canUseSplitView={canUseSplitView}
          mode={agentOutputViewMode}
          selectedMode={effectiveAgentOutputViewMode}
          onChange={setAgentOutputViewMode}
        />
      ) : null,
    [
      agentOutputViewMode,
      canUseSplitView,
      canUseOwnerControls,
      effectiveAgentOutputViewMode,
      session,
      setAgentOutputViewMode,
    ],
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
            <ChatChromeMotion
              direction="top"
              distance={chatTopContentReserve}
              style={{
                left: 0,
                position: "absolute",
                right: 0,
                top: topBarHeight,
                zIndex: 25,
              }}
              visible={effectiveChatChromeVisible}
            >
              <View className="border-b border-border bg-background px-4 py-3 flex-row items-center justify-between">
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
                        </View>
                        <View className="flex-row items-center gap-1.5" style={{ minWidth: 0 }}>
                          {session && !isSharedConversation ? (
                            <View className="flex-shrink-0">
                              <RuntimeBrandMark agent={session} />
                            </View>
                          ) : null}
                          <Text
                            className="text-xs text-muted-foreground"
                            numberOfLines={1}
                            ellipsizeMode="middle"
                            style={{ minWidth: 0, flexShrink: 1 }}
                          >
                            {sessionSubtitle}
                          </Text>
                          <SubagentBadge subagents={session?.subagents} />
                        </View>
                      </View>
                      {modeControls ? <View className="mr-2">{modeControls}</View> : null}
                      {session && canUseOwnerControls ? (
                        <>
                          <View className="mr-2">
                            <AgentActions
                              session={session}
                              projectStateKey={stateProjectKey}
                              endpoint={serviceEndpoint}
                              token={token}
                              compact
                              mainCheckoutPath={desktopState?.mainCheckoutPath}
                              onKilled={goBack}
                            />
                          </View>
                          <Pressable
                            onPress={toggleSharePanel}
                            accessibilityLabel="Invite collaborator"
                            className="h-8 w-8 items-center justify-center rounded-md border border-border mr-2"
                          >
                            <UserPlus size={15} color="#a1a1aa" />
                          </Pressable>
                          <Pressable
                            onPress={toggleManagePanel}
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
                                ...(machineId ? { machine: machineId } : {}),
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
                      </View>
                      <View className="flex-row items-center gap-1.5" style={{ minWidth: 0 }}>
                        {session && !isSharedConversation ? (
                          <View className="flex-shrink-0">
                            <RuntimeBrandMark agent={session} />
                          </View>
                        ) : null}
                        <Text
                          className="text-xs text-muted-foreground"
                          numberOfLines={1}
                          ellipsizeMode="middle"
                          style={{ minWidth: 0, flexShrink: 1 }}
                        >
                          {sessionSubtitle}
                        </Text>
                        <SubagentBadge subagents={session?.subagents} />
                      </View>
                    </View>
                    {modeControls ? (
                      <View className="mx-2 flex-shrink-0">{modeControls}</View>
                    ) : null}
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
                                  projectStateKey={stateProjectKey}
                                  endpoint={serviceEndpoint}
                                  token={token}
                                  compact
                                  mainCheckoutPath={desktopState?.mainCheckoutPath}
                                  onKilled={goBack}
                                />
                              </View>
                              <Pressable
                                onPress={toggleSharePanel}
                                accessibilityLabel="Invite collaborator"
                                className="h-8 w-8 items-center justify-center rounded-md border border-border mr-2"
                              >
                                <UserPlus size={15} color="#a1a1aa" />
                              </Pressable>
                              <Pressable
                                onPress={toggleManagePanel}
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
                                    ...(machineId ? { machine: machineId } : {}),
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
            </ChatChromeMotion>
            {/*
            Closed by default. These are settings, and pinning them above every
            conversation cost the chat ~250px on every screen for controls with
            no recorded use.
          */}
            {session && managePanelOpen && canUseOwnerControls ? (
              <View
                style={{
                  left: 0,
                  maxHeight: Math.round(windowHeight * 0.6),
                  position: "absolute",
                  right: 0,
                  top: chatControlPanelTopReserve,
                  zIndex: 24,
                }}
              >
                <ScrollView>
                  {compactHeaderActions && !useScrollableNativeHeader ? (
                    <View className="border-b border-border bg-card px-4 py-3">
                      <AgentActions
                        session={session}
                        projectStateKey={stateProjectKey}
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
                    projectStateKey={stateProjectKey}
                    groups={worktreeGroups}
                  />
                  {canManageTeammates ? (
                    <TeammatePanel
                      key={`${session.id}:teammates`}
                      session={session}
                      endpoint={serviceEndpoint}
                      token={token}
                      projectStateKey={stateProjectKey}
                    />
                  ) : null}
                </ScrollView>
              </View>
            ) : null}
            {sharePanelOpen ? (
              <View
                className={cn("border-b border-border bg-card px-4", activeShare ? "py-2" : "py-3")}
                style={{
                  left: 0,
                  maxHeight: chatControlPanelReserve || undefined,
                  position: "absolute",
                  right: 0,
                  top: chatControlPanelTopReserve,
                  zIndex: 23,
                }}
              >
                <ScrollView keyboardShouldPersistTaps="handled">
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
                </ScrollView>
              </View>
            ) : null}
            {serviceDisconnected ? (
              <View
                className="border-b border-border bg-card/80 px-4 py-2"
                style={{
                  left: 0,
                  position: "absolute",
                  right: 0,
                  top: chatHeaderTopReserve,
                  zIndex: 22,
                }}
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
              <View
                className="flex-1 p-4"
                style={{
                  paddingBottom: showComposerFooter ? chatBottomContentReserve : 16,
                  paddingTop: chatTopContentReserve + 16,
                }}
              >
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
              <View
                className="flex-1 p-4"
                style={{
                  paddingBottom: showComposerFooter ? chatBottomContentReserve : 16,
                  paddingTop: chatTopContentReserve + 16,
                }}
              >
                <Text className="text-sm text-muted-foreground">
                  Project service not running. Start the project host to view this session.
                </Text>
              </View>
            ) : (
              <View
                className="flex-1 bg-background"
                style={
                  effectiveAgentOutputViewMode === "split" ? { flexDirection: "row" } : undefined
                }
              >
                {chatViewVisible ? (
                  <View
                    className="flex-1 bg-background"
                    style={
                      effectiveAgentOutputViewMode === "split"
                        ? { borderRightWidth: 1, borderRightColor: "#27272a", minWidth: 0 }
                        : undefined
                    }
                  >
                    <AgentChatSessionViewport
                      key={chatViewportKey}
                      allMessages={allMessages}
                      bottomContentInset={chatBottomContentReserve}
                      dividerWidth={chatDividerWidth}
                      newMessageBadgeBottomOffset={newMessageBadgeBottomOffset}
                      placeholderState={chatPlaceholderState}
                      ref={chatViewportRef}
                      windowNotice={transcriptWindowNotice}
                      onChromeVisibleChange={handleChatChromeVisibleChange}
                      onRequestHistoryPage={requestChatHistoryPage}
                      onRetryTranscriptLoad={handleRetryTranscriptLoad}
                      serviceEndpoint={displayServiceEndpoint}
                      agentKey={agentKey}
                      topContentInset={chatTopContentReserve}
                    />
                  </View>
                ) : null}
                {terminalViewVisible ? (
                  <View className="flex-1 bg-background" style={{ minWidth: 0 }}>
                    <AgentTerminalOutputPane
                      ref={terminalViewportRef}
                      bottomContentInset={chatBottomContentReserve}
                      dividerWidth={chatDividerWidth}
                      keyboardVisible={keyboardVisible}
                      onChromeVisibleChange={handleChatChromeVisibleChange}
                      agentKey={agentKey}
                      topContentInset={chatTopContentReserve}
                    />
                  </View>
                ) : null}
              </View>
            )}
            {showComposerFooter ? composerFooter : null}
          </View>
        </View>
      </View>
    </View>
  );
}

type ComposerDraftTextInputProps = {
  composerKeyboardProps: Partial<React.ComponentProps<typeof TextInput>>;
  composerPasteProps?: Record<string, unknown>;
  disabled: boolean;
  draftKey: string;
  onBlur: () => void;
  onDraftChange: (text: string) => void;
  onFocus: () => void;
};

const ComposerDraftTextInput = React.memo(
  React.forwardRef<TextInput, ComposerDraftTextInputProps>(function ComposerDraftTextInput(
    {
      composerKeyboardProps,
      composerPasteProps,
      disabled,
      draftKey,
      onBlur,
      onDraftChange,
      onFocus,
    },
    ref,
  ) {
    const [draft, setDraft] = useAtom(chatComposerDraftFamily(draftKey));
    const handleDraftChange = useCallback(
      (text: string) => {
        setDraft(text);
        onDraftChange(text);
      },
      [onDraftChange, setDraft],
    );

    return (
      <TextInput
        ref={ref}
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
        {...composerKeyboardProps}
        {...COMPOSER_WEB_INPUT_PROPS}
        {...composerPasteProps}
        placeholder="Ask the agent…"
        placeholderTextColor="#71717a"
        multiline
        lineBreakStrategyIOS="standard"
        editable={!disabled}
        scrollEnabled
        textBreakStrategy="balanced"
        className="w-full text-sm text-foreground"
        style={[
          NO_BROWSER_FOCUS_RING,
          {
            alignSelf: "stretch",
            fontSize: COMPOSER_INPUT_FONT_SIZE,
            lineHeight: COMPOSER_INPUT_LINE_HEIGHT,
            maxWidth: "100%",
            maxHeight: COMPOSER_INPUT_MAX_HEIGHT,
            minHeight: COMPOSER_INPUT_MIN_HEIGHT,
            minWidth: 0,
            paddingHorizontal: COMPOSER_INPUT_HORIZONTAL_PADDING,
            paddingTop: COMPOSER_INPUT_VERTICAL_PADDING,
            paddingBottom: COMPOSER_INPUT_VERTICAL_PADDING,
            opacity: disabled ? 0.55 : 1,
            width: "100%",
          },
        ]}
        textAlignVertical="top"
      />
    );
  }),
);
ComposerDraftTextInput.displayName = "ComposerDraftTextInput";

const ComposerSendControl = React.memo(function ComposerSendControl({
  canSendBase,
  draftKey,
  hasPendingAttachments,
  onPress,
  wide,
}: {
  canSendBase: boolean;
  draftKey: string;
  hasPendingAttachments: boolean;
  onPress: () => void;
  wide: boolean;
}) {
  const draft = useAtomValue(chatComposerDraftFamily(draftKey));
  const canSend = canSendBase && (hasComposerDraftContent(draft) || hasPendingAttachments);

  return (
    <ComposerControl
      wide={wide}
      brand
      label="Send"
      accessibilityLabel="Send the message"
      icon={<ArrowUp size={18} color={CONTROL_ON_BRAND} />}
      disabled={!canSend}
      onPress={onPress}
    />
  );
});
ComposerSendControl.displayName = "ComposerSendControl";

type AgentOutputModeOption = Exclude<AgentOutputViewMode, "split"> | "split";

function AgentOutputModeControl({
  canUseSplitView,
  mode,
  onChange,
  selectedMode,
}: {
  canUseSplitView: boolean;
  mode: AgentOutputViewMode;
  onChange: (mode: AgentOutputViewMode) => void;
  selectedMode: AgentOutputViewMode;
}) {
  const options: AgentOutputModeOption[] = canUseSplitView
    ? ["chat", "split", "terminal"]
    : ["chat", "terminal"];

  return (
    <View className="h-8 flex-row overflow-hidden rounded-md border border-border bg-background">
      {options.map((option) => {
        const selected = selectedMode === option;
        const ink = selected ? CONTROL_ON_BRAND : "#a1a1aa";
        return (
          <Pressable
            key={option}
            accessibilityLabel={agentOutputModeLabel(option)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            onPress={() => {
              if (mode !== option) onChange(option);
            }}
            className={cn(
              "h-8 w-9 items-center justify-center border-r border-border last:border-r-0",
              selected ? "bg-primary" : "bg-background active:bg-accent",
            )}
          >
            {agentOutputModeIcon(option, ink)}
          </Pressable>
        );
      })}
    </View>
  );
}

function agentOutputModeLabel(mode: AgentOutputModeOption): string {
  if (mode === "chat") return "Show chat";
  if (mode === "split") return "Show chat and output";
  return "Show output";
}

function agentOutputModeIcon(mode: AgentOutputModeOption, color: string) {
  if (mode === "chat") return <MessageSquareText size={15} color={color} />;
  if (mode === "split") return <Columns2 size={15} color={color} />;
  return <Terminal size={15} color={color} />;
}

const TERMINAL_OUTPUT_LINE_STYLE: TextStyle = {
  color: "#e4e4e7",
  fontFamily: Platform.select({
    android: "monospace",
    default: "Menlo",
    ios: "Menlo",
    web: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  }),
  fontSize: 12,
  lineHeight: 17,
};
const TERMINAL_OUTPUT_MAX_LINES = 500;

type AgentTerminalOutputPaneProps = {
  bottomContentInset: number;
  dividerWidth: number;
  keyboardVisible: boolean;
  onChromeVisibleChange: (visible: boolean) => void;
  agentKey: AgentStateKey;
  topContentInset: number;
};

const AgentTerminalOutputPane = React.memo(
  React.forwardRef<ChatSessionViewportHandle, AgentTerminalOutputPaneProps>(
    function AgentTerminalOutputPane(
      {
        bottomContentInset,
        dividerWidth,
        keyboardVisible,
        onChromeVisibleChange,
        agentKey,
        topContentInset,
      },
      ref,
    ) {
      const outputPlain = useAtomValue(outputBufferFamily(agentKey));
      const outputAnsi = useAtomValue(outputAnsiFamily(agentKey));
      const outputAvailable = useAtomValue(outputAvailableFamily(agentKey));
      const scrollRef = useRef<ChatScrollHandle | null>(null);
      const output = outputAnsi || outputPlain;
      const outputTail = useMemo(
        () => output.replace(/\r/g, "").split("\n").slice(-TERMINAL_OUTPUT_MAX_LINES).join("\n"),
        [output],
      );
      const liveLines = useMemo(
        () =>
          formatTerminalOutputForDisplay(outputTail, {
            dividerWidth: Math.max(48, dividerWidth * 2),
          }),
        [dividerWidth, outputTail],
      );
      const liveOutput = useMemo(
        () =>
          terminalVisibleOutputForPinned({
            lines: liveLines,
            outputAvailable,
            outputText: outputTail,
            sessionKey: agentKey,
          }),
        [liveLines, outputAvailable, outputTail, agentKey],
      );
      const [visibleOutput, setVisibleOutput] = useState(liveOutput);
      const terminalScrollPolicyRef = useRef<ChatScrollPolicy>(createChatScrollPolicy());
      const terminalScrollChromeRef = useRef<ChatScrollChromeState>(createChatScrollChromeState());
      const terminalScrollFrameRef = useRef<number | null>(null);
      const terminalScrollPendingCommandReasonRef = useRef<ChatScrollReason | null>(null);
      const terminalInitialLayoutKeyRef = useRef<string | null>(null);
      // `scrollToEnd` targets `contentHeight - viewportHeight` and knows nothing
      // about the keyboard's contentInset, so with the keyboard up it lands short by
      // exactly the inset and the newest output stays behind it. Track the geometry
      // and scroll to the offset that really shows the last line.
      const terminalGeometryRef = useRef<ChatScrollMetrics>({
        bottomInset: 0,
        contentHeight: 0,
        offsetY: 0,
        viewportHeight: 0,
      });
      const extraContentPadding = useSharedValue(bottomContentInset);
      const visibleLines = visibleOutput.sessionKey === agentKey ? visibleOutput.lines : liveLines;
      const visibleOutputText =
        visibleOutput.sessionKey === agentKey ? visibleOutput.outputText : outputTail;
      const visibleOutputAvailable =
        visibleOutput.sessionKey === agentKey ? visibleOutput.outputAvailable : outputAvailable;
      const hasOutput = visibleOutputText.trim().length > 0 || visibleOutputAvailable;

      const cancelPendingTerminalScroll = useCallback(() => {
        if (terminalScrollFrameRef.current === null) return;
        cancelAnimationFrame(terminalScrollFrameRef.current);
        terminalScrollFrameRef.current = null;
        terminalScrollPendingCommandReasonRef.current = null;
      }, []);

      useEffect(() => {
        return cancelPendingTerminalScroll;
      }, [cancelPendingTerminalScroll]);

      useEffect(() => {
        extraContentPadding.value = bottomContentInset;
      }, [bottomContentInset, extraContentPadding]);

      const executeTerminalScrollCommand = useCallback(
        (command: ChatScrollCommand) => {
          if (command.kind === "none") return;
          cancelPendingTerminalScroll();
          terminalScrollPendingCommandReasonRef.current = command.reason;
          terminalScrollFrameRef.current = requestAnimationFrame(() => {
            terminalScrollFrameRef.current = null;
            terminalScrollPendingCommandReasonRef.current = null;
            if (
              !chatScrollCommandRunsWhileUnpinned(command.reason) &&
              terminalScrollPolicyRef.current.intent !== "pinned"
            ) {
              return;
            }
            const target = chatScrollEndOffset(terminalGeometryRef.current);
            if (target === null) {
              scrollRef.current?.scrollToEnd({ animated: command.animated });
            } else {
              scrollRef.current?.scrollTo({ animated: command.animated, y: target });
            }
          });
        },
        [cancelPendingTerminalScroll],
      );

      // The terminal twin of the chat viewport's `showNewest`. The pane freezes
      // its rendered output while the reader has scrolled up -- see
      // `terminalVisibleOutputForLiveChange` -- so without this, sending from a
      // scrolled-up terminal never showed the echo of your own message, and
      // `executeTerminalScrollCommand` drops any command that is not `initial` or
      // `navigation` while unpinned.
      const showNewestTerminalOutput = useCallback(() => {
        terminalScrollPolicyRef.current = chatPolicyAfterNavigationFocus();
        terminalScrollChromeRef.current = createChatScrollChromeState();
        onChromeVisibleChange(true);
        setVisibleOutput(liveOutput);
        executeTerminalScrollCommand(chatCommandForNavigationFocus());
      }, [executeTerminalScrollCommand, liveOutput, onChromeVisibleChange]);

      useImperativeHandle(ref, () => ({ showNewest: showNewestTerminalOutput }), [
        showNewestTerminalOutput,
      ]);

      useEffect(() => {
        terminalScrollPolicyRef.current = chatPolicyAfterNavigationFocus();
        terminalScrollChromeRef.current = createChatScrollChromeState();
        terminalInitialLayoutKeyRef.current = null;
        // This pane has no `key`, so it is the same instance across agents and
        // its geometry would otherwise answer for the previous one -- a
        // navigation scroll computed from another agent's content height.
        terminalGeometryRef.current = {
          bottomInset: terminalGeometryRef.current.bottomInset,
          contentHeight: 0,
          offsetY: 0,
          viewportHeight: 0,
        };
        onChromeVisibleChange(true);
        executeTerminalScrollCommand(chatCommandForNavigationFocus());
      }, [executeTerminalScrollCommand, onChromeVisibleChange, agentKey]);

      useEffect(() => {
        if (Platform.OS === "web") return;
        executeTerminalScrollCommand(chatCommandForKeyboardChange(terminalScrollPolicyRef.current));
      }, [executeTerminalScrollCommand, keyboardVisible]);

      useEffect(() => {
        const next = terminalVisibleOutputForLiveChange(visibleOutput, {
          intent: terminalScrollPolicyRef.current.intent,
          liveOutput,
        });
        if (next !== visibleOutput) setVisibleOutput(next);
      }, [liveOutput, visibleOutput]);

      const handleTerminalLayout = useCallback(
        (event: LayoutChangeEvent) => {
          terminalGeometryRef.current = {
            ...terminalGeometryRef.current,
            viewportHeight: event.nativeEvent.layout.height,
          };
          if (terminalInitialLayoutKeyRef.current !== agentKey) {
            terminalInitialLayoutKeyRef.current = agentKey;
            executeTerminalScrollCommand(chatCommandForInitialLayout());
            return;
          }
          executeTerminalScrollCommand(
            chatCommandForContentChange(terminalScrollPolicyRef.current),
          );
        },
        [executeTerminalScrollCommand, agentKey],
      );

      const handleTerminalContentSizeChange = useCallback(
        (_contentWidth: number, contentHeight: number) => {
          terminalGeometryRef.current = { ...terminalGeometryRef.current, contentHeight };
          executeTerminalScrollCommand(
            chatCommandForContentChange(terminalScrollPolicyRef.current),
          );
        },
        [executeTerminalScrollCommand],
      );

      // Android does not report the keyboard-driven inset in the scroll event, so
      // the library hands it over here instead.
      const handleTerminalContentInsetChange = useCallback(
        (insets: { bottom: number }) => {
          if (terminalGeometryRef.current.bottomInset === insets.bottom) return;
          terminalGeometryRef.current = {
            ...terminalGeometryRef.current,
            bottomInset: insets.bottom,
          };
          executeTerminalScrollCommand(
            chatCommandForKeyboardChange(terminalScrollPolicyRef.current),
          );
        },
        [executeTerminalScrollCommand],
      );

      const handleTerminalScroll = useCallback(
        (event: NativeSyntheticEvent<NativeScrollEvent>) => {
          const metrics: ChatScrollMetrics = {
            bottomInset: terminalGeometryRef.current.bottomInset,
            contentHeight: event.nativeEvent.contentSize.height,
            offsetY: event.nativeEvent.contentOffset.y,
            viewportHeight: event.nativeEvent.layoutMeasurement.height,
          };
          terminalGeometryRef.current = metrics;
          const previousIntent = terminalScrollPolicyRef.current.intent;
          const nextScroll = terminalScrollStateAfterUserScroll({
            chrome: terminalScrollChromeRef.current,
            metrics,
            policy: terminalScrollPolicyRef.current,
          });
          const nextPolicy = nextScroll.policy;
          if (
            nextPolicy.intent === "reading" &&
            !chatScrollCommandRunsWhileUnpinned(terminalScrollPendingCommandReasonRef.current)
          ) {
            cancelPendingTerminalScroll();
          }
          terminalScrollPolicyRef.current = nextPolicy;
          if (nextScroll.chrome !== terminalScrollChromeRef.current) {
            terminalScrollChromeRef.current = nextScroll.chrome;
            onChromeVisibleChange(nextScroll.chrome.visible);
          }
          if (previousIntent === "reading" && nextPolicy.intent === "pinned") {
            setVisibleOutput(liveOutput);
          }
        },
        [cancelPendingTerminalScroll, liveOutput, onChromeVisibleChange],
      );

      const contentContainerStyle = {
        flexGrow: 1,
        justifyContent: "flex-end" as const,
        paddingBottom: Platform.OS === "web" ? bottomContentInset + 18 : 18,
        paddingHorizontal: 12,
        paddingTop: topContentInset + 16,
      };
      const content = hasOutput ? (
        <View className="rounded-lg border border-border bg-card/80 px-3 py-2">
          {visibleLines.map((line, lineIndex) => (
            <RNText key={lineIndex} style={TERMINAL_OUTPUT_LINE_STYLE}>
              {line.length === 0
                ? "\u00a0"
                : line.map((span, spanIndex) => (
                    <RNText key={spanIndex} style={span.style}>
                      {span.text}
                    </RNText>
                  ))}
            </RNText>
          ))}
        </View>
      ) : (
        <View className="items-center justify-center px-4 py-10">
          <View
            className="max-w-[90%] flex-row items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
            style={{ minWidth: 220 }}
          >
            <ActivityIndicator size="small" color="#a1a1aa" />
            <View className="min-w-0 shrink">
              <Text className="text-sm text-muted-foreground">Loading output</Text>
              <Text className="mt-1 text-xs text-muted-foreground">
                Waiting for terminal output from the project service.
              </Text>
            </View>
          </View>
        </View>
      );

      if (Platform.OS !== "web") {
        return (
          <KeyboardChatScrollView
            ref={scrollRef as React.Ref<React.ElementRef<typeof KeyboardChatScrollView>>}
            className="flex-1 bg-background"
            contentContainerStyle={contentContainerStyle}
            extraContentPadding={extraContentPadding}
            keyboardDismissMode="interactive"
            keyboardLiftBehavior="whenAtEnd"
            keyboardShouldPersistTaps="handled"
            onContentInsetChange={handleTerminalContentInsetChange}
            onContentSizeChange={handleTerminalContentSizeChange}
            onLayout={handleTerminalLayout}
            onScroll={handleTerminalScroll}
            scrollEventThrottle={16}
            showsVerticalScrollIndicator
          >
            {content}
          </KeyboardChatScrollView>
        );
      }

      return (
        <ScrollView
          ref={scrollRef as React.Ref<ScrollView>}
          className="flex-1 bg-background"
          contentContainerStyle={contentContainerStyle}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={handleTerminalContentSizeChange}
          onLayout={handleTerminalLayout}
          onScroll={handleTerminalScroll}
          scrollEventThrottle={16}
          showsVerticalScrollIndicator
        >
          {content}
        </ScrollView>
      );
    },
  ),
);
AgentTerminalOutputPane.displayName = "AgentTerminalOutputPane";

type AgentChatSessionViewportProps = {
  allMessages: readonly ChatMessage[];
  bottomContentInset: number;
  dividerWidth: number;
  newMessageBadgeBottomOffset: number;
  onChromeVisibleChange: (visible: boolean) => void;
  onRequestHistoryPage: (metrics: ChatScrollMetrics) => void;
  onRetryTranscriptLoad: (purpose?: AgentOutputFeedPurpose) => void;
  placeholderState: ChatTranscriptPlaceholderState;
  serviceEndpoint: ServiceEndpoint;
  agentKey: AgentStateKey;
  topContentInset: number;
  windowNotice: string | null;
};

const AgentChatSessionViewport = React.memo(
  React.forwardRef<ChatSessionViewportHandle, AgentChatSessionViewportProps>(
    function AgentChatSessionViewport(
      {
        allMessages,
        bottomContentInset,
        dividerWidth,
        newMessageBadgeBottomOffset,
        onChromeVisibleChange,
        onRequestHistoryPage,
        onRetryTranscriptLoad,
        placeholderState,
        serviceEndpoint,
        agentKey,
        topContentInset,
        windowNotice,
      },
      ref,
    ) {
      const liveChatTranscript = useMemo(
        () =>
          chatVisibleTranscriptForPinned({
            liveMessages: allMessages,
            sessionKey: agentKey,
          }),
        [allMessages, agentKey],
      );
      const [visibleChatTranscript, setVisibleChatTranscript] = useState<
        ChatVisibleTranscript<ChatMessage>
      >(() => liveChatTranscript);
      const chatScrollRef = useRef<ChatScrollHandle | null>(null);
      const chatScrollMetricsRef = useRef<ChatScrollMetrics>({
        bottomInset: 0,
        contentHeight: 0,
        offsetY: 0,
        viewportHeight: 0,
      });
      const chatScrollPolicyRef = useRef<ChatScrollPolicy>(createChatScrollPolicy());
      const chatScrollChromeRef = useRef<ChatScrollChromeState>(createChatScrollChromeState());
      const chatScrollFrameRef = useRef<number | null>(null);
      const chatScrollPendingCommandReasonRef = useRef<ChatScrollReason | null>(null);
      const liveChatTranscriptRef = useRef<ChatVisibleTranscript<ChatMessage>>(liveChatTranscript);
      const visibleChatTranscriptRef =
        useRef<ChatVisibleTranscript<ChatMessage>>(liveChatTranscript);
      const chatInitialLayoutKeyRef = useRef<AgentStateKey | null>(null);
      const newMessageBadgeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
      const newMessageBadgeFadeRef = useRef<ReturnType<typeof setTimeout> | null>(null);
      const newMessageBadgeAnnouncedCountRef = useRef(0);
      const [newMessageBadge, setNewMessageBadge] = useState({ count: 0, visible: false });

      const visibleMessages = chatVisibleTranscriptMessages(visibleChatTranscript, {
        liveMessages: allMessages,
        sessionKey: agentKey,
      });

      const applyVisibleChatTranscript = useCallback((next: ChatVisibleTranscript<ChatMessage>) => {
        const current = visibleChatTranscriptRef.current;
        if (current.sessionKey === next.sessionKey && current.messages === next.messages) return;
        visibleChatTranscriptRef.current = next;
        setVisibleChatTranscript(next);
      }, []);

      const showLiveChatTranscript = useCallback(() => {
        const live = liveChatTranscriptRef.current;
        if (live.sessionKey !== agentKey) return;
        applyVisibleChatTranscript(live);
      }, [applyVisibleChatTranscript, agentKey]);

      const clearNewMessageBadgeTimers = useCallback(() => {
        if (newMessageBadgeDebounceRef.current !== null) {
          clearTimeout(newMessageBadgeDebounceRef.current);
          newMessageBadgeDebounceRef.current = null;
        }
        if (newMessageBadgeFadeRef.current !== null) {
          clearTimeout(newMessageBadgeFadeRef.current);
          newMessageBadgeFadeRef.current = null;
        }
      }, []);

      const resetNewMessageBadge = useCallback(() => {
        clearNewMessageBadgeTimers();
        newMessageBadgeAnnouncedCountRef.current = 0;
        setNewMessageBadge((current) =>
          current.count === 0 && !current.visible ? current : { count: 0, visible: false },
        );
      }, [clearNewMessageBadgeTimers]);

      const fadeNewMessageBadgeLater = useCallback(() => {
        if (newMessageBadgeFadeRef.current !== null) {
          clearTimeout(newMessageBadgeFadeRef.current);
        }
        newMessageBadgeFadeRef.current = setTimeout(() => {
          newMessageBadgeFadeRef.current = null;
          setNewMessageBadge((current) => ({ ...current, visible: false }));
        }, CHAT_NEW_MESSAGE_BADGE_VISIBLE_MS);
      }, []);

      const cancelPendingChatScroll = useCallback(() => {
        if (chatScrollFrameRef.current === null) return;
        cancelAnimationFrame(chatScrollFrameRef.current);
        chatScrollFrameRef.current = null;
        chatScrollPendingCommandReasonRef.current = null;
      }, []);

      const executeChatScrollCommand = useCallback(
        (command: ChatScrollCommand, noneReason = "unknown") => {
          if (command.kind === "none") {
            void noneReason;
            return;
          }
          cancelPendingChatScroll();
          chatScrollPendingCommandReasonRef.current = command.reason;
          chatScrollFrameRef.current = requestAnimationFrame(() => {
            chatScrollFrameRef.current = null;
            chatScrollPendingCommandReasonRef.current = null;
            if (
              !chatScrollCommandRunsWhileUnpinned(command.reason) &&
              chatScrollPolicyRef.current.intent !== "pinned"
            ) {
              return;
            }
            // `scrollToEnd` targets `contentHeight - viewportHeight` and knows
            // nothing about the bottom contentInset the composer reserve and the
            // keyboard add, so it lands short by exactly that -- and the next
            // scroll event then reads as scrollback and freezes the pane. The
            // terminal pane next door already scrolls to the real end; this is
            // the same helper, so both agree about where the end is.
            const target = chatScrollEndOffset(chatScrollMetricsRef.current);
            if (target === null) {
              chatScrollRef.current?.scrollToEnd({ animated: command.animated });
            } else {
              chatScrollRef.current?.scrollTo({ animated: command.animated, y: target });
            }
          });
        },
        [cancelPendingChatScroll],
      );

      const showNewest = useCallback(() => {
        const live = chatVisibleTranscriptForPinned({
          liveMessages: allMessages,
          sessionKey: agentKey,
        });
        liveChatTranscriptRef.current = live;
        chatScrollPolicyRef.current = chatPolicyAfterNavigationFocus();
        chatScrollChromeRef.current = createChatScrollChromeState();
        resetNewMessageBadge();
        onChromeVisibleChange(true);
        applyVisibleChatTranscript(live);
        executeChatScrollCommand(chatCommandForNavigationFocus());
      }, [
        allMessages,
        applyVisibleChatTranscript,
        executeChatScrollCommand,
        onChromeVisibleChange,
        resetNewMessageBadge,
        agentKey,
      ]);

      useImperativeHandle(ref, () => ({ showNewest }), [showNewest]);

      useEffect(() => cancelPendingChatScroll, [cancelPendingChatScroll]);

      useEffect(() => clearNewMessageBadgeTimers, [clearNewMessageBadgeTimers]);

      useFocusEffect(
        useCallback(() => {
          // Cleared only while nothing has been measured. Claiming it always
          // made `handleChatLayout` take the content branch, so the landing
          // happened before `onLayout`, `onContentSizeChange` and the
          // library's inset callback had said anything, and `scrollToEnd` was
          // all that was left to land it. Clearing it always is the other
          // mistake: a re-focus with no remount -- back from a modal -- would
          // leave the next layout change, a composer growing a line, to fire
          // an `initial` scroll that yanks a reader who has since scrolled up.
          // Measured means the command below is enough.
          chatInitialLayoutKeyRef.current =
            chatScrollEndOffset(chatScrollMetricsRef.current) === null ? null : agentKey;
          chatScrollPolicyRef.current = chatPolicyAfterNavigationFocus();
          chatScrollChromeRef.current = createChatScrollChromeState();
          resetNewMessageBadge();
          onChromeVisibleChange(true);
          showLiveChatTranscript();
          const interaction = InteractionManager.runAfterInteractions(() => {
            executeChatScrollCommand(chatCommandForNavigationFocus());
          });
          return () => {
            interaction.cancel();
            cancelPendingChatScroll();
          };
        }, [
          agentKey,
          cancelPendingChatScroll,
          executeChatScrollCommand,
          onChromeVisibleChange,
          resetNewMessageBadge,
          showLiveChatTranscript,
        ]),
      );

      const handleChatLayout = useCallback(
        (event: LayoutChangeEvent) => {
          chatScrollMetricsRef.current = {
            ...chatScrollMetricsRef.current,
            viewportHeight: event.nativeEvent.layout.height,
          };
          if (chatInitialLayoutKeyRef.current !== agentKey) {
            chatInitialLayoutKeyRef.current = agentKey;
            executeChatScrollCommand(chatCommandForInitialLayout());
            return;
          }
          executeChatScrollCommand(
            chatCommandForContentChange(chatScrollPolicyRef.current),
            "content",
          );
        },
        [executeChatScrollCommand, agentKey],
      );

      const handleChatContentSizeChange = useCallback(
        (_contentWidth: number, contentHeight: number) => {
          chatScrollMetricsRef.current = {
            ...chatScrollMetricsRef.current,
            contentHeight,
          };
          executeChatScrollCommand(
            chatCommandForContentChange(chatScrollPolicyRef.current),
            "content",
          );
        },
        [executeChatScrollCommand],
      );

      // Android does not report the keyboard-driven inset in the scroll event, so
      // the library hands it over here instead -- the same reason the terminal
      // pane takes it this way.
      const handleChatContentInsetChange = useCallback(
        (insets: { bottom: number }) => {
          if (chatScrollMetricsRef.current.bottomInset === insets.bottom) return;
          chatScrollMetricsRef.current = {
            ...chatScrollMetricsRef.current,
            bottomInset: insets.bottom,
          };
          // Acted on, not merely recorded. The library reports this through a
          // Reanimated reaction, so it can arrive AFTER every landing scroll
          // has already run against an inset of zero -- each of them short by
          // the reserve. The next scroll event would then measure that gap
          // against the new inset, read it as scrollback, and freeze the pane
          // with the reader mid-history. Re-landing here closes that window,
          // and `keyboard` is the reason it is: only a reader who has not
          // scrolled away gets moved.
          executeChatScrollCommand(
            chatCommandForKeyboardChange(chatScrollPolicyRef.current),
            "keyboard",
          );
        },
        [executeChatScrollCommand],
      );

      const handleChatScroll = useCallback(
        (event: NativeSyntheticEvent<NativeScrollEvent>) => {
          const metrics: ChatScrollMetrics = {
            bottomInset: chatScrollMetricsRef.current.bottomInset,
            contentHeight: event.nativeEvent.contentSize.height,
            offsetY: event.nativeEvent.contentOffset.y,
            viewportHeight: event.nativeEvent.layoutMeasurement.height,
          };
          chatScrollMetricsRef.current = metrics;
          const previousIntent = chatScrollPolicyRef.current.intent;
          const nextPolicy = chatPolicyAfterUserScroll(chatScrollPolicyRef.current, metrics);
          // A still-queued `initial` or `navigation` scroll survives: it is what
          // puts the reader at the newest message, and the frame it is waiting
          // on would have run it -- its own guard lets those two through
          // whatever the intent says. This only covers the queued frame; a
          // scroll already issued is past saving, which is why where the end
          // is matters more than this.
          if (
            nextPolicy.intent === "reading" &&
            !chatScrollCommandRunsWhileUnpinned(chatScrollPendingCommandReasonRef.current)
          ) {
            cancelPendingChatScroll();
          }
          chatScrollPolicyRef.current = nextPolicy;
          const nextChrome = chatChromeAfterUserScroll(
            chatScrollChromeRef.current,
            nextPolicy,
            metrics,
          );
          if (nextChrome !== chatScrollChromeRef.current) {
            chatScrollChromeRef.current = nextChrome;
            onChromeVisibleChange(nextChrome.visible);
          }
          if (previousIntent === "reading" && nextPolicy.intent === "pinned") {
            resetNewMessageBadge();
            showLiveChatTranscript();
          }
          onRequestHistoryPage(metrics);
        },
        [
          cancelPendingChatScroll,
          onRequestHistoryPage,
          onChromeVisibleChange,
          resetNewMessageBadge,
          showLiveChatTranscript,
        ],
      );

      useEffect(() => {
        liveChatTranscriptRef.current = liveChatTranscript;
        const next = chatVisibleTranscriptForLiveChange(visibleChatTranscriptRef.current, {
          intent: chatScrollPolicyRef.current.intent,
          liveMessages: allMessages,
          sessionKey: agentKey,
        });
        applyVisibleChatTranscript(next);
      }, [allMessages, applyVisibleChatTranscript, liveChatTranscript, agentKey]);

      useEffect(() => {
        if (chatScrollPolicyRef.current.intent !== "reading") return;
        const count = chatFrozenNewMessageCount({
          frozenMessages: visibleChatTranscriptRef.current.messages,
          liveMessages: allMessages,
        });
        if (count < newMessageBadgeAnnouncedCountRef.current) {
          newMessageBadgeAnnouncedCountRef.current = count;
        }
        if (count <= newMessageBadgeAnnouncedCountRef.current) return;
        if (count <= 0) return;
        if (newMessageBadgeDebounceRef.current !== null) {
          clearTimeout(newMessageBadgeDebounceRef.current);
        }
        newMessageBadgeDebounceRef.current = setTimeout(() => {
          newMessageBadgeDebounceRef.current = null;
          if (chatScrollPolicyRef.current.intent !== "reading") return;
          const nextCount = chatFrozenNewMessageCount({
            frozenMessages: visibleChatTranscriptRef.current.messages,
            liveMessages: liveChatTranscriptRef.current.messages,
          });
          if (nextCount < newMessageBadgeAnnouncedCountRef.current) {
            newMessageBadgeAnnouncedCountRef.current = nextCount;
          }
          if (nextCount <= newMessageBadgeAnnouncedCountRef.current) return;
          if (nextCount <= 0) return;
          newMessageBadgeAnnouncedCountRef.current = nextCount;
          setNewMessageBadge({ count: nextCount, visible: true });
          fadeNewMessageBadgeLater();
        }, CHAT_NEW_MESSAGE_BADGE_DEBOUNCE_MS);
      }, [allMessages, fadeNewMessageBadgeLater]);

      return (
        <View className="flex-1 bg-background">
          <AgentChatTranscript
            messages={visibleMessages}
            onContentInsetChange={handleChatContentInsetChange}
            onContentSizeChange={handleChatContentSizeChange}
            onLayout={handleChatLayout}
            onRetryTranscriptLoad={onRetryTranscriptLoad}
            onScroll={handleChatScroll}
            placeholderState={placeholderState}
            ref={chatScrollRef}
            windowNotice={windowNotice}
            serviceEndpoint={serviceEndpoint}
            dividerWidth={dividerWidth}
            bottomContentInset={bottomContentInset}
            topContentInset={topContentInset}
          />
          <ChatNewMessagesBadge
            count={newMessageBadge.count}
            onPress={showNewest}
            visible={newMessageBadge.visible && newMessageBadge.count > 0}
            style={{
              bottom: newMessageBadgeBottomOffset,
              alignItems: "center",
              left: 0,
              position: "absolute",
              right: 0,
              zIndex: 20,
            }}
          />
        </View>
      );
    },
  ),
);
AgentChatSessionViewport.displayName = "AgentChatSessionViewport";

type AgentChatTranscriptProps = {
  bottomContentInset: number;
  dividerWidth: number;
  messages: readonly ChatMessage[];
  onContentInsetChange: (insets: { bottom: number }) => void;
  onContentSizeChange: (contentWidth: number, contentHeight: number) => void;
  onLayout: (event: LayoutChangeEvent) => void;
  onRetryTranscriptLoad: (purpose?: AgentOutputFeedPurpose) => void;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  placeholderState: ChatTranscriptPlaceholderState;
  serviceEndpoint: ServiceEndpoint;
  topContentInset: number;
  /** Why scrolling up stopped loading more, or null while it has not. */
  windowNotice: string | null;
};

const AgentChatTranscript = React.memo(
  React.forwardRef<ChatScrollHandle, AgentChatTranscriptProps>(function AgentChatTranscript(
    {
      bottomContentInset,
      dividerWidth,
      messages,
      onContentInsetChange,
      onContentSizeChange,
      onLayout,
      onRetryTranscriptLoad,
      onScroll,
      placeholderState,
      serviceEndpoint,
      topContentInset,
      windowNotice,
    },
    ref,
  ) {
    const extraContentPadding = useSharedValue(bottomContentInset);

    useEffect(() => {
      extraContentPadding.value = bottomContentInset;
    }, [bottomContentInset, extraContentPadding]);

    const content =
      messages.length === 0 ? (
        <ChatTranscriptPlaceholder
          state={placeholderState}
          onRetryTranscriptLoad={onRetryTranscriptLoad}
        />
      ) : (
        <View className="w-full gap-1">
          {windowNotice ? (
            <View className="w-full items-center pb-2">
              <View className="rounded-md border border-border bg-card px-3 py-2">
                <Text className="text-xs text-muted-foreground">{windowNotice}</Text>
              </View>
            </View>
          ) : null}
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
      paddingTop: topContentInset + 16,
      paddingBottom: Platform.OS === "web" ? bottomContentInset + 18 : 18,
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
          onContentInsetChange={onContentInsetChange}
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
  }),
);
AgentChatTranscript.displayName = "AgentChatTranscript";

function ChatTranscriptPlaceholder({
  onRetryTranscriptLoad,
  state,
}: {
  onRetryTranscriptLoad: (purpose?: AgentOutputFeedPurpose) => void;
  state: ChatTranscriptPlaceholderState;
}) {
  if (state.kind === "none") return null;
  const retryable = state.kind === "timed-out" || state.kind === "error";
  const loading = state.kind === "loading";
  return (
    <View className="flex-1 items-center justify-center px-4 py-10">
      <View
        className="max-w-[90%] rounded-lg border border-border bg-card px-3 py-2 shadow-sm"
        style={{ minWidth: 240 }}
      >
        <View className="flex-row items-center gap-2">
          {loading ? (
            <ActivityIndicator size="small" color="#a1a1aa" />
          ) : state.kind === "error" ? (
            <CircleAlert size={18} color="#f87171" />
          ) : null}
          <View className="min-w-0 shrink">
            <Text className="text-sm text-muted-foreground">{state.title}</Text>
            <Text className="mt-1 text-xs text-muted-foreground">{state.message}</Text>
          </View>
        </View>
        {retryable ? (
          <Button
            className="mt-2 self-start"
            size="sm"
            variant="outline"
            label={state.retryLabel}
            onPress={() => onRetryTranscriptLoad(state.kind === "timed-out" ? "initial" : "poll")}
          />
        ) : null}
      </View>
    </View>
  );
}

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

/**
 * Renders what `composerFooterContent` decided, and decides nothing itself.
 *
 * The precedence used to live here as a four-branch ternary, which meant it
 * was reachable only by grepping this file's source in a test -- and every
 * such assertion was defeated by a mutation that kept the asserted string.
 */
function ComposerFooterContentView({ content }: { content: ComposerFooterState }) {
  switch (content.kind) {
    case "error":
      return (
        <View className="min-w-0 flex-row items-start gap-1.5">
          <CircleAlert size={13} color="#f87171" style={{ marginTop: 1 }} />
          <Text className="min-w-0 flex-1 text-xs text-destructive" numberOfLines={3}>
            {content.text}
          </Text>
        </View>
      );
    case "held":
      return (
        <View className="min-w-0 flex-row items-start gap-1.5">
          <Clock size={13} color="#e0b341" style={{ marginTop: 1 }} />
          <Text className="min-w-0 flex-1 text-xs text-muted-foreground" numberOfLines={3}>
            {content.text}
          </Text>
        </View>
      );
    case "warning":
      return (
        <View className="min-w-0 flex-row items-start gap-1.5">
          <CircleAlert size={13} color="#e0b341" style={{ marginTop: 1 }} />
          <Text className="min-w-0 flex-1 text-xs text-muted-foreground" numberOfLines={3}>
            {content.text}
          </Text>
        </View>
      );
    case "sending":
      return (
        <View className="min-w-0 flex-row items-center gap-1.5">
          <ActivityIndicator size="small" color="#a1a1aa" />
          <Text className="text-xs text-muted-foreground" numberOfLines={1}>
            Sending...
          </Text>
        </View>
      );
    case "awaiting-echo":
      return (
        <View className="min-w-0 flex-row items-start gap-1.5">
          {/* Not a check: the send is away, the agent has not shown it yet. */}
          <Clock size={13} color="#a1a1aa" style={{ marginTop: 1 }} />
          <Text className="min-w-0 flex-1 text-xs text-muted-foreground" numberOfLines={3}>
            {content.text}
          </Text>
        </View>
      );
    case "activity":
      return <ActivityFooterLabel label={content.label} shimmer={content.shimmer} />;
    case "empty":
      return null;
  }
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
