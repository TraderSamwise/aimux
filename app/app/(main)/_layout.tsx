import React, { useEffect, useLayoutEffect, useRef } from "react";
import { Platform } from "react-native";
import { Stack, useGlobalSearchParams, usePathname } from "expo-router";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { AppShell } from "@/components/AppShell";
import { NotificationProvider } from "@/components/NotificationProvider";
import { NativeNotificationRouter } from "@/components/NativeNotificationRouter";
import { getDesktopState, listNotifications, listProjects, setApiRelay } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { isBrowserDocumentVisible, showBrowserNotification } from "@/lib/browser-notifications";
import { env } from "@/lib/env";
import { startHeartbeat } from "@/lib/heartbeat";
import { evaluateAlertEvent } from "@/lib/notification-policy";
import {
  getProjectServiceEndpoint,
  isProjectHostOfflineError,
} from "@/lib/project-connection-display";
import { registerSecurityPushToken } from "@/lib/push-registration";
import { RelayTransport } from "@/lib/relay-transport";
import { projectPathFromSearchOrLocation } from "@/lib/view-location";
import {
  desktopStateErrorFamily,
  desktopStateFamily,
  kickDesktopStateRefreshAtom,
  desktopStateRefreshNonceAtom,
} from "@/stores/desktopState";
import {
  notificationFeedErrorFamily,
  notificationFeedFamily,
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
  const activeShare = useAtomValue(activeSharedSessionAtom);
  const selectedProjectEndpoint = useAtomValue(selectedProjectEndpointAtom);
  const refreshNonce = useAtomValue(desktopStateRefreshNonceAtom);
  const notificationRefreshNonce = useAtomValue(notificationFeedRefreshNonceAtom);
  const notificationSettings = useAtomValue(notificationSettingsAtom);
  const relayStatus = useAtomValue(relayStatusAtom);
  const kickDesktopStateRefresh = useSetAtom(kickDesktopStateRefreshAtom);
  const kickProjectApiViewRefresh = useSetAtom(kickProjectApiViewRefreshAtom);
  const kickNotificationFeedRefresh = useSetAtom(kickNotificationFeedRefreshAtom);
  const markNotificationRecordsObserved = useSetAtom(markNotificationRecordsObservedAtom);
  const store = useStore();
  const { getToken } = useAuth();
  const getTokenRef = useRef(getToken);
  const pathname = usePathname();
  const searchParams = useGlobalSearchParams<{ project?: string | string[] }>();
  const urlProjectPath = projectPathFromSearchOrLocation(searchParams.project);
  const effectiveProjectPath = urlProjectPath ?? selectedProjectPath;
  const effectiveProject = projects.find((project) => project.path === effectiveProjectPath);
  const endpoint = effectiveProject
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
    void registerSecurityPushToken(
      relayUrl,
      () => getTokenRef.current(),
      activeShareRelayOptions,
    ).catch((err) => {
      console.warn("security push registration failed:", err);
    });
    return () => {
      unsub();
      unsubSecurity();
      setApiRelay(null);
      transport.disconnect();
      store.set(relayStatusAtom, "disconnected");
    };
  }, [activeShareOwnerUserId, activeShareRelayKey, activeShareShareId, relayUrl, store]);

  // Poll /projects as a discovery fallback; project-service updates arrive over SSE.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function loop() {
      if (cancelled) return;
      if (activeShare) {
        reconcileProjects([projectFromActiveShare(activeShare)]);
        store.set(selectedProjectPathAtom, activeShare.projectRoot);
        store.set(selectedSessionIdAtom, activeShare.sessionId);
        timer = setTimeout(loop, PROJECT_LIST_POLL_INTERVAL_MS);
        return;
      }
      if (!relayReadyForRequests) return;
      try {
        const token = await getTokenRef.current();
        const projects = await listProjects({ token });
        if (!cancelled) reconcileProjects(projects);
      } catch (err) {
        // Failed fetches report inline per-operation; no global UI per task description.
        if (!cancelled) console.warn("project list refresh failed:", err);
      }
      if (cancelled) return;
      timer = setTimeout(loop, PROJECT_LIST_POLL_INTERVAL_MS);
    }

    void loop();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeShare, reconcileProjects, relayReadyForRequests, store]);

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
      store.set(desktopStateFamily(effectiveProjectPath), null);
      store.set(desktopStateErrorFamily(effectiveProjectPath), null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      if (cancelled) return;
      try {
        const token = await getTokenRef.current();
        const state = await getDesktopState(endpoint!, { token });
        if (cancelled) return;
        store.set(desktopStateFamily(effectiveProjectPath!), state);
        store.set(desktopStateErrorFamily(effectiveProjectPath!), null);
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          store.set(desktopStateErrorFamily(effectiveProjectPath!), msg);
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
      if (timer) clearTimeout(timer);
    };
    // endpoint is included as a value but we depend on endpointKey for stable identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeShare, effectiveProjectPath, endpointKey, refreshNonce, relayReadyForRequests, store]);

  // Poll durable notifications for the selected project. This mirrors
  // desktop-state polling but uses the daemon's notification records as the
  // canonical feed for cross-device delivery work.
  useEffect(() => {
    if (activeShare) return;
    if (!effectiveProjectPath) return;
    if (!relayReadyForRequests) return;
    if (!endpoint) {
      store.set(notificationFeedFamily(effectiveProjectPath), null);
      store.set(notificationFeedErrorFamily(effectiveProjectPath), null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      if (cancelled) return;
      try {
        const token = await getTokenRef.current();
        const feed = await listNotifications(endpoint!, { token });
        if (cancelled) return;
        store.set(notificationFeedFamily(effectiveProjectPath!), {
          notifications: feed.notifications,
          unreadCount: feed.unreadCount,
          fetchedAt: new Date().toISOString(),
        });
        store.set(notificationFeedErrorFamily(effectiveProjectPath!), null);
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          store.set(notificationFeedErrorFamily(effectiveProjectPath!), msg);
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
      if (timer) clearTimeout(timer);
    };
    // endpoint is included as a value but we depend on endpointKey for stable identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeShare,
    effectiveProjectPath,
    endpointKey,
    notificationRefreshNonce,
    relayReadyForRequests,
    store,
  ]);

  // Realtime project updates and alerts. In local mode this opens EventSource
  // directly; in relay mode startHeartbeat uses the relay project-events channel.
  useEffect(() => {
    if (!effectiveProjectPath) return;
    if (!relayReadyForRequests) return;
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
                kickProjectApiViewRefresh();
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
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
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

function isProjectScopedPath(pathname: string) {
  return PROJECT_SCOPED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || (prefix !== "/" && pathname.startsWith(`${prefix}/`)),
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
