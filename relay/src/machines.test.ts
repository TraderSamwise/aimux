import { describe, expect, it } from "vitest";
import handshakeContract from "../../testdata/contracts/v1/relay-handshake.json";
import {
  UNIDENTIFIED_MACHINE_ID,
  isValidMachineId,
  machineFromConnectUrl,
  machineFromTags,
  resolveDaemonTarget,
  resolveSharedDaemonTarget,
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

  // The slot kept for daemons that predate machine identity. A daemon that
  // could ask for it could evict one, or be evicted by one.
  it("refuses the reserved id", () => {
    expect(isValidMachineId(UNIDENTIFIED_MACHINE_ID)).toBe(false);
    expect(machineFromConnectUrl(new URL(`wss://relay/daemon/connect?machineId=${UNIDENTIFIED_MACHINE_ID}`)).id).toBe(
      UNIDENTIFIED_MACHINE_ID,
    );
    expect(machineFromTags(["daemon", `machine:${UNIDENTIFIED_MACHINE_ID}`]).id).toBe(UNIDENTIFIED_MACHINE_ID);
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

describe("choosing which machine answers a shared guest", () => {
  it("routes to the machine the share is bound to", () => {
    expect(resolveSharedDaemonTarget([MBP, STRIX], "strix")).toEqual({ ok: true, machineId: "strix" });
  });

  it("routes to the only machine when the share names none", () => {
    expect(resolveSharedDaemonTarget([MBP], undefined)).toEqual({ ok: true, machineId: "mbp" });
  });

  // A share grants one session on one host. Every refusal returns an empty
  // list, because the rest of the fleet is none of a guest's business.
  it("never tells a guest which machines exist", () => {
    for (const resolution of [
      resolveSharedDaemonTarget([], "strix"),
      resolveSharedDaemonTarget([MBP], "strix"),
      resolveSharedDaemonTarget([MBP, STRIX], undefined),
    ]) {
      expect(resolution.ok).toBe(false);
      expect(resolution.ok === false && resolution.machines).toEqual([]);
      expect(resolution.ok === false && resolution.status).toBe(503);
    }
  });

  it("refuses rather than falling back when the host is away", () => {
    expect(resolveSharedDaemonTarget([MBP], "strix")).toEqual({
      ok: false,
      status: 503,
      error: "The machine hosting this shared chat is not connected",
      machines: [],
    });
  });

  // The number of machines on the account is not a guest's business, so an
  // unbound share and an away host are refused in the same words.
  it("does not let the wording reveal that the fleet is plural", () => {
    const away = resolveSharedDaemonTarget([MBP], "strix");
    const unbound = resolveSharedDaemonTarget([MBP, STRIX], undefined);
    expect(away.ok).toBe(false);
    expect(unbound.ok).toBe(false);
    expect(away.ok === false && away.error).toBe(unbound.ok === false && unbound.error);
  });
});

// The daemon builds this URL in Rust and the relay parses it here. Each side
// used to assert only its own copy of the shape, so renaming a parameter on
// one side left both suites green while every daemon in the field landed in
// the `unidentified` slot. Both sides now read the same file.
describe("the daemon handshake contract", () => {
  const contract = handshakeContract;

  it("parses the machine out of the URL the Rust daemon builds", () => {
    const url = new URL(contract.example.url.replace(/^wss:/, "https:"));

    expect(url.pathname).toBe(contract.path);
    expect(machineFromConnectUrl(url)).toEqual({
      id: contract.example.machineId,
      name: contract.example.machineName,
    });
  });

  it("reads the parameter names the contract declares", () => {
    const url = new URL(`https://relay.example${contract.path}`);
    url.searchParams.set(contract.machineIdParam, "strix");
    url.searchParams.set(contract.machineNameParam, "sam-strix");

    expect(machineFromConnectUrl(url)).toEqual({ id: "strix", name: "sam-strix" });
  });

  it("agrees on the reserved id for a daemon that named no machine", () => {
    expect(UNIDENTIFIED_MACHINE_ID).toBe(contract.reservedUnidentifiedMachineId);
    expect(isValidMachineId(contract.reservedUnidentifiedMachineId)).toBe(false);
  });
});
