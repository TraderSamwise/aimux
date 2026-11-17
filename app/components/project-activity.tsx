import React from "react";
import { View } from "react-native";
import { ClipboardList, FileText } from "lucide-react-native";

import { Card } from "@/components/ui/card";
import { PageStateCard } from "@/components/PageLayout";
import { Text } from "@/components/ui/text";
import { TaskWorkflowActions } from "@/components/workflow-actions";
import type { TaskSummaryResponse } from "@/lib/api";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { ProjectObservabilityModel } from "@/stores/project";
import { cn } from "@/lib/utils";

type ProjectStoryItem = ProjectObservabilityModel["story"][number];

/**
 * The project's recent activity, and its open queue.
 *
 * Both lived inside the project screen, which is the screen being retired:
 * the activity feed belongs beside the coordination worklist and the counts
 * belong on the topology screen, and neither can move while the components
 * that render them are private to the screen they are moving out of.
 */
export function StoryList({
  items,
  emptyTitle = "No story yet",
  emptyBody = "Project activity will appear here.",
}: {
  items: ProjectStoryItem[];
  emptyTitle?: string;
  emptyBody?: string;
}) {
  if (items.length === 0) {
    return <PageStateCard title={emptyTitle} body={emptyBody} />;
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

/**
 * How the project's task queue is progressing.
 *
 * Shown beside the queue it describes rather than on its own screen: a count
 * of blocked tasks is only useful next to the tasks.
 */
export function TaskProgress({ model }: { model: ProjectObservabilityModel }) {
  const cells: Array<{ label: string; value: number }> = [
    { label: "Pending", value: model.progress.pending },
    { label: "Assigned", value: model.progress.assigned },
    { label: "Active", value: model.progress.in_progress },
    { label: "Blocked", value: model.progress.blocked },
    { label: "Done", value: model.progress.done },
    { label: "Failed", value: model.progress.failed },
  ];
  return (
    <View className="mb-4 flex-row flex-wrap">
      {cells.map((cell) => (
        <Card key={cell.label} className="mr-2 mb-2 min-w-[96px] flex-1 rounded-lg p-3">
          <Text className="text-[20px] font-bold leading-tight text-foreground">{cell.value}</Text>
          <Text className="mt-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            {cell.label}
          </Text>
        </Card>
      ))}
    </View>
  );
}

export function TaskList({
  tasks,
  endpoint,
}: {
  tasks: TaskSummaryResponse[];
  endpoint: ServiceEndpoint | null;
}) {
  if (tasks.length === 0) {
    return (
      <PageStateCard title="No queue items" body="Open task exchange items will appear here." />
    );
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
