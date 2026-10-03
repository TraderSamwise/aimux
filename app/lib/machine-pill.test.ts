import { describe, expect, it } from "vitest";

import { machinePanelRows, machinePillState } from "./machine-pill";

const MBP = { id: "mbp", name: "sam-mbp" };
const STRIX = { id: "strix", name: "sam-strix" };

describe("what the Remote pill says", () => {
  // With one machine "Remote" is the whole answer, and the pill keeps the
  // relay status it has always shown.
  it("says nothing about machines when there is only one", () => {
    expect(
      machinePillState({
        machines: [MBP],
        departedMachineIds: [],
        currentMachineId: "mbp",
        currentMachineName: "sam-mbp",
      }),
    ).toEqual({ label: null, online: true, openable: false });
  });

  it("names the host the open project is on", () => {
    expect(
      machinePillState({
        machines: [MBP, STRIX],
        departedMachineIds: [],
        currentMachineId: "strix",
        currentMachineName: "sam-strix",
      }),
    ).toEqual({ label: "sam-strix", online: true, openable: true });
  });

  // The host going away is what the pill has to show, so the name stays and
  // the dot goes out.
  it("keeps naming a host that has gone away", () => {
    expect(
      machinePillState({
        machines: [MBP],
        departedMachineIds: ["strix"],
        currentMachineId: "strix",
        currentMachineName: "sam-strix",
      }),
    ).toEqual({ label: "sam-strix", online: false, openable: true });
  });

  it("is still worth pressing when no project is open", () => {
    expect(
      machinePillState({
        machines: [MBP, STRIX],
        departedMachineIds: [],
        currentMachineId: null,
        currentMachineName: null,
      }),
    ).toEqual({ label: null, online: false, openable: true });
  });

  it("prefers the relay's name over the one the project was stamped with", () => {
    expect(
      machinePillState({
        machines: [MBP, { id: "strix", name: "sam-strix-renamed" }],
        departedMachineIds: [],
        currentMachineId: "strix",
        currentMachineName: "sam-strix",
      }).label,
    ).toBe("sam-strix-renamed");
  });
});

describe("the machine panel", () => {
  it("lists every machine with its project count, connected ones first", () => {
    expect(
      machinePanelRows({
        machines: [STRIX, MBP],
        projects: [
          { machineId: "mbp", machineName: "sam-mbp" },
          { machineId: "mbp", machineName: "sam-mbp" },
          { machineId: "strix", machineName: "sam-strix" },
          { machineId: "mini", machineName: "sam-mini" },
          {},
        ],
        currentMachineId: "strix",
      }),
    ).toEqual([
      { id: "mbp", name: "sam-mbp", online: true, projectCount: 2, current: false },
      { id: "strix", name: "sam-strix", online: true, projectCount: 1, current: true },
      { id: "mini", name: "sam-mini", online: false, projectCount: 1, current: false },
    ]);
  });

  it("shows a connected machine that has nothing on it", () => {
    expect(machinePanelRows({ machines: [MBP], projects: [], currentMachineId: null })).toEqual([
      { id: "mbp", name: "sam-mbp", online: true, projectCount: 0, current: false },
    ]);
  });

  it("lists nothing when no machine is known", () => {
    expect(machinePanelRows({ machines: [], projects: [{}], currentMachineId: null })).toEqual([]);
  });
});
