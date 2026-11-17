import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { projectStateKey } from "@/lib/project-key";
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
import { StoryList, TaskList, TaskProgress } from "@/components/project-activity";
import { isOpenTask } from "@/lib/project-observability";
import { createProjectResourceRequestTracker } from "@/lib/project-resource-request-tracker";
import {
  emptyProjectObservability,
  projectObservabilityResourceFamily,
  projectTasksResourceFamily,
} from "@/stores/project";
import {
  refreshProjectObservabilityResourceAtom,
  refreshProjectTasksResourceAtom,
} from "@/stores/projectRefresh";
import { projectApiViewRefreshNonceFamily } from "@/stores/projectViews";
import { selectedSessionIdAtom } from "@/stores/projects";
import { serviceEndpointKey } from "@/lib/daemon-url";

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
  const { project, projectPath, machineId, projectRef, endpoint, projectLoading } =
    useRouteProject();
  // Keyed by the pair: two machines' copies of one checkout are two
  // projects, and sharing an atom between them bleeds one host into the
  // other.
  const projectKeyForState = projectStateKey(projectRef);
  const refreshNonce = useAtomValue(projectApiViewRefreshNonceFamily("coordination-worklist"));
  const resource = useAtomValue(coordinationWorklistResourceFamily(projectKeyForState));
  const beginCoordinationWorklistRefresh = useSetAtom(beginCoordinationWorklistRefreshAtom);
  const applyCoordinationWorklistSuccess = useSetAtom(applyCoordinationWorklistSuccessAtom);
  const applyCoordinationWorklistFailure = useSetAtom(applyCoordinationWorklistFailureAtom);
  const clearCoordinationWorklistResource = useSetAtom(clearCoordinationWorklistResourceAtom);
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const { getToken } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const endpointKey = serviceEndpointKey(endpoint);
  const endpointRef = useRef(endpoint);
  const endpointKeyRef = useRef(endpointKey);
  const projectPathRef = useRef(projectKeyForState);
  const getTokenRef = useRef(getToken);
  const refreshSeqRef = useRef(0);
  const refreshGenerationRef = useRef(0);
  const requestScopeRef = useRef<CoordinationWorklistRequestScope>({
    projectStateKey: projectKeyForState,
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
    projectPathRef.current = projectKeyForState;
    requestScopeRef.current = {
      projectStateKey: projectKeyForState,
      endpointKey,
      generation: refreshGenerationRef.current,
    };
  }, [endpointKey, projectKeyForState]);

  const refresh = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    const currentEndpoint = endpointRef.current;
    const currentProjectStateKey = projectPathRef.current;
    const requestScope = {
      projectStateKey: currentProjectStateKey,
      endpointKey: endpointKeyRef.current,
      generation: refreshGenerationRef.current,
    };
    if (!currentEndpoint) {
      clearCoordinationWorklistResource(currentProjectStateKey);
      return;
    }
    beginCoordinationWorklistRefresh(currentProjectStateKey);
    try {
      const token = await getTokenRef.current();
      const response = await getCoordinationWorklist(currentEndpoint, "user", { token });
      if (seq !== refreshSeqRef.current) return;
      if (!isCurrentCoordinationWorklistRequest(requestScope, requestScopeRef.current)) return;
      applyCoordinationWorklistSuccess({
        projectStateKey: currentProjectStateKey,
        worklist: {
          items: response.worklist.items,
          fetchedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      if (seq !== refreshSeqRef.current) return;
      if (!isCurrentCoordinationWorklistRequest(requestScope, requestScopeRef.current)) return;
      applyCoordinationWorklistFailure({
        projectStateKey: currentProjectStateKey,
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

  // The project's recent activity and its open queue, moved here from the
  // project screen: what needs a person and what is in flight are the same
  // question, and they were two screens apart.
  const observabilityRefreshNonce = useAtomValue(
    projectApiViewRefreshNonceFamily("project-observability"),
  );
  const tasksRefreshNonce = useAtomValue(projectApiViewRefreshNonceFamily("tasks"));
  const observabilityResource = useAtomValue(
    projectObservabilityResourceFamily(projectKeyForState),
  );
  const tasksResource = useAtomValue(projectTasksResourceFamily(projectKeyForState));
  const refreshObservability = useSetAtom(refreshProjectObservabilityResourceAtom);
  const refreshTasks = useSetAtom(refreshProjectTasksResourceAtom);
  const activityTrackerRef = useRef(
    createProjectResourceRequestTracker({
      projectStateKey: projectKeyForState,
      endpointKey,
    }),
  );
  // Before paint, as the project screen did: a switch between projects that
  // updated the tracker after the render could accept a reply for the project
  // just left.
  useLayoutEffect(() => {
    const tracker = activityTrackerRef.current;
    tracker.update({ projectStateKey: projectKeyForState, endpointKey });
    return () => {
      tracker.invalidateGeneration();
    };
  }, [endpointKey, projectKeyForState]);
  const refreshActivity = useCallback(async () => {
    const request = activityTrackerRef.current.begin();
    const input = {
      endpoint,
      getToken,
      request,
      isCurrentRequest: (marker: typeof request) => activityTrackerRef.current.isCurrent(marker),
    };
    await Promise.all([refreshObservability(input), refreshTasks(input)]);
  }, [endpoint, getToken, refreshObservability, refreshTasks]);
  const serializedRefreshActivity = useSerializedProjectApiRefresh(refreshActivity);
  useEffect(() => {
    const timer = setTimeout(() => {
      void serializedRefreshActivity();
    }, 0);
    return () => clearTimeout(timer);
  }, [
    endpointKey,
    observabilityRefreshNonce,
    projectKeyForState,
    serializedRefreshActivity,
    tasksRefreshNonce,
  ]);
  // Absent is not empty: before the first answer a zeroed progress strip and
  // "no queue items" are a claim about the project, not a loading state.
  const activityReady = observabilityResource.value?.project !== undefined;
  const tasksReady = tasksResource.value !== null;
  const activityModel = observabilityResource.value?.project ?? emptyProjectObservability();
  const openTasks = useMemo(
    () => (tasksResource.value?.tasks ?? []).filter(isOpenTask),
    [tasksResource.value],
  );

  useEffect(() => {
    const timer = setTimeout(() => {
      void serializedRefresh();
    }, 0);
    return () => clearTimeout(timer);
  }, [endpointKey, projectKeyForState, refreshNonce, serializedRefresh]);

  const visibleItems = useMemo(() => resource.value?.items ?? [], [resource.value?.items]);
  const visibleError = resource.error;
  const needsYou = useMemo(() => visibleItems.filter((item) => item.actionable), [visibleItems]);
  const tail = useMemo(() => visibleItems.filter((item) => !item.actionable), [visibleItems]);

  function handlePressItem(item: CoordinationWorklistItem) {
    if (item.sessionId) {
      selectSession(item.sessionId);
      router.push(detailHrefForPath(pathname, "agent", item.sessionId, projectPath, machineId));
      return;
    }
    const threadId = threadIdFor(item);
    if (threadId) {
      router.push(
        buildViewHref("/threads", { project: projectPath, machine: machineId, threadId }),
      );
      return;
    }
    router.push(buildViewHref("/notifications", { project: projectPath, machine: machineId }));
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
            onPress={() => {
              // Everything this screen shows, not just the worklist: the
              // queue and the activity feed are on it now.
              void serializedRefresh();
              void serializedRefreshActivity();
            }}
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

      {/* Outside the worklist's own empty state on purpose: a quiet worklist
          is not a quiet project, and hiding the queue and the activity behind
          "nothing needs you" would lose both the moment it is true. */}
      {project && endpoint ? (
        <View className="mt-6">
          {/* The failures come with the data: these two resources moved here
              from the project screen, and a screen that shows their contents
              has to show when they could not be read. */}
          {tasksResource.error ? (
            <PageStateCard title="Project queue failed" body={tasksResource.error} tone="danger" />
          ) : null}
          {observabilityResource.error ? (
            <PageStateCard
              title="Project activity failed"
              body={observabilityResource.error}
              tone="danger"
            />
          ) : null}
          <Text className="mb-3 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
            Queue
          </Text>
          {activityReady ? <TaskProgress model={activityModel} /> : null}
          {tasksReady ? (
            <TaskList tasks={openTasks} endpoint={endpoint} />
          ) : (
            <PageStateCard title="Loading queue..." body="Fetching task exchange state." />
          )}
          <Text className="mt-6 mb-3 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
            Activity
          </Text>
          {activityReady ? (
            <StoryList items={activityModel.story} />
          ) : (
            <PageStateCard title="Loading activity..." body="Fetching project activity." />
          )}
        </View>
      ) : null}
    </Page>
  );
}
