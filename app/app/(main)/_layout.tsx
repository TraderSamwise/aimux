import React, { useEffect } from "react";
import { Stack, useGlobalSearchParams } from "expo-router";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { AppShell } from "@/components/AppShell";
import { NotificationProvider } from "@/components/NotificationProvider";
import { getDesktopState, listNotifications, listProjects, setApiRelay } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { isBrowserDocumentVisible, showBrowserNotification } from "@/lib/browser-notifications";
import { env } from "@/lib/env";
import { registerSecurityPushToken } from "@/lib/push-registration";
import { RelayTransport } from "@/lib/relay-transport";
import { projectPathFromSearch } from "@/lib/view-location";
import {
  desktopStateErrorFamily,
  desktopStateFamily,
  desktopStateRefreshNonceAtom,
} from "@/stores/desktopState";
import {
  notificationFeedErrorFamily,
  notificationFeedFamily,
  notificationFeedRefreshNonceAtom,
} from "@/stores/notifications";
import {
  reconcileProjectsAtom,
  selectedProjectEndpointAtom,
  selectedProjectPathAtom,
  selectedSessionIdAtom,
} from "@/stores/projects";
import { relayConfiguredAtom, relayStatusAtom } from "@/stores/relay";
import { activeSharedSessionAtom, type ActiveSharedSession } from "@/stores/settings";
import { addSecurityEventAtom } from "@/stores/security";

const POLL_INTERVAL_MS = 2000;

export default function MainLayout() {
  const reconcileProjects = useSetAtom(reconcileProjectsAtom);
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const activeShare = useAtomValue(activeSharedSessionAtom);
  const endpoint = useAtomValue(selectedProjectEndpointAtom);
  const refreshNonce = useAtomValue(desktopStateRefreshNonceAtom);
  const notificationRefreshNonce = useAtomValue(notificationFeedRefreshNonceAtom);
  const store = useStore();
  const { getToken } = useAuth();
  const searchParams = useGlobalSearchParams<{ project?: string | string[] }>();
  const urlProjectPath = projectPathFromSearch(searchParams.project);

  useEffect(() => {
    if (activeShare || !urlProjectPath || urlProjectPath === selectedProjectPath) return;
    store.set(selectedProjectPathAtom, urlProjectPath);
    store.set(selectedSessionIdAtom, null);
  }, [activeShare, selectedProjectPath, store, urlProjectPath]);

  // Relay transport lifecycle: connect when a relay URL is configured, mirror
  // its status into the store, and register it with the API layer so requests
  // route through the tunnel. No-op when EXPO_PUBLIC_AIMUX_RELAY_URL is unset.
  useEffect(() => {
    const relayUrl = env.AIMUX_RELAY_URL;
    if (!relayUrl) {
      store.set(relayConfiguredAtom, false);
      store.set(relayStatusAtom, "disconnected");
      return;
    }
    store.set(relayConfiguredAtom, true);
    const transport = new RelayTransport(
      relayUrl,
      getToken,
      undefined,
      activeShare ? { ownerUserId: activeShare.ownerUserId, shareId: activeShare.shareId } : {},
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
      getToken,
      activeShare ? { ownerUserId: activeShare.ownerUserId, shareId: activeShare.shareId } : {},
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
  }, [activeShare, getToken, store]);

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
      try {
        const token = await getToken();
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
  }, [activeShare, getToken, reconcileProjects, store]);

  // Poll /desktop-state for the selected project every 2s. Re-triggers on
  // selection change and on a refresh-nonce bump (from optimistic mutations).
  // Keyed by host:port primitives so the timer survives project-list reconciles
  // that create new array identities.
  const endpointKey = endpoint ? `${endpoint.host}:${endpoint.port}` : null;
  useEffect(() => {
    if (activeShare) return;
    if (!selectedProjectPath) return;
    if (!endpoint) {
      store.set(desktopStateFamily(selectedProjectPath), null);
      store.set(desktopStateErrorFamily(selectedProjectPath), null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      if (cancelled) return;
      try {
        const token = await getToken();
        const state = await getDesktopState(endpoint!, { token });
        if (cancelled) return;
        store.set(desktopStateFamily(selectedProjectPath!), state);
        store.set(desktopStateErrorFamily(selectedProjectPath!), null);
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          store.set(desktopStateErrorFamily(selectedProjectPath!), msg);
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
  }, [activeShare, selectedProjectPath, endpointKey, refreshNonce, getToken, store]);

  // Poll durable notifications for the selected project. This mirrors
  // desktop-state polling but uses the daemon's notification records as the
  // canonical feed for cross-device delivery work.
  useEffect(() => {
    if (activeShare) return;
    if (!selectedProjectPath) return;
    if (!endpoint) {
      store.set(notificationFeedFamily(selectedProjectPath), null);
      store.set(notificationFeedErrorFamily(selectedProjectPath), null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      if (cancelled) return;
      try {
        const token = await getToken();
        const feed = await listNotifications(endpoint!, { token });
        if (cancelled) return;
        store.set(notificationFeedFamily(selectedProjectPath!), {
          notifications: feed.notifications,
          unreadCount: feed.unreadCount,
          fetchedAt: new Date().toISOString(),
        });
        store.set(notificationFeedErrorFamily(selectedProjectPath!), null);
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          store.set(notificationFeedErrorFamily(selectedProjectPath!), msg);
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
  }, [activeShare, selectedProjectPath, endpointKey, notificationRefreshNonce, getToken, store]);

  return (
    <>
      <NotificationProvider />
      <AppShell>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
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
