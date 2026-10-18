import React, { useMemo, useRef, useState } from "react";
import type { ProjectStateKey } from "@/lib/project-key";
import { Pressable, View } from "react-native";
import { useSetAtom } from "jotai";
import { Plus } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { spawnAgent } from "@/lib/api";
import {
  AGENT_TOOL_CHOICES,
  agentCreationRole,
  agentCreationPolicyIsAvailable,
  type AgentCreationTarget,
  AGENT_CREATION_REFRESH_VIEWS,
  creatableWorktreeChoices,
  isSelectableWorktreePath,
  type AgentToolChoice,
} from "@/lib/agent-create";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { WorktreeBucket } from "@/lib/desktop-state";
import { isTransientRequestError } from "@/lib/request-errors";
import { cn } from "@/lib/utils";
import { kickDesktopStateRefreshAtom } from "@/stores/desktopState";
import { recordProjectLifecycleTransitionAtom } from "@/stores/lifecycleTransitions";
import { kickProjectApiViewRefreshAtom } from "@/stores/projectViews";

import type { AgentCreationPolicy } from "../../src/project-api-contract";

export function AgentCreatePanel({
  endpoint,
  token,
  projectStateKey,
  groups,
  agentCreation,
}: {
  endpoint: ServiceEndpoint | null;
  token: string | null;
  projectStateKey: ProjectStateKey;
  groups: WorktreeBucket[];
  agentCreation?: AgentCreationPolicy;
}) {
  const [tool, setTool] = useState<AgentToolChoice>("claude");
  const toolRef = useRef<AgentToolChoice>("claude");
  const [targetOverride, setTarget] = useState<AgentCreationTarget | null>(null);
  const targetRef = useRef<AgentCreationTarget | null>(null);
  const target = targetOverride ?? agentCreation?.defaultTarget;
  const [worktreePath, setWorktreePath] = useState<string | null>(null);
  const worktreePathRef = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kickDesktopRefresh = useSetAtom(kickDesktopStateRefreshAtom);
  const kickProjectViewRefresh = useSetAtom(kickProjectApiViewRefreshAtom);
  const recordTransition = useSetAtom(recordProjectLifecycleTransitionAtom);

  const worktreeChoices = useMemo(() => creatableWorktreeChoices(groups), [groups]);
  const selectedWorktreePath = isSelectableWorktreePath(worktreeChoices, worktreePath)
    ? worktreePath
    : null;

  function selectTool(choice: AgentToolChoice) {
    toolRef.current = choice;
    setTool(choice);
  }

  function selectWorktree(path: string | null) {
    targetRef.current = "worktree";
    setTarget("worktree");
    worktreePathRef.current = path;
    setWorktreePath(path);
  }

  const policyUnavailable = !agentCreationPolicyIsAvailable(agentCreation);

  async function createAgent() {
    if (!endpoint || busy || policyUnavailable) return;
    const selectedTool = toolRef.current;
    const selectedTarget = targetRef.current ?? agentCreation?.defaultTarget;
    const selectedPath =
      selectedTarget === "worktree" &&
      isSelectableWorktreePath(worktreeChoices, worktreePathRef.current)
        ? worktreePathRef.current
        : null;
    setBusy(true);
    setError(null);
    try {
      const response = await spawnAgent(
        endpoint,
        {
          tool: selectedTool,
          role: agentCreationRole(agentCreation, selectedTarget),
          worktreePath: selectedPath ?? undefined,
          open: false,
        },
        { token },
      );
      recordTransition({
        projectStateKey,
        transition: response.transition,
        label: response.sessionId,
        tool: selectedTool,
        worktreePath: selectedPath ?? undefined,
      });
      kickDesktopRefresh();
      kickProjectViewRefresh(AGENT_CREATION_REFRESH_VIEWS);
    } catch (e) {
      if (!isTransientRequestError(e)) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-3 rounded-lg p-3">
      <View className="flex-row flex-wrap items-center gap-3">
        <View className="min-w-[150px]">
          <Text className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            New Agent
          </Text>
          <Text className="mt-1 text-[13px] text-muted-foreground" numberOfLines={1}>
            Spawn via project API
          </Text>
        </View>

        <View className="flex-row rounded-md border border-border">
          {AGENT_TOOL_CHOICES.map((choice) => (
            <Pressable
              key={choice}
              onPress={() => selectTool(choice)}
              accessibilityRole="button"
              accessibilityState={{ selected: tool === choice }}
              className={cn(
                "px-3 py-2",
                tool === choice ? "bg-accent" : "hover:bg-accent/60 active:bg-accent",
              )}
            >
              <Text className="text-xs font-medium text-foreground">{choice}</Text>
            </Pressable>
          ))}
        </View>

        <View className="min-w-[180px] flex-1 flex-row flex-wrap gap-2">
          <WorktreeChip
            label="Supervisor Lane"
            active={target === "supervisor"}
            onPress={() => {
              targetRef.current = "supervisor";
              setTarget("supervisor");
            }}
          />
          <WorktreeChip
            label="Main checkout"
            active={target === "worktree" && selectedWorktreePath === null}
            onPress={() => selectWorktree(null)}
          />
          {worktreeChoices
            .filter((choice) => choice.path)
            .map((choice) => (
              <WorktreeChip
                key={choice.key}
                label={choice.label}
                active={target === "worktree" && selectedWorktreePath === choice.path}
                onPress={() => selectWorktree(choice.path)}
              />
            ))}
        </View>

        <Button
          variant="outline"
          size="sm"
          disabled={!endpoint || busy || policyUnavailable}
          onPress={createAgent}
          accessibilityLabel="Create agent"
          className="gap-2"
        >
          <Plus size={14} color="#a1a1aa" />
          <Text className="text-sm font-medium text-foreground">
            {busy ? "Creating" : "Create"}
          </Text>
        </Button>
      </View>
      {policyUnavailable ? (
        <Text
          className="mt-2 text-xs text-destructive"
          accessibilityLabel="Creation policy unavailable"
        >
          Agent creation policy is unavailable from the project host. Refresh project state before
          launching an agent.
        </Text>
      ) : null}
      {error ? <Text className="mt-2 text-xs text-destructive">{error}</Text> : null}
    </Card>
  );
}

function WorktreeChip({
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
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      className={cn(
        "rounded-md border px-2.5 py-1.5",
        active ? "border-primary bg-accent" : "border-border hover:bg-accent/60 active:bg-accent",
      )}
    >
      <Text className="text-xs text-foreground" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}
