import React, { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Platform } from "react-native";
import { Stack, useGlobalSearchParams, usePathname, useRouter } from "expo-router";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { AppShell } from "@/components/AppShell";
import { NotificationProvider } from "@/components/NotificationProvider";
import { NativeNotificationRouter } from "@/components/NativeNotificationRouter";
import {
  getDesktopState,
  listNotifications,
  listProjectsAcrossMachines,
  listShares,
  setApiRelay,
} from "@/lib/api";
import type { DesktopState } from "@/lib/desktop-state";
import { useAuth } from "@/lib/auth";
import { CHAT_OUTPUT_CAPTURE_START_LINE } from "@/lib/chat-output-constants";
import { deliverBrowserNotification, isBrowserDocumentVisible } from "@/lib/browser-notifications";
import { env } from "@/lib/env";
import { startHeartbeat } from "@/lib/heartbeat";
import { evaluateAlertEvent } from "@/lib/notification-policy";
import { observeNotificationStartup } from "@/lib/notification-startup";
import {
  getProjectServiceEndpoint,
  isRelayUnavailableForProjectDiscovery,
  isProjectHostOfflineError,
} from "@/lib/project-connection-display";
import { useAppStackScreenOptions } from "@/lib/navigation";
import { registerSecurityPushToken } from "@/lib/push-registration";
import { RelayTransport } from "@/lib/relay-transport";
import { getErrorMessage, isTransientRequestError } from "@/lib/request-errors";
import {
  activeSessionsFromShareSummaries,
  sharedSessionsEqual,
  shouldApplySharedSessionHydrate,
} from "@/lib/shared-sessions";
import { sharedChatHref, useRouteShare } from "@/lib/use-route-share";
import { projectRefFromSearchOrLocation, type SearchValue } from "@/lib/view-location";
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
  clearNotificationStartupIssueAtom,
  reportNotificationStartupIssueAtom,
} from "@/stores/notificationStartup";
import {
  explicitProjectSelectionAtom,
  projectsAtom,
  projectListStatusAtom,
  reconcileProjectsAtom,
  rememberProjectViewPath,
  selectedProjectEndpointAtom,
  selectedProjectRefAtom,
  selectedSessionIdAtom,
} from "@/stores/projects";
import {
  projectListFailed,
  projectListPartial,
  projectListUnavailable,
  relayUnavailableDetail,
} from "@/lib/project-list-status";
import { appToast } from "@/lib/toast";
import { toastErrorMessage, toastIdForOperation } from "@/lib/toast-shared";
import {
  kickProjectApiViewRefreshAtom,
  projectUpdateTouchesDesktopState,
  projectUpdateTouchesNotificationFeed,
  projectUpdateTouchesProjectApiView,
} from "@/stores/projectViews";
import {
  departedMachineIdsAtom,
  knownMachinesAtom,
  recordRelayMachinesAtom,
  relayConfiguredAtom,
  relayMachinesAtom,
  relayPendingApprovalAtom,
  relayStatusAtom,
} from "@/stores/relay";
import {
  activeSharedSessionAtom,
  acceptedSharedSessionsAtom,
  notificationSettingsAtom,
  type ActiveSharedSession,
} from "@/stores/settings";
import { addSecurityEventAtom } from "@/stores/security";
import { PROJECT_API_EVENT_NAMES } from "../../../src/project-api-contract";
import { serviceEndpointKey } from "@/lib/daemon-url";
import {
  findProjectForRef,
  parseProjectKey,
  projectKey,
  projectStateKey,
  resolveRouteProjectRef,
  sameProjectRef,
} from "@/lib/project-key";

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
  const setProjectListStatus = useSetAtom(projectListStatusAtom);
  const projects = useAtomValue(projectsAtom);
  const selectedProjectRef = useAtomValue(selectedProjectRefAtom);
  const explicitProjectSelection = useAtomValue(explicitProjectSelectionAtom);
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
  const reportNotificationStartupIssue = useSetAtom(reportNotificationStartupIssueAtom);
  const clearNotificationStartupIssue = useSetAtom(clearNotificationStartupIssueAtom);
  const setAcceptedShares = useSetAtom(acceptedSharedSessionsAtom);
  const setLegacyActiveShare = useSetAtom(activeSharedSessionAtom);
  const setAcceptedSharesRef = useRef(setAcceptedShares);
  const setLegacyActiveShareRef = useRef(setLegacyActiveShare);
  const preservedEmptyShareHydrateRef = useRef(false);
  const store = useStore();
  const { getToken } = useAuth();
  const router = useRouter();
  const getTokenRef = useRef(getToken);
  const stackScreenOptions = useAppStackScreenOptions();
  const pathname = usePathname();
  const searchParams = useGlobalSearchParams();
  // Rebuilt from a key string so its identity is stable across renders: this
  // is an effect dependency, and a fresh object every render would re-run the
  // URL-to-selection effect on every paint.
  const urlProjectKey = projectKey(
    projectRefFromSearchOrLocation(
      searchParams.project as SearchValue,
      searchParams.machine as SearchValue,
    ),
  );
  const urlProjectRef = useMemo(() => parseProjectKey(urlProjectKey), [urlProjectKey]);
  // Both halves of the effective project come from one source, so a path is
  // never paired with another host's machine.
  const effectiveProjectRef = resolveRouteProjectRef({
    urlRef: urlProjectRef,
    selectedRef: selectedProjectRef,
    shareProjectRoot: activeShare?.projectRoot,
  });
  const effectiveProjectPath = effectiveProjectRef?.path ?? null;
  // A primitive stand-in for the ref, so an effect that depends on it does not
  // re-run on every render just because the object is rebuilt.
  const effectiveProjectKey = projectKey(effectiveProjectRef);
  const effectiveProjectStateKey = projectStateKey(effectiveProjectRef);
  const effectiveProject = activeShare
    ? projectFromActiveShare(activeShare)
    : findProjectForRef(projects, effectiveProjectRef);
  const endpoint = activeShare
    ? activeShare.serviceEndpoint
    : effectiveProject
      ? getProjectServiceEndpoint(effectiveProject)
      : urlProjectRef && !sameProjectRef(urlProjectRef, selectedProjectRef)
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

  useEffect(() => {
    setAcceptedSharesRef.current = setAcceptedShares;
    setLegacyActiveShareRef.current = setLegacyActiveShare;
  }, [setAcceptedShares, setLegacyActiveShare]);

  // URL -> selection. Compared as refs, and only when the URL names a machine
  // or the selection does not: a machineless URL must not downgrade a
  // selection that knows its host, or this and the writer below trade
  // corrections forever.
  usePrePaintEffect(() => {
    if (activeShare || !urlProjectRef) return;
    if (sameProjectRef(urlProjectRef, selectedProjectRef)) return;
    // A machineless URL does not downgrade a selection that knows which host
    // holds that same path; the URL writer below fills the machine back in.
    if (
      !urlProjectRef.machineId &&
      selectedProjectRef?.machineId &&
      selectedProjectRef.path === urlProjectRef.path
    ) {
      return;
    }
    const urlKey = projectKey(urlProjectRef);
    const selectedKey = projectKey(selectedProjectRef);
    if (
      explicitProjectSelection &&
      explicitProjectSelection.key === selectedKey &&
      explicitProjectSelection.key !== urlKey &&
      explicitProjectSelection.expiresAt > Date.now()
    ) {
      return;
    }
    if (explicitProjectSelection?.key === urlKey) {
      store.set(explicitProjectSelectionAtom, null);
    }
    store.set(selectedProjectRefAtom, urlProjectRef);
    store.set(selectedSessionIdAtom, null);
  }, [activeShare, explicitProjectSelection, selectedProjectRef, store, urlProjectRef]);

  useEffect(() => {
    if (!activeShare) return;
    if (pathname === "/shares" || pathname.startsWith("/shares/")) return;
    router.replace(sharedChatHref(activeShare));
  }, [activeShare, pathname, router]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (!effectiveProjectPath || !isProjectScopedPath(pathname)) return;
    if (activeShare) return;
    const url = new URL(window.location.href);
    const effectiveMachineId = effectiveProjectRef?.machineId ?? "";
    if (
      url.searchParams.get("project") === effectiveProjectPath &&
      (url.searchParams.get("machine") ?? "") === effectiveMachineId
    ) {
      return;
    }
    url.searchParams.set("project", effectiveProjectPath);
    if (effectiveMachineId) url.searchParams.set("machine", effectiveMachineId);
    else url.searchParams.delete("machine");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  });

  useEffect(() => {
    if (activeShare || !effectiveProjectPath || !isProjectScopedPath(pathname)) return;
    rememberProjectViewPath(
      parseProjectKey(effectiveProjectKey),
      projectViewPathForCurrentRoute(
        pathname,
        effectiveProjectPath,
        searchParams as Record<string, string | string[] | undefined>,
      ),
    );
  }, [activeShare, effectiveProjectKey, effectiveProjectPath, pathname, searchParams]);

  // Relay transport lifecycle: connect when a relay URL is configured, mirror
  // its status into the store, and register it with the API layer so requests
  // route through the tunnel. No-op when EXPO_PUBLIC_AIMUX_RELAY_URL is unset.
  useEffect(() => {
    if (!relayUrl) {
      store.set(relayConfiguredAtom, false);
      store.set(relayStatusAtom, "disconnected");
      store.set(relayPendingApprovalAtom, null);
      store.set(relayMachinesAtom, []);
      store.set(knownMachinesAtom, []);
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
    const unsubPendingApproval = transport.onPendingApprovalChange((approval) =>
      store.set(relayPendingApprovalAtom, approval),
    );
    const unsubMachines = transport.onMachinesChange((machines) =>
      store.set(recordRelayMachinesAtom, machines),
    );
    const unsubSecurity = transport.onSecurityEvent((event) => {
      store.set(addSecurityEventAtom, event);
      if (!isBrowserDocumentVisible()) {
        const notification = {
          id: event.id,
          category: "system",
          kind: event.kind,
          title: event.title,
          body: event.body,
          dedupeKey: `security:${event.id}`,
        } as const;
        deliverBrowserNotification(notification);
      }
    });
    setApiRelay(transport);
    void transport.connect();
    return () => {
      unsub();
      unsubPendingApproval();
      unsubMachines();
      unsubSecurity();
      setApiRelay(null);
      transport.disconnect();
      store.set(relayStatusAtom, "disconnected");
      store.set(relayPendingApprovalAtom, null);
      store.set(relayMachinesAtom, []);
      store.set(knownMachinesAtom, []);
    };
  }, [activeShareOwnerUserId, activeShareRelayKey, activeShareShareId, relayUrl, store]);

  useEffect(() => {
    if (!relayUrl || relayStatus !== "connected") return;
    const activeShareRelayOptions =
      activeShareOwnerUserId && activeShareShareId
        ? { ownerUserId: activeShareOwnerUserId, shareId: activeShareShareId }
        : {};
    const requestPermission = notificationSettings.enabled && notificationSettings.channels.push;
    void observeNotificationStartup({
      source: "push_registration",
      operation: () =>
        registerSecurityPushToken(relayUrl, () => getTokenRef.current(), {
          ...activeShareRelayOptions,
          agentAlerts: requestPermission,
          requestPermission,
        }),
      onIssue: reportNotificationStartupIssue,
      onClear: clearNotificationStartupIssue,
    });
  }, [
    activeShareOwnerUserId,
    activeShareShareId,
    clearNotificationStartupIssue,
    notificationSettings.channels.push,
    notificationSettings.enabled,
    reportNotificationStartupIssue,
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
          projectStateKey: projectStateKey({ path: activeShare.projectRoot }),
          state: desktopStateFromActiveShare(activeShare),
        });
        timer = setTimeout(loop, PROJECT_LIST_POLL_INTERVAL_MS);
        return;
      }
      if (!relayReadyForRequests) {
        if (relayUrl && isRelayUnavailableForProjectDiscovery(relayStatus)) {
          setProjectListStatus(projectListUnavailable(relayUnavailableDetail(relayStatus)));
        }
        timer = setTimeout(loop, PROJECT_LIST_POLL_INTERVAL_MS);
        return;
      }
      try {
        const token = await getTokenRef.current();
        const { projects, failures, answeringMachineIds } = await listProjectsAcrossMachines({
          token,
        });
        if (!cancelled) {
          reconcileProjects(projects, {
            // A machine that left the relay is never queried, so it has no
            // failure to report -- without naming it here its projects would
            // simply vanish instead of greying out.
            unansweredMachineIds: [
              ...failures.map((failure) => failure.machineId),
              ...store.get(departedMachineIdsAtom),
            ],
            answeringMachineIds,
            // A list missing one machine is real but short, and "ok" would
            // call it whole.
            status: failures.length > 0 ? projectListPartial(failures) : undefined,
          });
        }
      } catch (err) {
        // A fetch that failed is not a list of zero projects. Every non-transient
        // outcome has to reach the UI as itself.
        if (!cancelled && !isTransientRequestError(err)) {
          const msg = getErrorMessage(err);
          if (isProjectHostOfflineError(msg)) {
            // No machine answered, so there is no list -- but a machine that
            // merely went away still keeps its last-known projects, greyed,
            // rather than disappearing.
            reconcileProjects([], {
              unansweredMachineIds: store.get(departedMachineIdsAtom),
            });
            setProjectListStatus(projectListUnavailable("The daemon is offline."));
          } else {
            setProjectListStatus(projectListFailed(msg));
            // Keyed by the operation, so a poll failing every ten seconds
            // replaces its toast instead of stacking an hour of them.
            appToast.error("Could not load projects", {
              id: toastIdForOperation("project-list"),
              description: toastErrorMessage(err, msg),
            });
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
    relayUrl,
    setProjectListStatus,
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
        const acceptedShares = activeSessionsFromShareSummaries(result.shares);
        setAcceptedSharesRef.current((current) => {
          const preserveEmptyOnce =
            acceptedShares.length === 0 &&
            current.length > 0 &&
            !preservedEmptyShareHydrateRef.current;
          if (!shouldApplySharedSessionHydrate(current, acceptedShares, { preserveEmptyOnce })) {
            preservedEmptyShareHydrateRef.current = true;
            return current;
          }
          if (acceptedShares.length > 0) preservedEmptyShareHydrateRef.current = false;
          return sharedSessionsEqual(current, acceptedShares) ? current : acceptedShares;
        });
        const stillActive = activeShare
          ? acceptedShares.some(
              (share) =>
                share.ownerUserId === activeShare.ownerUserId &&
                share.shareId === activeShare.shareId,
            )
          : false;
        if (activeShare && acceptedShares.length > 0 && !stillActive) {
          setLegacyActiveShareRef.current(null);
        }
      } catch (err) {
        if (!cancelled && !isTransientRequestError(err)) {
          appToast.error("Could not load shared chats", {
            id: toastIdForOperation("shared-chats"),
            description: toastErrorMessage(err, "The shared chat list could not be refreshed."),
          });
        }
      }
    }
    void refreshShares();
    const timer = setInterval(() => void refreshShares(), PROJECT_LIST_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeShare, relayUrl]);

  // Poll /desktop-state for the selected project as an SSE fallback. Re-triggers on
  // selection change and on a refresh-nonce bump (from optimistic mutations).
  // Keyed by host:port primitives so the timer survives project-list reconciles
  // that create new array identities.
  const endpointKey = serviceEndpointKey(endpoint);
  useEffect(() => {
    if (activeShare) return;
    if (!effectiveProjectPath) return;
    if (!relayReadyForRequests) return;
    if (!endpoint) {
      clearDesktopStateResource(effectiveProjectStateKey);
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
      beginDesktopStateRefresh(effectiveProjectStateKey);
      try {
        const token = await getTokenRef.current();
        const state = await getDesktopState(endpoint!, { token, signal: controller.signal });
        if (cancelled) return;
        applyDesktopStateSuccess({ projectStateKey: effectiveProjectStateKey, state });
      } catch (err) {
        if (!cancelled && !controller.signal.aborted && !isTransientRequestError(err)) {
          const msg = getErrorMessage(err);
          applyDesktopStateFailure({ projectStateKey: effectiveProjectStateKey, error: msg });
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
      clearNotificationFeedResource(effectiveProjectStateKey);
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
      beginNotificationFeedRefresh(effectiveProjectStateKey);
      try {
        const token = await getTokenRef.current();
        const feed = await listNotifications(endpoint!, { token, signal: controller.signal });
        if (cancelled) return;
        applyNotificationFeedSuccess({
          projectStateKey: effectiveProjectStateKey,
          feed: {
            notifications: feed.notifications,
            unreadCount: feed.unreadCount,
            fetchedAt: new Date().toISOString(),
          },
        });
      } catch (err) {
        if (!cancelled && !controller.signal.aborted && !isTransientRequestError(err)) {
          const msg = getErrorMessage(err);
          applyNotificationFeedFailure({ projectStateKey: effectiveProjectStateKey, error: msg });
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
    const projectStateKeyForStream = effectiveProjectStateKey;
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
          mode: activeShare?.sessionId ? "chat" : undefined,
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
              markNotificationRecordsObserved({
                projectStateKey: projectStateKeyForStream,
                ids: [event.notificationId],
              });
            }
            kickNotificationFeedRefresh();
            const notification = evaluateAlertEvent(event, notificationSettings, {
              projectName: effectiveProject?.name,
              projectPath: effectiveProjectPath ?? undefined,
              machineId: effectiveProjectRef?.machineId,
            });
            if (
              notification &&
              notificationSettings.channels.browser &&
              !isBrowserDocumentVisible()
            ) {
              deliverBrowserNotification(notification);
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
          <Stack.Screen name="monitor" />
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
    // A shared session is reachable and has no local dashboard to sample, so it
    // must not read as offline in the picker.
    dashboardAlive: true,
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

function projectViewPathForCurrentRoute(
  pathname: string,
  projectPath: string,
  searchParams: Record<string, string | string[] | undefined>,
) {
  const query = new URLSearchParams();
  query.set("project", projectPath);
  for (const key of ["mode", "lens", "section", "document", "threadId"] as const) {
    const value = firstSearchParam(searchParams[key]);
    if (value) query.set(key, value);
  }
  const search = query.toString();
  return `${pathname}${search ? `?${search}` : ""}`;
}

function firstSearchParam(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  const trimmed = first?.trim();
  return trimmed ? trimmed : null;
}
