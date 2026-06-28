import React, { useCallback, useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useGlobalSearchParams, usePathname, useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { useColorScheme } from "nativewind";
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  ExternalLink,
  GitPullRequest,
  RotateCw,
  ShieldAlert,
  Trash2,
} from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Page, PageHeader } from "@/components/PageLayout";
import { Text } from "@/components/ui/text";
import { clearNotifications, listNotifications, markNotificationsRead } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  buildForYouFeed,
  type ForYouCard,
  type ForYouKind,
  type ForYouSource,
} from "@/lib/for-you-feed";
import { cn } from "@/lib/utils";
import { buildViewHref, cleanSearchValue, detailHrefForPath } from "@/lib/view-location";
import { useRouteProject } from "@/lib/use-route-project";
import { desktopStateFamily } from "@/stores/desktopState";
import {
  kickNotificationFeedRefreshAtom,
  notificationFeedErrorFamily,
  notificationFeedFamily,
} from "@/stores/notifications";
import { selectedSessionIdAtom } from "@/stores/projects";
import {
  clearSecurityEventsAtom,
  markSecurityEventsReadAtom,
  securityEventsAtom,
  securityUnreadCountAtom,
} from "@/stores/security";

const EMPTY_PROJECT_PATH = "__aimux_no_selected_project__";

const LENSES: Array<{ id: ForYouKind | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "action-required", label: "Action" },
  { id: "approval", label: "Approval" },
  { id: "shipped", label: "Shipped" },
  { id: "progress", label: "Progress" },
  { id: "observation", label: "Observe" },
];

function resolveLens(value: string | null): ForYouKind | "all" {
  return LENSES.some((lens) => lens.id === value) ? (value as ForYouKind | "all") : "all";
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

function kindLabel(kind: ForYouKind): string {
  switch (kind) {
    case "action-required":
      return "Action required";
    case "approval":
      return "Approval";
    case "shipped":
      return "Shipped";
    case "progress":
      return "Progress";
    case "observation":
      return "Observation";
  }
}

function sourceLabel(source: ForYouSource): string {
  switch (source) {
    case "notification":
      return "notification";
    case "security":
      return "security";
    case "agent":
      return "agent";
    case "service":
      return "service";
  }
}

function kindTone(kind: ForYouKind): string {
  switch (kind) {
    case "action-required":
      return "border-amber-500/40 bg-amber-500/10";
    case "approval":
      return "border-sky-500/40 bg-sky-500/10";
    case "shipped":
      return "border-emerald-500/40 bg-emerald-500/10";
    case "progress":
      return "border-violet-500/40 bg-violet-500/10";
    case "observation":
      return "border-border bg-card";
  }
}

function KindIcon({ kind, source }: { kind: ForYouKind; source: ForYouSource }) {
  const color =
    kind === "action-required"
      ? "#f59e0b"
      : kind === "approval"
        ? "#38bdf8"
        : kind === "shipped"
          ? "#22c55e"
          : kind === "progress"
            ? "#a78bfa"
            : "#a1a1aa";

  if (source === "security") return <ShieldAlert size={18} color="#f87171" />;
  if (kind === "approval") return <GitPullRequest size={18} color={color} />;
  if (kind === "shipped") return <CheckCircle2 size={18} color={color} />;
  if (kind === "progress") return <Activity size={18} color={color} />;
  return <AlertTriangle size={18} color={color} />;
}

function LensChip({
  label,
  count,
  active,
  onPress,
}: {
  label: string;
  count: number;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        "mr-2 mb-2 flex-row items-center rounded-full border px-3 py-1.5 active:opacity-80",
        active ? "border-foreground bg-foreground" : "border-border bg-card",
      )}
    >
      <Text
        className={cn("text-[12px] font-semibold", active ? "text-background" : "text-foreground")}
      >
        {label}
      </Text>
      <Text
        className={cn(
          "ml-1.5 text-[11px] font-bold",
          active ? "text-background/70" : "text-muted-foreground",
        )}
      >
        {count}
      </Text>
    </Pressable>
  );
}

function ForYouCardRow({
  card,
  busy,
  onOpen,
  onRead,
  onClear,
}: {
  card: ForYouCard;
  busy: boolean;
  onOpen: (card: ForYouCard) => void;
  onRead: (card: ForYouCard) => void;
  onClear: (card: ForYouCard) => void;
}) {
  const { colorScheme } = useColorScheme();
  const foregroundIconColor = colorScheme === "dark" ? "#fafafa" : "#09090b";
  const canOpen = Boolean(card.sessionId || card.serviceId);
  const canMutateNotification = Boolean(card.notificationId);

  return (
    <Card className={cn("mb-3 rounded-lg p-4", kindTone(card.kind), card.unread && "bg-secondary")}>
      <View className="flex-row items-start">
        <View className="mr-3 mt-0.5 rounded-full bg-background/60 p-2">
          <KindIcon kind={card.kind} source={card.source} />
        </View>
        <View className="min-w-0 flex-1">
          <View className="flex-row items-center">
            {card.unread ? <View className="mr-2 h-2 w-2 rounded-full bg-emerald-500" /> : null}
            <Text
              className="min-w-0 flex-1 text-[15px] font-semibold text-foreground"
              numberOfLines={2}
            >
              {card.title}
            </Text>
          </View>
          {card.body ? (
            <Text className="mt-2 text-[13px] leading-snug text-foreground/90">{card.body}</Text>
          ) : null}
          <Text className="mt-3 text-[11px] uppercase tracking-widest text-muted-foreground">
            {kindLabel(card.kind)}
            {` · ${sourceLabel(card.source)}`}
            {card.subtitle ? ` · ${card.subtitle}` : ""}
            {relativeTime(card.createdAt) ? ` · ${relativeTime(card.createdAt)}` : ""}
          </Text>
        </View>
      </View>

      <View className="mt-4 flex-row flex-wrap gap-2">
        {canOpen ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onPress={() => onOpen(card)}
            className="gap-1.5"
          >
            <ExternalLink size={14} color={foregroundIconColor} />
            <Text className="text-sm font-medium text-foreground">Open</Text>
          </Button>
        ) : null}
        {canMutateNotification && card.unread ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onPress={() => onRead(card)}
            className="gap-1.5"
          >
            <Check size={14} color={foregroundIconColor} />
            <Text className="text-sm font-medium text-foreground">Read</Text>
          </Button>
        ) : null}
        {canMutateNotification ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onPress={() => onClear(card)}
            className="gap-1.5"
          >
            <Trash2 size={14} color="#a1a1aa" />
            <Text className="text-sm font-medium text-muted-foreground">Clear</Text>
          </Button>
        ) : null}
      </View>
    </Card>
  );
}

export default function NotificationsScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const { colorScheme } = useColorScheme();
  const foregroundIconColor = colorScheme === "dark" ? "#fafafa" : "#09090b";
  const { project, projectPath, endpoint } = useRouteProject();
  const projectPathKey = projectPath ?? EMPTY_PROJECT_PATH;
  const feed = useAtomValue(notificationFeedFamily(projectPathKey));
  const feedError = useAtomValue(notificationFeedErrorFamily(projectPathKey));
  const desktopState = useAtomValue(desktopStateFamily(projectPathKey));
  const setFeed = useSetAtom(notificationFeedFamily(projectPathKey));
  const setFeedError = useSetAtom(notificationFeedErrorFamily(projectPathKey));
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const kickRefresh = useSetAtom(kickNotificationFeedRefreshAtom);
  const securityEvents = useAtomValue(securityEventsAtom);
  const securityUnreadCount = useAtomValue(securityUnreadCountAtom);
  const markSecurityEventsRead = useSetAtom(markSecurityEventsReadAtom);
  const clearSecurityEvents = useSetAtom(clearSecurityEventsAtom);
  const { getToken } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const searchParams = useGlobalSearchParams<{ lens?: string | string[] }>();
  const lens = resolveLens(cleanSearchValue(searchParams.lens));

  const notificationRecords = useMemo(() => feed?.notifications ?? [], [feed?.notifications]);
  const forYou = useMemo(
    () =>
      buildForYouFeed({
        notifications: notificationRecords,
        securityEvents,
        desktopState,
      }),
    [desktopState, notificationRecords, securityEvents],
  );
  const visibleCards =
    lens === "all" ? forYou.cards : forYou.cards.filter((card) => card.kind === lens);
  const unreadCount = feed?.unreadCount ?? 0;
  const lastUpdated = feed?.fetchedAt ? relativeTime(feed.fetchedAt) : "";
  const hasNotifications = notificationRecords.length > 0;
  const hasSecurityEvents = securityEvents.length > 0;

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

  async function openCard(card: ForYouCard) {
    if (card.notificationId && card.unread) {
      await mutate(`open:${card.notificationId}`, "read", { id: card.notificationId });
    }
    if (card.sessionId) {
      selectSession(card.sessionId);
      router.push(detailHrefForPath(pathname, "agent", card.sessionId, projectPath));
    } else if (card.serviceId) {
      router.push(detailHrefForPath(pathname, "service", card.serviceId, projectPath));
    }
  }

  return (
    <Page>
      <PageHeader
        eyebrow="For You"
        title="Attention Feed"
        subtitle={
          project
            ? `${project.name}${project.path ? ` · ${project.path}` : ""}`
            : "Select a project to view attention items"
        }
        actions={
          <Button
            variant="outline"
            size="icon"
            disabled={!endpoint || busy === "refresh"}
            onPress={refresh}
            accessibilityLabel="Refresh attention feed"
          >
            <RotateCw size={18} color={foregroundIconColor} />
          </Button>
        }
      />

      <View className="mb-4 flex-row flex-wrap">
        {LENSES.map((item) => (
          <LensChip
            key={item.id}
            label={item.label}
            count={item.id === "all" ? forYou.cards.length : forYou.counts[item.id]}
            active={lens === item.id}
            onPress={() =>
              router.replace(
                buildViewHref("/notifications", {
                  project: projectPath ?? undefined,
                  lens: item.id,
                }),
              )
            }
          />
        ))}
      </View>

      <View className="mb-4 flex-row flex-wrap items-center gap-2">
        {hasSecurityEvents ? (
          <View className="rounded-full border border-red-500/40 bg-red-950/20 px-3 py-1.5">
            <Text className="text-xs font-medium text-foreground">
              {securityUnreadCount} security unread
            </Text>
          </View>
        ) : null}
        <View className="rounded-full border border-border bg-card px-3 py-1.5">
          <Text className="text-xs font-medium text-foreground">
            {unreadCount} {unreadCount === 1 ? "notification" : "notifications"} unread
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
          <Check size={14} color={foregroundIconColor} />
          <Text className="text-sm font-medium text-foreground">Read notifications</Text>
        </Button>
        {hasSecurityEvents ? (
          <Button
            variant="outline"
            size="sm"
            disabled={securityUnreadCount === 0}
            onPress={() => markSecurityEventsRead()}
            className="gap-1.5"
          >
            <ShieldAlert size={14} color={foregroundIconColor} />
            <Text className="text-sm font-medium text-foreground">Read security</Text>
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          disabled={!endpoint || !hasNotifications || busy !== null}
          onPress={() => void mutate("clear-all", "clear")}
          className="gap-1.5"
        >
          <Trash2 size={14} color="#a1a1aa" />
          <Text className="text-sm font-medium text-muted-foreground">Clear notifications</Text>
        </Button>
        {hasSecurityEvents ? (
          <Button
            variant="ghost"
            size="sm"
            onPress={() => clearSecurityEvents()}
            className="gap-1.5"
          >
            <Trash2 size={14} color="#a1a1aa" />
            <Text className="text-sm font-medium text-muted-foreground">Clear security</Text>
          </Button>
        ) : null}
      </View>

      {feedError ? (
        <Card className="mb-4 rounded-lg border-destructive/50 bg-destructive/10">
          <Text className="text-sm font-semibold text-foreground">Attention feed failed</Text>
          <Text className="mt-1 text-xs text-muted-foreground">{feedError}</Text>
        </Card>
      ) : null}

      {!project ? (
        <Card className="rounded-lg p-5">
          <Text className="text-base font-semibold text-foreground">No project selected</Text>
          <Text className="mt-1 text-sm text-muted-foreground">
            Pick a project from the sidebar to see its attention feed.
          </Text>
        </Card>
      ) : visibleCards.length > 0 ? (
        visibleCards.map((card) => (
          <ForYouCardRow
            key={card.id}
            card={card}
            busy={busy !== null}
            onOpen={(item) => void openCard(item)}
            onRead={(item) =>
              item.notificationId
                ? void mutate(`read:${item.notificationId}`, "read", { id: item.notificationId })
                : undefined
            }
            onClear={(item) =>
              item.notificationId
                ? void mutate(`clear:${item.notificationId}`, "clear", {
                    id: item.notificationId,
                  })
                : undefined
            }
          />
        ))
      ) : !endpoint ? (
        <Card className="rounded-lg p-5">
          <Text className="text-base font-semibold text-foreground">Project host offline</Text>
          <Text className="mt-1 text-sm text-muted-foreground">
            Start the project host to load attention items.
          </Text>
        </Card>
      ) : !feed ? (
        <Card className="rounded-lg p-5">
          <Text className="text-base font-semibold text-foreground">Loading feed...</Text>
        </Card>
      ) : (
        <Card className="rounded-lg p-5">
          <Text className="text-base font-semibold text-foreground">All caught up</Text>
          <Text className="mt-1 text-sm text-muted-foreground">
            New agent activity, approvals, security alerts, and shipped work will appear here.
          </Text>
        </Card>
      )}
    </Page>
  );
}
