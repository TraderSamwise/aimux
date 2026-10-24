import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DaemonProject } from "@/lib/api";

const SELECTION_KEY = "aimux-selected-project";

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
  const state = { answersSynchronouslyWith: undefined as unknown };
  return {
    reads,
    written,
    state,
    impl: {
      // Stands in for the JSON storage itself, so these reads answer with
      // parsed values rather than JSON text.
      getItem: (key: string) => {
        if (state.answersSynchronouslyWith !== undefined) return state.answersSynchronouslyWith;
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
  vi.resetModules();
  storage.reads.length = 0;
  storage.state.answersSynchronouslyWith = options?.answersSynchronouslyWith;
  for (const key of Object.keys(storage.written)) delete storage.written[key];

  const projects = await import("@/stores/projects");
  const store = createStore();
  // Mounted, as the app mounts it through `useAtomValue`. Mounting matters:
  // `atomWithStorage.onMount` issues a SECOND read, and the latch has to
  // survive it.
  const unsubscribe = store.sub(projects.selectedProjectHydratedAtom, () => {});
  return { ...projects, store, unsubscribe };
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

  // The destructive case, and the reason a failed read is its own answer:
  // adopting a default here PERSISTS it, so a storage fault that hid the
  // remembered key would go on to overwrite it -- destroying exactly what
  // could not be read. The key is still on disk and still wanted.
  it("does not persist a guess over a key it could not read", async () => {
    const { reconcileProjectsAtom, selectedProjectRefAtom, store, unsubscribe } = await launch();

    await failPendingReads(new Error("storage is unavailable"));
    store.set(reconcileProjectsAtom, [ZETA, ALPHA]);

    expect(store.get(selectedProjectRefAtom), "no project is adopted").toBeNull();
    expect(storage.written[SELECTION_KEY], "and the stored key is left alone").toBeUndefined();
    unsubscribe();
  });

  // The SSR and web-static path: `createSsrSafeJsonStorage` falls back to a
  // storage with no `window`, which answers at once. There is no promise to
  // unwrap, so nothing may wait on one.
  it("answers immediately when storage is synchronous", async () => {
    const { selectedProjectReadStateAtom, selectedProjectRefAtom, store, unsubscribe } =
      await launch({ answersSynchronouslyWith: "/repo/zeta" });

    expect(store.get(selectedProjectReadStateAtom)).toBe("read");
    expect(store.get(selectedProjectRefAtom)).toEqual({ path: "/repo/zeta" });
    unsubscribe();
  });
});
