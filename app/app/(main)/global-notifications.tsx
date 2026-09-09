import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import { AlertTriangle, Bell, Check, RotateCw } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Card, PressableCard } from "@/components/ui/card";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { SegmentedControl, type SegmentOption } from "@/components/ui/segmented-control";
import { Text } from "@/components/ui/text";
import { listNotifications, markNotificationsRead } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  filterGlobalNotificationRows,
  splitGlobalNotificationRows,
  sortGlobalNotificationRows,
  type GlobalNotificationScope,
} from "@/lib/global-notification-feed";
import {
  buildViewHref,
  buildViewPath,
  detailHrefForPath,
  detailViewPathForPath,
} from "@/lib/view-location";
import { getProjectServiceEndpoint } from "@/lib/project-connection-display";
import {
  applyGlobalNotificationFailureAtom,
  applyGlobalNotificationSuccessAtom,
  beginGlobalNotificationRefreshAtom,
  globalInboxRequestKey,
  globalNotificationResourceAtom,
  mergeGlobalRowsWithPrevious,
  settleGlobalNotificationRefreshAtom,
  type GlobalNotificationRow,
} from "@/stores/globalInbox";
import {
  notificationEffectiveUnread,
  notificationLocalReadStateAtom,
  markNotificationRecordsReadLocalAtom,
} from "@/stores/notifications";
import {
  projectsAtom,
  selectProjectAtom,
  selectedProjectPathAtom,
  selectedSessionIdAtom,
} from "@/stores/projects";

function relativeTime(value: string): string {
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return "";
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (deltaSeconds < 60) return "just now";
  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 7) return `${deltaDays}d ago`;
  return new Date(then).toLocaleDateString();
}

function SwipeReadAction({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      className="mb-2 ml-2 w-24 items-center justify-center rounded-lg border border-emerald-500/40 bg-emerald-500/15 active:opacity-80"
      accessibilityRole="button"
      accessibilityLabel="Read notification"
    >
      <Check size={18} color="#22c55e" />
      <Text className="mt-1 text-xs font-semibold text-emerald-500">Read</Text>
    </Pressable>
  );
}

function GlobalNotificationCard({
  row,
  onOpen,
  onRead,
}: {
  row: GlobalNotificationRow;
  onOpen: (row: GlobalNotificationRow) => void;
  onRead: (row: GlobalNotificationRow) => void;
}) {
  const iconColor = row.notification.unread ? "#f59e0b" : "#a1a1aa";
  const card = (
    <PressableCard
      onPress={() => onOpen(row)}
      className="mb-2 rounded-lg p-3 active:bg-accent/60"
      accessibilityRole="button"
      accessibilityLabel={`Open notification ${row.notification.title}`}
    >
      <View className="flex-row items-start gap-3">
        <View className="mt-0.5 rounded-md border border-border bg-background p-2">
          {row.notification.unread ? (
            <AlertTriangle size={16} color={iconColor} />
          ) : (
            <Bell size={16} color={iconColor} />
          )}
        </View>
        <View className="min-w-0 flex-1">
          <View className="flex-row items-center">
            {row.notification.unread ? (
              <View className="mr-2 h-2 w-2 rounded-full bg-emerald-500" />
            ) : null}
            <Text className="min-w-0 flex-1 text-base font-medium text-foreground">
              {row.notification.title}
            </Text>
          </View>
          <Text className="mt-1 text-xs text-muted-foreground" numberOfLines={1}>
            {row.projectName}
            {row.notification.kind ? ` · ${row.notification.kind}` : ""}
            {relativeTime(row.notification.createdAt)
              ? ` · ${relativeTime(row.notification.createdAt)}`
              : ""}
          </Text>
          <Text className="mt-2 text-sm text-foreground/90" numberOfLines={3}>
            {row.notification.body}
          </Text>
        </View>
      </View>
    </PressableCard>
  );

  if (Platform.OS === "web" || !row.notification.unread) return card;

  return (
    <ReanimatedSwipeable
      friction={2}
      rightThreshold={42}
      overshootRight={false}
      enableTrackpadTwoFingerGesture
      onSwipeableOpen={() => onRead(row)}
      renderRightActions={() => <SwipeReadAction onPress={() => onRead(row)} />}
    >
      {card}
    </ReanimatedSwipeable>
  );
}

function NotificationSection({
  count,
  label,
  rows,
  onOpen,
  onRead,
}: {
  count: number;
  label: string;
  rows: GlobalNotificationRow[];
  onOpen: (row: GlobalNotificationRow) => void;
  onRead: (row: GlobalNotificationRow) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <View className="mb-4">
      <View className="mb-2 flex-row items-center justify-between">
        <Text className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          {label}
        </Text>
        <Text className="text-xs text-muted-foreground">{count}</Text>
      </View>
      {rows.map((row) => (
        <GlobalNotificationCard
          key={`${row.projectPath}:${row.notification.id}`}
          row={row}
          onOpen={onOpen}
          onRead={onRead}
        />
      ))}
    </View>
  );
}

export default function GlobalNotificationsScreen() {
  const router = useRouter();
  const selectProject = useSetAtom(selectProjectAtom);
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const projects = useAtomValue(projectsAtom);
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const [notificationScope, setNotificationScope] = useState<GlobalNotificationScope>("all");
  const { getToken } = useAuth();
  const resource = useAtomValue(globalNotificationResourceAtom);
  const beginRefresh = useSetAtom(beginGlobalNotificationRefreshAtom);
  const applySuccess = useSetAtom(applyGlobalNotificationSuccessAtom);
  const applyFailure = useSetAtom(applyGlobalNotificationFailureAtom);
  const settleRefresh = useSetAtom(settleGlobalNotificationRefreshAtom);
  const readState = useAtomValue(notificationLocalReadStateAtom);
  const markNotificationsReadLocal = useSetAtom(markNotificationRecordsReadLocalAtom);
  const getTokenRef = useRef(getToken);

  const onlineProjects = useMemo(
    () => projects.filter((project) => getProjectServiceEndpoint(project)),
    [projects],
  );
  const onlineProjectKey = useMemo(
    () =>
      onlineProjects
        .map((project) => {
          const endpoint = getProjectServiceEndpoint(project);
          return `${project.path}:${endpoint?.host ?? ""}:${endpoint?.port ?? ""}`;
        })
        .join("|"),
    [onlineProjects],
  );
  const onlineProjectsRef = useRef(onlineProjects);
  const onlineProjectKeyRef = useRef(onlineProjectKey);
  const resourceRef = useRef(resource);
  const rows = useMemo(
    () =>
      (resource.value?.rows ?? [])
        .map((row) => ({
          ...row,
          notification: {
            ...row.notification,
            unread: notificationEffectiveUnread({
              projectPath: row.projectPath,
              notification: row.notification,
              readState,
            }),
          },
        }))
        .sort(sortGlobalNotificationRows),
    [readState, resource.value?.rows],
  );
  const scopeProject = useMemo(
    () => projects.find((project) => project.path === selectedProjectPath) ?? null,
    [projects, selectedProjectPath],
  );
  const scopeProjectPath = scopeProject?.path ?? selectedProjectPath;
  const activeNotificationScope =
    notificationScope === "project" && scopeProjectPath ? notificationScope : "all";
  const visibleRows = useMemo(
    () => filterGlobalNotificationRows(rows, activeNotificationScope, scopeProjectPath),
    [activeNotificationScope, rows, scopeProjectPath],
  );
  const sections = useMemo(() => splitGlobalNotificationRows(visibleRows), [visibleRows]);
  const errors = [...(resource.value?.errors ?? []), ...(resource.error ? [resource.error] : [])];
  const loading = resource.pending;
  const unreadCount = rows.filter((row) => row.notification.unread).length;
  const visibleUnreadCount = sections.unread.length;
  const inboxSubtitle =
    activeNotificationScope === "project" && scopeProject
      ? `${visibleUnreadCount} unread in ${scopeProject.name}`
      : `${visibleUnreadCount} unread across ${onlineProjects.length} online project${
          onlineProjects.length === 1 ? "" : "s"
        }`;
  const projectUnreadCount = rows.filter(
    (row) => row.notification.unread && row.projectPath === scopeProjectPath,
  ).length;
  const scopeOptions = useMemo(() => {
    const options: Array<SegmentOption<GlobalNotificationScope>> = [
      { value: "all", label: "All", count: unreadCount },
    ];
    if (scopeProjectPath) {
      options.push({
        value: "project",
        label: scopeProject?.name ?? "Project",
        count: projectUnreadCount,
      });
    }
    return options;
  }, [projectUnreadCount, scopeProject?.name, scopeProjectPath, unreadCount]);

  useEffect(() => {
    onlineProjectsRef.current = onlineProjects;
    onlineProjectKeyRef.current = onlineProjectKey;
    getTokenRef.current = getToken;
    resourceRef.current = resource;
  }, [getToken, onlineProjectKey, onlineProjects, resource]);

  const hasFetchError = errors.length > 0;

  const refresh = useCallback(async () => {
    const projectSnapshot = onlineProjectsRef.current;
    const requestSourceKey = onlineProjectKeyRef.current;
    const requestKey = globalInboxRequestKey("notifications", requestSourceKey);
    beginRefresh({ requestKey });
    try {
      const token = await getTokenRef.current();
      const results = await Promise.allSettled(
        projectSnapshot.map(async (project) => {
          const endpoint = getProjectServiceEndpoint(project);
          if (!endpoint) return [];
          const feed = await listNotifications(endpoint, { token });
          return feed.notifications
            .filter((notification) => !notification.cleared)
            .map((notification) => ({
              projectName: project.name,
              projectPath: project.path,
              notification,
            }));
        }),
      );
      const nextRows: GlobalNotificationRow[] = [];
      const nextErrors: string[] = [];
      const failedProjectPaths = new Set<string>();
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          nextRows.push(...result.value);
        } else {
          const project = projectSnapshot[index];
          if (project) failedProjectPaths.add(project.path);
          nextErrors.push(`${project?.name ?? "Project"}: ${String(result.reason)}`);
        }
      });
      if (onlineProjectKeyRef.current !== requestSourceKey) {
        settleRefresh({ requestKey });
        return;
      }
      const mergedRows = mergeGlobalRowsWithPrevious(
        resourceRef.current.value?.rows ?? [],
        nextRows,
        failedProjectPaths,
      ).sort(sortGlobalNotificationRows);
      applySuccess({
        requestKey,
        value: {
          rows: mergedRows,
          errors: nextErrors,
          projectCount: projectSnapshot.length,
          fetchedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      if (onlineProjectKeyRef.current !== requestSourceKey) {
        settleRefresh({ requestKey });
        return;
      }
      applyFailure({
        requestKey,
        error: `Unable to refresh inbox: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }, [applyFailure, applySuccess, beginRefresh, settleRefresh]);

  useEffect(() => {
    void refresh();
  }, [onlineProjectKey, refresh]);

  const markRowRead = useCallback(
    (row: GlobalNotificationRow) => {
      markNotificationsReadLocal({ projectPath: row.projectPath, ids: [row.notification.id] });
      void (async () => {
        const project = onlineProjectsRef.current.find((item) => item.path === row.projectPath);
        const endpoint = project ? getProjectServiceEndpoint(project) : null;
        if (!endpoint) return;
        try {
          const token = await getTokenRef.current();
          await markNotificationsRead(endpoint, { id: row.notification.id }, { token });
        } catch {
          // Device-local read state keeps the row settled if the host drops mid-action.
        }
      })();
    },
    [markNotificationsReadLocal],
  );

  function openRow(row: GlobalNotificationRow) {
    markRowRead(row);
    selectProject(row.projectPath);
    const sessionId = row.notification.sessionId;
    if (sessionId) {
      selectSession(sessionId);
      const webHref = detailViewPathForPath("/project", "agent", sessionId, row.projectPath);
      if (Platform.OS === "web" && typeof window !== "undefined") {
        window.location.assign(String(webHref));
        return;
      }
      router.push(detailHrefForPath("/project", "agent", sessionId, row.projectPath));
      return;
    }
    const inboxHref = buildViewPath("/notifications", { project: row.projectPath });
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.location.assign(String(inboxHref));
      return;
    }
    router.push(buildViewHref("/notifications", { project: row.projectPath }));
  }

  return (
    <Page>
      <PageHeader
        eyebrow={
          activeNotificationScope === "project" && scopeProject ? scopeProject.name : "All Projects"
        }
        title="Inbox"
        subtitle={inboxSubtitle}
        actions={
          <Button
            variant="outline"
            size="icon"
            disabled={loading}
            onPress={() => void refresh()}
            accessibilityLabel="Refresh global inbox"
          >
            <RotateCw size={18} color="#fafafa" />
          </Button>
        }
      />

      <SegmentedControl
        options={scopeOptions}
        value={activeNotificationScope}
        onChange={setNotificationScope}
        fullWidth
        className="mb-4"
      />

      {hasFetchError ? (
        <Card className="mb-4 rounded-lg border-amber-500/40 bg-amber-500/10">
          <Text className="text-sm font-semibold text-foreground">Some projects failed</Text>
          <Text className="mt-1 text-xs text-muted-foreground">{errors.join("\n")}</Text>
        </Card>
      ) : null}

      {visibleRows.length === 0 && hasFetchError && !loading ? (
        <PageStateCard
          title="Unable to load inbox"
          body="Fix the failed project connection or refresh to try again."
          tone="warning"
        />
      ) : visibleRows.length === 0 ? (
        <PageStateCard
          title={loading ? "Loading inbox..." : "All caught up"}
          body={
            activeNotificationScope === "project" && scopeProject
              ? `${scopeProject.name} notifications will appear here.`
              : "Project-scoped notifications will appear here as a flattened feed."
          }
        />
      ) : (
        <>
          <NotificationSection
            label="Unread"
            count={sections.unread.length}
            rows={sections.unread}
            onOpen={openRow}
            onRead={markRowRead}
          />
          <NotificationSection
            label="Read"
            count={sections.read.length}
            rows={sections.read}
            onOpen={openRow}
            onRead={markRowRead}
          />
        </>
      )}
    </Page>
  );
}
