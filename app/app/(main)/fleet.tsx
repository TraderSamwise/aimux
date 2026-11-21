import React, { useCallback, useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { useAtomValue, useSetAtom } from "jotai";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { UsageMonitor } from "@/components/UsageMonitor";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { credentialProfileView, profileDirectories } from "@/lib/credential-profile-view";
import { canClaimSwarmHost, swarmHostView } from "@/lib/swarm-host-view";
import { machineTargets, selectableMachines } from "@/lib/machine-targets";
import {
  getCredentialProfiles,
  getFleetUsage,
  getSwarmHost,
  setCredentialProfile,
  setSwarmHost,
  type CredentialProfile,
  type CredentialProfilesResponse,
  type FleetUsageMachine,
  type FleetUsageResponse,
  type SwarmHostResponse,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import {
  applyFleetUsageFailureAtom,
  applyFleetUsageSuccessAtom,
  beginFleetUsageRefreshAtom,
  fleetUsageRequestKey,
  fleetUsageResourceAtom,
} from "@/stores/fleet";

/**
 * What a machine has left, or why it did not say.
 *
 * The three outcomes the report draws are kept apart here, because collapsing
 * any two of them is the whole class of bug this feature was built against: a
 * machine that answered, a machine that answered badly, and a machine that
 * never answered are not the same thing.
 */
function MachineCard({ machine }: { machine: FleetUsageMachine }) {
  const snapshot = machine.usage?.usage;
  // A peer can answer 200 and still carry its own error -- a project service
  // that could not collect usage. That is the peer's words, so it is shown
  // rather than replaced with a generic failure.
  const peerError = machine.usage?.error;
  return (
    <Card className="mb-3 p-4">
      <View className="mb-2 flex-row items-center justify-between">
        <Text className="font-mono text-sm font-semibold">{machine.machineId}</Text>
        {machine.ok ? null : (
          <Text className="font-mono text-xs text-[#f0a0a0]">
            {machine.status == null ? "no answer" : `answered ${machine.status}`}
          </Text>
        )}
      </View>
      {machine.error ? (
        <Text className="font-mono text-xs text-muted-foreground">{machine.error}</Text>
      ) : null}
      {peerError ? (
        <Text className="font-mono text-xs text-muted-foreground">{peerError}</Text>
      ) : null}
      {snapshot ? (
        <UsageMonitor usage={snapshot} />
      ) : machine.error || peerError ? null : (
        <Text className="font-mono text-xs text-muted-foreground">
          This machine reported no usage lines.
        </Text>
      )}
    </Card>
  );
}

/**
 * Which credential profile this machine launches agents with, and a tap to
 * change it.
 *
 * Per MACHINE, because that is what a profile is. It acts on the machine this
 * app is talking to, which the relay resolves when the account has one and
 * which the machine selector names when it has several -- multi-machine
 * switching from one screen needs that selector wired in, and is not here yet.
 */
function CredentialProfilePanel({ machineId }: { machineId?: string }) {
  const { getToken } = useAuth();
  const [resource, setResource] = useState<{
    value: CredentialProfilesResponse | null;
    error: string | null;
    pending: boolean;
  }>({ value: null, error: null, pending: false });

  const load = useCallback(async () => {
    setResource((current) => ({ ...current, pending: true }));
    try {
      const token = await getToken();
      const value = await getCredentialProfiles({ token, machineId });
      setResource({ value, error: null, pending: false });
    } catch (error) {
      setResource((current) => ({
        // The last good answer is KEPT, so a failed refresh does not read as a
        // machine with no profiles.
        ...current,
        error: `Unable to read credential profiles: ${
          error instanceof Error ? error.message : String(error)
        }`,
        pending: false,
      }));
    }
  }, [getToken, machineId]);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = useCallback(
    async (profile: string | null) => {
      setResource((current) => ({ ...current, pending: true }));
      try {
        const token = await getToken();
        const result = await setCredentialProfile(profile, { token, machineId });
        if (!result.ok) {
          // The daemon refuses an undefined name rather than storing it, so
          // its words are shown rather than a generic failure.
          throw new Error(result.error ?? "the switch was refused");
        }
        await load();
      } catch (error) {
        setResource((current) => ({
          ...current,
          error: `Unable to switch profile: ${
            error instanceof Error ? error.message : String(error)
          }`,
          pending: false,
        }));
      }
    },
    [getToken, load, machineId],
  );

  const report = resource.value;
  // The branch is decided in `credentialProfileView`, where a gate can reach
  // every outcome -- the hooks here are stubbed in tests, so a branch written
  // inline would be unprovable.
  const view = credentialProfileView(report);

  return (
    <Card className="mb-4 p-4">
      <View className="mb-2 flex-row items-center justify-between">
        <Text className="font-mono text-xs font-semibold text-[#b8bbc6]">Credential profile</Text>
        {report?.active ? (
          <Button variant="outline" size="sm" onPress={() => void choose(null)}>
            <Text>Use this machine&apos;s own accounts</Text>
          </Button>
        ) : null}
      </View>

      {resource.error ? (
        <Text className="mb-2 font-mono text-xs text-[#f0a0a0]">{resource.error}</Text>
      ) : null}

      {view.kind === "unreadable" ? (
        <Text className="font-mono text-xs text-muted-foreground">{view.reason}</Text>
      ) : view.kind === "loading" ? (
        <Text className="font-mono text-xs text-muted-foreground">Reading profiles...</Text>
      ) : view.kind === "none" ? (
        <Text className="font-mono text-xs text-muted-foreground">
          No credential profiles are configured on this machine.
        </Text>
      ) : (
        view.profiles.map((profile: CredentialProfile) => {
          const active = profile.name === view.active;
          return (
            <Pressable
              key={profile.name}
              disabled={active || resource.pending}
              onPress={() => void choose(profile.name)}
              className="mb-1 flex-row items-center justify-between"
            >
              <Text className="font-mono text-xs text-[#b8bbc6]">
                {profile.name}
                {active ? " (active)" : ""}
              </Text>
              <Text className="font-mono text-xs text-muted-foreground">
                {profileDirectories(profile)}
              </Text>
            </Pressable>
          );
        })
      )}
    </Card>
  );
}

/**
 * Where the swarm overseer is pinned, and a way to move it here.
 *
 * Only ONE move is offered -- unpinning -- because that is what a person on
 * this machine can act on without deciding for another. `canClaimSwarmHost`
 * keeps the control away from the states the daemon would refuse: offering a
 * button that is going to be refused is worse than not offering it.
 */
function SwarmHostPanel() {
  const { getToken } = useAuth();
  const [resource, setResource] = useState<{
    value: SwarmHostResponse | null;
    error: string | null;
    pending: boolean;
  }>({ value: null, error: null, pending: false });

  const load = useCallback(async () => {
    setResource((current) => ({ ...current, pending: true }));
    try {
      const token = await getToken();
      const value = await getSwarmHost({ token });
      setResource({ value, error: null, pending: false });
    } catch (error) {
      setResource((current) => ({
        // The last good answer is kept, so a failed refresh does not read as
        // an unpinned swarm -- which would invite a second overseer.
        ...current,
        error: `Unable to read the swarm host: ${
          error instanceof Error ? error.message : String(error)
        }`,
        pending: false,
      }));
    }
  }, [getToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const unpin = useCallback(async () => {
    setResource((current) => ({ ...current, pending: true }));
    try {
      const token = await getToken();
      const result = await setSwarmHost(null, { token });
      if (!result.ok) throw new Error(result.error ?? "the move was refused");
      await load();
    } catch (error) {
      setResource((current) => ({
        ...current,
        error: `Unable to move the swarm host: ${
          error instanceof Error ? error.message : String(error)
        }`,
        pending: false,
      }));
    }
  }, [getToken, load]);

  const view = swarmHostView(resource.value);

  return (
    <Card className="mb-4 p-4">
      <View className="mb-2 flex-row items-center justify-between">
        <Text className="font-mono text-xs font-semibold text-[#b8bbc6]">Swarm overseer</Text>
        {view.kind === "here" || view.kind === "elsewhere" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={resource.pending}
            onPress={() => void unpin()}
          >
            <Text>Unpin</Text>
          </Button>
        ) : null}
      </View>

      {resource.error ? (
        <Text className="mb-1 font-mono text-xs text-[#f0a0a0]">{resource.error}</Text>
      ) : null}

      <Text className="font-mono text-xs text-muted-foreground">
        {view.kind === "unreadable"
          ? view.reason
          : view.kind === "loading"
            ? "Reading the swarm host..."
            : view.kind === "here"
              ? "Pinned to this machine."
              : view.kind === "elsewhere"
                ? `Pinned to ${view.host}.`
                : "Not pinned; the next machine to start one claims it."}
      </Text>

      {canClaimSwarmHost(view) ? (
        <Text className="mt-1 font-mono text-xs text-muted-foreground">
          Starting a swarm overseer here would claim it.
        </Text>
      ) : null}
    </Card>
  );
}

/**
 * Which machine the per-machine controls below address.
 *
 * An unreachable machine is SHOWN and not selectable: hiding it would make the
 * fleet look smaller than it is, and offering a control the relay will refuse
 * is worse than offering none. The reason it gave is on the chip.
 */
function MachineSelector({
  report,
  selected,
  onSelect,
}: {
  report: FleetUsageResponse | null;
  selected?: string;
  onSelect: (machineId?: string) => void;
}) {
  const targets = machineTargets(report);

  if (targets.kind === "loading") return null;
  if (targets.kind === "unknown") {
    return (
      <Card className="mb-4 p-4">
        <Text className="mb-1 font-mono text-xs font-semibold text-[#b8bbc6]">Machine</Text>
        <Text className="font-mono text-xs text-muted-foreground">
          {targets.reason} Controls below act on this machine.
        </Text>
      </Card>
    );
  }
  // Nothing to choose between, so no chooser -- the controls act on this
  // machine, which is what they did before any of this existed.
  if (selectableMachines(targets).length === 0 && targets.targets.length === 0) return null;

  return (
    <Card className="mb-4 p-4">
      <Text className="mb-2 font-mono text-xs font-semibold text-[#b8bbc6]">Machine</Text>
      <View className="flex-row flex-wrap gap-2">
        <Pressable
          onPress={() => onSelect(undefined)}
          className={`rounded border px-2 py-1 ${
            selected == null ? "border-[#7aa2f7] bg-[#1f2335]" : "border-[#2a2e3f]"
          }`}
        >
          <Text className="font-mono text-xs">This machine</Text>
        </Pressable>
        {targets.targets.map((target) => (
          <Pressable
            key={target.machineId}
            disabled={!target.reachable}
            onPress={() => onSelect(target.machineId)}
            className={`rounded border px-2 py-1 ${
              selected === target.machineId ? "border-[#7aa2f7] bg-[#1f2335]" : "border-[#2a2e3f]"
            } ${target.reachable ? "" : "opacity-40"}`}
          >
            <Text className="font-mono text-xs">
              {target.machineId}
              {target.reachable ? "" : ` (${target.reason})`}
            </Text>
          </Pressable>
        ))}
      </View>
    </Card>
  );
}

export default function FleetScreen() {
  const { getToken } = useAuth();
  const resource = useAtomValue(fleetUsageResourceAtom);
  const beginRefresh = useSetAtom(beginFleetUsageRefreshAtom);
  const applySuccess = useSetAtom(applyFleetUsageSuccessAtom);
  const applyFailure = useSetAtom(applyFleetUsageFailureAtom);

  const refresh = useCallback(async () => {
    const requestKey = fleetUsageRequestKey();
    beginRefresh({ requestKey });
    try {
      const token = await getToken();
      const value = await getFleetUsage({ token });
      applySuccess({ requestKey, value });
    } catch (error) {
      applyFailure({
        requestKey,
        error: `Unable to read fleet usage: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }, [applyFailure, applySuccess, beginRefresh, getToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const report = resource.value;
  // ABSENT IS NOT EMPTY. No `machines` key means this machine does not know
  // which machines exist; an empty array means the relay said there are none.
  // The two render differently because they are opposite claims, and the
  // report goes to the trouble of distinguishing them.
  // `undefined` means "whichever machine this app is already talking to",
  // which is what every per-machine wrapper does with an absent `machineId`.
  // So the default needs no special case and no guess at a local machine name.
  const [selectedMachine, setSelectedMachine] = useState<string | undefined>(undefined);
  const machines = report?.machines;
  const fleetUnknown = report != null && machines == null;

  return (
    <Page>
      <PageHeader
        title="Fleet"
        subtitle="What every machine in this account has left"
        actions={
          <Button variant="outline" size="sm" onPress={() => void refresh()}>
            <Text>{resource.pending ? "Refreshing..." : "Refresh"}</Text>
          </Button>
        }
      />

      <SwarmHostPanel />

      <MachineSelector report={report} selected={selectedMachine} onSelect={setSelectedMachine} />

      <CredentialProfilePanel machineId={selectedMachine} />

      {resource.error ? (
        <Card className="mb-3 border-[#5a2a2a] p-4">
          <Text className="font-mono text-xs text-[#f0a0a0]">{resource.error}</Text>
          {resource.value ? (
            <Text className="mt-1 font-mono text-xs text-muted-foreground">
              Showing the last answer that arrived.
            </Text>
          ) : null}
        </Card>
      ) : null}

      {fleetUnknown ? (
        <PageStateCard
          title="The fleet is not known"
          // The report's own reason, not a guess. "No machines are online"
          // would state the opposite of what this means.
          body={report?.error ?? "This machine could not find out which machines exist."}
          tone="warning"
        />
      ) : machines == null ? (
        <PageStateCard
          title={resource.pending ? "Reading the fleet..." : "No fleet read yet"}
          body="Each machine's Claude and Codex headroom will appear here."
        />
      ) : machines.length === 0 ? (
        <PageStateCard
          title="No other machines are online"
          body="Only this machine is in the account right now."
        />
      ) : (
        // RENDERED IN THE ORDER GIVEN. `build_fleet_usage_report` puts what
        // needs attention first so that this screen and `aimux fleet usage`
        // cannot disagree. Sorting here would make that a second rule.
        machines.map((machine) => <MachineCard key={machine.machineId} machine={machine} />)
      )}
    </Page>
  );
}
