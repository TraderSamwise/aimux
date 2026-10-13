import React, { useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSetAtom } from "jotai";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Text } from "@/components/ui/text";
import { createWorktree, spawnAgent } from "@/lib/api";
import {
  AGENT_TOOL_CHOICES,
  AGENT_CREATION_REFRESH_VIEWS,
  WORKTREE_CREATION_REFRESH_VIEWS,
  creatableWorktreeChoices,
  canSubmitCreation,
  isSelectableWorktreePath,
  type AgentToolChoice,
} from "@/lib/agent-create";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { WorktreeBucket } from "@/lib/desktop-state";
import type { ProjectStateKey } from "@/lib/project-key";
import { isTransientRequestError } from "@/lib/request-errors";
import { cn } from "@/lib/utils";
import { kickDesktopStateRefreshAtom } from "@/stores/desktopState";
import { recordProjectLifecycleTransitionAtom } from "@/stores/lifecycleTransitions";
import { kickProjectApiViewRefreshAtom } from "@/stores/projectViews";

type CreateKind = "agent" | "worktree";

const KIND_OPTIONS = [
  { value: "agent" as const, label: "Agent" },
  { value: "worktree" as const, label: "Worktree" },
];

function ChoiceChip({
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
        "rounded-md border px-3 py-2",
        active ? "border-primary bg-accent" : "border-border hover:bg-accent/60 active:bg-accent",
      )}
    >
      <Text className="text-xs font-medium text-foreground" numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Making a worktree or an agent, from wherever you are.
 *
 * Both already existed, but only on the Project screen — so from the sidebar,
 * which is where you are when you notice you want one, you had to navigate
 * away first. The rules come from `lib/agent-create` so this and the Project
 * screen cannot drift apart.
 */
export function CreateInProjectDialog({
  endpoint,
  token,
  projectStateKey,
  groups,
  onDismiss,
}: {
  endpoint: ServiceEndpoint | null;
  token: string | null;
  projectStateKey: ProjectStateKey;
  groups: WorktreeBucket[];
  onDismiss: () => void;
}) {
  const [kind, setKind] = useState<CreateKind>("agent");
  const [tool, setTool] = useState<AgentToolChoice>("claude");
  const [worktreePath, setWorktreePath] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const kickDesktopRefresh = useSetAtom(kickDesktopStateRefreshAtom);
  const kickProjectViewRefresh = useSetAtom(kickProjectApiViewRefreshAtom);
  const recordTransition = useSetAtom(recordProjectLifecycleTransitionAtom);

  const worktreeChoices = useMemo(() => creatableWorktreeChoices(groups), [groups]);
  // Re-read every render rather than trusted from state: a worktree can be
  // removed while this dialog is open, and launching into a path that is gone
  // fails in a way nobody could have predicted from the form.
  const selectedWorktreePath = isSelectableWorktreePath(worktreeChoices, worktreePath)
    ? worktreePath
    : null;
  const trimmedName = name.trim();
  const canSubmit = canSubmitCreation({ kind, hasEndpoint: Boolean(endpoint), busy, name });

  async function submit() {
    if (!endpoint || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === "agent") {
        const response = await spawnAgent(
          endpoint,
          { tool, worktreePath: selectedWorktreePath ?? undefined, open: false },
          { token },
        );
        recordTransition({
          projectStateKey,
          transition: response.transition,
          label: response.sessionId,
          tool,
          worktreePath: selectedWorktreePath ?? undefined,
        });
        kickDesktopRefresh();
        kickProjectViewRefresh(AGENT_CREATION_REFRESH_VIEWS);
        onDismiss();
        return;
      }
      const response = await createWorktree(endpoint, trimmedName, { token });
      recordTransition({
        projectStateKey,
        transition: response.transition,
        worktreeName: trimmedName,
        worktreePath: response.path,
      });
      kickDesktopRefresh();
      kickProjectViewRefresh(WORKTREE_CREATION_REFRESH_VIEWS);
      // Stays open on the agent step instead of closing. The sidebar lists
      // active agents, so an empty worktree disappears from it the moment it
      // stops being pending -- closing here would look like nothing happened.
      // The worktree you just made is also the one you are about to put
      // something in.
      setCreated(trimmedName);
      setName("");
      setWorktreePath(response.path ?? null);
      setKind("agent");
    } catch (e) {
      // Shown verbatim: the route is the thing that knows a name is taken, and
      // it names the path. A guess made here would be wrong in both
      // directions.
      if (!isTransientRequestError(e)) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onDismiss}>
      <Pressable
        onPress={onDismiss}
        style={StyleSheet.absoluteFill}
        className="bg-black/60"
        accessibilityLabel="Dismiss"
      />
      <View className="flex-1 items-center justify-center p-6" pointerEvents="box-none">
        <Card className="w-full max-w-sm p-5">
          <Text className="text-lg font-semibold text-foreground">Add to this project</Text>

          <View className="mt-4">
            <SegmentedControl
              options={KIND_OPTIONS}
              value={kind}
              onChange={(next) => {
                setCreated(null);
                setError(null);
                setKind(next);
              }}
              fullWidth
            />
          </View>

          {kind === "agent" ? (
            <>
              <Text className="mt-5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Tool
              </Text>
              <View className="mt-2 flex-row flex-wrap gap-2">
                {AGENT_TOOL_CHOICES.map((choice) => (
                  <ChoiceChip
                    key={choice}
                    label={choice}
                    active={tool === choice}
                    onPress={() => setTool(choice)}
                  />
                ))}
              </View>

              <Text className="mt-5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Where
              </Text>
              {/* Capped so a project with many worktrees cannot push the
                  buttons off a phone screen. */}
              <ScrollView className="mt-2 max-h-40" keyboardShouldPersistTaps="handled">
                <View className="flex-row flex-wrap gap-2">
                  <ChoiceChip
                    label="Main checkout"
                    active={selectedWorktreePath === null}
                    onPress={() => setWorktreePath(null)}
                  />
                  {worktreeChoices.map((choice) => (
                    <ChoiceChip
                      key={choice.key}
                      label={choice.label}
                      active={selectedWorktreePath === choice.path}
                      onPress={() => setWorktreePath(choice.path)}
                    />
                  ))}
                </View>
              </ScrollView>
            </>
          ) : (
            <>
              <Text className="mt-5 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                Name
              </Text>
              <Input
                accessibilityLabel="New worktree name"
                value={name}
                onChangeText={setName}
                placeholder="feat/the-thing"
                autoCapitalize="none"
                autoCorrect={false}
                className="mt-2 h-9 text-sm"
                onSubmitEditing={() => void submit()}
              />
            </>
          )}

          {created ? (
            <Text className="mt-4 text-[12px] text-muted-foreground">
              Created {created}. It stays empty until something runs in it — launch an agent to see
              it in the sidebar.
            </Text>
          ) : null}

          {error ? (
            <Text className="mt-4 text-[12px] text-destructive" accessibilityLabel="Create failed">
              {error}
            </Text>
          ) : null}

          <View className="mt-5 flex-row justify-end gap-2">
            <Button variant="ghost" size="sm" onPress={onDismiss} disabled={busy}>
              <Text className="text-sm text-foreground">Cancel</Text>
            </Button>
            <Button variant="outline" size="sm" disabled={!canSubmit} onPress={() => void submit()}>
              <Text className="text-sm text-foreground">
                {busy ? "Creating" : kind === "agent" ? "Launch agent" : "Create worktree"}
              </Text>
            </Button>
          </View>

          {!endpoint ? (
            <Text className="mt-3 text-[12px] text-muted-foreground">
              The project host is not reachable, so nothing can be created yet.
            </Text>
          ) : null}
        </Card>
      </View>
    </Modal>
  );
}
