import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { componentBody, stripComments } from "@/test/component-source";

import { urlProjectSelectionWrite, type UrlProjectSelectionInput } from "./url-project-selection";

const NOW = 1_700_000_000_000;

const base: UrlProjectSelectionInput = {
  shareOwnsRoute: false,
  urlProjectRef: { machineId: "mbp", path: "/repo/aimux" },
  selectedProjectRef: { machineId: "mbp", path: "/repo/other" },
  selectionReadState: "read",
  explicitProjectSelection: null,
  now: NOW,
};

describe("what the URL does to the project selection", () => {
  it("adopts the project the URL names", () => {
    expect(urlProjectSelectionWrite(base)).toEqual({
      ref: { machineId: "mbp", path: "/repo/aimux" },
      clearExplicitSelection: false,
    });
  });

  it("leaves the selection alone when a shared chat owns the route", () => {
    expect(urlProjectSelectionWrite({ ...base, shareOwnsRoute: true })).toBeNull();
  });

  it("leaves the selection alone when the URL names no project", () => {
    expect(urlProjectSelectionWrite({ ...base, urlProjectRef: null })).toBeNull();
  });

  it("does nothing when the URL already names the selection", () => {
    expect(
      urlProjectSelectionWrite({
        ...base,
        selectedProjectRef: { machineId: "mbp", path: "/repo/aimux" },
      }),
    ).toBeNull();
  });

  // The reason the read state is an input at all. Every guard here compares
  // the URL against the selection, and a selection still in flight compares
  // as absent -- so the downgrade guard below could not apply, and the write
  // PERSISTS, putting a bare path on disk over a machine-qualified key.
  it("waits for the stored selection rather than comparing against a read in flight", () => {
    expect(
      urlProjectSelectionWrite({
        ...base,
        selectionReadState: "unread",
        selectedProjectRef: null,
        urlProjectRef: { path: "/repo/aimux" },
      }),
    ).toBeNull();
  });

  // A read that FAILED never arrives, so waiting would strand the deep link
  // the user just tapped -- but the selection it would be compared against is
  // unknown, so a machineless URL must not be written over whatever is still
  // on disk. The screen renders the URL's project either way.
  it("honours a machine-bearing URL after a failed read", () => {
    expect(urlProjectSelectionWrite({ ...base, selectionReadState: "failed" })).toEqual({
      ref: { machineId: "mbp", path: "/repo/aimux" },
      clearExplicitSelection: false,
    });
  });

  it("refuses to persist a machineless URL after a failed read", () => {
    expect(
      urlProjectSelectionWrite({
        ...base,
        selectionReadState: "failed",
        selectedProjectRef: null,
        urlProjectRef: { path: "/repo/aimux" },
      }),
    ).toBeNull();
  });

  // And it waits whatever the selection currently holds, so the guard cannot
  // be weakened to "unread AND no selection" -- which every other case here
  // would still satisfy.
  it("waits for the read even when the selection already holds a project", () => {
    expect(
      urlProjectSelectionWrite({
        ...base,
        selectionReadState: "unread",
        selectedProjectRef: { machineId: "strix", path: "/repo/other" },
      }),
    ).toBeNull();
  });

  // And once it has been read, the guard it was protecting does its job.
  it("does not let a machineless URL downgrade a selection that knows its host", () => {
    expect(
      urlProjectSelectionWrite({
        ...base,
        urlProjectRef: { path: "/repo/aimux" },
        selectedProjectRef: { machineId: "mbp", path: "/repo/aimux" },
      }),
    ).toBeNull();
  });

  // A machineless URL for a DIFFERENT path is not a downgrade, so it stands.
  it("adopts a machineless URL that names another path", () => {
    expect(
      urlProjectSelectionWrite({
        ...base,
        urlProjectRef: { path: "/repo/elsewhere" },
        selectedProjectRef: { machineId: "mbp", path: "/repo/aimux" },
      }),
    ).toEqual({ ref: { path: "/repo/elsewhere" }, clearExplicitSelection: false });
  });

  it("honours a hand-made selection that has not expired", () => {
    expect(
      urlProjectSelectionWrite({
        ...base,
        explicitProjectSelection: { key: "mbp\u0000/repo/other", expiresAt: NOW + 1_000 },
      }),
    ).toBeNull();
  });

  it("stops honouring it once it has expired", () => {
    expect(
      urlProjectSelectionWrite({
        ...base,
        explicitProjectSelection: { key: "mbp\u0000/repo/other", expiresAt: NOW - 1 },
      }),
    ).toEqual({
      ref: { machineId: "mbp", path: "/repo/aimux" },
      clearExplicitSelection: false,
    });
  });

  // The hold was for the project the URL now names, so it has been honoured
  // and must be cleared, or it would keep refusing a later URL.
  it("spends the hold when the URL agrees with it", () => {
    expect(
      urlProjectSelectionWrite({
        ...base,
        explicitProjectSelection: { key: "mbp\u0000/repo/aimux", expiresAt: NOW + 1_000 },
      }),
    ).toEqual({
      ref: { machineId: "mbp", path: "/repo/aimux" },
      clearExplicitSelection: true,
    });
  });
});

// The rule above is only worth anything if the layout feeds it the real
// signals. Source rather than render: this is a route component no renderer in
// this app executes.
describe("the layout that applies it", () => {
  // The component's own body, so neither commenting the code out nor moving it
  // into a function nothing calls can satisfy these.
  const source = componentBody(
    join(dirname(fileURLToPath(import.meta.url)), "..", "app", "(main)", "_layout.tsx"),
    "export default function MainLayout(",
  );

  it("asks the rule rather than deciding inline", () => {
    expect(source).toContain("urlProjectSelectionWrite({");
    expect(source, "and must not keep a second copy of the downgrade guard").not.toContain(
      "!urlProjectRef.machineId &&",
    );
  });

  it("shares the downgrade rule with the readers rather than restating it", () => {
    const rule = stripComments(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "url-project-selection.ts"),
        "utf8",
      ),
    );
    // `resolveRouteProjectRef` is built on the same helper, and it is what the
    // layout and `useRouteProject` use to READ the current project. A writer
    // with its own copy of the rule would agree today and drift silently.
    expect(rule).toContain("preferMachineBearingRef(");
    expect(rule, "no second spelling of it").not.toMatch(/input\.selectedProjectRef\?\.machineId/);
  });

  it("passes the real read state, not a constant", () => {
    expect(source).toContain("selectionReadState: selectedProjectReadState,");
    expect(source, "from the store").toContain("useAtomValue(selectedProjectReadStateAtom)");
    expect(source, "and THIS effect re-runs when it lands").toMatch(
      /urlProjectSelectionWrite\(\{[\s\S]{0,600}?\}, \[[^\]]{0,200}selectedProjectReadState,/,
    );
  });

  // The recording of a selection made before the memory was read is refused,
  // and the screen that made it is keyed on the session id, so nothing fires
  // again. Without this replay a cold start into a chat never records it.
  it("replays the open agent once its memory has been read", () => {
    expect(source).toContain("useAtomValue(lastAgentHydratedAtom)");
    expect(source).toMatch(
      /if \(!lastAgentHydrated \|\| !selectedProjectHydrated\) return;[\s\S]{0,200}store\.set\(selectedSessionIdAtom, open\)/,
    );
    expect(source, "and it re-runs when either read lands").toMatch(
      /store\.set\(selectedSessionIdAtom, open\);[\s\S]{0,120}\}, \[[^\]]{0,160}lastAgentHydrated,[^\]]{0,160}selectedProjectHydrated,/,
    );
  });

  it("acts on both halves of the answer", () => {
    expect(source).toContain(
      "if (write.clearExplicitSelection) store.set(explicitProjectSelectionAtom, null);",
    );
    expect(source).toContain("store.set(selectedProjectRefAtom, write.ref);");
  });
});
