import React, { useCallback, useEffect } from "react";
import { View } from "react-native";
import { useAtomValue, useSetAtom } from "jotai";
import { Page, PageHeader, PageStateCard } from "@/components/PageLayout";
import { UsageMonitor } from "@/components/UsageMonitor";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { getFleetUsage, type FleetUsageMachine } from "@/lib/api";
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
