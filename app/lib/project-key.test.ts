import { describe, expect, it } from "vitest";

import {
  findProjectByRef,
  projectRefFromPayload,
  findProjectForRef,
  preferMachineBearingRef,
  uniqueProjectRefForPath,
  parseProjectKey,
  projectKey,
  projectRefOf,
  sameProjectRef,
} from "./project-key";

const MBP_AIMUX = { machineId: "mbp", path: "/Users/sam/cs/aimux", name: "aimux" };
const STRIX_AIMUX = { machineId: "strix", path: "/Users/sam/cs/aimux", name: "aimux" };
const LOCAL_AIMUX = { path: "/Users/sam/cs/aimux", name: "aimux" };

describe("what identifies a project", () => {
  // The same checkout path exists on both of Sam's MacBooks, so a path alone
  // names two different projects.
  it("tells two machines' identical paths apart", () => {
    expect(projectKey(MBP_AIMUX)).not.toBe(projectKey(STRIX_AIMUX));
    expect(sameProjectRef(MBP_AIMUX, STRIX_AIMUX)).toBe(false);
  });

  it("has no key for a project with no path", () => {
    expect(projectKey(null)).toBeNull();
    expect(projectKey({ path: "" })).toBeNull();
    expect(projectRefOf(null)).toBeNull();
    expect(projectRefOf({ path: "" })).toBeNull();
  });

  it("keeps a machineless project distinct from a machine's", () => {
    expect(projectKey(LOCAL_AIMUX)).not.toBe(projectKey(MBP_AIMUX));
    expect(sameProjectRef(LOCAL_AIMUX, MBP_AIMUX)).toBe(false);
    expect(sameProjectRef(LOCAL_AIMUX, { path: LOCAL_AIMUX.path })).toBe(true);
  });

  it("drops an absent machine rather than storing it as undefined", () => {
    expect(projectRefOf(LOCAL_AIMUX)).toEqual({ path: LOCAL_AIMUX.path });
    expect(projectRefOf(MBP_AIMUX)).toEqual({ machineId: "mbp", path: MBP_AIMUX.path });
  });
});

describe("finding a project by its ref", () => {
  const projects = [MBP_AIMUX, STRIX_AIMUX, LOCAL_AIMUX];

  it("returns the one on the machine asked for", () => {
    expect(findProjectByRef(projects, { machineId: "strix", path: STRIX_AIMUX.path })).toBe(
      STRIX_AIMUX,
    );
    expect(findProjectByRef(projects, { path: LOCAL_AIMUX.path })).toBe(LOCAL_AIMUX);
  });

  // Falling back to a path match would hand back whichever machine came first
  // in the list, which is the failure this module exists to stop.
  it("finds nothing rather than the wrong machine's project", () => {
    expect(findProjectByRef(projects, { machineId: "mini", path: MBP_AIMUX.path })).toBeUndefined();
    expect(findProjectByRef([MBP_AIMUX], { path: MBP_AIMUX.path })).toBeUndefined();
    expect(findProjectByRef(projects, null)).toBeUndefined();
  });
});

describe("a ref that has been through storage", () => {
  it("round-trips", () => {
    for (const ref of [MBP_AIMUX, LOCAL_AIMUX]) {
      expect(parseProjectKey(projectKey(ref))).toEqual(projectRefOf(ref));
    }
  });

  // What an older build persisted, from before machines existed. A bare path
  // is a ref with no machine, which is what it meant.
  it("reads a bare path as a machineless ref", () => {
    expect(parseProjectKey("/Users/sam/cs/aimux")).toEqual({ path: "/Users/sam/cs/aimux" });
  });

  it("reads nothing out of nothing", () => {
    expect(parseProjectKey(null)).toBeNull();
    expect(parseProjectKey("")).toBeNull();
    expect(parseProjectKey("mbp\u0000")).toBeNull();
  });
});

describe("resolving a path that names no machine", () => {
  it("answers when one machine has it", () => {
    expect(uniqueProjectRefForPath([MBP_AIMUX], MBP_AIMUX.path)).toEqual({
      machineId: "mbp",
      path: MBP_AIMUX.path,
    });
  });

  // Two machines hold this path. Which one was meant is unknowable, and
  // opening the first would silently be the wrong host.
  it("refuses when two machines have it", () => {
    expect(uniqueProjectRefForPath([MBP_AIMUX, STRIX_AIMUX], MBP_AIMUX.path)).toBeNull();
  });

  it("refuses nothing and the unknown", () => {
    expect(uniqueProjectRefForPath([MBP_AIMUX], null)).toBeNull();
    expect(uniqueProjectRefForPath([MBP_AIMUX], "/repo/other")).toBeNull();
  });
});

describe("resolving a ref that came from a URL or from storage", () => {
  // Every URL written before machines existed carries a path and no machine.
  // Refusing those would have broken every link the app had already produced.
  it("resolves a machineless ref when one machine has the path", () => {
    expect(findProjectForRef([MBP_AIMUX], { path: MBP_AIMUX.path })).toBe(MBP_AIMUX);
  });

  it("refuses a machineless ref when two machines have the path", () => {
    expect(findProjectForRef([MBP_AIMUX, STRIX_AIMUX], { path: MBP_AIMUX.path })).toBeUndefined();
  });

  it("never falls back for a ref that names a machine", () => {
    expect(
      findProjectForRef([MBP_AIMUX], { machineId: "strix", path: MBP_AIMUX.path }),
    ).toBeUndefined();
  });

  it("prefers an exact match over the path fallback", () => {
    expect(
      findProjectForRef([LOCAL_AIMUX, MBP_AIMUX], { machineId: "mbp", path: MBP_AIMUX.path }),
    ).toBe(MBP_AIMUX);
  });
});

describe("a URL that omits the machine beside a selection that knows it", () => {
  // The URL is the less complete answer. Letting it win would drop the host
  // and leave the project unresolved on a two-machine account.
  it("keeps the selection when the paths match", () => {
    expect(
      preferMachineBearingRef({ path: MBP_AIMUX.path }, { machineId: "mbp", path: MBP_AIMUX.path }),
    ).toEqual({ machineId: "mbp", path: MBP_AIMUX.path });
  });

  it("follows the URL to a different project", () => {
    expect(
      preferMachineBearingRef({ path: "/repo/other" }, { machineId: "mbp", path: MBP_AIMUX.path }),
    ).toEqual({ path: "/repo/other" });
  });

  it("follows a URL that names its own machine", () => {
    expect(
      preferMachineBearingRef(
        { machineId: "strix", path: MBP_AIMUX.path },
        { machineId: "mbp", path: MBP_AIMUX.path },
      ),
    ).toEqual({ machineId: "strix", path: MBP_AIMUX.path });
  });

  it("falls back to the selection when the URL names nothing", () => {
    expect(preferMachineBearingRef(null, { machineId: "mbp", path: MBP_AIMUX.path })).toEqual({
      machineId: "mbp",
      path: MBP_AIMUX.path,
    });
    expect(preferMachineBearingRef(null, null)).toBeNull();
  });
});

describe("a ref out of a push payload", () => {
  it("uses the machine the payload names", () => {
    expect(projectRefFromPayload([MBP_AIMUX, STRIX_AIMUX], MBP_AIMUX.path, "strix")).toEqual({
      machineId: "strix",
      path: MBP_AIMUX.path,
    });
  });

  // Sent before the relay stamped the machine. One machine with that path is
  // still an answer.
  it("resolves a payload with no machine when one machine has the path", () => {
    expect(projectRefFromPayload([MBP_AIMUX], MBP_AIMUX.path, undefined)).toEqual({
      machineId: "mbp",
      path: MBP_AIMUX.path,
    });
    expect(projectRefFromPayload([MBP_AIMUX], MBP_AIMUX.path, "   ")).toEqual({
      machineId: "mbp",
      path: MBP_AIMUX.path,
    });
  });

  // Tapping it would otherwise open whichever host came first in the list.
  it("refuses a payload with no machine when two machines have the path", () => {
    expect(projectRefFromPayload([MBP_AIMUX, STRIX_AIMUX], MBP_AIMUX.path, undefined)).toBeNull();
  });

  // A machine the app has never heard of still routes: the relay refuses it by
  // name, which is a better answer than opening another host.
  it("trusts a named machine it has no project for", () => {
    expect(projectRefFromPayload([MBP_AIMUX], MBP_AIMUX.path, "mini")).toEqual({
      machineId: "mini",
      path: MBP_AIMUX.path,
    });
  });

  it("resolves nothing without a path", () => {
    expect(projectRefFromPayload([MBP_AIMUX], "", "mbp")).toBeNull();
    expect(projectRefFromPayload([MBP_AIMUX], null, "mbp")).toBeNull();
  });
});
