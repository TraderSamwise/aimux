import React, { useCallback, useEffect, useMemo, useRef } from "react";
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
import { useSerializedProjectApiRefresh } from "@/lib/project-api-refresh";
import { useRouteProject } from "@/lib/use-route-project";
import { buildViewHref, detailHrefForPath } from "@/lib/view-location";
import {
  applyCoordinationWorklistFailureAtom,
  applyCoordinationWorklistSuccessAtom,
  beginCoordinationWorklistRefreshAtom,
  clearCoordinationWorklistResourceAtom,
  coordinationWorklistResourceFamily,
  isCurrentCoordinationWorklistRequest,
  type CoordinationWorklistRequestScope,
} from "@/stores/coordination";
import { projectApiViewRefreshNonceFamily } from "@/stores/projectViews";
import { selectedSessionIdAtom } from "@/stores/projects";

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
  const { project, projectPath, endpoint, projectLoading } = useRouteProject();
  const projectPathKey = projectPath ?? "__aimux_no_selected_project__";
  const refreshNonce = useAtomValue(projectApiViewRefreshNonceFamily("coordination-worklist"));
  const resource = useAtomValue(coordinationWorklistResourceFamily(projectPathKey));
  const beginCoordinationWorklistRefresh = useSetAtom(beginCoordinationWorklistRefreshAtom);
  const applyCoordinationWorklistSuccess = useSetAtom(applyCoordinationWorklistSuccessAtom);
  const applyCoordinationWorklistFailure = useSetAtom(applyCoordinationWorklistFailureAtom);
  const clearCoordinationWorklistResource = useSetAtom(clearCoordinationWorklistResourceAtom);
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const { getToken } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const endpointKey = endpoint ? `${endpoint.host}:${endpoint.port}` : null;
  const endpointRef = useRef(endpoint);
  const endpointKeyRef = useRef(endpointKey);
  const projectPathRef = useRef(projectPathKey);
  const getTokenRef = useRef(getToken);
  const refreshSeqRef = useRef(0);
  const refreshGenerationRef = useRef(0);
  const requestScopeRef = useRef<CoordinationWorklistRequestScope>({
    projectPath: projectPathKey,
    endpointKey,
    generation: 0,
  });

  useEffect(() => {
    endpointRef.current = endpoint;
    getTokenRef.current = getToken;
  }, [endpoint, getToken]);

  useEffect(() => {
    refreshGenerationRef.current += 1;
    endpointKeyRef.current = endpointKey;
    projectPathRef.current = projectPathKey;
    requestScopeRef.current = {
      projectPath: projectPathKey,
      endpointKey,
      generation: refreshGenerationRef.current,
    };
  }, [endpointKey, projectPathKey]);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    const currentEndpoint = endpointRef.current;
    const currentProjectPath = projectPathRef.current;
    const requestScope = {
      projectPath: currentProjectPath,
      endpointKey: endpointKeyRef.current,
      generation: refreshGenerationRef.current,
    };
    if (!currentEndpoint) {
      clearCoordinationWorklistResource(currentProjectPath);
      return;
    }
    beginCoordinationWorklistRefresh(currentProjectPath);
    try {
      const token = await getTokenRef.current();
      const response = await getCoordinationWorklist(currentEndpoint, "user", { token });
      if (seq !== refreshSeqRef.current) return;
      if (!isCurrentCoordinationWorklistRequest(requestScope, requestScopeRef.current)) return;
      applyCoordinationWorklistSuccess({
        projectPath: currentProjectPath,
        worklist: {
          items: response.worklist.items,
          fetchedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      if (seq !== refreshSeqRef.current) return;
      if (!isCurrentCoordinationWorklistRequest(requestScope, requestScopeRef.current)) return;
      applyCoordinationWorklistFailure({
        projectPath: currentProjectPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [
    applyCoordinationWorklistFailure,
    applyCoordinationWorklistSuccess,
    beginCoordinationWorklistRefresh,
    clearCoordinationWorklistResource,
  ]);
  const serializedRefresh = useSerializedProjectApiRefresh(refresh);

  useEffect(() => {
    const timer = setTimeout(() => {
      void serializedRefresh();
    }, 0);
    return () => clearTimeout(timer);
  }, [endpointKey, projectPathKey, refreshNonce, serializedRefresh]);

  const visibleItems = useMemo(() => resource.value?.items ?? [], [resource.value?.items]);
  const visibleError = resource.error;
  const needsYou = useMemo(() => visibleItems.filter((item) => item.actionable), [visibleItems]);
  const tail = useMemo(() => visibleItems.filter((item) => !item.actionable), [visibleItems]);

  function handlePressItem(item: CoordinationWorklistItem) {
    if (item.sessionId) {
      selectSession(item.sessionId);
      router.push(detailHrefForPath(pathname, "agent", item.sessionId, projectPath));
      return;
    }
    const threadId = threadIdFor(item);
    if (threadId) {
      router.push(buildViewHref("/threads", { project: projectPath, threadId }));
      return;
    }
    router.push(buildViewHref("/notifications", { project: projectPath }));
  }

  return (
    <Page>
      <PageHeader
        eyebrow="Project"
        title="Coordination"
        subtitle={
          project
            ? `${project.name}${project.path ? ` · ${project.path}` : ""}`
            : projectLoading
              ? `Loading ${projectPath}`
              : "No project selected"
        }
        actions={
          <Button
            variant="outline"
            size="icon"
            disabled={!endpoint || resource.pending}
            onPress={() => void serializedRefresh()}
            accessibilityLabel="Refresh coordination"
          >
            <RefreshCw size={18} color={foregroundIconColor} />
          </Button>
        }
      />

      {projectLoading ? (
        <PageStateCard title="Loading project..." body="Fetching project state from the daemon." />
      ) : !project ? (
        <PageStateCard title="No project selected" body="Pick a project from the sidebar." />
      ) : !endpoint ? (
        <PageStateCard
          title="Project host offline"
          body="Start the project host to load coordination."
        />
      ) : visibleError && !resource.value && !resource.pending ? (
        <PageStateCard title="Coordination failed" body={visibleError} tone="danger" />
      ) : visibleItems.length === 0 ? (
        <PageStateCard
          title={resource.pending ? "Loading coordination..." : "Nothing needs you"}
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
