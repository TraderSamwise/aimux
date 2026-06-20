import React, { useEffect, useLayoutEffect, useRef } from "react";
import { Platform } from "react-native";
import { Stack, useGlobalSearchParams } from "expo-router";
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
import { getProjectServiceEndpoint } from "@/lib/project-connection-display";
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
  projectUpdateTouchesServiceView,
} from "@/stores/projectViews";
import { relayConfiguredAtom, relayStatusAtom } from "@/stores/relay";
import {
  activeSharedSessionAtom,
  notificationSettingsAtom,
  type ActiveSharedSession,
} from "@/stores/settings";
import { addSecurityEventAtom } from "@/stores/security";
import { PROJECT_API_EVENT_NAMES } from "../../../src/project-api-contract";

const POLL_INTERVAL_MS = 2000;
const usePrePaintEffect = Platform.OS === "web" ? useLayoutEffect : useEffect;

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

  // Poll /projects every 2s; reconcile into the projects atom.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function loop() {
      if (cancelled) return;
      if (activeShare) {
        reconcileProjects([projectFromActiveShare(activeShare)]);
        store.set(selectedProjectPathAtom, activeShare.projectRoot);
        store.set(selectedSessionIdAtom, activeShare.sessionId);
        timer = setTimeout(loop, POLL_INTERVAL_MS);
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
      timer = setTimeout(loop, POLL_INTERVAL_MS);
    }

    void loop();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeShare, reconcileProjects, relayReadyForRequests, store]);

  // Poll /desktop-state for the selected project every 2s. Re-triggers on
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
          console.warn("desktop-state fetch failed:", err);
        }
      }
      if (cancelled) return;
      timer = setTimeout(poll, POLL_INTERVAL_MS);
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
          console.warn("notification fetch failed:", err);
        }
      }
      if (cancelled) return;
      timer = setTimeout(poll, POLL_INTERVAL_MS);
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

  // Realtime alert delivery for local projects. The durable notification poll
  // above keeps the inbox current, but browser notifications should use live
  // events when the browser can reach the project service directly. Relay mode
  // cannot open this EventSource, so it stays on the relay-aware polling path.
  useEffect(() => {
    if (activeShare) return;
    if (relayUrl) return;
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
          sessionId: null,
          token,
          onEvent: (event) => {
            if (event.type === PROJECT_API_EVENT_NAMES.projectUpdate) {
              if (projectUpdateTouchesServiceView(event.views)) {
                kickProjectApiViewRefresh();
              }
              if (
                event.views.includes("desktop-state") ||
                event.views.includes("agents") ||
                event.views.includes("services") ||
                event.views.includes("worktrees")
              ) {
                kickDesktopStateRefresh();
              }
              if (event.views.includes("notifications") || event.views.includes("inbox")) {
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
              console.warn("notification heartbeat failed:", err);
              scheduleReconnect();
            }
          },
        });
      } catch (err) {
        if (!cancelled) {
          console.warn("notification heartbeat setup failed:", err);
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
