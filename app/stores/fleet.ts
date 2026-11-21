import { atom } from "jotai";
import type { FleetUsageResponse } from "@/lib/api";

/**
 * The fleet quota read, as one resource.
 *
 * Shaped like the global-inbox resources -- value / error / pending / stale /
 * updatedAt -- so a screen reads it the same way. It is a single atom rather
 * than one per project because the fleet read is ONE daemon request: the
 * daemon fans out to its peers and merges, so there is nothing per-project to
 * key on.
 */
export interface FleetUsageResource {
  value: FleetUsageResponse | null;
  error: string | null;
  pending: boolean;
  pendingRequestKey: string | null;
  stale: boolean;
  updatedAt: number | null;
}

const emptyFleetUsageResource = (): FleetUsageResource => ({
  value: null,
  error: null,
  pending: false,
  pendingRequestKey: null,
  stale: false,
  updatedAt: null,
});

export const fleetUsageResourceAtom = atom<FleetUsageResource>(emptyFleetUsageResource());

let fleetRequestSequence = 0;

export function fleetUsageRequestKey(): string {
  fleetRequestSequence += 1;
  return `fleet-usage-${fleetRequestSequence}`;
}

export const beginFleetUsageRefreshAtom = atom(
  null,
  (get, set, { requestKey }: { requestKey: string }) => {
    const current = get(fleetUsageResourceAtom);
    set(fleetUsageResourceAtom, {
      ...current,
      pending: true,
      pendingRequestKey: requestKey,
      // The previous answer stays on screen while a refresh runs, marked
      // stale, rather than blanking the fleet on every poll.
      stale: current.value != null,
    });
  },
);

export const applyFleetUsageSuccessAtom = atom(
  null,
  (
    get,
    set,
    {
      requestKey,
      value,
      updatedAt,
    }: {
      requestKey: string;
      value: FleetUsageResponse;
      updatedAt?: number;
    },
  ) => {
    const current = get(fleetUsageResourceAtom);
    // A reply to a request we are no longer waiting on is dropped, so a slow
    // first fetch cannot overwrite a newer one.
    if (current.pendingRequestKey !== requestKey) return;
    set(fleetUsageResourceAtom, {
      value,
      error: null,
      pending: false,
      pendingRequestKey: null,
      stale: false,
      updatedAt: updatedAt ?? Date.now(),
    });
  },
);

export const applyFleetUsageFailureAtom = atom(
  null,
  (get, set, { requestKey, error }: { requestKey: string; error: string }) => {
    const current = get(fleetUsageResourceAtom);
    if (current.pendingRequestKey !== requestKey) return;
    set(fleetUsageResourceAtom, {
      ...current,
      // The last good answer is KEPT alongside the error. Dropping it would
      // turn "this refresh failed" into "the fleet is unknown", which is a
      // different claim, and the screen says both.
      error,
      pending: false,
      pendingRequestKey: null,
      stale: current.value != null,
    });
  },
);
