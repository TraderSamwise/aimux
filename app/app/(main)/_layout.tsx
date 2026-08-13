import React, { useEffect, useLayoutEffect, useRef } from "react";
import { Platform } from "react-native";
import { Stack, useGlobalSearchParams, usePathname } from "expo-router";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { AppShell } from "@/components/AppShell";
import { NotificationProvider } from "@/components/NotificationProvider";
import { NativeNotificationRouter } from "@/components/NativeNotificationRouter";
import {
  getDesktopState,
  listNotifications,
  listProjects,
  listShares,
  setApiRelay,
} from "@/lib/api";
import type { DesktopState } from "@/lib/desktop-state";
import { useAuth } from "@/lib/auth";
import { CHAT_OUTPUT_CAPTURE_START_LINE } from "@/lib/chat-output-constants";
import { isBrowserDocumentVisible, showBrowserNotification } from "@/lib/browser-notifications";
import { env } from "@/lib/env";
import { startHeartbeat } from "@/lib/heartbeat";
import { evaluateAlertEvent } from "@/lib/notification-policy";
import {
  getProjectServiceEndpoint,
  isProjectHostOfflineError,
} from "@/lib/project-connection-display";
import { useAppStackScreenOptions } from "@/lib/navigation";
import { registerSecurityPushToken } from "@/lib/push-registration";
import { RelayTransport } from "@/lib/relay-transport";
import { getErrorMessage, isTransientRequestError } from "@/lib/request-errors";
import { useRouteShare } from "@/lib/use-route-share";
import { projectPathFromSearchOrLocation } from "@/lib/view-location";
import {
  applyDesktopStateFailureAtom,
  applyDesktopStateSuccessAtom,
  beginDesktopStateRefreshAtom,
  clearDesktopStateResourceAtom,
  kickDesktopStateRefreshAtom,
  desktopStateRefreshNonceAtom,
} from "@/stores/desktopState";
import {
  applyNotificationFeedFailureAtom,
  applyNotificationFeedSuccessAtom,
  beginNotificationFeedRefreshAtom,
  clearNotificationFeedResourceAtom,
  kickNotificationFeedRefreshAtom,
  markNotificationRecordsObservedAtom,
  notificationFeedRefreshNonceAtom,
} from "@/stores/notifications";
import {
  projectsAtom,
  reconcileProjectsAtom,
  selectedProjectEndpointAtom,
  selectedProjectPathAtom,
  selectedSessionIdAtom,
} from "@/stores/projects";
import {
  kickProjectApiViewRefreshAtom,
  projectUpdateTouchesDesktopState,
  projectUpdateTouchesNotificationFeed,
  projectUpdateTouchesProjectApiView,
} from "@/stores/projectViews";
import { relayConfiguredAtom, relayStatusAtom } from "@/stores/relay";
import {
  activeSharedSessionAtom,
  acceptedSharedSessionsAtom,
  notificationSettingsAtom,
  type ActiveSharedSession,
} from "@/stores/settings";
import { addSecurityEventAtom } from "@/stores/security";
import { PROJECT_API_EVENT_NAMES } from "../../../src/project-api-contract";

const PROJECT_LIST_POLL_INTERVAL_MS = 10_000;
const PROJECT_VIEW_FALLBACK_POLL_INTERVAL_MS = 10_000;
const usePrePaintEffect = Platform.OS === "web" ? useLayoutEffect : useEffect;
const PROJECT_SCOPED_PATH_PREFIXES = [
  "/",
  "/agent",
  "/service",
  "/project",
  "/coordination",
  "/topology",
  "/library",
  "/notifications",
  "/threads",
];

export default function MainLayout() {
  const reconcileProjects = useSetAtom(reconcileProjectsAtom);
  const projects = useAtomValue(projectsAtom);
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const activeShare = useRouteShare();
  const selectedProjectEndpoint = useAtomValue(selectedProjectEndpointAtom);
  const refreshNonce = useAtomValue(desktopStateRefreshNonceAtom);
  const notificationRefreshNonce = useAtomValue(notificationFeedRefreshNonceAtom);
  const notificationSettings = useAtomValue(notificationSettingsAtom);
  const relayStatus = useAtomValue(relayStatusAtom);
  const beginDesktopStateRefresh = useSetAtom(beginDesktopStateRefreshAtom);
  const applyDesktopStateSuccess = useSetAtom(applyDesktopStateSuccessAtom);
  const applyDesktopStateFailure = useSetAtom(applyDesktopStateFailureAtom);
  const clearDesktopStateResource = useSetAtom(clearDesktopStateResourceAtom);
  const kickDesktopStateRefresh = useSetAtom(kickDesktopStateRefreshAtom);
  const kickProjectApiViewRefresh = useSetAtom(kickProjectApiViewRefreshAtom);
  const kickNotificationFeedRefresh = useSetAtom(kickNotificationFeedRefreshAtom);
  const beginNotificationFeedRefresh = useSetAtom(beginNotificationFeedRefreshAtom);
  const applyNotificationFeedSuccess = useSetAtom(applyNotificationFeedSuccessAtom);
  const applyNotificationFeedFailure = useSetAtom(applyNotificationFeedFailureAtom);
  const clearNotificationFeedResource = useSetAtom(clearNotificationFeedResourceAtom);
  const markNotificationRecordsObserved = useSetAtom(markNotificationRecordsObservedAtom);
  const setAcceptedShares = useSetAtom(acceptedSharedSessionsAtom);
  const setLegacyActiveShare = useSetAtom(activeSharedSessionAtom);
  const store = useStore();
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  const stackScreenOptions = useAppStackScreenOptions();
  const pathname = usePathname();
  const searchParams = useGlobalSearchParams<{ project?: string | string[] }>();
  const urlProjectPath = projectPathFromSearchOrLocation(searchParams.project);
  const effectiveProjectPath = activeShare?.projectRoot ?? urlProjectPath ?? selectedProjectPath;
  const effectiveProject = activeShare
    ? projectFromActiveShare(activeShare)
    : projects.find((project) => project.path === effectiveProjectPath);
  const endpoint = activeShare
    ? activeShare.serviceEndpoint
    : effectiveProject
      ? getProjectServiceEndpoint(effectiveProject)
      : urlProjectPath && urlProjectPath !== selectedProjectPath
        ? null
        : selectedProjectEndpoint;
  const relayUrl = env.AIMUX_RELAY_URL;
  const relayReadyForRequests = !relayUrl || relayStatus === "connected";
  const activeShareOwnerUserId = activeShare?.ownerUserId;
  const activeShareShareId = activeShare?.shareId;
  const activeShareRelayKey = activeShare
    ? `${activeShare.ownerUserId}:${activeShare.shareId}`
    : "";

  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);

  usePrePaintEffect(() => {
    if (activeShare || !urlProjectPath || urlProjectPath === selectedProjectPath) return;
    store.set(selectedProjectPathAtom, urlProjectPath);
    store.set(selectedSessionIdAtom, null);
  }, [activeShare, selectedProjectPath, store, urlProjectPath]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!effectiveProjectPath || !isProjectScopedPath(pathname)) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("project") === effectiveProjectPath) return;
    url.searchParams.set("project", effectiveProjectPath);
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  });

  // Relay transport lifecycle: connect when a relay URL is configured, mirror
  // its status into the store, and register it with the API layer so requests
  // route through the tunnel. No-op when EXPO_PUBLIC_AIMUX_RELAY_URL is unset.
  useEffect(() => {
    if (!relayUrl) {
      store.set(relayConfiguredAtom, false);
      store.set(relayStatusAtom, "disconnected");
      return;
    }
    store.set(relayConfiguredAtom, true);
    const activeShareRelayOptions =
      activeShareOwnerUserId && activeShareShareId
        ? { ownerUserId: activeShareOwnerUserId, shareId: activeShareShareId }
        : {};
    const transport = new RelayTransport(
      relayUrl,
      () => getTokenRef.current(),
      undefined,
      activeShareRelayOptions,
    );
    const unsub = transport.onStatusChange((status) => store.set(relayStatusAtom, status));
    const unsubSecurity = transport.onSecurityEvent((event) => {
      store.set(addSecurityEventAtom, event);
      if (!isBrowserDocumentVisible()) {
        showBrowserNotification({
          id: event.id,
          category: "system",
          kind: event.kind,
          title: event.title,
          body: event.body,
          dedupeKey: `security:${event.id}`,
        });
      }
    });
    setApiRelay(transport);
    void transport.connect();
    return () => {
      unsub();
      unsubSecurity();
      setApiRelay(null);
      transport.disconnect();
      store.set(relayStatusAtom, "disconnected");
    };
  }, [activeShareOwnerUserId, activeShareRelayKey, activeShareShareId, relayUrl, store]);

  useEffect(() => {
    if (!relayUrl || relayStatus !== "connected") return;
    const activeShareRelayOptions =
      activeShareOwnerUserId && activeShareShareId
        ? { ownerUserId: activeShareOwnerUserId, shareId: activeShareShareId }
        : {};
    const requestPermission = notificationSettings.enabled && notificationSettings.channels.push;
    void registerSecurityPushToken(relayUrl, () => getTokenRef.current(), {
      ...activeShareRelayOptions,
      agentAlerts: requestPermission,
      requestPermission,
    }).catch((err) => {
      console.warn("push registration failed:", err);
    });
  }, [
    activeShareOwnerUserId,
    activeShareShareId,
    notificationSettings.channels.push,
    notificationSettings.enabled,
    relayStatus,
    relayUrl,
  ]);

  // Poll /projects as a discovery fallback; project-service updates arrive over SSE.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function loop() {
      if (cancelled) return;
      if (activeShare) {
        applyDesktopStateSuccess({
          projectPath: activeShare.projectRoot,
          state: desktopStateFromActiveShare(activeShare),
        });
        timer = setTimeout(loop, PROJECT_LIST_POLL_INTERVAL_MS);
        return;
      }
      if (!relayReadyForRequests) {
        if (relayStatus === "daemon_offline") {
          reconcileProjects([]);
        }
        timer = setTimeout(loop, PROJECT_LIST_POLL_INTERVAL_MS);
        return;
      }
      try {
        const token = await getTokenRef.current();
        const projects = await listProjects({ token });
        if (!cancelled) reconcileProjects(projects);
      } catch (err) {
        // Failed fetches report inline per-operation; no global UI per task description.
        if (!cancelled && !isTransientRequestError(err)) {
          const msg = getErrorMessage(err);
          if (isProjectHostOfflineError(msg)) {
            reconcileProjects([]);
          } else {
            console.warn("project list refresh failed:", err);
          }
        }
      }
      if (cancelled) return;
      timer = setTimeout(loop, PROJECT_LIST_POLL_INTERVAL_MS);
    }

    void loop();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    activeShare,
    applyDesktopStateSuccess,
    reconcileProjects,
    relayReadyForRequests,
    relayStatus,
    store,
  ]);

  useEffect(() => {
    if (!relayUrl) return;
    let cancelled = false;
    async function refreshShares() {
      try {
        const token = await getTokenRef.current();
        if (!token) return;
        const result = await listShares({ token });
        if (cancelled) return;
        const acceptedShares = result.shares
          .filter((share) => share.serviceEndpoint)
          .map((share) => ({
            shareId: share.id,
            ownerUserId: share.ownerUserId,
            projectRoot: share.projectRoot,
            sessionId: share.sessionId,
            serviceEndpoint: share.serviceEndpoint!,
            acceptedAt: share.updatedAt || share.createdAt,
          }));
        if (acceptedShares.length > 0) setAcceptedShares(acceptedShares);
        const stillActive = activeShare
          ? acceptedShares.some(
              (share) =>
                share.ownerUserId === activeShare.ownerUserId &&
                share.shareId === activeShare.shareId,
            )
          : false;
        if (!stillActive) setLegacyActiveShare(null);
      } catch (err) {
        if (!cancelled && !isTransientRequestError(err)) {
          console.warn("shared chat list refresh failed:", err);
        }
      }
    }
    void refreshShares();
    const timer = setInterval(() => void refreshShares(), PROJECT_LIST_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeShare, relayUrl, setAcceptedShares, setLegacyActiveShare]);

  // Poll /desktop-state for the selected project as an SSE fallback. Re-triggers on
  // selection change and on a refresh-nonce bump (from optimistic mutations).
  // Keyed by host:port primitives so the timer survives project-list reconciles
  // that create new array identities.
  const endpointKey = endpoint ? `${endpoint.host}:${endpoint.port}` : null;
  useEffect(() => {
    if (activeShare) return;
    if (!effectiveProjectPath) return;
    if (!relayReadyForRequests) return;
    if (!endpoint) {
      clearDesktopStateResource(effectiveProjectPath);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let activeController: AbortController | null = null;

    async function poll() {
      if (cancelled) return;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      beginDesktopStateRefresh(effectiveProjectPath!);
      try {
        const token = await getTokenRef.current();
        const state = await getDesktopState(endpoint!, { token, signal: controller.signal });
        if (cancelled) return;
        applyDesktopStateSuccess({ projectPath: effectiveProjectPath!, state });
      } catch (err) {
        if (!cancelled && !controller.signal.aborted && !isTransientRequestError(err)) {
          const msg = getErrorMessage(err);
          applyDesktopStateFailure({ projectPath: effectiveProjectPath!, error: msg });
          if (!isProjectHostOfflineError(msg)) {
            console.warn("desktop-state fetch failed:", err);
          }
        }
      }
      if (cancelled) return;
      timer = setTimeout(poll, PROJECT_VIEW_FALLBACK_POLL_INTERVAL_MS);
    }

    void poll();
    return () => {
      cancelled = true;
      activeController?.abort();
      if (timer) clearTimeout(timer);
    };
    // endpoint is included as a value but we depend on endpointKey for stable identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeShare,
    applyDesktopStateFailure,
    applyDesktopStateSuccess,
    beginDesktopStateRefresh,
    clearDesktopStateResource,
    effectiveProjectPath,
    endpointKey,
    refreshNonce,
    relayReadyForRequests,
  ]);

  // Poll durable notifications for the selected project. This mirrors
  // desktop-state polling but uses the daemon's notification records as the
  // canonical feed for cross-device delivery work.
  useEffect(() => {
    if (activeShare) return;
    if (!effectiveProjectPath) return;
    if (!relayReadyForRequests) return;
    if (!endpoint) {
      clearNotificationFeedResource(effectiveProjectPath);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let activeController: AbortController | null = null;

    async function poll() {
      if (cancelled) return;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      beginNotificationFeedRefresh(effectiveProjectPath!);
      try {
        const token = await getTokenRef.current();
        const feed = await listNotifications(endpoint!, { token, signal: controller.signal });
        if (cancelled) return;
        applyNotificationFeedSuccess({
          projectPath: effectiveProjectPath!,
          feed: {
            notifications: feed.notifications,
            unreadCount: feed.unreadCount,
            fetchedAt: new Date().toISOString(),
          },
        });
      } catch (err) {
        if (!cancelled && !controller.signal.aborted && !isTransientRequestError(err)) {
          const msg = getErrorMessage(err);
          applyNotificationFeedFailure({ projectPath: effectiveProjectPath!, error: msg });
          if (!isProjectHostOfflineError(msg)) {
            console.warn("notification fetch failed:", err);
          }
        }
      }
      if (cancelled) return;
      timer = setTimeout(poll, PROJECT_VIEW_FALLBACK_POLL_INTERVAL_MS);
    }

    void poll();
    return () => {
      cancelled = true;
      activeController?.abort();
      if (timer) clearTimeout(timer);
    };
    // endpoint is included as a value but we depend on endpointKey for stable identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeShare,
    applyNotificationFeedFailure,
    applyNotificationFeedSuccess,
    beginNotificationFeedRefresh,
    clearNotificationFeedResource,
    effectiveProjectPath,
    endpointKey,
    notificationRefreshNonce,
    relayReadyForRequests,
  ]);

  // Realtime project updates and alerts. In local mode this opens EventSource
  // directly; in relay mode startHeartbeat uses the relay project-events channel.
  useEffect(() => {
    if (!effectiveProjectPath) return;
    if (!activeShare && !relayReadyForRequests) return;
    if (!endpoint) return;
    const projectPath = effectiveProjectPath;
    let cancelled = false;
    let handle: { stop: () => void } | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function scheduleReconnect() {
      if (cancelled || reconnectTimer) return;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        handle?.stop();
        handle = null;
        void connect();
      }, 3000);
    }

    async function connect() {
      try {
        const token = await getTokenRef.current();
        if (cancelled) return;
        handle = startHeartbeat({
          serviceEndpoint: endpoint!,
          sessionId: activeShare?.sessionId ?? null,
          startLine: activeShare?.sessionId ? CHAT_OUTPUT_CAPTURE_START_LINE : undefined,
          token,
          onEvent: (event) => {
            if (event.type === PROJECT_API_EVENT_NAMES.ready) {
              kickProjectApiViewRefresh();
              kickDesktopStateRefresh();
              kickNotificationFeedRefresh();
              return;
            }
            if (event.type === PROJECT_API_EVENT_NAMES.projectUpdate) {
              if (projectUpdateTouchesProjectApiView(event.views)) {
                kickProjectApiViewRefresh(event.views);
              }
              if (projectUpdateTouchesDesktopState(event.views)) {
                kickDesktopStateRefresh();
              }
              if (projectUpdateTouchesNotificationFeed(event.views)) {
                kickNotificationFeedRefresh();
              }
              return;
            }
            if (event.type !== "alert") return;
            if (event.notificationId) {
              markNotificationRecordsObserved({ projectPath, ids: [event.notificationId] });
            }
            kickNotificationFeedRefresh();
            const notification = evaluateAlertEvent(event, notificationSettings, {
              projectName: effectiveProject?.name,
              projectPath,
            });
            if (
              notification &&
              notificationSettings.channels.browser &&
              !isBrowserDocumentVisible()
            ) {
              showBrowserNotification(notification);
            }
          },
          onError: (err) => {
            if (!cancelled) {
              console.warn("notification heartbeat failed:", getErrorMessage(err));
              scheduleReconnect();
            }
          },
        });
      } catch (err) {
        if (!cancelled) {
          console.warn("notification heartbeat setup failed:", getErrorMessage(err));
          scheduleReconnect();
        }
      }
    }

    void connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      handle?.stop();
    };
    // endpoint is included as a value but we depend on endpointKey for stable identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeShare,
    effectiveProject?.name,
    effectiveProjectPath,
    endpointKey,
    kickDesktopStateRefresh,
    kickProjectApiViewRefresh,
    kickNotificationFeedRefresh,
    markNotificationRecordsObserved,
    notificationSettings,
    relayUrl,
    relayReadyForRequests,
  ]);

  return (
    <>
      <NotificationProvider />
      <NativeNotificationRouter />
      <AppShell>
        <Stack screenOptions={stackScreenOptions}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="agent/[sessionId]/chat" />
          <Stack.Screen name="shares/index" />
          <Stack.Screen name="shares/[ownerUserId]/[shareId]/agent/[sessionId]/chat" />
          <Stack.Screen name="global-notifications" />
          <Stack.Screen name="global-threads" />
        </Stack>
      </AppShell>
    </>
  );
}

function projectFromActiveShare(activeShare: ActiveSharedSession) {
  const name = activeShare.projectRoot.split("/").filter(Boolean).pop() || "shared project";
  return {
    id: `shared:${activeShare.shareId}`,
    name,
    path: activeShare.projectRoot,
    lastSeen: activeShare.acceptedAt,
    dashboardSessionName: `shared:${activeShare.shareId}`,
    sessions: [
      {
        id: activeShare.sessionId,
        tool: "shared",
        status: "running" as const,
        label: "Shared session",
      },
    ],
    service: null,
    serviceAlive: true,
    serviceEndpoint: activeShare.serviceEndpoint,
  };
}

function desktopStateFromActiveShare(activeShare: ActiveSharedSession): DesktopState {
  const name = activeShare.projectRoot.split("/").filter(Boolean).pop() || "Shared project";
  return {
    ok: true,
    sessions: [
      {
        id: activeShare.sessionId,
        command: "shared",
        toolConfigKey: "shared",
        status: "running",
        worktreePath: activeShare.projectRoot,
        worktreeName: name,
        label: "Shared session",
      },
    ],
    services: [],
    worktrees: [],
    mainCheckoutInfo: { name, branch: "" },
    mainCheckoutPath: activeShare.projectRoot,
  };
}

function isProjectScopedPath(pathname: string) {
  return PROJECT_SCOPED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || (prefix !== "/" && pathname.startsWith(`${prefix}/`)),
  );
}
