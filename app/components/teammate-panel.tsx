import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import { useAtomValue, useSetAtom } from "jotai";
import { Play, RefreshCw, Send, Square, Trash2, Users } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import {
  createTeammate,
  createTeammateTask,
  killTeammate,
  listTeammates,
  resumeTeammate,
  stopTeammate,
  type TeammateListResponse,
} from "@/lib/api";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { DesktopSession } from "@/lib/desktop-state";
import { cn } from "@/lib/utils";
import { kickDesktopStateRefreshAtom } from "@/stores/desktopState";
import {
  kickProjectApiViewRefreshAtom,
  projectApiViewRefreshNonceAtom,
} from "@/stores/projectViews";

type Teammate = TeammateListResponse["teammates"][number];
type TeammateAction = "refresh" | "create" | "task" | "stop" | "resume" | "kill";

export function TeammatePanel({
  session,
  endpoint,
  token,
}: {
  session: DesktopSession;
  endpoint: ServiceEndpoint | null;
  token: string | null;
}) {
  const [teammates, setTeammates] = useState<Teammate[]>([]);
  const [role, setRole] = useState("coder");
  const [label, setLabel] = useState("");
  const [taskBody, setTaskBody] = useState("");
  const [selectedTeammateId, setSelectedTeammateId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<TeammateAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const actionRef = useRef<TeammateAction | null>(null);
  const refreshNonce = useAtomValue(projectApiViewRefreshNonceAtom);
  const kickDesktopRefresh = useSetAtom(kickDesktopStateRefreshAtom);
  const kickProjectViewRefresh = useSetAtom(kickProjectApiViewRefreshAtom);

  const selectedTeammate = useMemo(
    () => teammates.find((teammate) => teammate.id === selectedTeammateId) ?? teammates[0] ?? null,
    [selectedTeammateId, teammates],
  );
  const trimmedRole = role.trim() || "coder";
  const trimmedLabel = label.trim();
  const trimmedTask = taskBody.trim();
  const canAct = Boolean(endpoint) && !busyAction;
  const canCreate = canAct && Boolean(session.id);
  const canAssignTask = canAct && Boolean(selectedTeammate?.id) && Boolean(trimmedTask);

  const applyTeammates = useCallback((result: TeammateListResponse) => {
    setTeammates(result.teammates);
    setSelectedTeammateId((current) =>
      result.teammates.some((teammate) => teammate.id === current)
        ? current
        : (result.teammates[0]?.id ?? null),
    );
  }, []);

  async function refreshTeammates(nextStatus?: string) {
    if (!endpoint || actionRef.current) return;
    actionRef.current = "refresh";
    setBusyAction("refresh");
    setError(null);
    try {
      const result = await listTeammates(endpoint, session.id, { token });
      applyTeammates(result);
      if (nextStatus) setStatus(nextStatus);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      actionRef.current = null;
      setBusyAction(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    if (!endpoint) return undefined;
    listTeammates(endpoint, session.id, { token })
      .then((result) => {
        if (cancelled) return;
        setError(null);
        applyTeammates(result);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [applyTeammates, endpoint, refreshNonce, session.id, token]);

  async function runMutation(
    action: TeammateAction,
    fn: () => Promise<unknown>,
    nextStatus: string,
  ): Promise<boolean> {
    if (!endpoint || actionRef.current) return false;
    actionRef.current = action;
    setBusyAction(action);
    setError(null);
    setStatus(null);
    try {
      await fn();
      kickDesktopRefresh();
      kickProjectViewRefresh();
      applyTeammates(await listTeammates(endpoint, session.id, { token }));
      setStatus(nextStatus);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      actionRef.current = null;
      setBusyAction(null);
    }
  }

  async function handleCreateTeammate() {
    if (!endpoint || !canCreate) return;
    const initialTask = trimmedTask
      ? { body: trimmedTask, worktreePath: session.worktreePath }
      : undefined;
    const created = await runMutation(
      "create",
      () =>
        createTeammate(
          endpoint,
          {
            parentSessionId: session.id,
            role: trimmedRole,
            label: trimmedLabel || undefined,
            worktreePath: session.worktreePath,
            open: false,
            initialTask,
          },
          { token },
        ),
      initialTask ? "Teammate created and tasked." : "Teammate created.",
    );
    if (created) {
      setLabel("");
      if (initialTask) setTaskBody("");
    }
  }

  async function handleAssignTask() {
    if (!endpoint || !selectedTeammate?.id || !canAssignTask) return;
    const assigned = await runMutation(
      "task",
      () =>
        createTeammateTask(
          endpoint,
          {
            parentSessionId: session.id,
            teammateSessionId: selectedTeammate.id,
            body: trimmedTask,
            worktreePath: selectedTeammate.worktreePath ?? session.worktreePath,
          },
          { token },
        ),
      "Task assigned.",
    );
    if (assigned) setTaskBody("");
  }

  if (!endpoint) return null;

  return (
    <Card className="border-b border-border rounded-none border-x-0 border-t-0 p-4">
      <View className="flex-row flex-wrap items-start gap-4">
        <View className="min-w-[260px] flex-1">
          <PanelLabel label="Team" />
          <View className="mt-2 flex-row gap-2">
            <Input
              value={role}
              onChangeText={setRole}
              placeholder="Role"
              className="h-9 w-28 text-sm"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Input
              value={label}
              onChangeText={setLabel}
              placeholder="Label"
              className="h-9 flex-1 text-sm"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!canCreate}
              onPress={handleCreateTeammate}
            >
              <Text className="text-sm text-foreground">
                {busyAction === "create" ? "Creating" : "Create"}
              </Text>
            </Button>
          </View>
          <View className="mt-3 flex-row flex-wrap gap-2">
            {teammates.length > 0 ? (
              teammates.map((teammate) => (
                <TeammateChip
                  key={teammate.id}
                  teammate={teammate}
                  active={selectedTeammate?.id === teammate.id}
                  onPress={() => setSelectedTeammateId(teammate.id)}
                />
              ))
            ) : (
              <Text className="text-xs text-muted-foreground">No teammates</Text>
            )}
          </View>
        </View>

        <View className="min-w-[300px] flex-[1.4]">
          <PanelLabel label="Task" />
          <View className="mt-2 flex-row gap-2">
            <Input
              value={taskBody}
              onChangeText={setTaskBody}
              placeholder={
                selectedTeammate ? `Task ${displayTeammateName(selectedTeammate)}` : "Task teammate"
              }
              className="min-h-9 flex-1 py-2 text-sm"
              multiline
              textAlignVertical="top"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!canAssignTask}
              onPress={handleAssignTask}
            >
              <Text className="text-sm text-foreground">
                {busyAction === "task" ? "Sending" : "Assign"}
              </Text>
            </Button>
          </View>
        </View>

        <View className="min-w-[220px]">
          <PanelLabel label="Lifecycle" />
          <View className="mt-2 flex-row flex-wrap gap-2">
            <IconButton
              label="Refresh"
              disabled={!canAct}
              busy={busyAction === "refresh"}
              onPress={() => void refreshTeammates("Teammates refreshed.")}
            />
            <IconButton
              label="Stop"
              disabled={!canAct || !selectedTeammate || selectedTeammate.status === "offline"}
              busy={busyAction === "stop"}
              onPress={() =>
                selectedTeammate
                  ? void runMutation(
                      "stop",
                      () => stopTeammate(endpoint, session.id, selectedTeammate.id, { token }),
                      "Teammate stopped.",
                    )
                  : undefined
              }
            />
            <IconButton
              label="Resume"
              disabled={!canAct || !selectedTeammate || selectedTeammate.status !== "offline"}
              busy={busyAction === "resume"}
              onPress={() =>
                selectedTeammate
                  ? void runMutation(
                      "resume",
                      () => resumeTeammate(endpoint, session.id, selectedTeammate.id, { token }),
                      "Teammate resumed.",
                    )
                  : undefined
              }
            />
            <IconButton
              label="Kill"
              destructive
              disabled={!canAct || !selectedTeammate}
              busy={busyAction === "kill"}
              onPress={() =>
                selectedTeammate
                  ? void runMutation(
                      "kill",
                      () => killTeammate(endpoint, session.id, selectedTeammate.id, { token }),
                      "Teammate killed.",
                    )
                  : undefined
              }
            />
          </View>
        </View>
      </View>
      {error ? <Text className="mt-3 text-xs text-destructive">{error}</Text> : null}
      {status ? <Text className="mt-3 text-xs text-muted-foreground">{status}</Text> : null}
    </Card>
  );
}

function PanelLabel({ label }: { label: string }) {
  return (
    <View className="flex-row items-center gap-2">
      <Users size={13} color="#a1a1aa" />
      <Text className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        {label}
      </Text>
    </View>
  );
}

function TeammateChip({
  teammate,
  active,
  onPress,
}: {
  teammate: Teammate;
  active: boolean;
  onPress: () => void;
}) {
  const status = typeof teammate.status === "string" ? teammate.status : "unknown";
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      className={cn(
        "rounded-md border px-2.5 py-1.5",
        active ? "border-primary bg-primary/10" : "border-border bg-background",
      )}
    >
      <Text className={cn("text-xs", active ? "text-primary" : "text-foreground")}>
        {displayTeammateName(teammate)}
      </Text>
      <Text className="mt-0.5 text-[10px] text-muted-foreground">{status}</Text>
    </Pressable>
  );
}

function IconButton({
  label,
  disabled,
  busy,
  destructive,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  busy?: boolean;
  destructive?: boolean;
  onPress: () => void;
}) {
  const Icon =
    label === "Refresh"
      ? RefreshCw
      : label === "Stop"
        ? Square
        : label === "Resume"
          ? Play
          : label === "Kill"
            ? Trash2
            : Send;
  return (
    <Button
      variant={destructive ? "ghost" : "outline"}
      size="sm"
      disabled={disabled}
      onPress={onPress}
      className="gap-1.5"
    >
      <Icon size={12} color={destructive ? "#ef4444" : "#a1a1aa"} />
      <Text className={cn("text-sm", destructive ? "text-destructive" : "text-foreground")}>
        {busy ? `${label}...` : label}
      </Text>
    </Button>
  );
}

function displayTeammateName(teammate: Teammate): string {
  const label = typeof teammate.label === "string" ? teammate.label.trim() : "";
  const role = typeof teammate.role === "string" ? teammate.role.trim() : "";
  return label || role || teammate.id;
}
