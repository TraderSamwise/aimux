import React, { useState } from "react";
import { Pressable, View } from "react-native";
import { useSetAtom } from "jotai";
import { Play, Square, Trash2 } from "lucide-react-native";
import { Text } from "@/components/ui/text";
import { removeService, resumeService, stopService } from "@/lib/api";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { DesktopService } from "@/lib/desktop-state";
import { cn } from "@/lib/utils";
import { kickDesktopStateRefreshAtom } from "@/stores/desktopState";

type LucideIcon = typeof Square;

function IconButton({
  icon: Icon,
  size,
  onPress,
  disabled,
  accessibilityLabel,
}: {
  icon: LucideIcon;
  size: number;
  onPress: () => void;
  disabled?: boolean;
  accessibilityLabel: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel}
      className={cn("p-1 rounded active:bg-accent/50", disabled && "opacity-40")}
    >
      <Icon size={size} color="#9ca3af" />
    </Pressable>
  );
}

// Inline Stop / Resume / Remove cluster used in the sidebar service row, the
// main-panel service card, and the service detail screen. Calls the matching
// API wrapper, bumps the refresh nonce on success, and surfaces failures via
// the optional `onError` callback (default: inline render via `error` state).
//
// `onRemoved` fires after a successful Remove so callers can navigate back if
// the screen they're on is the removed service's detail page.
export function ServiceActions({
  service,
  endpoint,
  token,
  iconSize = 14,
  onRemoved,
}: {
  service: DesktopService;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  iconSize?: number;
  onRemoved?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kickRefresh = useSetAtom(kickDesktopStateRefreshAtom);

  const canAct = !!endpoint && !busy;

  function runAction(fn: () => Promise<unknown>, opts?: { isRemove?: boolean }) {
    return async () => {
      if (!endpoint) return;
      setBusy(true);
      setError(null);
      try {
        await fn();
        kickRefresh();
        if (opts?.isRemove) onRemoved?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    };
  }

  if (!endpoint) {
    return <Text className="text-xs text-muted-foreground">service offline</Text>;
  }

  return (
    <View>
      <View className="flex-row gap-1">
        {service.status === "running" ? (
          <IconButton
            icon={Square}
            size={iconSize}
            onPress={runAction(() => stopService(endpoint, service.id, { token }))}
            disabled={!canAct}
            accessibilityLabel="Stop"
          />
        ) : (
          <IconButton
            icon={Play}
            size={iconSize}
            onPress={runAction(() => resumeService(endpoint, service.id, { token }))}
            disabled={!canAct}
            accessibilityLabel="Resume"
          />
        )}
        {service.status !== "running" ? (
          <IconButton
            icon={Trash2}
            size={iconSize}
            onPress={runAction(() => removeService(endpoint, service.id, { token }), {
              isRemove: true,
            })}
            disabled={!canAct}
            accessibilityLabel="Remove"
          />
        ) : null}
      </View>
      {error ? <Text className="text-xs text-destructive mt-1">{error}</Text> : null}
    </View>
  );
}
