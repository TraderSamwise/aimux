import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useGlobalSearchParams, useRouter } from "expo-router";
import { useAtomValue } from "jotai";
import { ClipboardList, FileText, Network, RefreshCw } from "lucide-react-native";
import { useColorScheme } from "nativewind";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { Text } from "@/components/ui/text";
import {
  getProjectObservability,
  listTasks,
  type ProjectObservabilityResponse,
  type TaskSummaryResponse,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { cn } from "@/lib/utils";
import { WorktreeDashboard } from "@/components/WorktreeDashboard";
import { buildViewHref, cleanSearchValue } from "@/lib/view-location";
import {
  useProjectApiRelayPolling,
  useSerializedProjectApiRefresh,
} from "@/lib/project-api-relay-polling";
import { projectApiViewRefreshNonceAtom } from "@/stores/projectViews";
import { selectedProjectAtom, selectedProjectEndpointAtom } from "@/stores/projects";

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

type ProjectObservabilityModel = ProjectObservabilityResponse["project"];
type ProjectStoryItem = ProjectObservabilityModel["story"][number];

function emptyProjectObservability(): ProjectObservabilityModel {
  return {
    summary: {
      agentsRunning: 0,
      agentsWaiting: 0,
      agentsOffline: 0,
      services: 0,
      worktrees: 0,
      openTasks: 0,
      doneTasks: 0,
      unreadNotifications: 0,
    },
    progress: {
      pending: 0,
      assigned: 0,
      in_progress: 0,
      blocked: 0,
      done: 0,
      failed: 0,
      total: 0,
    },
    story: [],
  };
}

function matchesStoryTerms(item: ProjectStoryItem, terms: RegExp): boolean {
  return terms.test([item.title, item.meta, item.body].filter(Boolean).join(" "));
}

function resolveProjectSection(value: string | null): ProjectSection {
  return SECTIONS.some((section) => section.id === value) ? (value as ProjectSection) : "dashboard";
}

function SummaryTile({ label, value }: { label: string; value: number }) {
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

function TaskList({ tasks }: { tasks: TaskSummaryResponse[] }) {
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
  const [tasks, setTasks] = useState<TaskSummaryResponse[]>([]);
  const [tasksKey, setTasksKey] = useState<string | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [taskErrorKey, setTaskErrorKey] = useState<string | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [model, setModel] = useState<ProjectObservabilityModel>(() => emptyProjectObservability());
  const [modelKey, setModelKey] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectErrorKey, setProjectErrorKey] = useState<string | null>(null);
  const [loadingProject, setLoadingProject] = useState(false);
  const project = useAtomValue(selectedProjectAtom);
  const endpoint = useAtomValue(selectedProjectEndpointAtom);
  const projectViewRefreshNonce = useAtomValue(projectApiViewRefreshNonceAtom);
  const { getToken } = useAuth();
  const router = useRouter();
  const searchParams = useGlobalSearchParams<{ section?: string | string[] }>();
  const section = resolveProjectSection(cleanSearchValue(searchParams.section));
  const endpointKey = endpoint ? `${endpoint.host}:${endpoint.port}` : null;
  const viewKey = endpointKey ? `${project?.path ?? ""}|${endpointKey}` : null;
  const endpointRef = useRef(endpoint);
  const viewKeyRef = useRef(viewKey);
  const getTokenRef = useRef(getToken);
  const refreshSeqRef = useRef(0);
  const projectRefreshSeqRef = useRef(0);

  useEffect(() => {
    endpointRef.current = endpoint;
    viewKeyRef.current = viewKey;
    getTokenRef.current = getToken;
  }, [endpoint, getToken, viewKey]);

  const visibleModel = modelKey === viewKey ? model : emptyProjectObservability();
  const visibleTasks = useMemo(
    () => (tasksKey === viewKey ? tasks : []),
    [tasks, tasksKey, viewKey],
  );

  const refreshProject = useCallback(async () => {
    const seq = ++projectRefreshSeqRef.current;
    const currentEndpoint = endpointRef.current;
    const currentViewKey = viewKeyRef.current;
    if (!currentEndpoint) {
      setModel(emptyProjectObservability());
      setModelKey(null);
      setProjectError(null);
      setProjectErrorKey(null);
      setLoadingProject(false);
      return;
    }
    setLoadingProject(true);
    try {
      const token = await getTokenRef.current();
      const response = await getProjectObservability(currentEndpoint, { token });
      if (seq !== projectRefreshSeqRef.current) return;
      setModel(response.project);
      setModelKey(currentViewKey);
      setProjectError(null);
      setProjectErrorKey(null);
    } catch (err) {
      if (seq !== projectRefreshSeqRef.current) return;
      setProjectError(err instanceof Error ? err.message : String(err));
      setProjectErrorKey(currentViewKey);
    } finally {
      if (seq === projectRefreshSeqRef.current) setLoadingProject(false);
    }
  }, []);

  const refreshTasks = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    const currentEndpoint = endpointRef.current;
    const currentViewKey = viewKeyRef.current;
    if (!currentEndpoint) {
      setTasks([]);
      setTasksKey(null);
      setTaskError(null);
      setTaskErrorKey(null);
      setLoadingTasks(false);
      return;
    }
    setLoadingTasks(true);
    try {
      const token = await getTokenRef.current();
      const response = await listTasks(currentEndpoint, undefined, { token });
      if (seq !== refreshSeqRef.current) return;
      setTasks(response.tasks);
      setTasksKey(currentViewKey);
      setTaskError(null);
      setTaskErrorKey(null);
    } catch (err) {
      if (seq !== refreshSeqRef.current) return;
      setTaskError(err instanceof Error ? err.message : String(err));
      setTaskErrorKey(currentViewKey);
    } finally {
      if (seq === refreshSeqRef.current) setLoadingTasks(false);
    }
  }, []);

  const refreshProjectView = useCallback(async () => {
    await Promise.all([refreshProject(), refreshTasks()]);
  }, [refreshProject, refreshTasks]);
  const serializedRefreshProjectView = useSerializedProjectApiRefresh(refreshProjectView);

  useEffect(() => {
    const timer = setTimeout(() => {
      void serializedRefreshProjectView();
    }, 0);
    return () => clearTimeout(timer);
  }, [endpointKey, projectViewRefreshNonce, serializedRefreshProjectView]);

  useProjectApiRelayPolling(endpointKey, serializedRefreshProjectView);

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
    () => visibleTasks.filter((task) => task.status !== "done" && task.status !== "failed"),
    [visibleTasks],
  );
  const agentCount =
    visibleModel.summary.agentsRunning +
    visibleModel.summary.agentsWaiting +
    visibleModel.summary.agentsOffline;
  const taskCount = visibleModel.summary.openTasks + visibleModel.summary.doneTasks;
  const visibleProjectError = projectErrorKey === viewKey ? projectError : null;
  const visibleTaskError = taskErrorKey === viewKey ? taskError : null;

  return (
    <Page>
      <PageHeader
        eyebrow="Project"
        title={project?.name ?? "No project selected"}
        subtitle={project?.path}
        actions={
          <Button
            variant="outline"
            size="icon"
            disabled={!endpoint || loadingTasks || loadingProject}
            onPress={() => {
              void serializedRefreshProjectView();
            }}
            accessibilityLabel="Refresh project"
          >
            <RefreshCw size={18} color={foregroundIconColor} />
          </Button>
        }
      />

      <View className="mb-5 flex-row flex-wrap">
        <SummaryTile label="Agents" value={agentCount} />
        <SummaryTile label="Services" value={visibleModel.summary.services} />
        <SummaryTile label="Worktrees" value={visibleModel.summary.worktrees} />
        <SummaryTile label="Tasks" value={taskCount} />
        <SummaryTile label="Unread" value={visibleModel.summary.unreadNotifications} />
      </View>

      <View className="mb-4 flex-row flex-wrap">
        {SECTIONS.map((item) => (
          <SectionChip
            key={item.id}
            label={item.label}
            active={section === item.id}
            onPress={() =>
              router.replace(
                buildViewHref("/project", { project: project?.path, section: item.id }),
              )
            }
          />
        ))}
      </View>

      {!project ? (
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
          {section === "story" ? <StoryList items={visibleModel.story} /> : null}
          {section === "progress" ? <ProgressSection model={visibleModel} /> : null}
          {section === "artifacts" ? <StoryList items={artifactHints} /> : null}
          {section === "tests" ? <StoryList items={verificationHints} /> : null}
          {section === "queue" ? <TaskList tasks={openTasks} /> : null}
          {section === "topology" ? (
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
