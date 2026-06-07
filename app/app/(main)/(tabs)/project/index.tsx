import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useGlobalSearchParams, useRouter } from "expo-router";
import { useAtomValue } from "jotai";
import { ClipboardList, FileText, GitBranch, Network, RefreshCw } from "lucide-react-native";
import { useColorScheme } from "nativewind";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { Text } from "@/components/ui/text";
import { listTasks, type TaskSummaryResponse } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { buildProjectTopology } from "@/lib/openrig-topology";
import {
  buildProjectObservability,
  type ProjectObservability,
  type ProjectStoryItem,
} from "@/lib/project-observability";
import { cn } from "@/lib/utils";
import { WorktreeDashboard } from "@/components/WorktreeDashboard";
import { buildViewHref, cleanSearchValue } from "@/lib/view-location";
import { desktopStateFamily, worktreeGroupsFamily } from "@/stores/desktopState";
import { notificationFeedFamily } from "@/stores/notifications";
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

function ProgressSection({ model }: { model: ProjectObservability }) {
  return (
    <View>
      <View className="mb-4 flex-row flex-wrap">
        <SummaryTile label="Running" value={model.summary.running} />
        <SummaryTile label="Waiting" value={model.summary.waiting} />
        <SummaryTile label="Offline" value={model.summary.offline} />
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
  const [taskError, setTaskError] = useState<string | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const project = useAtomValue(selectedProjectAtom);
  const endpoint = useAtomValue(selectedProjectEndpointAtom);
  const desktopState = useAtomValue(desktopStateFamily(project?.path ?? ""));
  const groups = useAtomValue(worktreeGroupsFamily(project?.path ?? ""));
  const notificationFeed = useAtomValue(notificationFeedFamily(project?.path ?? ""));
  const { getToken } = useAuth();
  const router = useRouter();
  const searchParams = useGlobalSearchParams<{ section?: string | string[] }>();
  const section = resolveProjectSection(cleanSearchValue(searchParams.section));
  const endpointKey = endpoint ? `${endpoint.host}:${endpoint.port}` : null;
  const endpointRef = useRef(endpoint);
  const getTokenRef = useRef(getToken);
  const refreshSeqRef = useRef(0);

  useEffect(() => {
    endpointRef.current = endpoint;
    getTokenRef.current = getToken;
  }, [endpoint, getToken]);

  const refreshTasks = useCallback(async () => {
    const seq = ++refreshSeqRef.current;
    const currentEndpoint = endpointRef.current;
    if (!currentEndpoint) {
      setTasks([]);
      setTaskError(null);
      setLoadingTasks(false);
      return;
    }
    setLoadingTasks(true);
    try {
      const token = await getTokenRef.current();
      const response = await listTasks(currentEndpoint, undefined, { token });
      if (seq !== refreshSeqRef.current) return;
      setTasks(response.tasks);
      setTaskError(null);
    } catch (err) {
      if (seq !== refreshSeqRef.current) return;
      setTaskError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === refreshSeqRef.current) setLoadingTasks(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      void refreshTasks();
    }, 0);
    return () => clearTimeout(timer);
  }, [endpointKey, refreshTasks]);

  const model = useMemo(
    () =>
      buildProjectObservability({
        desktopState,
        notifications: notificationFeed?.notifications ?? [],
        tasks,
      }),
    [desktopState, notificationFeed?.notifications, tasks],
  );
  const topology = useMemo(
    () => (project ? buildProjectTopology(project, groups, desktopState) : null),
    [desktopState, groups, project],
  );

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
            disabled={!endpoint || loadingTasks}
            onPress={() => void refreshTasks()}
            accessibilityLabel="Refresh project tasks"
          >
            <RefreshCw size={18} color={foregroundIconColor} />
          </Button>
        }
      />

      <View className="mb-5 flex-row flex-wrap">
        <SummaryTile label="Agents" value={model.summary.agents} />
        <SummaryTile label="Services" value={model.summary.services} />
        <SummaryTile label="Worktrees" value={model.summary.worktrees} />
        <SummaryTile label="Tasks" value={model.summary.tasks} />
        <SummaryTile label="Unread" value={model.summary.unreadNotifications} />
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
        <EmptyCard title="Project host offline" body="Start the project host to load tasks." />
      ) : taskError ? (
        <Card className="mb-4 rounded-lg border-destructive/50 bg-destructive/10">
          <Text className="text-sm font-semibold text-foreground">Project queue failed</Text>
          <Text className="mt-1 text-xs text-muted-foreground">{taskError}</Text>
        </Card>
      ) : null}

      {project && endpoint ? (
        <>
          {section === "dashboard" ? <WorktreeDashboard padded={false} /> : null}
          {section === "story" ? <StoryList items={model.story} /> : null}
          {section === "progress" ? <ProgressSection model={model} /> : null}
          {section === "artifacts" ? <StoryList items={model.artifactHints} /> : null}
          {section === "tests" ? <StoryList items={model.verificationHints} /> : null}
          {section === "queue" ? <TaskList tasks={model.openTasks} /> : null}
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
                  {topology?.summary.worktrees ?? 0} worktrees · {topology?.summary.agents ?? 0}{" "}
                  agents · {topology?.summary.services ?? 0} services
                </Text>
              </Card>
              {groups.map((bucket) => (
                <Card key={bucket.key} className="mb-3 rounded-lg p-4">
                  <View className="flex-row items-center">
                    <GitBranch size={15} color="#a1a1aa" />
                    <Text className="ml-2 flex-1 text-[14px] font-semibold text-foreground">
                      {bucket.name}
                    </Text>
                    <Text className="text-[11px] text-muted-foreground">
                      {bucket.sessions.length + bucket.services.length} nodes
                    </Text>
                  </View>
                  {bucket.branch ? (
                    <Text className="mt-2 text-[11px] font-mono text-muted-foreground">
                      {bucket.branch}
                    </Text>
                  ) : null}
                </Card>
              ))}
            </View>
          ) : null}
        </>
      ) : null}
    </Page>
  );
}
