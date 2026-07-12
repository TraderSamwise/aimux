import React, { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useSetAtom } from "jotai";
import { Plus, Trash2 } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { createWorktree, removeWorktree } from "@/lib/api";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { WorktreeBucket } from "@/lib/desktop-state";
import { cn } from "@/lib/utils";
import type { ProjectLifecycleTransition } from "../../src/project-api-contract";
import { kickDesktopStateRefreshAtom } from "@/stores/desktopState";
import {
  failLocalProjectLifecycleTransition,
  localProjectLifecycleTransition,
  recordProjectLifecycleTransitionAtom,
} from "@/stores/lifecycleTransitions";
import { kickProjectApiViewRefreshAtom } from "@/stores/projectViews";

type WorktreeAction = "create" | "remove";

export function WorktreeManagementPanel({
  endpoint,
  token,
  projectPath,
  groups,
}: {
  endpoint: ServiceEndpoint | null;
  token: string | null;
  projectPath: string;
  groups: WorktreeBucket[];
}) {
  const [name, setName] = useState("");
  const [removePath, setRemovePath] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<WorktreeAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const kickDesktopRefresh = useSetAtom(kickDesktopStateRefreshAtom);
  const kickProjectViewRefresh = useSetAtom(kickProjectApiViewRefreshAtom);
  const recordTransition = useSetAtom(recordProjectLifecycleTransitionAtom);

  const removableWorktrees = useMemo(
    () =>
      groups
        .filter(
          (group) =>
            !group.isMainCheckout &&
            group.path &&
            !group.pending &&
            !group.removing &&
            group.sessions.length === 0 &&
            group.services.length === 0,
        )
        .map((group) => ({ key: group.key, label: group.name, path: group.path as string })),
    [groups],
  );

  async function runAction(action: WorktreeAction, fn: () => Promise<unknown>) {
    if (!endpoint || busyAction) return;
    setBusyAction(action);
    setError(null);
    try {
      await fn();
      kickDesktopRefresh();
      kickProjectViewRefresh([
        "worktrees",
        "project-observability",
        "topology",
        "library",
        "graveyard",
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyAction(null);
    }
  }

  const trimmedName = name.trim();
  const canAct = Boolean(endpoint) && !busyAction;

  if (!endpoint) {
    return null;
  }

  return (
    <Card className="mb-3 rounded-lg p-3">
      <View className="flex-row flex-wrap items-start gap-4">
        <View className="min-w-[280px] flex-1">
          <View className="flex-row items-center gap-2">
            <Plus size={13} color="#a1a1aa" />
            <Text className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Worktrees
            </Text>
          </View>
          <View className="mt-2 flex-row gap-2">
            <Input
              nativeID="worktree-name"
              accessibilityLabel="New worktree name"
              value={name}
              onChangeText={setName}
              placeholder="New worktree name"
              className="h-9 flex-1 text-sm"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!canAct || !trimmedName}
              onPress={() =>
                runAction("create", async () => {
                  const response = await createWorktree(endpoint, trimmedName, { token });
                  recordTransition({
                    projectPath,
                    transition: response.transition,
                    worktreeName: trimmedName,
                    worktreePath: response.path,
                  });
                  setName("");
                })
              }
              className="gap-2"
            >
              <Plus size={14} color="#a1a1aa" />
              <Text className="text-sm text-foreground">
                {busyAction === "create" ? "Creating" : "Create"}
              </Text>
            </Button>
          </View>
        </View>

        <View className="min-w-[280px] flex-1">
          <View className="flex-row items-center gap-2">
            <Trash2 size={13} color="#a1a1aa" />
            <Text className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
              Remove Empty
            </Text>
          </View>
          <View className="mt-2 flex-row flex-wrap items-center gap-2">
            {removableWorktrees.length > 0 ? (
              removableWorktrees.map((worktree) => (
                <WorktreeChip
                  key={worktree.key}
                  label={worktree.label}
                  active={removePath === worktree.path}
                  disabled={!canAct}
                  onPress={() => setRemovePath(worktree.path)}
                />
              ))
            ) : (
              <Text className="text-xs text-muted-foreground">No empty worktrees</Text>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={!canAct || !removePath}
              onPress={() =>
                removePath
                  ? runAction("remove", async () => {
                      const localTransition = localWorktreeRemoveTransition(removePath);
                      recordTransition({
                        projectPath,
                        transition: localTransition,
                        worktreePath: removePath,
                      });
                      let response: Awaited<ReturnType<typeof removeWorktree>>;
                      try {
                        response = await removeWorktree(endpoint, removePath, { token });
                      } catch (e) {
                        recordTransition({
                          projectPath,
                          transition: failLocalProjectLifecycleTransition(localTransition),
                          worktreePath: removePath,
                        });
                        throw e;
                      }
                      recordTransition({
                        projectPath,
                        transition: response.transition,
                        worktreePath: removePath,
                      });
                      setRemovePath(null);
                    })
                  : undefined
              }
            >
              <Text className="text-sm text-foreground">
                {busyAction === "remove" ? "Removing" : "Remove"}
              </Text>
            </Button>
          </View>
        </View>
      </View>
      {error ? <Text className="mt-2 text-xs text-destructive">{error}</Text> : null}
    </Card>
  );
}

function localWorktreeRemoveTransition(path: string): ProjectLifecycleTransition {
  const name = path.split(/[\\/]/).pop() ?? path;
  return localProjectLifecycleTransition({
    operation: "worktree.remove",
    targetKind: "worktree",
    targetId: name,
    targetPath: path,
  });
}

function WorktreeChip({
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
