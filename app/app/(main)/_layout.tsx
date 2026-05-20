import React, { useEffect, useRef } from "react";
import { Stack } from "expo-router";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { AppShell } from "@/components/AppShell";
import { getDesktopState, listProjects } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  desktopStateErrorFamily,
  desktopStateFamily,
  desktopStateRefreshNonceAtom,
} from "@/stores/desktopState";
import {
  reconcileProjectsAtom,
  selectedProjectEndpointAtom,
  selectedProjectPathAtom,
} from "@/stores/projects";

const POLL_INTERVAL_MS = 2000;

export default function MainLayout() {
  const reconcileProjects = useSetAtom(reconcileProjectsAtom);
  const selectedProjectPath = useAtomValue(selectedProjectPathAtom);
  const endpoint = useAtomValue(selectedProjectEndpointAtom);
  const refreshNonce = useAtomValue(desktopStateRefreshNonceAtom);
  const store = useStore();
  const { getToken } = useAuth();
  const tokenRef = useRef<string | null>(null);

  // Poll /projects every 2s; reconcile into the projects atom.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function loop() {
      if (cancelled) return;
      try {
        const token = await getToken();
        if (!cancelled) tokenRef.current = token;
        const projects = await listProjects({ token });
        if (!cancelled) reconcileProjects(projects);
      } catch (err) {
        // Failed fetches report inline per-operation; no global UI per task description.
        if (!cancelled) console.warn("project list refresh failed:", err);
      }
      if (cancelled) return;
      timer = setTimeout(loop, POLL_INTERVAL_MS);
    }

    void loop();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [getToken, reconcileProjects]);

  // Poll /desktop-state for the selected project every 2s. Re-triggers on
  // selection change and on a refresh-nonce bump (from optimistic mutations).
  // Keyed by host:port primitives so the timer survives project-list reconciles
  // that create new array identities.
  const endpointKey = endpoint ? `${endpoint.host}:${endpoint.port}` : null;
  useEffect(() => {
    if (!selectedProjectPath || !endpoint) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      if (cancelled) return;
      try {
        const token = await getToken();
        const state = await getDesktopState(endpoint!, { token });
        if (cancelled) return;
        store.set(desktopStateFamily(selectedProjectPath!), state);
        store.set(desktopStateErrorFamily(selectedProjectPath!), null);
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          store.set(desktopStateErrorFamily(selectedProjectPath!), msg);
          console.warn("desktop-state fetch failed:", err);
        }
      }
      if (cancelled) return;
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // endpoint is included as a value but we depend on endpointKey for stable identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectPath, endpointKey, refreshNonce, getToken, store]);

  return (
    <AppShell>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="agent/[sessionId]/chat" />
        <Stack.Screen name="plans/[sessionId]" />
        <Stack.Screen name="service/[serviceId]" />
        <Stack.Screen name="threads" />
        <Stack.Screen name="graveyard" />
        <Stack.Screen name="settings" />
      </Stack>
    </AppShell>
  );
}
