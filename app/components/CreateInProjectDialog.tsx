import React, { useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSetAtom } from "jotai";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Text } from "@/components/ui/text";
import { createWorktree, spawnAgent } from "@/lib/api";
import {
  AGENT_TOOL_CHOICES,
  agentCreationRole,
  agentCreationPolicyIsAvailable,
  type AgentCreationTarget,
  AGENT_CREATION_REFRESH_VIEWS,
  WORKTREE_CREATION_REFRESH_VIEWS,
  creatableWorktreeChoices,
  canSubmitCreation,
  choicesIncludingJustCreated,
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

import type { AgentCreationPolicy } from "../../src/project-api-contract";

type CreateKind = "agent" | "worktree";

/**
 * Creations in flight, by project.
 *
 * Module scope rather than a ref, because Cancel unmounts the dialog without
 * stopping the request: a ref is recreated on reopen, so a second submit could
 * launch another agent while the first was still going. The `finally` that
 * clears this runs whether or not the dialog is still on screen.
 */
const CREATIONS_IN_FLIGHT = new Set<string>();

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
      accessibilityLabel={label}
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
  agentCreation,
  onDismiss,
}: {
  endpoint: ServiceEndpoint | null;
  token: string | null;
  projectStateKey: ProjectStateKey;
  groups: WorktreeBucket[];
  agentCreation?: AgentCreationPolicy;
  onDismiss: () => void;
}) {
  const [kind, setKind] = useState<CreateKind>("agent");
  const [tool, setTool] = useState<AgentToolChoice>("claude");
  const [targetOverride, setTarget] = useState<AgentCreationTarget | null>(null);
  const target = targetOverride ?? agentCreation?.defaultTarget;
  const [worktreePath, setWorktreePath] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    name: string;
    path: string;
    alreadyUnderway: boolean;
  } | null>(null);
  const kickDesktopRefresh = useSetAtom(kickDesktopStateRefreshAtom);
  const kickProjectViewRefresh = useSetAtom(kickProjectApiViewRefreshAtom);
  const recordTransition = useSetAtom(recordProjectLifecycleTransitionAtom);

  const worktreeChoices = useMemo(
    () => choicesIncludingJustCreated(groups, creatableWorktreeChoices(groups), created),
    [groups, created],
  );
  // Re-read every render rather than trusted from state: a worktree can be
  // removed while this dialog is open, and launching into a path that is gone
  // fails in a way nobody could have predicted from the form.
  const selectedWorktreePath = isSelectableWorktreePath(worktreeChoices, worktreePath)
    ? worktreePath
    : null;
  const trimmedName = name.trim();
  const policyUnavailable = !agentCreationPolicyIsAvailable(agentCreation);
  const canSubmit =
    canSubmitCreation({ kind, hasEndpoint: Boolean(endpoint), busy, name }) &&
    (kind !== "agent" || !policyUnavailable);

  async function submit() {
    // Keyed on the project, not on this component: two taps 40ms apart both
    // read `busy` as false, the name field submits on return as a second
    // trigger, and dismissing mid-flight and reopening would otherwise reset
    // the guard entirely.
    const flightKey = `${projectStateKey}:${kind}`;
    if (!endpoint || !canSubmit || CREATIONS_IN_FLIGHT.has(flightKey)) return;
    CREATIONS_IN_FLIGHT.add(flightKey);
    setBusy(true);
    setError(null);
    try {
      if (kind === "agent") {
        const response = await spawnAgent(
          endpoint,
          {
            tool,
            role: agentCreationRole(agentCreation, target),
            worktreePath: target === "worktree" ? (selectedWorktreePath ?? undefined) : undefined,
            open: false,
          },
          { token },
        );
        recordTransition({
          projectStateKey,
          transition: response.transition,
          label: response.sessionId,
          tool,
          worktreePath: target === "worktree" ? (selectedWorktreePath ?? undefined) : undefined,
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
      const createdPath = response.path ?? null;
      // `creating` means a create for this path was ALREADY in flight and the
      // route answered idempotently -- a 200 for something it did not do.
      // Saying "Created" there claims someone else's work as this tap's.
      const alreadyUnderway = response.status === "creating";
      setCreated(createdPath ? { name: trimmedName, path: createdPath, alreadyUnderway } : null);
      setName("");
      setWorktreePath(createdPath);
      setTarget("worktree");
      setKind("agent");
    } catch (e) {
      // Shown verbatim: the route is the thing that knows a name is taken,
      // and it names the path. A guess made here would be wrong in both
      // directions. A transient error still says SOMETHING -- swallowing it
      // left the button back at "Launch agent" and the dialog open, which
      // looks exactly like never having tapped it.
      setError(
        isTransientRequestError(e)
          ? "Lost contact with the project host, so it is not known whether this was created. Check the project before trying again."
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      CREATIONS_IN_FLIGHT.delete(flightKey);
      setBusy(false);
    }
  }

  return (
    <Modal transparent visible animationType="fade" statusBarTranslucent onRequestClose={onDismiss}>
      <Pressable
        onPress={onDismiss}
        style={StyleSheet.absoluteFill}
        className="bg-black/60"
        accessibilityLabel="Dismiss"
      />
      {/* iOS Modals do not resize for the keyboard, and the worktree step
          opens it immediately because the name is its only field -- without
          this, both buttons sit under the keyboard on a small phone. */}
      <KeyboardAvoidingView
        className="flex-1 items-center justify-center p-6"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        pointerEvents="box-none"
      >
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
                    label="Supervisor Lane"
                    active={target === "supervisor"}
                    onPress={() => setTarget("supervisor")}
                  />
                  <ChoiceChip
                    label="Main checkout"
                    active={target === "worktree" && selectedWorktreePath === null}
                    onPress={() => {
                      setTarget("worktree");
                      setWorktreePath(null);
                    }}
                  />
                  {worktreeChoices.map((choice) => (
                    <ChoiceChip
                      key={choice.key}
                      label={choice.label}
                      active={target === "worktree" && selectedWorktreePath === choice.path}
                      onPress={() => {
                        setTarget("worktree");
                        setWorktreePath(choice.path);
                      }}
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
              {created.alreadyUnderway
                ? `${created.name} was already being created — this did not start a second one.`
                : `Created ${created.name}.`}{" "}
              It stays empty until something runs in it — launch an agent to see it in the sidebar.
            </Text>
          ) : null}

          {kind === "agent" && policyUnavailable ? (
            <Text
              className="mt-4 text-[12px] text-destructive"
              accessibilityLabel="Creation policy unavailable"
            >
              Agent creation policy is unavailable from the project host. Refresh project state
              before launching an agent.
            </Text>
          ) : null}

          {error ? (
            <Text className="mt-4 text-[12px] text-destructive" accessibilityLabel="Create failed">
              {error}
            </Text>
          ) : null}

          <View className="mt-5 flex-row justify-end gap-2">
            {/* Never disabled. These are queued lifecycle routes with a long
                timeout -- 120s to spawn, 180s to create a worktree -- so a
                disabled Cancel meant minutes trapped behind a dialog whose
                only other exit is the backdrop the keyboard sits on. It
                abandons rather than cancels: the request carries on, and what
                it created appears at the next poll. */}
            <Button variant="ghost" size="sm" onPress={onDismiss}>
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
      </KeyboardAvoidingView>
    </Modal>
  );
}
