import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { CheckCircle2, CircleAlert, Clock, RefreshCw } from "lucide-react-native";
import { useColorScheme } from "nativewind";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import {
  getCoordinationWorklist,
  type CoordinationBucket,
  type CoordinationReachability,
  type CoordinationWorklistItem,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useProjectApiRelayPolling } from "@/lib/project-api-relay-polling";
import { buildViewHref, detailHrefForPath } from "@/lib/view-location";
import { projectApiViewRefreshNonceAtom } from "@/stores/projectViews";
import {
  selectedProjectAtom,
  selectedProjectEndpointAtom,
  selectedSessionIdAtom,
} from "@/stores/projects";

function reachabilityLabel(reachability: CoordinationReachability): string {
  switch (reachability) {
    case "live":
      return "live";
    case "offline":
      return "offline";
    case "missing":
      return "missing";
    case "none":
      return "project";
  }
}

function bucketTone(bucket: CoordinationBucket): string {
  switch (bucket) {
    case "awake":
      return "#f59e0b";
    case "asleep":
      return "#38bdf8";
    case "unreachable":
      return "#71717a";
    case "handled":
      return "#22c55e";
  }
}

function threadIdFor(item: CoordinationWorklistItem): string | null {
  const thread = item.thread?.["thread"];
  if (thread && typeof thread === "object" && "id" in thread) {
    const id = (thread as { id?: unknown }).id;
    return typeof id === "string" && id.trim() ? id : null;
  }
  return null;
}

function WorklistRow({ item, onPress }: { item: CoordinationWorklistItem; onPress: () => void }) {
  const color = bucketTone(item.bucket);
  const Icon = item.actionable ? CircleAlert : item.stale ? Clock : CheckCircle2;
  return (
    <Pressable onPress={onPress} className="border-b border-border px-4 py-3 active:bg-accent">
      <View className="flex-row items-start">
        <View className="mr-3 rounded-full bg-secondary p-2">
          <Icon size={16} color={color} />
        </View>
        <View className="min-w-0 flex-1">
          <View className="flex-row items-center">
            <Text className="flex-1 text-[14px] font-semibold text-foreground" numberOfLines={2}>
              {item.title}
            </Text>
            <View className="ml-2 h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
          </View>
          <Text className="mt-1 text-[11px] uppercase tracking-widest text-muted-foreground">
            {[item.kind, item.type, item.bucket, reachabilityLabel(item.reachability)]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          {item.when ? (
            <Text className="mt-1 text-[11px] text-muted-foreground">{item.when}</Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

function WorklistSection({
  title,
  items,
  onPressItem,
}: {
  title: string;
  items: CoordinationWorklistItem[];
  onPressItem: (item: CoordinationWorklistItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <View className="mb-5">
      <Text className="mb-2 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
        {title}
      </Text>
      <Card className="overflow-hidden rounded-xl p-0">
        {items.map((item) => (
          <WorklistRow key={item.key} item={item} onPress={() => onPressItem(item)} />
        ))}
      </Card>
    </View>
  );
}

export default function CoordinationScreen() {
  const { colorScheme } = useColorScheme();
  const foregroundIconColor = colorScheme === "dark" ? "#fafafa" : "#09090b";
  const project = useAtomValue(selectedProjectAtom);
  const endpoint = useAtomValue(selectedProjectEndpointAtom);
  const refreshNonce = useAtomValue(projectApiViewRefreshNonceAtom);
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const { getToken } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const endpointKey = endpoint ? `${endpoint.host}:${endpoint.port}` : null;
  const viewKey = endpointKey ? `${project?.path ?? ""}|${endpointKey}` : null;
  const [items, setItems] = useState<CoordinationWorklistItem[]>([]);
  const [itemsKey, setItemsKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpointRef = useRef(endpoint);
  const viewKeyRef = useRef(viewKey);
  const getTokenRef = useRef(getToken);
  const refreshSeqRef = useRef(0);

  useEffect(() => {
    endpointRef.current = endpoint;
    viewKeyRef.current = viewKey;
    getTokenRef.current = getToken;
  }, [endpoint, getToken, viewKey]);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    const currentEndpoint = endpointRef.current;
    const currentViewKey = viewKeyRef.current;
    if (!currentEndpoint) {
      setItems([]);
      setItemsKey(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const token = await getTokenRef.current();
      const response = await getCoordinationWorklist(currentEndpoint, "user", { token });
      if (seq !== refreshSeqRef.current) return;
      setItems(response.worklist.items);
      setItemsKey(currentViewKey);
      setError(null);
    } catch (err) {
      if (seq !== refreshSeqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === refreshSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void refresh();
    }, 0);
    return () => clearTimeout(timer);
  }, [endpointKey, refreshNonce, refresh]);

  useProjectApiRelayPolling(endpointKey, refresh);

  const visibleItems = useMemo(
    () => (itemsKey === viewKey ? items : []),
    [items, itemsKey, viewKey],
  );
  const needsYou = useMemo(() => visibleItems.filter((item) => item.actionable), [visibleItems]);
  const tail = useMemo(() => visibleItems.filter((item) => !item.actionable), [visibleItems]);

  function handlePressItem(item: CoordinationWorklistItem) {
    if (item.sessionId) {
      selectSession(item.sessionId);
      router.push(detailHrefForPath(pathname, "agent", item.sessionId, project?.path));
      return;
    }
    const threadId = threadIdFor(item);
    if (threadId) {
      router.push(buildViewHref("/threads", { project: project?.path, threadId }));
      return;
    }
    router.push(buildViewHref("/notifications", { project: project?.path }));
  }

  return (
    <Page>
      <PageHeader
        eyebrow="Project"
        title="Coordination"
        subtitle={
          project
            ? `${project.name}${project.path ? ` · ${project.path}` : ""}`
            : "No project selected"
        }
        actions={
          <Button
            variant="outline"
            size="icon"
            disabled={!endpoint || loading}
            onPress={() => void refresh()}
            accessibilityLabel="Refresh coordination"
          >
            <RefreshCw size={18} color={foregroundIconColor} />
          </Button>
        }
      />

      {!project ? (
        <PageStateCard title="No project selected" body="Pick a project from the sidebar." />
      ) : !endpoint ? (
        <PageStateCard
          title="Project host offline"
          body="Start the project host to load coordination."
        />
      ) : error ? (
        <PageStateCard title="Coordination failed" body={error} tone="danger" />
      ) : visibleItems.length === 0 ? (
        <PageStateCard
          title={loading ? "Loading coordination..." : "Nothing needs you"}
          body="Agent asks, handoffs, reviews, and waiting threads will appear here."
        />
      ) : (
        <View>
          <View className="mb-5 flex-row flex-wrap">
            <Card className="mr-2 mb-2 min-w-[128px] flex-1 rounded-lg p-3">
              <Text className="text-[22px] font-bold leading-tight text-foreground">
                {needsYou.length}
              </Text>
              <Text className="mt-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Needs You
              </Text>
            </Card>
            <Card className="mr-2 mb-2 min-w-[128px] flex-1 rounded-lg p-3">
              <Text className="text-[22px] font-bold leading-tight text-foreground">
                {tail.length}
              </Text>
              <Text className="mt-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Later
              </Text>
            </Card>
          </View>
          <WorklistSection title="Needs You" items={needsYou} onPressItem={handlePressItem} />
          <WorklistSection title="Later" items={tail} onPressItem={handlePressItem} />
        </View>
      )}
    </Page>
  );
}
