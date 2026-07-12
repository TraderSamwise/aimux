import React, { useState } from "react";
import { View } from "react-native";
import { useSetAtom } from "jotai";
import { Play, Square, Trash2 } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { removeService, resumeService, stopService } from "@/lib/api";
import type { ProjectLifecycleTransition } from "../../src/project-api-contract";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { DesktopService } from "@/lib/desktop-state";
import { cn } from "@/lib/utils";
import { kickDesktopStateRefreshAtom } from "@/stores/desktopState";
import {
  failLocalProjectLifecycleTransition,
  localProjectLifecycleTransition,
  recordProjectLifecycleTransitionAtom,
} from "@/stores/lifecycleTransitions";
import { kickProjectApiViewRefreshAtom } from "@/stores/projectViews";

type LucideIcon = typeof Square;

export function ServiceActions({
  service,
  endpoint,
  token,
  projectPath,
  compact = false,
  onRemoved,
}: {
  service: DesktopService;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  projectPath: string;
  compact?: boolean;
  onRemoved?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kickRefresh = useSetAtom(kickDesktopStateRefreshAtom);
  const kickProjectViewRefresh = useSetAtom(kickProjectApiViewRefreshAtom);
  const recordTransition = useSetAtom(recordProjectLifecycleTransitionAtom);

  const hasPendingAction = Boolean(service.pendingAction);
  const canAct = !!endpoint && !busy && !hasPendingAction;

  function runAction(
    fn: () => Promise<{ transition?: ProjectLifecycleTransition }>,
    opts?: { isRemove?: boolean; localTransition?: () => ProjectLifecycleTransition },
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
          label: service.label || service.id,
          worktreePath: service.worktreePath,
        });
      }
      try {
        const response = await fn();
        recordTransition({
          projectPath,
          transition: response.transition,
          label: service.label || service.id,
          worktreePath: service.worktreePath,
        });
        kickRefresh();
        kickProjectViewRefresh(["services", "project-observability", "topology"]);
        if (opts?.isRemove) onRemoved?.();
      } catch (e) {
        if (localTransition) {
          recordTransition({
            projectPath,
            transition: failLocalProjectLifecycleTransition(localTransition),
            label: service.label || service.id,
            worktreePath: service.worktreePath,
          });
        }
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };
  }

  if (!endpoint) {
    return compact ? null : <Text className="text-xs text-muted-foreground">service offline</Text>;
  }

  const sizeClass = compact ? "h-7 w-7" : "h-9 w-9";
  const iconSize = compact ? 13 : 15;
  const gap = compact ? "ml-1" : "ml-1.5";

  return (
    <View>
      <View className="flex-row items-center">
        {service.status === "running" ? (
          <ActionButton
            icon={Square}
            iconSize={iconSize}
            sizeClass={sizeClass}
            onPress={runAction(() => stopService(endpoint, service.id, { token }), {
              localTransition: () =>
                localProjectLifecycleTransition({
                  operation: "service.stop",
                  targetKind: "service",
                  targetId: service.id,
                }),
            })}
            disabled={!canAct}
            label="Stop"
          />
        ) : (
          <ActionButton
            icon={Play}
            iconSize={iconSize}
            sizeClass={sizeClass}
            onPress={runAction(() => resumeService(endpoint, service.id, { token }), {
              localTransition: () =>
                localProjectLifecycleTransition({
                  operation: "service.resume",
                  targetKind: "service",
                  targetId: service.id,
                }),
            })}
            disabled={!canAct}
            label="Resume"
          />
        )}
        {service.status !== "running" ? (
          <View className={gap}>
            <ActionButton
              icon={Trash2}
              iconSize={iconSize}
              sizeClass={sizeClass}
              onPress={runAction(() => removeService(endpoint, service.id, { token }), {
                isRemove: true,
                localTransition: () =>
                  localProjectLifecycleTransition({
                    operation: "service.remove",
                    targetKind: "service",
                    targetId: service.id,
                  }),
              })}
              disabled={!canAct}
              label="Remove"
            />
          </View>
        ) : null}
      </View>
      {error ? <Text className="text-[11px] text-destructive mt-1">{error}</Text> : null}
    </View>
  );
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
