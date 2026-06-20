import React, { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useLocalSearchParams, usePathname, useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { ChevronLeft } from "lucide-react-native";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { ServiceActions } from "@/components/service-actions";
import { StatusDot } from "@/components/status-dot";
import { getDesktopState } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { env } from "@/lib/env";
import { singleRouteParam } from "@/lib/route-params";
import { parentViewHrefForPath } from "@/lib/view-location";
import type { ServiceEndpoint } from "@/lib/daemon-url";
import type { DesktopService, WorktreeBucket } from "@/lib/desktop-state";
import { desktopStateFamily, worktreeGroupsFamily } from "@/stores/desktopState";
import { selectedProjectAtom, selectedProjectEndpointAtom } from "@/stores/projects";
import { relayStatusAtom } from "@/stores/relay";

function findService(
  groups: WorktreeBucket[],
  serviceId: string | undefined,
): { service: DesktopService; bucket: WorktreeBucket } | null {
  if (!serviceId) return null;
  for (const bucket of groups) {
    const service = bucket.services.find((s) => s.id === serviceId);
    if (service) return { service, bucket };
  }
  return null;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row mb-1">
      <Text className="text-xs text-muted-foreground w-28" numberOfLines={1}>
        {label}
      </Text>
      <Text className="text-sm text-foreground flex-1" selectable>
        {value}
      </Text>
    </View>
  );
}

export default function ServiceDetailScreen() {
  const params = useLocalSearchParams<{ serviceId?: string | string[] }>();
  const serviceId = singleRouteParam(params.serviceId);
  const project = useAtomValue(selectedProjectAtom);
  const endpoint = useAtomValue(selectedProjectEndpointAtom);
  const projectPath = project?.path ?? "";
  const groups = useAtomValue(worktreeGroupsFamily(projectPath));
  const setDesktopState = useSetAtom(desktopStateFamily(projectPath));
  const relayStatus = useAtomValue(relayStatusAtom);
  const router = useRouter();
  const pathname = usePathname();

  const { getToken } = useAuth();
  const [token, setToken] = useState<string | null>(null);
  const [loadingMissingService, setLoadingMissingService] = useState(false);
  const [missingServiceFetchKey, setMissingServiceFetchKey] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const t = await getToken();
        if (!cancelled) setToken(t);
      } catch {
        if (!cancelled) setToken(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken]);

  const found = useMemo(() => findService(groups, serviceId), [groups, serviceId]);
  const endpointKey = endpoint ? `${endpoint.host}:${endpoint.port}` : null;
  const relayReadyForRequests = !env.AIMUX_RELAY_URL || relayStatus === "connected";

  useEffect(() => {
    if (found || !endpoint || !endpointKey || !projectPath || !serviceId) return;
    if (!relayReadyForRequests) return;
    const fetchKey = `${projectPath}|${endpointKey}|${serviceId}`;
    if (missingServiceFetchKey === fetchKey) return;
    let cancelled = false;
    (async () => {
      setMissingServiceFetchKey(fetchKey);
      setLoadingMissingService(true);
      try {
        const currentToken = await getToken();
        const state = await getDesktopState(endpoint, { token: currentToken });
        if (!cancelled) setDesktopState(state);
      } catch (err) {
        console.warn("service detail desktop-state refresh failed:", err);
      } finally {
        if (!cancelled) setLoadingMissingService(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    endpoint,
    endpointKey,
    found,
    getToken,
    missingServiceFetchKey,
    projectPath,
    relayReadyForRequests,
    serviceId,
    setDesktopState,
  ]);

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace(parentViewHrefForPath(pathname, project?.path));
  }

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1 p-6">
        <Pressable onPress={goBack} className="flex-row items-center gap-1 mb-4 active:opacity-70">
          <ChevronLeft size={16} color="#9ca3af" />
          <Text className="text-sm text-muted-foreground">Back</Text>
        </Pressable>

        {!found && loadingMissingService ? (
          <Text className="text-sm text-muted-foreground">Loading service...</Text>
        ) : !found ? (
          <Text className="text-sm text-muted-foreground">
            Service not found. It may have been removed.
          </Text>
        ) : (
          <ServiceDetailBody
            service={found.service}
            bucket={found.bucket}
            endpoint={endpoint}
            token={token}
            onRemoved={goBack}
          />
        )}
      </ScrollView>
    </View>
  );
}

function ServiceDetailBody({
  service,
  bucket,
  endpoint,
  token,
  onRemoved,
}: {
  service: DesktopService;
  bucket: WorktreeBucket;
  endpoint: ServiceEndpoint | null;
  token: string | null;
  onRemoved: () => void;
}) {
  const title = service.label || service.id;
  const showSubtitle = !!service.label && service.label !== service.id;
  const args = service.args && service.args.length > 0 ? service.args.join(" ") : null;
  const worktreeLine = [bucket.name, bucket.branch, bucket.path].filter(Boolean).join(" · ");

  return (
    <>
      <View className="flex-row items-start mb-6">
        <View className="flex-1 min-w-0">
          <Text className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground mb-1.5">
            Service
          </Text>
          <Text
            className="text-[28px] font-bold text-foreground leading-tight"
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {title}
          </Text>
          {showSubtitle ? (
            <Text className="text-[12px] text-muted-foreground mt-1.5" numberOfLines={1}>
              {service.id}
            </Text>
          ) : null}
        </View>
        <View className="ml-3 mt-7">
          <ServiceActions
            service={service}
            endpoint={endpoint}
            token={token}
            onRemoved={onRemoved}
          />
        </View>
      </View>

      <Card className="p-5">
        <View className="flex-row items-center mb-3">
          <StatusDot status={service.status} size="md" />
          <Text className="text-[14px] font-semibold text-foreground ml-2.5">{service.status}</Text>
        </View>
        {worktreeLine ? <Row label="Worktree" value={worktreeLine} /> : null}
        {service.command ? <Row label="Command" value={service.command} /> : null}
        {args ? <Row label="Args" value={args} /> : null}
        {service.shellCommand ? <Row label="Shell" value={service.shellCommand} /> : null}
        {service.previewLine ? <Row label="Preview" value={service.previewLine} /> : null}
      </Card>
    </>
  );
}
