import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import {
  departedMachineIdsAtom,
  knownMachinesAtom,
  mergeKnownMachines,
  recordRelayMachinesAtom,
  relayMachinesAtom,
} from "./relay";

const MBP = { id: "mbp", name: "sam-mbp" };
const STRIX = { id: "strix", name: "sam-strix" };

describe("remembering which machines exist", () => {
  // The project fan-out only asks machines the relay currently reports, so a
  // machine that goes away is never queried. Without remembering it, its
  // projects would vanish instead of greying out.
  it("keeps a machine after the relay stops reporting it", () => {
    const store = createStore();
    store.set(recordRelayMachinesAtom, [MBP, STRIX]);
    store.set(recordRelayMachinesAtom, [MBP]);

    expect(store.get(relayMachinesAtom)).toEqual([MBP]);
    expect(store.get(knownMachinesAtom)).toEqual([MBP, STRIX]);
    expect(store.get(departedMachineIdsAtom)).toEqual(["strix"]);
  });

  it("has nothing departed while every machine is connected", () => {
    const store = createStore();
    store.set(recordRelayMachinesAtom, [MBP, STRIX]);
    expect(store.get(departedMachineIdsAtom)).toEqual([]);
  });

  // A renamed host is the same host.
  it("takes the newest name rather than adding a second entry", () => {
    expect(mergeKnownMachines([MBP], [{ id: "mbp", name: "sam-mbp-renamed" }])).toEqual([
      { id: "mbp", name: "sam-mbp-renamed" },
    ]);
  });

  it("returns the same array when nothing changed", () => {
    const known = [MBP];
    expect(mergeKnownMachines(known, [MBP])).toBe(known);
    expect(mergeKnownMachines(known, [])).toBe(known);
  });
});
