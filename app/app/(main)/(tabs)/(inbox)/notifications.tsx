import React, { useCallback, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Check, ExternalLink, RotateCw, Trash2 } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import {
  clearNotifications,
  listNotifications,
  markNotificationsRead,
  type NotificationRecord,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import {
  kickNotificationFeedRefreshAtom,
  notificationFeedErrorFamily,
  notificationFeedFamily,
} from "@/stores/notifications";
import {
  selectedProjectAtom,
  selectedProjectEndpointAtom,
  selectedProjectPathAtom,
  selectedSessionIdAtom,
} from "@/stores/projects";

const EMPTY_PROJECT_PATH = "__aimux_no_selected_project__";

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

function kindLabel(record: NotificationRecord): string {
  return record.kind?.replace(/_/g, " ") || record.targetKind || "notification";
}

function notificationTitle(record: NotificationRecord): string {
  return record.title || record.subtitle || "aimux";
}

function NotificationRow({
  record,
  busy,
  onOpen,
  onRead,
  onClear,
}: {
  record: NotificationRecord;
  busy: boolean;
  onOpen: (record: NotificationRecord) => void;
  onRead: (record: NotificationRecord) => void;
  onClear: (record: NotificationRecord) => void;
}) {
  const canOpen = Boolean(record.sessionId);
  return (
    <Card
      className={cn(
        "mb-3 rounded-lg p-4",
        record.unread ? "border-emerald-500/40 bg-secondary" : "bg-card",
      )}
    >
      <View className="flex-row items-start">
        <View className="flex-1 min-w-0 pr-3">
          <View className="flex-row items-center">
            {record.unread ? <View className="mr-2 h-2 w-2 rounded-full bg-emerald-500" /> : null}
            <Text
              className="flex-1 min-w-0 text-[15px] font-semibold text-foreground"
              numberOfLines={2}
            >
              {notificationTitle(record)}
            </Text>
          </View>
          {record.subtitle ? (
            <Text className="mt-1 text-[12px] text-muted-foreground" numberOfLines={1}>
              {record.subtitle}
            </Text>
          ) : null}
          {record.body ? (
            <Text className="mt-2 text-[13px] leading-snug text-foreground/90">{record.body}</Text>
          ) : null}
          <Text className="mt-3 text-[11px] uppercase tracking-widest text-muted-foreground">
            {kindLabel(record)}
            {record.sessionId ? ` · ${record.sessionId}` : ""}
            {relativeTime(record.createdAt) ? ` · ${relativeTime(record.createdAt)}` : ""}
          </Text>
        </View>
      </View>
      <View className="mt-4 flex-row flex-wrap gap-2">
        {canOpen ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onPress={() => onOpen(record)}
            className="gap-1.5"
          >
            <ExternalLink size={14} color="#fafafa" />
            <Text className="text-sm font-medium text-foreground">Open</Text>
          </Button>
        ) : null}
        {record.unread ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onPress={() => onRead(record)}
            className="gap-1.5"
          >
            <Check size={14} color="#fafafa" />
            <Text className="text-sm font-medium text-foreground">Read</Text>
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onPress={() => onClear(record)}
          className="gap-1.5"
        >
          <Trash2 size={14} color="#a1a1aa" />
          <Text className="text-sm font-medium text-muted-foreground">Clear</Text>
        </Button>
      </View>
    </Card>
  );
}

export default function NotificationsScreen() {
  const router = useRouter();
  const project = useAtomValue(selectedProjectAtom);
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const endpoint = useAtomValue(selectedProjectEndpointAtom);
  const projectPathKey = selectedProjectPath ?? EMPTY_PROJECT_PATH;
  const feed = useAtomValue(notificationFeedFamily(projectPathKey));
  const feedError = useAtomValue(notificationFeedErrorFamily(projectPathKey));
  const setFeed = useSetAtom(notificationFeedFamily(projectPathKey));
  const setFeedError = useSetAtom(notificationFeedErrorFamily(projectPathKey));
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const kickRefresh = useSetAtom(kickNotificationFeedRefreshAtom);
  const { getToken } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);

  const unreadCount = feed?.unreadCount ?? 0;
  const lastUpdated = feed?.fetchedAt ? relativeTime(feed.fetchedAt) : "";

  const groupedNotifications = useMemo(() => {
    const notifications = feed?.notifications ?? [];
    return [...notifications].sort((a, b) => {
      if (a.unread !== b.unread) return a.unread ? -1 : 1;
      const bTime = Date.parse(b.createdAt);
      const aTime = Date.parse(a.createdAt);
      return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
    });
  }, [feed?.notifications]);
  const hasNotifications = groupedNotifications.length > 0;

  const refresh = useCallback(async () => {
    if (!endpoint) return;
    setBusy("refresh");
    try {
      const token = await getToken();
      const next = await listNotifications(endpoint, { token });
      setFeed({
        notifications: next.notifications,
        unreadCount: next.unreadCount,
        fetchedAt: new Date().toISOString(),
      });
      setFeedError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFeedError(msg);
    } finally {
      setBusy(null);
    }
  }, [endpoint, getToken, setFeed, setFeedError]);

  const mutate = useCallback(
    async (
      key: string,
      action: "read" | "clear",
      input: { id?: string; sessionId?: string } = {},
    ) => {
      if (!endpoint) return;
      setBusy(key);
      try {
        const token = await getToken();
        if (action === "read") {
          await markNotificationsRead(endpoint, input, { token });
        } else {
          await clearNotifications(endpoint, input, { token });
        }
        const next = await listNotifications(endpoint, { token });
        setFeed({
          notifications: next.notifications,
          unreadCount: next.unreadCount,
          fetchedAt: new Date().toISOString(),
        });
        setFeedError(null);
        kickRefresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setFeedError(msg);
      } finally {
        setBusy(null);
      }
    },
    [endpoint, getToken, kickRefresh, setFeed, setFeedError],
  );

  async function openNotification(record: NotificationRecord) {
    if (!record.sessionId) return;
    if (record.unread) await mutate(`open:${record.id}`, "read", { id: record.id });
    selectSession(record.sessionId);
    router.push({
      pathname: "/agent/[sessionId]/chat",
      params: { sessionId: record.sessionId },
    });
  }

  return (
    <ScrollView className="flex-1 bg-background" contentContainerClassName="px-4 py-5 md:px-8">
      <View className="mx-auto w-full max-w-3xl">
        <View className="mb-5 flex-row items-start justify-between gap-3">
          <View className="flex-1 min-w-0">
            <Text className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
              Notifications
            </Text>
            <Text className="mt-1 text-2xl font-bold text-foreground">Inbox</Text>
            <Text className="mt-1 text-sm text-muted-foreground" numberOfLines={2}>
              {project ? project.name : "Select a project to view notifications"}
              {project?.path ? ` · ${project.path}` : ""}
            </Text>
          </View>
          <Button
            variant="outline"
            size="icon"
            disabled={!endpoint || busy === "refresh"}
            onPress={refresh}
            accessibilityLabel="Refresh notifications"
          >
            <RotateCw size={18} color="#fafafa" />
          </Button>
        </View>

        <View className="mb-4 flex-row flex-wrap items-center gap-2">
          <View className="rounded-full border border-border bg-card px-3 py-1.5">
            <Text className="text-xs font-medium text-foreground">
              {unreadCount} unread
              {lastUpdated ? ` · updated ${lastUpdated}` : ""}
            </Text>
          </View>
          <Button
            variant="outline"
            size="sm"
            disabled={!endpoint || unreadCount === 0 || busy !== null}
            onPress={() => void mutate("read-all", "read")}
            className="gap-1.5"
          >
            <Check size={14} color="#fafafa" />
            <Text className="text-sm font-medium text-foreground">Mark all read</Text>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!endpoint || !hasNotifications || busy !== null}
            onPress={() => void mutate("clear-all", "clear")}
            className="gap-1.5"
          >
            <Trash2 size={14} color="#a1a1aa" />
            <Text className="text-sm font-medium text-muted-foreground">Clear all</Text>
          </Button>
        </View>

        {feedError ? (
          <Card className="mb-4 rounded-lg border-destructive/50 bg-destructive/10">
            <Text className="text-sm font-semibold text-foreground">Notification feed failed</Text>
            <Text className="mt-1 text-xs text-muted-foreground">{feedError}</Text>
          </Card>
        ) : null}

        {!project ? (
          <Card className="rounded-lg p-5">
            <Text className="text-base font-semibold text-foreground">No project selected</Text>
            <Text className="mt-1 text-sm text-muted-foreground">
              Pick a project from the sidebar to see its notification inbox.
            </Text>
          </Card>
        ) : !endpoint ? (
          <Card className="rounded-lg p-5">
            <Text className="text-base font-semibold text-foreground">Project host offline</Text>
            <Text className="mt-1 text-sm text-muted-foreground">
              Start the project host to load notifications.
            </Text>
          </Card>
        ) : !feed ? (
          <Card className="rounded-lg p-5">
            <Text className="text-base font-semibold text-foreground">Loading inbox...</Text>
          </Card>
        ) : groupedNotifications.length === 0 ? (
          <Card className="rounded-lg p-5">
            <Text className="text-base font-semibold text-foreground">No notifications</Text>
            <Text className="mt-1 text-sm text-muted-foreground">
              New agent activity will appear here.
            </Text>
          </Card>
        ) : (
          groupedNotifications.map((record) => (
            <NotificationRow
              key={record.id}
              record={record}
              busy={busy !== null}
              onOpen={(item) => void openNotification(item)}
              onRead={(item) => void mutate(`read:${item.id}`, "read", { id: item.id })}
              onClear={(item) => void mutate(`clear:${item.id}`, "clear", { id: item.id })}
            />
          ))
        )}
      </View>
    </ScrollView>
  );
}
