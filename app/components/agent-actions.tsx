import React, { useState } from "react";
import { View } from "react-native";
import { useSetAtom } from "jotai";
import { Play, Square, Trash2 } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import { killAgent, resumeAgent, stopAgent } from "@/lib/api";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { DesktopSession } from "@/lib/desktop-state";
import { cn } from "@/lib/utils";
import { kickDesktopStateRefreshAtom } from "@/stores/desktopState";
import { kickProjectApiViewRefreshAtom } from "@/stores/projectViews";

type LucideIcon = typeof Square;

export function AgentActions({
  session,
  endpoint,
  token,
  compact = false,
  onKilled,
}: {
  session: DesktopSession;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  compact?: boolean;
  onKilled?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kickDesktopRefresh = useSetAtom(kickDesktopStateRefreshAtom);
  const kickProjectViewRefresh = useSetAtom(kickProjectApiViewRefreshAtom);
  const canAct = !!endpoint && !busy;
  const isRunning = session.status === "running" || session.status === "waiting";

  function runAction(fn: () => Promise<unknown>, opts?: { isKill?: boolean }) {
    return async () => {
      if (!endpoint) return;
      setBusy(true);
      setError(null);
      try {
        await fn();
        kickDesktopRefresh();
        kickProjectViewRefresh();
        if (opts?.isKill) onKilled?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
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

  return (
    <View>
      <View className="flex-row items-center gap-1">
        {isRunning ? (
          <ActionButton
            icon={Square}
            iconSize={iconSize}
            sizeClass={sizeClass}
            onPress={runAction(() => stopAgent(endpoint, session.id, { token }))}
            disabled={!canAct}
            label={`Stop ${session.label || session.id}`}
          />
        ) : (
          <ActionButton
            icon={Play}
            iconSize={iconSize}
            sizeClass={sizeClass}
            onPress={runAction(() => resumeAgent(endpoint, session.id, { token }))}
            disabled={!canAct}
            label={`Resume ${session.label || session.id}`}
          />
        )}
        <ActionButton
          icon={Trash2}
          iconSize={iconSize}
          sizeClass={sizeClass}
          onPress={runAction(() => killAgent(endpoint, session.id, { token }), { isKill: true })}
          disabled={!canAct}
          label={`Kill ${session.label || session.id}`}
        />
      </View>
      {error ? <Text className="mt-1 text-[11px] text-destructive">{error}</Text> : null}
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
