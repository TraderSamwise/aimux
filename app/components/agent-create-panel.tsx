import React, { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { useSetAtom } from "jotai";
import { Plus } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { spawnAgent } from "@/lib/api";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { WorktreeBucket } from "@/lib/desktop-state";
import { cn } from "@/lib/utils";
import { kickDesktopStateRefreshAtom } from "@/stores/desktopState";
import { kickProjectApiViewRefreshAtom } from "@/stores/projectViews";

const TOOL_CHOICES = ["claude", "codex", "aider"] as const;
type ToolChoice = (typeof TOOL_CHOICES)[number];

export function AgentCreatePanel({
  endpoint,
  token,
  groups,
}: {
  endpoint: ServiceEndpoint | null;
  token: string | null;
  groups: WorktreeBucket[];
}) {
  const [tool, setTool] = useState<ToolChoice>("claude");
  const [worktreePath, setWorktreePath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kickDesktopRefresh = useSetAtom(kickDesktopStateRefreshAtom);
  const kickProjectViewRefresh = useSetAtom(kickProjectApiViewRefreshAtom);

  const worktreeChoices = useMemo(
    () =>
      groups
        .filter((group) => !group.isMainCheckout && group.path)
        .map((group) => ({ key: group.key, label: group.name, path: group.path })),
    [groups],
  );

  async function createAgent() {
    if (!endpoint || busy) return;
    setBusy(true);
    setError(null);
    try {
      await spawnAgent(
        endpoint,
        {
          tool,
          worktreePath: worktreePath ?? undefined,
          open: false,
        },
        { token },
      );
      kickDesktopRefresh();
      kickProjectViewRefresh([
        "agents",
        "project-observability",
        "topology",
        "coordination-worklist",
        "team",
        "worktrees",
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
          {TOOL_CHOICES.map((choice) => (
            <Pressable
              key={choice}
              onPress={() => setTool(choice)}
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
            label="Main checkout"
            active={worktreePath === null}
            onPress={() => setWorktreePath(null)}
          />
          {worktreeChoices
            .filter((choice) => choice.path)
            .map((choice) => (
              <WorktreeChip
                key={choice.key}
                label={choice.label}
                active={worktreePath === choice.path}
                onPress={() => setWorktreePath(choice.path)}
              />
            ))}
        </View>

        <Button
          variant="outline"
          size="sm"
          disabled={!endpoint || busy}
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
