import React from "react";
import { Pressable, View } from "react-native";

import { Text } from "@/components/ui/text";
import type { DaemonProject } from "@/lib/api";
import { filterProjectPickerProjects, projectOnlineState } from "@/lib/project-picker";
import {
  PROJECT_LIST_OK,
  projectListEmptyMessage,
  projectListStaleMessage,
  type ProjectListStatus,
} from "@/lib/project-list-status";
import { cn } from "@/lib/utils";
import { projectKey, projectRefOf, sameProjectRef, type ProjectRef } from "@/lib/project-key";

export function ProjectPicker({
  projects,
  status = PROJECT_LIST_OK,
  selectedRef,
  showAllProjects,
  onShowAllProjectsChange,
  onSelect,
}: {
  projects: DaemonProject[];
  status?: ProjectListStatus;
  // The pair, not a path: the same checkout exists on two machines, and a path
  // alone would select, and highlight, both rows.
  selectedRef: ProjectRef | null;
  showAllProjects: boolean;
  onShowAllProjectsChange: (showAll: boolean) => void;
  onSelect: (ref: ProjectRef) => void;
}) {
  const visibleProjects = filterProjectPickerProjects(projects, { showAll: showAllProjects });
  const hiddenCount = Math.max(0, projects.length - visibleProjects.length);
  const emptyMessage = projectListEmptyMessage(status);
  const staleMessage = projects.length > 0 ? projectListStaleMessage(status) : null;

  return (
    <View className="pt-4 pb-2">
      <View className="flex-row items-center justify-between px-3.5 pb-2">
        <Text className="text-[10px] font-bold uppercase tracking-widest text-[#787a83]">
          Projects
        </Text>
        {projects.length > 0 ? (
          <View className="flex-row overflow-hidden rounded-md border border-[#30313a]">
            {[
              { label: "Active", value: false },
              { label: "All", value: true },
            ].map((option) => {
              const active = showAllProjects === option.value;
              return (
                <Pressable
                  key={option.label}
                  onPress={() => onShowAllProjectsChange(option.value)}
                  className={cn(
                    "px-2.5 py-1",
                    active ? "bg-[#edeef0]" : "bg-transparent hover:bg-[#232429]",
                  )}
                >
                  <Text
                    className={cn(
                      "text-[11px] font-semibold",
                      active ? "text-[#111216]" : "text-[#edeef0]",
                    )}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </View>
      {staleMessage ? (
        <View className="px-3.5 pb-2">
          <Text className="text-[12px] text-[#c9a227]">{staleMessage}</Text>
        </View>
      ) : null}
      {projects.length === 0 ? (
        <View className="px-3.5 py-3">
          <Text className="text-[13px] text-[#787a83]">
            {emptyMessage ? emptyMessage.title : "No projects detected"}
          </Text>
          {emptyMessage?.detail ? (
            <Text className="mt-1 text-[12px] text-[#5b5d66]">{emptyMessage.detail}</Text>
          ) : null}
        </View>
      ) : visibleProjects.length === 0 ? (
        <View className="px-3.5 py-3">
          <Text className="text-[13px] text-[#787a83]">No active projects</Text>
          {hiddenCount > 0 ? (
            <Text className="mt-1 text-[12px] text-[#5b5d66]">
              Switch to All to show {hiddenCount} hidden.
            </Text>
          ) : null}
        </View>
      ) : (
        visibleProjects.map((project) => {
          const ref = projectRefOf(project);
          const isSelected = sameProjectRef(ref, selectedRef);
          // The dot and the label had separate rules -- one on the agent count
          // falling back to the project service, the other on the service alone --
          // so they could disagree with each other and with the filter beside
          // them. All three ask the same helper now.
          const onlineState = projectOnlineState(project);
          const onlineAgentCount = onlineState === "online" ? project.onlineAgentCount : undefined;
          return (
            <Pressable
              key={projectKey(ref) ?? project.path}
              onPress={() => ref && onSelect(ref)}
              className={cn(
                "px-4 py-3",
                isSelected ? "bg-[#26272d]" : "hover:bg-[#232429] active:bg-[#26272d]",
              )}
            >
              <View className="flex-row items-center gap-2.5">
                <View
                  className={cn(
                    "h-[7px] w-[7px] rounded-full",
                    onlineState === "online"
                      ? "bg-[#4ade80]"
                      : onlineState === "offline"
                        ? "bg-[#5b5d66]"
                        : "border border-[#787a83]",
                  )}
                />
                <Text
                  className="min-w-0 flex-1 text-[14px] font-medium text-[#edeef0]"
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  {project.name}
                </Text>
                <Text
                  className={cn(
                    "font-mono text-[11px]",
                    onlineState === "online" ? "text-[#4ade80]" : "text-[#787a83]",
                  )}
                >
                  {onlineAgentCount === undefined
                    ? onlineState === "unknown"
                      ? "liveness unknown"
                      : onlineState
                    : `${onlineAgentCount} online`}
                </Text>
              </View>
              <Text
                className="ml-4 mt-0.5 font-mono text-[12px] text-[#787a83]"
                numberOfLines={1}
                ellipsizeMode="middle"
              >
                {project.path}
              </Text>
            </Pressable>
          );
        })
      )}
    </View>
  );
}
