import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { AlertTriangle, Bell, RotateCw } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { Text } from "@/components/ui/text";
import { listNotifications, type NotificationRecord } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { buildViewHref } from "@/lib/view-location";
import { getProjectServiceEndpoint } from "@/lib/project-connection-display";
import { projectsAtom, selectedSessionIdAtom } from "@/stores/projects";

interface GlobalNotificationRow {
  projectName: string;
  projectPath: string;
  notification: NotificationRecord;
}

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

function sortNotificationRows(a: GlobalNotificationRow, b: GlobalNotificationRow): number {
  if (a.notification.unread !== b.notification.unread) return a.notification.unread ? -1 : 1;
  const aTime = Date.parse(a.notification.createdAt);
  const bTime = Date.parse(b.notification.createdAt);
  return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
}

export default function GlobalNotificationsScreen() {
  const router = useRouter();
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const projects = useAtomValue(projectsAtom);
  const { getToken } = useAuth();
  const [rows, setRows] = useState<GlobalNotificationRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
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
  const refreshSeqRef = useRef(0);
  const unreadCount = rows.filter((row) => row.notification.unread).length;

  useEffect(() => {
    onlineProjectsRef.current = onlineProjects;
    getTokenRef.current = getToken;
  }, [getToken, onlineProjects]);

  const hasFetchError = errors.length > 0;

  const refresh = useCallback(async () => {
    const requestId = ++refreshSeqRef.current;
    const projectSnapshot = onlineProjectsRef.current;
    setLoading(true);
    setErrors([]);
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
      results.forEach((result, index) => {
        if (result.status === "fulfilled") {
          nextRows.push(...result.value);
        } else {
          nextErrors.push(`${projectSnapshot[index]?.name ?? "Project"}: ${String(result.reason)}`);
        }
      });
      if (refreshSeqRef.current !== requestId) return;
      nextRows.sort(sortNotificationRows);
      setRows(nextRows);
      setErrors(nextErrors);
    } catch (error) {
      if (refreshSeqRef.current !== requestId) return;
      setErrors([
        `Unable to refresh inbox: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    } finally {
      if (refreshSeqRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [onlineProjectKey, refresh]);

  function openRow(row: GlobalNotificationRow) {
    const sessionId = row.notification.sessionId;
    if (sessionId) {
      selectSession(sessionId);
      router.navigate(
        buildViewHref(`/notifications/agent/${encodeURIComponent(sessionId)}/chat`, {
          project: row.projectPath,
        }),
      );
      return;
    }
    router.navigate(buildViewHref("/notifications", { project: row.projectPath }));
  }

  return (
    <Page>
      <PageHeader
        eyebrow="All Projects"
        title="Inbox"
        subtitle={`${unreadCount} unread across ${onlineProjects.length} online project${
          onlineProjects.length === 1 ? "" : "s"
        }`}
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

      {hasFetchError ? (
        <Card className="mb-4 rounded-lg border-amber-500/40 bg-amber-500/10">
          <Text className="text-sm font-semibold text-foreground">Some projects failed</Text>
          <Text className="mt-1 text-xs text-muted-foreground">{errors.join("\n")}</Text>
        </Card>
      ) : null}

      {rows.length === 0 && hasFetchError && !loading ? (
        <PageStateCard
          title="Unable to load inbox"
          body="Fix the failed project connection or refresh to try again."
          tone="warning"
        />
      ) : rows.length === 0 ? (
        <PageStateCard
          title={loading ? "Loading inbox..." : "All caught up"}
          body="Project-scoped notifications will appear here as a flattened feed."
        />
      ) : (
        rows.map((row) => {
          const iconColor = row.notification.unread ? "#f59e0b" : "#a1a1aa";
          return (
            <Pressable
              key={`${row.projectPath}:${row.notification.id}`}
              onPress={() => openRow(row)}
              className="mb-2"
            >
              <Card className="rounded-lg p-3 active:bg-accent/60">
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
              </Card>
            </Pressable>
          );
        })
      )}
    </Page>
  );
}
