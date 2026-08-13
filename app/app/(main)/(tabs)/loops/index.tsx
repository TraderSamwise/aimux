import React, { useMemo, useState } from "react";
import { Pressable, View } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useAtomValue, useSetAtom } from "jotai";
import { Eye, RefreshCw, ShieldCheck, Target } from "lucide-react-native";
import { useColorScheme } from "nativewind";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { setAgentLoop, setAgentOverseer } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { DesktopSession, WorktreeBucket } from "@/lib/desktop-state";
import { detailHrefForPath } from "@/lib/view-location";
import { cn } from "@/lib/utils";
import { useRouteProject } from "@/lib/use-route-project";
import {
  desktopStateErrorFamily,
  desktopStateFamily,
  kickDesktopStateRefreshAtom,
  worktreeGroupsFamily,
} from "@/stores/desktopState";
import { kickProjectApiViewRefreshAtom } from "@/stores/projectViews";
import { selectedSessionIdAtom } from "@/stores/projects";

type BusyAction =
  | `loop:on:${string}`
  | `loop:off:${string}`
  | `overseer:on:${string}`
  | `overseer:off:${string}`;

interface SessionEntry {
  session: DesktopSession;
  worktree: WorktreeBucket;
  order: number;
}

const EMPTY_PROJECT_PATH = "__aimux_no_selected_project__";

export default function LoopsScreen() {
  const { colorScheme } = useColorScheme();
  const foregroundIconColor = colorScheme === "dark" ? "#fafafa" : "#09090b";
  const { project, projectPath, endpoint, projectLoading } = useRouteProject();
  const projectPathKey = projectPath ?? EMPTY_PROJECT_PATH;
  const state = useAtomValue(desktopStateFamily(projectPathKey));
  const stateError = useAtomValue(desktopStateErrorFamily(projectPathKey));
  const groups = useAtomValue(worktreeGroupsFamily(projectPathKey));
  const kickDesktopRefresh = useSetAtom(kickDesktopStateRefreshAtom);
  const kickProjectViewRefresh = useSetAtom(kickProjectApiViewRefreshAtom);
  const selectSession = useSetAtom(selectedSessionIdAtom);
  const { getToken } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [goalDrafts, setGoalDrafts] = useState<Record<string, string>>({});
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const entries = useMemo(() => flattenSessions(groups), [groups]);
  const overseer = useMemo(
    () => entries.find((entry) => entry.session.overseer === true) ?? null,
    [entries],
  );
  const watched = useMemo(
    () =>
      entries.filter(
        (entry) => entry.session.loop?.active === true && entry.session.overseer !== true,
      ),
    [entries],
  );
  const activeCandidates = useMemo(
    () => entries.filter((entry) => isManageableSession(entry.session)),
    [entries],
  );
  const watchCandidates = useMemo(
    () =>
      activeCandidates.filter(
        (entry) => entry.session.overseer !== true && entry.session.loop?.active !== true,
      ),
    [activeCandidates],
  );
  const overseerCandidates = useMemo(
    () =>
      activeCandidates.filter(
        (entry) => entry.session.overseer !== true && entry.session.loop?.active !== true,
      ),
    [activeCandidates],
  );
  const canMutate = Boolean(endpoint) && !busyAction;

  async function runAction(action: BusyAction, fn: () => Promise<void>, success: string) {
    if (!endpoint || busyAction) return;
    setBusyAction(action);
    setError(null);
    setMessage(null);
    try {
      await fn();
      kickDesktopRefresh();
      kickProjectViewRefresh([
        "agents",
        "desktop-state",
        "coordination-worklist",
        "project-observability",
        "team",
        "topology",
        "worktrees",
      ]);
      setMessage(success);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function watch(entry: SessionEntry) {
    const token = await getToken();
    const goal = (goalDrafts[entry.session.id] ?? "").trim();
    await setAgentLoop(
      endpoint!,
      { sessionId: entry.session.id, active: true, goal: goal || undefined },
      { token },
    );
    setGoalDrafts((current) => {
      const next = { ...current };
      delete next[entry.session.id];
      return next;
    });
  }

  function openAgent(entry: SessionEntry) {
    selectSession(entry.session.id);
    router.push(detailHrefForPath(pathname, "agent", entry.session.id, projectPath));
  }

  return (
    <Page contentClassName="px-4 py-5 md:px-8" contentStyle={{ maxWidth: 1180, width: "100%" }}>
      <PageHeader
        eyebrow="Project"
        title="Loop Overseer"
        subtitle={
          project
            ? `${project.name}${project.path ? ` · ${project.path}` : ""}`
            : projectLoading
              ? `Loading ${projectPath}`
              : "No project selected"
        }
        actions={
          <Button
            variant="outline"
            size="icon"
            disabled={!endpoint}
            onPress={() => kickDesktopRefresh()}
            accessibilityLabel="Refresh loop state"
          >
            <RefreshCw size={18} color={foregroundIconColor} />
          </Button>
        }
      />

      {projectLoading ? (
        <PageStateCard title="Loading project..." body="Fetching project state from the daemon." />
      ) : !project ? (
        <PageStateCard title="No project selected" body="Pick a project from the sidebar." />
      ) : !endpoint ? (
        <PageStateCard
          title="Project host offline"
          body="Start the project host to manage loop overseer state."
        />
      ) : !state && stateError ? (
        <PageStateCard title="Loop state failed" body={stateError} tone="danger" />
      ) : !state ? (
        <PageStateCard
          title="Loading loop state..."
          body="Agents and worktrees will appear once project state loads."
        />
      ) : (
        <View>
          <View className="mb-5 flex-row flex-wrap">
            <SummaryCard
              label="Overseer"
              value={overseer ? sessionLabel(overseer.session) : "None"}
            />
            <SummaryCard label="Watched" value={String(watched.length)} />
            <SummaryCard label="Available" value={String(watchCandidates.length)} />
          </View>

          {message ? <Notice tone="default" body={message} /> : null}
          {error ? <Notice tone="danger" body={error} /> : null}

          <Section title="Overseer" subtitle="One project-level loop runner owns follow-up state.">
            {overseer ? (
              <AgentRow
                entry={overseer}
                icon={ShieldCheck}
                detail="Project overseer"
                onOpen={() => openAgent(overseer)}
                actions={
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!canMutate}
                    onPress={() =>
                      runAction(
                        `overseer:off:${overseer.session.id}`,
                        async () => {
                          const token = await getToken();
                          await setAgentOverseer(
                            endpoint,
                            { sessionId: overseer.session.id, active: false },
                            { token },
                          );
                        },
                        "Overseer cleared",
                      )
                    }
                  >
                    <Text className="text-sm text-muted-foreground">
                      {busyAction === `overseer:off:${overseer.session.id}` ? "Clearing" : "Clear"}
                    </Text>
                  </Button>
                }
              />
            ) : (
              <EmptyText>No overseer set.</EmptyText>
            )}
            {overseerCandidates.length > 0 ? (
              <View className="mt-3">
                <Text className="mb-2 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  Make Overseer
                </Text>
                {overseerCandidates.map((entry) => (
                  <AgentRow
                    key={entry.session.id}
                    entry={entry}
                    icon={ShieldCheck}
                    onOpen={() => openAgent(entry)}
                    actions={
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canMutate}
                        onPress={() =>
                          runAction(
                            `overseer:on:${entry.session.id}`,
                            async () => {
                              const token = await getToken();
                              await setAgentOverseer(
                                endpoint,
                                { sessionId: entry.session.id, active: true },
                                { token },
                              );
                            },
                            "Overseer updated",
                          )
                        }
                      >
                        <Text className="text-sm text-foreground">
                          {busyAction === `overseer:on:${entry.session.id}` ? "Saving" : "Set"}
                        </Text>
                      </Button>
                    }
                  />
                ))}
              </View>
            ) : null}
          </Section>

          <Section title="Watched Agents" subtitle="Explicit loop membership stored on each agent.">
            {watched.length === 0 ? (
              <EmptyText>No agents are in the overseer loop.</EmptyText>
            ) : (
              watched.map((entry) => (
                <AgentRow
                  key={entry.session.id}
                  entry={entry}
                  icon={Eye}
                  detail={entry.session.loop?.goal || "Watching without a goal"}
                  onOpen={() => openAgent(entry)}
                  actions={
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canMutate}
                      onPress={() =>
                        runAction(
                          `loop:off:${entry.session.id}`,
                          async () => {
                            const token = await getToken();
                            await setAgentLoop(
                              endpoint,
                              { sessionId: entry.session.id, active: false },
                              { token },
                            );
                          },
                          "Agent removed from loop",
                        )
                      }
                    >
                      <Text className="text-sm text-muted-foreground">
                        {busyAction === `loop:off:${entry.session.id}` ? "Stopping" : "Stop"}
                      </Text>
                    </Button>
                  }
                />
              ))
            )}
          </Section>

          <Section title="Available Agents" subtitle="Add running agents to the overseer loop.">
            {watchCandidates.length === 0 ? (
              <EmptyText>No running agents are available to watch.</EmptyText>
            ) : (
              watchCandidates.map((entry) => (
                <AgentRow
                  key={entry.session.id}
                  entry={entry}
                  icon={Target}
                  onOpen={() => openAgent(entry)}
                  actions={
                    <View className="min-w-[220px] flex-row items-center gap-2">
                      <Input
                        accessibilityLabel={`Loop goal for ${sessionLabel(entry.session)}`}
                        value={goalDrafts[entry.session.id] ?? ""}
                        onChangeText={(value) =>
                          setGoalDrafts((current) => ({
                            ...current,
                            [entry.session.id]: value,
                          }))
                        }
                        placeholder="Optional goal"
                        className="h-9 min-w-[150px] flex-1 text-sm"
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canMutate}
                        onPress={() =>
                          runAction(
                            `loop:on:${entry.session.id}`,
                            () => watch(entry),
                            "Agent added to loop",
                          )
                        }
                      >
                        <Text className="text-sm text-foreground">
                          {busyAction === `loop:on:${entry.session.id}` ? "Adding" : "Watch"}
                        </Text>
                      </Button>
                    </View>
                  }
                />
              ))
            )}
          </Section>
        </View>
      )}
    </Page>
  );
}

function flattenSessions(groups: WorktreeBucket[]): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const group of groups) {
    for (const session of group.sessions) {
      entries.push({ session, worktree: group, order: entries.length });
    }
  }
  return entries.sort((a, b) => a.order - b.order);
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card className="mr-2 mb-2 min-w-[150px] flex-1 rounded-lg p-3">
      <Text className="text-[18px] font-bold leading-tight text-foreground" numberOfLines={1}>
        {value}
      </Text>
      <Text className="mt-1 text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
        {label}
      </Text>
    </Card>
  );
}

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <View className="mb-5">
      <View className="mb-2">
        <Text className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
          {title}
        </Text>
        <Text className="mt-0.5 text-xs text-muted-foreground">{subtitle}</Text>
      </View>
      <Card className="overflow-hidden rounded-xl p-0">{children}</Card>
    </View>
  );
}

function AgentRow({
  entry,
  icon: Icon,
  detail,
  actions,
  onOpen,
}: {
  entry: SessionEntry;
  icon: typeof Eye;
  detail?: string;
  actions: React.ReactNode;
  onOpen: () => void;
}) {
  const tone = statusTone(entry.session);
  return (
    <View className="border-b border-border px-4 py-3">
      <View className="flex-row flex-wrap items-center gap-3">
        <Pressable
          onPress={onOpen}
          className="min-w-[220px] flex-1 flex-row items-start gap-3 active:opacity-80"
        >
          <View className="mt-1 rounded-full bg-secondary p-2">
            <Icon size={15} color={tone} />
          </View>
          <View className="min-w-0 flex-1">
            <View className="flex-row items-center gap-2">
              <Text
                className="min-w-0 flex-shrink text-[14px] font-semibold text-foreground"
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {sessionLabel(entry.session)}
              </Text>
              <Text className="text-[11px] text-muted-foreground" numberOfLines={1}>
                {entry.session.toolConfigKey ??
                  entry.session.role ??
                  entry.session.command ??
                  "agent"}
              </Text>
            </View>
            <Text className="mt-0.5 text-xs text-muted-foreground" numberOfLines={1}>
              {[entry.worktree.name, entry.session.status].filter(Boolean).join(" · ")}
            </Text>
            {detail ? (
              <Text className="mt-1 text-xs text-muted-foreground" numberOfLines={2}>
                {detail}
              </Text>
            ) : null}
          </View>
        </Pressable>
        <View className="ml-auto">{actions}</View>
      </View>
    </View>
  );
}

function Notice({ tone, body }: { tone: "default" | "danger"; body: string }) {
  return (
    <Card
      className={cn(
        "mb-4 rounded-lg px-4 py-3",
        tone === "danger" && "border-destructive/50 bg-destructive/10",
      )}
    >
      <Text className={cn("text-sm", tone === "danger" ? "text-destructive" : "text-foreground")}>
        {body}
      </Text>
    </Card>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return (
    <View className="px-4 py-4">
      <Text className="text-sm text-muted-foreground">{children}</Text>
    </View>
  );
}

function sessionLabel(session: DesktopSession): string {
  return session.label || session.command || session.id;
}

function statusTone(session: DesktopSession): string {
  if (session.overseer) return "#38bdf8";
  if (session.loop?.active) return "#a78bfa";
  if (session.status === "offline") return "#71717a";
  if (session.status === "waiting") return "#f59e0b";
  return "#22c55e";
}

function isManageableSession(session: DesktopSession): boolean {
  return session.status === "running" || session.status === "idle" || session.status === "waiting";
}
