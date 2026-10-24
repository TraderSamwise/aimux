import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DaemonProject } from "@/lib/api";

const SELECTION_KEY = "aimux-selected-project";
const LAST_AGENT_KEY = "aimux-last-agent-by-project";

// The whole bug lives in the window between launch and AsyncStorage answering,
// and nothing in the unit environment pends: `createSsrSafeJsonStorage` sees no
// `window`, falls back to `noopStorage`, and answers synchronously. So the
// storage is replaced with one whose reads are settled by hand, and the real
// store module -- the real atoms, the real reconcile action -- is driven
// against it.
const storage = vi.hoisted(() => {
  const reads: Array<{
    key: string;
    settle: (value: unknown) => void;
    fail: (error: unknown) => void;
  }> = [];
  const written: Record<string, unknown> = {};
  // `noopStorage` answers synchronously on the SSR/web-static path, where
  // there is no promise to unwrap at all.
  const state = { answersSynchronously: false, answersSynchronouslyWith: null as unknown };
  return {
    reads,
    written,
    state,
    impl: {
      // Stands in for the JSON storage itself, so these reads answer with
      // parsed values rather than JSON text.
      getItem: (key: string) => {
        if (state.answersSynchronously) return state.answersSynchronouslyWith;
        const read = new Promise((resolve, reject) => {
          reads.push({ key, settle: resolve, fail: reject });
        });
        // Jotai holds this promise rather than awaiting it, so a rejection it
        // never looks at is reported as unhandled by the runner. Observing it
        // here changes nothing the atoms see.
        read.catch(() => {});
        return read;
      },
      setItem: (key: string, value: unknown) => {
        written[key] = value;
      },
      removeItem: (key: string) => {
        delete written[key];
      },
    },
  };
});

vi.mock("@/lib/jotai-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/jotai-storage")>();
  return { ...actual, createSsrSafeJsonStorage: () => storage.impl };
});

function project(input: Pick<DaemonProject, "id" | "name" | "path">): DaemonProject {
  return {
    ...input,
    dashboardSessionName: `aimux-${input.id}`,
    lastSeen: "2026-01-01T00:00:00.000Z",
    service: null,
    serviceAlive: true,
    serviceEndpoint: { host: "127.0.0.1", port: 43190 },
  };
}

const ALPHA = project({ id: "alpha", name: "Alpha", path: "/repo/alpha" });
const ZETA = project({ id: "zeta", name: "Zeta", path: "/repo/zeta" });

// A launch. Fresh modules, because `atomWithStorage` issues its eager
// `getOnInit` read once at import and that read is what these tests settle.
async function launch(options?: { answersSynchronouslyWith?: unknown }) {
  const synchronous = options !== undefined && "answersSynchronouslyWith" in options;
  vi.resetModules();
  storage.reads.length = 0;
  storage.state.answersSynchronously = synchronous;
  storage.state.answersSynchronouslyWith = options?.answersSynchronouslyWith ?? null;
  for (const key of Object.keys(storage.written)) delete storage.written[key];

  const projects = await import("@/stores/projects");
  const store = createStore();
  // Mounted, as the app mounts it through `useAtomValue`. Mounting matters:
  // `atomWithStorage.onMount` issues a SECOND read, and the latch has to
  // survive it.
  const subscriptions = [
    store.sub(projects.selectedProjectHydratedAtom, () => {}),
    store.sub(projects.lastAgentByProjectAtom, () => {}),
    store.sub(projects.lastAgentReadStateAtom, () => {}),
  ];
  const unsubscribe = () => {
    for (const stop of subscriptions) stop();
  };
  return { ...projects, store, unsubscribe };
}

// One key at a time, for the interleavings where the two reads do not land
// together.
async function settleReadsFor(key: string, value: unknown) {
  const matching = storage.reads.filter((read) => read.key === key);
  for (const read of matching) {
    storage.reads.splice(storage.reads.indexOf(read), 1);
    read.settle(value);
  }
  await Promise.resolve();
  await Promise.resolve();
}

async function settlePendingReads(value: unknown) {
  const pending = storage.reads.splice(0, storage.reads.length);
  for (const read of pending) read.settle(value);
  await Promise.resolve();
  await Promise.resolve();
}

async function failPendingReads(error: unknown) {
  const pending = storage.reads.splice(0, storage.reads.length);
  for (const read of pending) read.fail(error);
  await Promise.resolve();
  await Promise.resolve();
}

describe("the remembered project while storage is still being read", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reports the read as unfinished, then latches once it lands", async () => {
    const { selectedProjectHydratedAtom, store, unsubscribe } = await launch();

    expect(store.get(selectedProjectHydratedAtom), "nothing has come back yet").toBe(false);

    await settlePendingReads("/repo/zeta");

    expect(store.get(selectedProjectHydratedAtom)).toBe(true);
    unsubscribe();
  });

  // The headline claim: a launch where nothing writes the selection must still
  // end up on the stored project. Before this, jotai held the read in the atom
  // and never replaced it, so the key was observed only when something wrote
  // it again in the same session -- the project was saved on every change and
  // restored on none.
  it("restores the stored project on a launch that writes nothing", async () => {
    const { selectedProjectRefAtom, selectedProjectPathAtom, store, unsubscribe } = await launch();

    expect(store.get(selectedProjectRefAtom), "not read yet").toBeNull();

    await settlePendingReads("/repo/zeta");

    expect(store.get(selectedProjectRefAtom)).toEqual({ path: "/repo/zeta" });
    expect(store.get(selectedProjectPathAtom), "and every surface derived from it").toBe(
      "/repo/zeta",
    );
    unsubscribe();
  });

  // The defect in `unwrap`'s default fallback: a NEW promise over a resolved
  // value reports `undefined` again. `atomWithStorage` re-reads on every
  // mount, so a screen that remounts would un-answer a question that had
  // already been answered.
  it("stays answered across the re-read a remount issues", async () => {
    const { selectedProjectHydratedAtom, store, unsubscribe } = await launch();
    await settlePendingReads("/repo/zeta");
    expect(store.get(selectedProjectHydratedAtom)).toBe(true);

    unsubscribe();
    const again = store.sub(selectedProjectHydratedAtom, () => {});

    expect(storage.reads.length, "the remount really did issue a fresh read").toBeGreaterThan(0);
    expect(store.get(selectedProjectHydratedAtom), "and it must not un-answer").toBe(true);
    again();
  });

  // Broken storage is not slow storage. Waiting on it forever is the one
  // unrecoverable outcome, so a rejection finishes the wait -- while staying a
  // different answer from a read that came back.
  it("counts a failed read as finished, but not as answered", async () => {
    const { selectedProjectHydratedAtom, selectedProjectReadStateAtom, store, unsubscribe } =
      await launch();

    await failPendingReads(new Error("storage is unavailable"));

    expect(store.get(selectedProjectHydratedAtom), "nothing waits on it").toBe(true);
    expect(store.get(selectedProjectReadStateAtom), "and it did not answer").toBe("failed");
    unsubscribe();
  });

  // The reported bug, and the reason it was permanent: the first project poll
  // beats AsyncStorage, the pending selection reads as "no selection", and the
  // fallback to the first project is WRITTEN BACK to storage -- so the project
  // Sam left is gone from disk before it was ever read.
  it("does not adopt the first project, or overwrite the stored key, while the read is in flight", async () => {
    const { reconcileProjectsAtom, selectedProjectRefAtom, store, unsubscribe } = await launch();

    store.set(reconcileProjectsAtom, [ALPHA, ZETA]);

    expect(store.get(selectedProjectRefAtom), "no selection may be invented").toBeNull();
    expect(
      storage.written[SELECTION_KEY],
      "and nothing may be written over the remembered key",
    ).toBeUndefined();

    await settlePendingReads("/repo/zeta");

    expect(store.get(selectedProjectRefAtom)?.path, "the project Sam left").toBe("/repo/zeta");
    unsubscribe();
  });

  // The inverse: a read that came back EMPTY is the other answer, and a user
  // with no remembered project still has to land somewhere.
  it("adopts the first project once the read has come back empty", async () => {
    const { reconcileProjectsAtom, selectedProjectRefAtom, store, unsubscribe } = await launch();

    await settlePendingReads(null);
    store.set(reconcileProjectsAtom, [ZETA, ALPHA]);

    expect(store.get(selectedProjectRefAtom)?.path).toBe("/repo/alpha");
    unsubscribe();
  });

  // The direction that bites. `atomWithStorage` re-reads on every mount, so a
  // remount while storage is faulting would otherwise un-answer a question
  // already answered: the project the user is looking at reverts to none, and
  // every write that waits on the read is refused for the rest of the session.
  it("keeps what it read when a later read fails", async () => {
    const { selectedProjectReadStateAtom, selectedProjectRefAtom, store, unsubscribe } =
      await launch();
    await settlePendingReads("/repo/zeta");
    expect(store.get(selectedProjectReadStateAtom)).toBe("read");

    unsubscribe();
    const again = store.sub(selectedProjectReadStateAtom, () => {});
    await failPendingReads(new Error("storage went away"));

    expect(store.get(selectedProjectReadStateAtom), "still answered").toBe("read");
    expect(store.get(selectedProjectRefAtom), "and the project has not vanished").toEqual({
      path: "/repo/zeta",
    });
    again();
  });

  // The limit of the latch, stated rather than assumed. `unwrap` keeps no
  // previous value across a rejection, so the re-read a remount issues really
  // is a new read in flight -- and it settles, so nothing waits forever.
  it("goes back to waiting when a remount re-reads after a failure", async () => {
    const { selectedProjectReadStateAtom, store, unsubscribe } = await launch();
    await failPendingReads(new Error("storage is unavailable"));
    expect(store.get(selectedProjectReadStateAtom)).toBe("failed");

    unsubscribe();
    const again = store.sub(selectedProjectReadStateAtom, () => {});

    expect(store.get(selectedProjectReadStateAtom), "a fresh read is in flight").toBe("unread");
    await settlePendingReads("/repo/zeta");
    expect(store.get(selectedProjectReadStateAtom), "and it settles").toBe("read");
    again();
  });

  // The reason a failed read is its own answer: adopting a default here would
  // PERSIST it, so a storage fault that hid the remembered key would go on to
  // overwrite it -- destroying exactly what could not be read. The key is
  // still on disk and still wanted.
  //
  // But the app must not sit on an empty screen every launch either, which is
  // reachable with storage simply blocked. So it opens on a project IN MEMORY
  // and writes nothing.
  it("opens on a project without persisting a guess over a key it could not read", async () => {
    const { reconcileProjectsAtom, selectedProjectRefAtom, store, unsubscribe } = await launch();

    await failPendingReads(new Error("storage is unavailable"));
    store.set(reconcileProjectsAtom, [ZETA, ALPHA]);

    expect(store.get(selectedProjectRefAtom)?.path, "the app opens on something").toBe(
      "/repo/alpha",
    );
    expect(storage.written[SELECTION_KEY], "and the stored key is left alone").toBeUndefined();
    unsubscribe();
  });

  // One reconcile was not enough to prove this. Once the in-memory stand-in
  // supplies a selection, the NEXT snapshot sees a non-null ref and takes the
  // contradicted branch instead -- which used to persist, writing a guess
  // over the very key that could not be read.
  it("still persists nothing when a later snapshot contradicts the stand-in", async () => {
    const { reconcileProjectsAtom, selectedProjectRefAtom, store, unsubscribe } = await launch();

    await failPendingReads(new Error("storage is unavailable"));
    store.set(reconcileProjectsAtom, [ALPHA, ZETA]);
    expect(store.get(selectedProjectRefAtom)?.path).toBe("/repo/alpha");

    // Alpha's host drops out of the snapshot, so the stand-in is contradicted.
    store.set(reconcileProjectsAtom, [ZETA]);

    expect(store.get(selectedProjectRefAtom)?.path, "it moves on in memory").toBe("/repo/zeta");
    expect(storage.written[SELECTION_KEY], "and still writes nothing").toBeUndefined();
    unsubscribe();
  });

  // And a selection the user then makes by hand IS stored: the stand-in must
  // not shadow the real key once there is one to store.
  it("stores a selection made by hand after a failed read", async () => {
    const { reconcileProjectsAtom, selectedProjectRefAtom, selectProjectAtom, store, unsubscribe } =
      await launch();

    await failPendingReads(new Error("storage is unavailable"));
    store.set(reconcileProjectsAtom, [ZETA, ALPHA]);
    store.set(selectProjectAtom, { path: "/repo/zeta" });

    expect(store.get(selectedProjectRefAtom)?.path).toBe("/repo/zeta");
    expect(storage.written[SELECTION_KEY], "the hand-made choice is stored").toBe(
      "\u0000/repo/zeta",
    );
    unsubscribe();
  });

  // The SSR and web-static path: with no `window`, `createSsrSafeJsonStorage`
  // uses a storage that answers `null` at once and holds nothing. There is no
  // promise to unwrap, so nothing may wait on one -- and the answer is a real
  // "nothing stored", not a read in flight.
  it("answers immediately when storage is synchronous", async () => {
    const { selectedProjectReadStateAtom, selectedProjectRefAtom, store, unsubscribe } =
      await launch({ answersSynchronouslyWith: null });

    expect(store.get(selectedProjectReadStateAtom)).toBe("read");
    expect(store.get(selectedProjectRefAtom)).toBeNull();
    unsubscribe();
  });
});

describe("the agent you were last reading", () => {
  // The sibling of the project key, with the same defect and the same effect:
  // `!("then" in stored)` read the pending promise as an empty memory, jotai
  // never replaced it, so the memory was recorded on every selection and
  // restored on none.
  it("is restored on a launch that writes nothing", async () => {
    const { lastAgentByProjectAtom, store, unsubscribe } = await launch();

    expect(store.get(lastAgentByProjectAtom), "not read yet").toEqual({});

    await settleReadsFor(LAST_AGENT_KEY, { "\u0000/repo/zeta": "claude-9" });

    expect(store.get(lastAgentByProjectAtom)).toEqual({ "\u0000/repo/zeta": "claude-9" });
    unsubscribe();
  });

  // The destructive half. The writer merges onto whatever it reads, so a
  // selection made before the memory lands would persist a one-entry map --
  // keeping this project's agent and forgetting every other project's.
  it("is not wiped by a selection made before it has been read", async () => {
    const { lastAgentByProjectAtom, selectedSessionIdAtom, store, unsubscribe } = await launch();

    // The project is known; only the memory is still in flight.
    await settleReadsFor(SELECTION_KEY, "/repo/zeta");
    store.set(selectedSessionIdAtom, "claude-7");

    expect(store.get(selectedSessionIdAtom), "the selection itself still happens").toBe("claude-7");
    expect(
      storage.written[LAST_AGENT_KEY],
      "but nothing is persisted over the memory",
    ).toBeUndefined();

    await settleReadsFor(LAST_AGENT_KEY, { "\u0000/repo/other": "claude-1" });

    expect(
      store.get(lastAgentByProjectAtom),
      "another project's remembered agent survived",
    ).toEqual({ "\u0000/repo/other": "claude-1" });
    unsubscribe();
  });

  // What the layout's replay relies on: setting the same session id again,
  // after the memory has come back, records what the refused write did not.
  it("records a replayed selection once the memory arrives", async () => {
    const { lastAgentByProjectAtom, selectedSessionIdAtom, store, unsubscribe } = await launch();

    await settleReadsFor(SELECTION_KEY, "/repo/zeta");
    store.set(selectedSessionIdAtom, "claude-7");
    expect(storage.written[LAST_AGENT_KEY], "refused while the map was in flight").toBeUndefined();

    await settleReadsFor(LAST_AGENT_KEY, { "\u0000/repo/other": "claude-1" });
    store.set(selectedSessionIdAtom, store.get(selectedSessionIdAtom));

    expect(store.get(lastAgentByProjectAtom), "both entries, neither lost").toEqual({
      "\u0000/repo/other": "claude-1",
      "\u0000/repo/zeta": "claude-7",
    });
    unsubscribe();
  });

  // And once it has been read, recording works as before.
  it("records a selection once the memory has been read", async () => {
    const {
      lastAgentByProjectAtom,
      reconcileProjectsAtom,
      selectedSessionIdAtom,
      store,
      unsubscribe,
    } = await launch();

    await settleReadsFor(SELECTION_KEY, null);
    await settleReadsFor(LAST_AGENT_KEY, {});
    store.set(reconcileProjectsAtom, [ZETA]);
    store.set(selectedSessionIdAtom, "claude-7");

    expect(Object.values(store.get(lastAgentByProjectAtom))).toContain("claude-7");
    unsubscribe();
  });

  // A stored value of the wrong shape is not a memory. The writer merges onto
  // whatever the read returns, and `rememberAgentForProject` indexes it.
  it.each([
    ["null", null],
    // `typeof [] === "object"`, and spreading one gives numeric keys.
    ["an array", ["claude-7"]],
  ])("ignores a stored memory that is %s", async (_label, stored) => {
    const { lastAgentByProjectAtom, selectedSessionIdAtom, store, unsubscribe } = await launch();

    await settleReadsFor(SELECTION_KEY, "/repo/zeta");
    await settleReadsFor(LAST_AGENT_KEY, stored);

    expect(store.get(lastAgentByProjectAtom)).toEqual({});
    expect(() => store.set(selectedSessionIdAtom, "claude-7")).not.toThrow();
    unsubscribe();
  });

  // The empty memory is one shared object, so a consumer writing to it would
  // poison it for the whole process -- and the next real recording would
  // persist the poison.
  it("hands out an empty memory nothing can write to", async () => {
    const { lastAgentByProjectAtom, store, unsubscribe } = await launch();

    await settleReadsFor(LAST_AGENT_KEY, null);
    const memory = store.get(lastAgentByProjectAtom);

    expect(() => {
      (memory as Record<string, string>)["\u0000/repo/zeta"] = "claude-7";
    }).toThrow();
    unsubscribe();
  });
});
