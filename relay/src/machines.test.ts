import { describe, expect, it } from "vitest";
import {
  UNIDENTIFIED_MACHINE_ID,
  isValidMachineId,
  machineFromConnectUrl,
  machineFromTags,
  resolveDaemonTarget,
  sanitizeMachineName,
} from "./machines";

const MBP = { id: "mbp", name: "sam-mbp" };
const STRIX = { id: "strix", name: "sam-strix" };

describe("machine identity on the wire", () => {
  it("reads the machine a daemon declares", () => {
    expect(machineFromConnectUrl(new URL("wss://relay/daemon/connect?machineId=abc123&machineName=sam-strix"))).toEqual(
      { id: "abc123", name: "sam-strix" },
    );
  });

  // A daemon from before machine identity existed. One slot, so it behaves
  // exactly as it did: alone in the room.
  it("gives a daemon that says nothing the unidentified slot", () => {
    expect(machineFromConnectUrl(new URL("wss://relay/daemon/connect"))).toEqual({
      id: UNIDENTIFIED_MACHINE_ID,
      name: UNIDENTIFIED_MACHINE_ID,
    });
  });

  it("refuses an id that could break a socket tag", () => {
    for (const id of ["Has Caps", "has space", "semi;colon", "machine:nested", "", "a".repeat(65)]) {
      expect(isValidMachineId(id)).toBe(false);
      expect(machineFromConnectUrl(new URL(`wss://relay/daemon/connect?machineId=${encodeURIComponent(id)}`)).id).toBe(
        UNIDENTIFIED_MACHINE_ID,
      );
    }
    expect(isValidMachineId("sam-strix-01")).toBe(true);
  });

  it("falls back to the id when the name is not a hostname", () => {
    expect(sanitizeMachineName("Sam's MacBook")).toBeUndefined();
    expect(
      machineFromConnectUrl(new URL("wss://relay/daemon/connect?machineId=abc123&machineName=Sam%27s%20MacBook")),
    ).toEqual({ id: "abc123", name: "abc123" });
  });

  it("recovers the machine from socket tags after hibernation", () => {
    expect(machineFromTags(["daemon", "user:u1", "machine:strix", "machineName:sam-strix"])).toEqual(STRIX);
    expect(machineFromTags(["daemon", "user:u1"])).toEqual({
      id: UNIDENTIFIED_MACHINE_ID,
      name: UNIDENTIFIED_MACHINE_ID,
    });
  });
});

describe("choosing which machine answers", () => {
  it("says no daemon is connected when the room is empty", () => {
    expect(resolveDaemonTarget([], undefined)).toEqual({
      ok: false,
      status: 503,
      error: "Daemon not connected",
      machines: [],
    });
  });

  it("routes to the only machine when the client names none", () => {
    expect(resolveDaemonTarget([MBP], undefined)).toEqual({ ok: true, machineId: "mbp" });
  });

  // Guessing here would send a kill to the wrong host.
  it("asks rather than guesses when several machines are connected", () => {
    expect(resolveDaemonTarget([MBP, STRIX], undefined)).toEqual({
      ok: false,
      status: 409,
      error: "Several machines are connected; name one with machineId",
      machines: [MBP, STRIX],
    });
  });

  it("routes to the machine the client named", () => {
    expect(resolveDaemonTarget([MBP, STRIX], "strix")).toEqual({ ok: true, machineId: "strix" });
  });

  it("names the machine that is missing rather than falling back to another", () => {
    expect(resolveDaemonTarget([MBP], "strix")).toEqual({
      ok: false,
      status: 503,
      error: "Machine strix is not connected",
      machines: [MBP],
    });
  });
});
