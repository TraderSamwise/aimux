import React, { useState } from "react";
import { View } from "react-native";
import { useSetAtom } from "jotai";
import { GitFork, Play, Square, Trash2 } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { forkAgent, killAgent, resumeAgent, stopAgent } from "@/lib/api";
import type { ProjectLifecycleTransition } from "../../src/project-api-contract";
import { canResumeSession } from "@/lib/agent-lifecycle";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { DesktopSession } from "@/lib/desktop-state";
import { isTransientRequestError } from "@/lib/request-errors";
import { firstTokenOf } from "@/lib/status-tone";
import { cn } from "@/lib/utils";
import { kickDesktopStateRefreshAtom } from "@/stores/desktopState";
import {
  failLocalProjectLifecycleTransition,
  localProjectLifecycleTransition,
  recordProjectLifecycleTransitionAtom,
} from "@/stores/lifecycleTransitions";
import { kickProjectApiViewRefreshAtom } from "@/stores/projectViews";

type LucideIcon = typeof Square;

const AGENT_ACTION_REFRESH_VIEWS = [
  "agents",
  "project-observability",
  "topology",
  "coordination-worklist",
  "team",
  "worktrees",
] as const;

export function AgentActions({
  session,
  endpoint,
  token,
  projectPath,
  compact = false,
  mainCheckoutPath,
  onKilled,
}: {
  session: DesktopSession;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  projectPath: string;
  compact?: boolean;
  mainCheckoutPath?: string | null;
  onKilled?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kickDesktopRefresh = useSetAtom(kickDesktopStateRefreshAtom);
  const kickProjectViewRefresh = useSetAtom(kickProjectApiViewRefreshAtom);
  const recordTransition = useSetAtom(recordProjectLifecycleTransitionAtom);
  const hasPendingAction = Boolean(session.pendingAction);
  const canAct = !!endpoint && !busy && !hasPendingAction;
  const isRunning =
    session.status === "running" || session.status === "waiting" || session.status === "idle";
  const canResume = canResumeSession(session);
  const resumeBlocked =
    (session.status === "offline" || session.status === "exited") &&
    session.restoreState === "blocked";
  const resumeBlockedReason = session.restoreBlockedReason ?? "resume is unavailable";
  const forkTool = agentToolForFork(session);
  const forkWorktreePath =
    session.worktreePath && session.worktreePath !== mainCheckoutPath
      ? session.worktreePath
      : undefined;

  function runAction(
    fn: () => Promise<{ transition?: ProjectLifecycleTransition }>,
    opts?: { isKill?: boolean; localTransition?: () => ProjectLifecycleTransition },
  ) {
    return async () => {
      if (!endpoint) return;
      setBusy(true);
      setError(null);
      const localTransition = opts?.localTransition?.();
      if (localTransition) {
        recordTransition({
          projectPath,
          transition: localTransition,
          label: session.label || session.id,
          tool: forkTool || session.toolConfigKey || firstTokenOf(session.command),
          worktreePath: session.worktreePath,
        });
      }
      try {
        const response = await fn();
        recordTransition({
          projectPath,
          transition: response.transition,
          label: session.label || session.id,
          tool: forkTool || session.toolConfigKey || firstTokenOf(session.command),
          worktreePath: session.worktreePath,
        });
        kickDesktopRefresh();
        kickProjectViewRefresh(
          opts?.isKill ? [...AGENT_ACTION_REFRESH_VIEWS, "graveyard"] : AGENT_ACTION_REFRESH_VIEWS,
        );
        if (opts?.isKill) onKilled?.();
      } catch (e) {
        if (localTransition) {
          recordTransition({
            projectPath,
            transition: failLocalProjectLifecycleTransition(localTransition),
            label: session.label || session.id,
            tool: forkTool || session.toolConfigKey || firstTokenOf(session.command),
            worktreePath: session.worktreePath,
          });
        }
        if (!isTransientRequestError(e)) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setBusy(false);
      }
    };
  }

  if (!endpoint) {
    return compact ? null : <Text className="text-xs text-muted-foreground">controls offline</Text>;
  }

  const sizeClass = compact ? "h-7 w-7" : "h-9 w-9";
  const iconSize = compact ? 13 : 15;
  const visibleError = error && !isTransientRequestError(error) ? error : null;

  return (
    <View>
      <View className="flex-row items-center gap-1">
        {isRunning ? (
          <ActionButton
            icon={Square}
            iconSize={iconSize}
            sizeClass={sizeClass}
            onPress={runAction(() => stopAgent(endpoint, session.id, { token }), {
              localTransition: () =>
                localProjectLifecycleTransition({
                  operation: "agent.stop",
                  targetKind: "agent",
                  targetId: session.id,
                }),
            })}
            disabled={!canAct}
            label={`Stop ${session.label || session.id}`}
          />
        ) : canResume ? (
          <ActionButton
            icon={Play}
            iconSize={iconSize}
            sizeClass={sizeClass}
            onPress={runAction(() => resumeAgent(endpoint, session.id, { token }), {
              localTransition: () =>
                localProjectLifecycleTransition({
                  operation: "agent.resume",
                  targetKind: "agent",
                  targetId: session.id,
                }),
            })}
            disabled={!canAct}
            label={`Resume ${session.label || session.id}`}
          />
        ) : resumeBlocked ? (
          <ActionButton
            icon={Play}
            iconSize={iconSize}
            sizeClass={sizeClass}
            onPress={() => undefined}
            disabled
            label={`Resume unavailable for ${session.label || session.id}: ${resumeBlockedReason}`}
          />
        ) : null}
        {forkTool ? (
          <ActionButton
            icon={GitFork}
            iconSize={iconSize}
            sizeClass={sizeClass}
            onPress={runAction(() =>
              forkAgent(
                endpoint,
                {
                  sourceSessionId: session.id,
                  tool: forkTool,
                  worktreePath: forkWorktreePath,
                  open: false,
                },
                { token },
              ),
            )}
            disabled={!canAct}
            label={`Fork ${session.label || session.id}`}
          />
        ) : null}
        <ActionButton
          icon={Trash2}
          iconSize={iconSize}
          sizeClass={sizeClass}
          onPress={runAction(() => killAgent(endpoint, session.id, { token }), {
            isKill: true,
            localTransition: () =>
              localProjectLifecycleTransition({
                operation: "agent.kill",
                targetKind: "agent",
                targetId: session.id,
              }),
          })}
          disabled={!canAct}
          label={`Kill ${session.label || session.id}`}
        />
      </View>
      {visibleError ? (
        <Text className="mt-1 text-[11px] text-destructive">{visibleError}</Text>
      ) : null}
    </View>
  );
}

const FALLBACK_FORK_TOOLS = new Set(["claude", "codex", "aider"]);

function agentToolForFork(session: DesktopSession): string {
  if (session.toolConfigKey) return session.toolConfigKey;
  const commandTool = firstTokenOf(session.command);
  return FALLBACK_FORK_TOOLS.has(commandTool) ? commandTool : "";
}

function ActionButton({
  icon: Icon,
  iconSize,
  sizeClass,
  onPress,
  disabled,
  label,
}: {
  icon: LucideIcon;
  iconSize: number;
  sizeClass: string;
  onPress: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <Button
      variant="outline"
      size="icon"
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      className={cn("p-0", sizeClass)}
    >
      <Icon size={iconSize} color="#a1a1aa" />
    </Button>
  );
}
