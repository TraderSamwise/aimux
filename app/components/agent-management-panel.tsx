import React, { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useSetAtom } from "jotai";
import { GitBranch, Pencil, Radar, Repeat2 } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { migrateAgent, renameAgent, setAgentLoop, setAgentOverseer } from "@/lib/api";
import type { ProjectLifecycleTransition } from "../../src/project-api-contract";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { DesktopSession, WorktreeBucket } from "@/lib/desktop-state";
import { cn } from "@/lib/utils";
import { kickDesktopStateRefreshAtom } from "@/stores/desktopState";
import {
  failLocalProjectLifecycleTransition,
  localProjectLifecycleTransition,
  recordProjectLifecycleTransitionAtom,
} from "@/stores/lifecycleTransitions";
import { kickProjectApiViewRefreshAtom } from "@/stores/projectViews";

type AgentManagementAction = "rename" | "migrate" | "loop" | "overseer";

export function AgentManagementPanel({
  session,
  endpoint,
  token,
  projectPath,
  groups,
}: {
  session: DesktopSession;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  projectPath: string;
  groups: WorktreeBucket[];
}) {
  const [label, setLabel] = useState(session.label || "");
  const [loopGoal, setLoopGoal] = useState("");
  const [targetWorktreePath, setTargetWorktreePath] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<AgentManagementAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const kickDesktopRefresh = useSetAtom(kickDesktopStateRefreshAtom);
  const kickProjectViewRefresh = useSetAtom(kickProjectApiViewRefreshAtom);
  const recordTransition = useSetAtom(recordProjectLifecycleTransitionAtom);

  const worktreeChoices = useMemo(
    () =>
      groups
        .filter((group) => group.path && !group.pending && !group.removing)
        .map((group) => ({
          key: group.key,
          label: group.name,
          path: group.path as string,
          current:
            group.path === session.worktreePath || (group.isMainCheckout && !session.worktreePath),
        })),
    [groups, session.worktreePath],
  );

  async function runAction(action: AgentManagementAction, fn: () => Promise<unknown>) {
    if (!endpoint || busyAction) return;
    setBusyAction(action);
    setError(null);
    setStatus(null);
    try {
      await fn();
      kickDesktopRefresh();
      kickProjectViewRefresh([
        "agents",
        "project-observability",
        "topology",
        "coordination-worklist",
        "team",
        "worktrees",
      ]);
      setStatus(actionStatus(action));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyAction(null);
    }
  }

  async function runLifecycleAction(
    action: AgentManagementAction,
    fn: () => Promise<{ transition?: ProjectLifecycleTransition }>,
    next: { label?: string; worktreePath?: string; localTransition?: ProjectLifecycleTransition },
  ) {
    return runAction(action, async () => {
      if (next.localTransition) {
        recordTransition({
          projectPath,
          transition: next.localTransition,
          label: next.label ?? session.label ?? session.id,
          tool: session.toolConfigKey,
          worktreePath: next.worktreePath ?? session.worktreePath,
        });
      }
      try {
        const response = await fn();
        recordTransition({
          projectPath,
          transition: response.transition,
          label: next.label ?? session.label ?? session.id,
          tool: session.toolConfigKey,
          worktreePath: next.worktreePath ?? session.worktreePath,
        });
      } catch (e) {
        if (next.localTransition) {
          recordTransition({
            projectPath,
            transition: failLocalProjectLifecycleTransition(next.localTransition),
            label: next.label ?? session.label ?? session.id,
            tool: session.toolConfigKey,
            worktreePath: next.worktreePath ?? session.worktreePath,
          });
        }
        throw e;
      }
    });
  }

  const canAct = Boolean(endpoint) && !busyAction;
  const trimmedLabel = label.trim();
  const trimmedGoal = loopGoal.trim();
  const selectedWorktreePath = worktreeChoices.some((choice) => choice.path === targetWorktreePath)
    ? targetWorktreePath
    : null;
  const currentWorktreePath =
    worktreeChoices.find((choice) => choice.current)?.path ?? session.worktreePath ?? null;
  const canRename = canAct && trimmedLabel !== (session.label || "");
  const canMigrate =
    canAct && Boolean(selectedWorktreePath) && selectedWorktreePath !== currentWorktreePath;
  const fieldIdPrefix = `agent-${session.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;

  if (!endpoint) {
    return null;
  }

  return (
    <Card className="border-b border-border rounded-none border-x-0 border-t-0 p-4">
      <View className="flex-row flex-wrap gap-4">
        <View className="min-w-[240px] flex-1">
          <PanelLabel icon={Pencil} label="Label" />
          <View className="mt-2 flex-row gap-2">
            <Input
              nativeID={`${fieldIdPrefix}-label`}
              accessibilityLabel="Agent label"
              value={label}
              onChangeText={setLabel}
              placeholder="Agent label"
              className="h-9 flex-1 text-sm"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!canRename}
              onPress={() =>
                runLifecycleAction(
                  "rename",
                  () =>
                    renameAgent(
                      endpoint,
                      { sessionId: session.id, label: trimmedLabel },
                      { token },
                    ),
                  {
                    label: trimmedLabel,
                    localTransition: localProjectLifecycleTransition({
                      operation: "agent.rename",
                      targetKind: "agent",
                      targetId: session.id,
                    }),
                  },
                )
              }
            >
              <Text className="text-sm text-foreground">
                {busyAction === "rename" ? "Saving" : "Save"}
              </Text>
            </Button>
          </View>
        </View>

        <View className="min-w-[260px] flex-[1.2]">
          <PanelLabel icon={GitBranch} label="Move" />
          <View className="mt-2 flex-row flex-wrap items-center gap-2">
            {worktreeChoices.length > 0 ? (
              worktreeChoices.map((choice) => (
                <WorktreeChoice
                  key={choice.key}
                  label={choice.label}
                  active={selectedWorktreePath === choice.path}
                  disabled={choice.current || !canAct}
                  onPress={() => setTargetWorktreePath(choice.path)}
                />
              ))
            ) : (
              <Text className="text-xs text-muted-foreground">No worktree targets</Text>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={!canMigrate}
              onPress={() =>
                selectedWorktreePath
                  ? runLifecycleAction(
                      "migrate",
                      () =>
                        migrateAgent(
                          endpoint,
                          { sessionId: session.id, worktreePath: selectedWorktreePath },
                          { token },
                        ),
                      {
                        worktreePath: selectedWorktreePath,
                        localTransition: localProjectLifecycleTransition({
                          operation: "agent.migrate",
                          targetKind: "agent",
                          targetId: session.id,
                          targetPath: selectedWorktreePath,
                        }),
                      },
                    )
                  : undefined
              }
            >
              <Text className="text-sm text-foreground">
                {busyAction === "migrate" ? "Moving" : "Move"}
              </Text>
            </Button>
          </View>
        </View>

        <View className="min-w-[280px] flex-[1.3]">
          <PanelLabel icon={Repeat2} label="Loop" />
          <View className="mt-2 flex-row gap-2">
            <Input
              nativeID={`${fieldIdPrefix}-loop-goal`}
              accessibilityLabel="Loop goal"
              value={loopGoal}
              onChangeText={setLoopGoal}
              placeholder="Loop goal"
              className="h-9 flex-1 text-sm"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!canAct || !trimmedGoal}
              onPress={() =>
                runAction("loop", () =>
                  setAgentLoop(
                    endpoint,
                    { sessionId: session.id, active: true, goal: trimmedGoal },
                    { token },
                  ),
                )
              }
            >
              <Text className="text-sm text-foreground">
                {busyAction === "loop" ? "Saving" : "Start"}
              </Text>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!canAct}
              onPress={() =>
                runAction("loop", () =>
                  setAgentLoop(endpoint, { sessionId: session.id, active: false }, { token }),
                )
              }
            >
              <Text className="text-sm text-muted-foreground">Stop</Text>
            </Button>
          </View>
        </View>

        <View className="min-w-[180px]">
          <PanelLabel icon={Radar} label="Overseer" />
          <View className="mt-2 flex-row gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!canAct}
              onPress={() =>
                runAction("overseer", () =>
                  setAgentOverseer(endpoint, { sessionId: session.id, active: true }, { token }),
                )
              }
            >
              <Text className="text-sm text-foreground">On</Text>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!canAct}
              onPress={() =>
                runAction("overseer", () =>
                  setAgentOverseer(endpoint, { sessionId: session.id, active: false }, { token }),
                )
              }
            >
              <Text className="text-sm text-muted-foreground">Off</Text>
            </Button>
          </View>
        </View>
      </View>
      {error ? <Text className="mt-3 text-xs text-destructive">{error}</Text> : null}
      {status ? <Text className="mt-3 text-xs text-muted-foreground">{status}</Text> : null}
    </Card>
  );
}

function PanelLabel({ icon: Icon, label }: { icon: typeof Pencil; label: string }) {
  return (
    <View className="flex-row items-center gap-2">
      <Icon size={13} color="#a1a1aa" />
      <Text className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        {label}
      </Text>
    </View>
  );
}

function WorktreeChoice({
  label,
  active,
  disabled,
  onPress,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      className={cn(
        "rounded-md border px-2.5 py-1.5",
        active ? "border-primary bg-accent" : "border-border hover:bg-accent/60 active:bg-accent",
        disabled && "opacity-50",
      )}
    >
      <Text className="text-xs text-foreground" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function actionStatus(action: AgentManagementAction): string {
  if (action === "rename") return "Label saved";
  if (action === "migrate") return "Agent moved";
  if (action === "loop") return "Loop updated";
  return "Overseer updated";
}
