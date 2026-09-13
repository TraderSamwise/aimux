import React from "react";
import { Pressable, View } from "react-native";

import { Text } from "@/components/ui/text";
import type { DaemonProject } from "@/lib/api";
import { filterProjectPickerProjects } from "@/lib/project-picker";
import { cn } from "@/lib/utils";

export function ProjectPicker({
  projects,
  selectedPath,
  showAllProjects,
  onShowAllProjectsChange,
  onSelect,
}: {
  projects: DaemonProject[];
  selectedPath: string | null;
  showAllProjects: boolean;
  onShowAllProjectsChange: (showAll: boolean) => void;
  onSelect: (path: string) => void;
}) {
  const visibleProjects = filterProjectPickerProjects(projects, { showAll: showAllProjects });
  const hiddenCount = Math.max(0, projects.length - visibleProjects.length);

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
      {projects.length === 0 ? (
        <View className="px-3.5 py-3">
          <Text className="text-[13px] text-[#787a83]">No projects detected</Text>
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
          const isSelected = project.path === selectedPath;
          const onlineAgentCount = project.onlineAgentCount;
          const isOnline =
            onlineAgentCount === undefined ? project.serviceAlive : onlineAgentCount > 0;
          return (
            <Pressable
              key={project.path}
              onPress={() => onSelect(project.path)}
              className={cn(
                "px-4 py-3",
                isSelected ? "bg-[#26272d]" : "hover:bg-[#232429] active:bg-[#26272d]",
              )}
            >
              <View className="flex-row items-center gap-2.5">
                <View
                  className={cn(
                    "h-[7px] w-[7px] rounded-full",
                    isOnline ? "bg-[#4ade80]" : "bg-[#5b5d66]",
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
                    isOnline ? "text-[#4ade80]" : "text-[#787a83]",
                  )}
                >
                  {onlineAgentCount === undefined
                    ? isOnline
                      ? "online"
                      : "offline"
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
