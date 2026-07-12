import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Pressable, View } from "react-native";
import { useGlobalSearchParams, useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { ClipboardList, FileText, Network, RefreshCw } from "lucide-react-native";
import { useColorScheme } from "nativewind";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { Text } from "@/components/ui/text";
import type { TaskSummaryResponse } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import { cn } from "@/lib/utils";
import { WorktreeDashboard } from "@/components/WorktreeDashboard";
import { buildViewHref, cleanSearchValue } from "@/lib/view-location";
import { useSerializedProjectApiRefresh } from "@/lib/project-api-refresh";
import { createProjectResourceRequestTracker } from "@/lib/project-resource-request-tracker";
import { useRouteProject } from "@/lib/use-route-project";
import {
  emptyProjectObservability,
  projectObservabilityResourceFamily,
  projectTasksResourceFamily,
  type ProjectObservabilityModel,
} from "@/stores/project";
import {
  refreshProjectObservabilityResourceAtom,
  refreshProjectTasksResourceAtom,
} from "@/stores/projectRefresh";
import { projectApiViewRefreshNonceFamily } from "@/stores/projectViews";
import { TaskWorkflowActions } from "@/components/workflow-actions";

type ProjectSection =
  | "dashboard"
  | "story"
  | "progress"
  | "artifacts"
  | "tests"
  | "queue"
  | "topology";

const SECTIONS: Array<{ id: ProjectSection; label: string }> = [
  { id: "dashboard", label: "Dashboard" },
  { id: "story", label: "Story" },
  { id: "progress", label: "Progress" },
  { id: "artifacts", label: "Artifacts" },
  { id: "tests", label: "Tests" },
  { id: "queue", label: "Queue" },
  { id: "topology", label: "Topology" },
];

type ProjectStoryItem = ProjectObservabilityModel["story"][number];

function matchesStoryTerms(item: ProjectStoryItem, terms: RegExp): boolean {
  return terms.test([item.title, item.meta, item.body].filter(Boolean).join(" "));
}

function resolveProjectSection(value: string | null): ProjectSection {
  return SECTIONS.some((section) => section.id === value) ? (value as ProjectSection) : "dashboard";
}

function SummaryTile({ label, value }: { label: string; value: number | string }) {
  return (
    <Card className="mr-2 mb-2 min-w-[112px] flex-1 rounded-lg p-3">
      <Text className="text-[22px] font-bold leading-tight text-foreground">{value}</Text>
      <Text className="mt-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        {label}
      </Text>
    </Card>
  );
}

function SectionChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      className={cn(
        "mr-2 mb-2 rounded-full border px-3 py-1.5 active:opacity-80",
        active ? "border-foreground bg-foreground" : "border-border bg-card",
      )}
    >
      <Text
        className={cn("text-[12px] font-semibold", active ? "text-background" : "text-foreground")}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function EmptyCard({ title, body }: { title: string; body: string }) {
  return <PageStateCard title={title} body={body} />;
}

function StoryList({ items }: { items: ProjectStoryItem[] }) {
  if (items.length === 0) {
    return <EmptyCard title="No story yet" body="Project activity will appear here." />;
  }
  return (
    <View>
      {items.map((item) => (
        <Card key={item.id} className="mb-3 rounded-lg p-4">
          <View className="flex-row items-start">
            <View className="mr-3 rounded-full bg-secondary p-2">
              <FileText size={17} color="#a1a1aa" />
            </View>
            <View className="min-w-0 flex-1">
              <Text className="text-[15px] font-semibold text-foreground" numberOfLines={2}>
                {item.title}
              </Text>
              {item.body ? (
                <Text className="mt-2 text-[13px] leading-snug text-foreground/90">
                  {item.body}
                </Text>
              ) : null}
              {item.meta ? (
                <Text className="mt-3 text-[11px] uppercase tracking-widest text-muted-foreground">
                  {item.meta}
                </Text>
              ) : null}
            </View>
          </View>
        </Card>
      ))}
    </View>
  );
}

function TaskList({
  tasks,
  endpoint,
}: {
  tasks: TaskSummaryResponse[];
  endpoint: ServiceEndpoint | null;
}) {
  if (tasks.length === 0) {
    return <EmptyCard title="No queue items" body="Open task exchange items will appear here." />;
  }
  return (
    <Card className="overflow-hidden rounded-xl p-0">
      {tasks.map((task, index) => (
        <View key={task.id} className={cn("px-4 py-3", index > 0 && "border-t border-border")}>
          <View className="flex-row items-center">
            <ClipboardList size={15} color="#a1a1aa" />
            <Text className="ml-2 flex-1 text-[14px] font-semibold text-foreground">
              {task.description || task.id}
            </Text>
          </View>
          <Text className="mt-2 text-[11px] uppercase tracking-widest text-muted-foreground">
            {[task.status, task.assignedTo ?? task.assignee, task.tool].filter(Boolean).join(" · ")}
          </Text>
          <TaskWorkflowActions endpoint={endpoint} task={task} />
        </View>
      ))}
    </Card>
  );
}

function ProgressSection({ model }: { model: ProjectObservabilityModel }) {
  return (
    <View>
      <View className="mb-4 flex-row flex-wrap">
        <SummaryTile label="Running" value={model.summary.agentsRunning} />
        <SummaryTile label="Waiting" value={model.summary.agentsWaiting} />
        <SummaryTile label="Offline" value={model.summary.agentsOffline} />
        <SummaryTile label="Open Tasks" value={model.summary.openTasks} />
      </View>
      <StoryList items={model.story} />
    </View>
  );
}

export default function ProjectScreen() {
  const { colorScheme } = useColorScheme();
  const foregroundIconColor = colorScheme === "dark" ? "#fafafa" : "#09090b";
  const { project, projectPath, endpoint, projectLoading } = useRouteProject();
  const projectPathKey = projectPath ?? "__aimux_no_selected_project__";
  const projectObservabilityRefreshNonce = useAtomValue(
    projectApiViewRefreshNonceFamily("project-observability"),
  );
  const tasksRefreshNonce = useAtomValue(projectApiViewRefreshNonceFamily("tasks"));
  const projectResource = useAtomValue(projectObservabilityResourceFamily(projectPathKey));
  const tasksResource = useAtomValue(projectTasksResourceFamily(projectPathKey));
  const refreshProjectObservabilityResource = useSetAtom(refreshProjectObservabilityResourceAtom);
  const refreshProjectTasksResource = useSetAtom(refreshProjectTasksResourceAtom);
  const { getToken } = useAuth();
  const router = useRouter();
  const searchParams = useGlobalSearchParams<{ section?: string | string[] }>();
  const section = resolveProjectSection(cleanSearchValue(searchParams.section));
  const endpointKey = endpoint ? `${endpoint.host}:${endpoint.port}` : null;
  const requestTrackerRef = useRef(
    createProjectResourceRequestTracker({
      projectPath: projectPathKey,
      endpointKey,
    }),
  );

  useLayoutEffect(() => {
    const requestTracker = requestTrackerRef.current;
    requestTracker.update({
      projectPath: projectPathKey,
      endpointKey,
    });
    return () => {
      requestTracker.invalidateGeneration();
    };
  }, [endpointKey, projectPathKey]);

  const projectModelReady = projectResource.value?.project !== undefined;
  const tasksReady = tasksResource.value !== null;
  const visibleModel = projectResource.value?.project ?? emptyProjectObservability();
  const visibleTasks = useMemo(() => tasksResource.value?.tasks ?? [], [tasksResource.value]);

  const refreshProjectView = useCallback(async () => {
    const request = requestTrackerRef.current.begin();
    const input = {
      endpoint,
      getToken,
      request,
      isCurrentRequest: (marker: typeof request) => requestTrackerRef.current.isCurrent(marker),
    };
    await Promise.all([
      refreshProjectObservabilityResource(input),
      refreshProjectTasksResource(input),
    ]);
  }, [endpoint, getToken, refreshProjectObservabilityResource, refreshProjectTasksResource]);
  const serializedRefreshProjectView = useSerializedProjectApiRefresh(refreshProjectView);

  useEffect(() => {
    const timer = setTimeout(() => {
      void serializedRefreshProjectView();
    }, 0);
    return () => clearTimeout(timer);
  }, [
    endpointKey,
    projectObservabilityRefreshNonce,
    projectPathKey,
    serializedRefreshProjectView,
    tasksRefreshNonce,
  ]);

  const artifactHints = useMemo(
    () =>
      visibleModel.story.filter((item) =>
        matchesStoryTerms(item, /artifact|file|doc|plan|handoff/i),
      ),
    [visibleModel.story],
  );
  const verificationHints = useMemo(
    () =>
      visibleModel.story.filter((item) =>
        matchesStoryTerms(item, /test|verify|lint|build|typecheck/i),
      ),
    [visibleModel.story],
  );
  const openTasks = useMemo(
    () =>
      visibleTasks.filter((task) => {
        const status = String(task.status ?? "").toLowerCase();
        return status !== "done" && status !== "failed" && status !== "abandoned";
      }),
    [visibleTasks],
  );
  const agentCount =
    visibleModel.summary.agentsRunning +
    visibleModel.summary.agentsWaiting +
    visibleModel.summary.agentsOffline;
  const taskCount = visibleModel.summary.openTasks + visibleModel.summary.doneTasks;
  const summaryValue = (value: number) => (projectModelReady ? value : "...");
  const visibleProjectError = projectResource.error;
  const visibleTaskError = tasksResource.error;

  return (
    <Page>
      <PageHeader
        eyebrow="Project"
        title={project?.name ?? (projectLoading ? "Loading project..." : "No project selected")}
        subtitle={project?.path ?? (projectLoading ? projectPath : undefined)}
        actions={
          <Button
            variant="outline"
            size="icon"
            disabled={!endpoint || tasksResource.pending || projectResource.pending}
            onPress={() => {
              void serializedRefreshProjectView();
            }}
            accessibilityLabel="Refresh project"
          >
            <RefreshCw size={18} color={foregroundIconColor} />
          </Button>
        }
      />

      {!projectLoading ? (
        <>
          <View className="mb-5 flex-row flex-wrap">
            <SummaryTile label="Agents" value={summaryValue(agentCount)} />
            <SummaryTile label="Services" value={summaryValue(visibleModel.summary.services)} />
            <SummaryTile label="Worktrees" value={summaryValue(visibleModel.summary.worktrees)} />
            <SummaryTile label="Tasks" value={summaryValue(taskCount)} />
            <SummaryTile
              label="Unread"
              value={summaryValue(visibleModel.summary.unreadNotifications)}
            />
          </View>

          <View className="mb-4 flex-row flex-wrap">
            {SECTIONS.map((item) => (
              <SectionChip
                key={item.id}
                label={item.label}
                active={section === item.id}
                onPress={() =>
                  router.replace(
                    buildViewHref("/project", { project: projectPath, section: item.id }),
                  )
                }
              />
            ))}
          </View>
        </>
      ) : null}

      {projectLoading ? (
        <EmptyCard title="Loading project..." body="Fetching project state from the daemon." />
      ) : !project ? (
        <EmptyCard title="No project selected" body="Pick a project from the sidebar." />
      ) : !endpoint ? (
        <EmptyCard
          title="Project host offline"
          body="Start the project host to load project state."
        />
      ) : visibleProjectError ? (
        <Card className="mb-4 rounded-lg border-destructive/50 bg-destructive/10">
          <Text className="text-sm font-semibold text-foreground">Project state failed</Text>
          <Text className="mt-1 text-xs text-muted-foreground">{visibleProjectError}</Text>
        </Card>
      ) : visibleTaskError ? (
        <Card className="mb-4 rounded-lg border-destructive/50 bg-destructive/10">
          <Text className="text-sm font-semibold text-foreground">Project queue failed</Text>
          <Text className="mt-1 text-xs text-muted-foreground">{visibleTaskError}</Text>
        </Card>
      ) : null}

      {project && endpoint ? (
        <>
          {section === "dashboard" ? <WorktreeDashboard padded={false} /> : null}
          {section !== "dashboard" && !projectModelReady ? (
            <EmptyCard title="Loading project state..." body="Fetching project state." />
          ) : null}
          {section === "story" && projectModelReady ? (
            <StoryList items={visibleModel.story} />
          ) : null}
          {section === "progress" && projectModelReady ? (
            <ProgressSection model={visibleModel} />
          ) : null}
          {section === "artifacts" && projectModelReady ? (
            <StoryList items={artifactHints} />
          ) : null}
          {section === "tests" && projectModelReady ? (
            <StoryList items={verificationHints} />
          ) : null}
          {section === "queue" && projectModelReady && !tasksReady ? (
            <EmptyCard title="Loading project queue..." body="Fetching queue state." />
          ) : null}
          {section === "queue" && projectModelReady && tasksReady ? (
            <TaskList tasks={openTasks} endpoint={endpoint} />
          ) : null}
          {section === "topology" && projectModelReady ? (
            <View>
              <Card className="mb-3 rounded-lg p-4">
                <View className="flex-row items-center">
                  <Network size={17} color="#a1a1aa" />
                  <Text className="ml-2 text-[15px] font-semibold text-foreground">
                    Runtime topology
                  </Text>
                </View>
                <Text className="mt-2 text-[13px] text-muted-foreground">
                  {visibleModel.summary.worktrees} worktrees · {agentCount} agents ·{" "}
                  {visibleModel.summary.services} services
                </Text>
              </Card>
            </View>
          ) : null}
        </>
      ) : null}
    </Page>
  );
}
