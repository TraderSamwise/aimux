import { createStore } from "jotai";
import { projectStateKey } from "@/lib/project-key";
import { describe, expect, it } from "vitest";

import type { LibraryDocument } from "@/lib/api";
import {
  applyLibraryFailureAtom,
  applyLibrarySuccessAtom,
  beginLibraryRefreshAtom,
  clearLibraryResourceAtom,
  isCurrentLibraryRequest,
  libraryErrorFamily,
  libraryFamily,
  libraryResourceFamily,
  type LibraryValue,
} from "./library";

function document(id: string): LibraryDocument {
  return {
    id,
    title: "AGENTS.md",
    path: "/repo/AGENTS.md",
    kind: "agents",
    size: 1200,
    updatedAt: "2026-01-01T00:00:00.000Z",
    content: "instructions",
  };
}

function library(overrides: Partial<LibraryValue> = {}): LibraryValue {
  return {
    documents: [document("doc-1")],
    fetchedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("library resource lifecycle", () => {
  it("marks an in-flight refresh stale when a previous library exists", () => {
    const store = createStore();
    const stateKey = projectStateKey({ path: "/repo" });
    const current = library();

    store.set(applyLibrarySuccessAtom, {
      projectStateKey: stateKey,
      library: current,
      updatedAt: 10,
    });
    store.set(beginLibraryRefreshAtom, stateKey);

    expect(store.get(libraryResourceFamily(stateKey))).toEqual({
      value: current,
      error: null,
      pending: true,
      stale: true,
      updatedAt: 10,
    });
  });

  it("keeps the last good library after a refresh failure", () => {
    const store = createStore();
    const stateKey = projectStateKey({ path: "/repo" });
    const current = library();

    store.set(applyLibrarySuccessAtom, {
      projectStateKey: stateKey,
      library: current,
      updatedAt: 10,
    });
    store.set(applyLibraryFailureAtom, {
      projectStateKey: stateKey,
      error: "service unavailable",
    });

    expect(store.get(libraryFamily(stateKey))).toBe(current);
    expect(store.get(libraryErrorFamily(stateKey))).toBe("service unavailable");
    expect(store.get(libraryResourceFamily(stateKey))).toMatchObject({
      value: current,
      error: "service unavailable",
      pending: false,
      stale: true,
    });
  });

  it("clears stale/error metadata after the library recovers", () => {
    const store = createStore();
    const stateKey = projectStateKey({ path: "/repo" });
    const current = library();
    const recovered = library({ documents: [document("doc-2")] });

    store.set(applyLibrarySuccessAtom, {
      projectStateKey: stateKey,
      library: current,
      updatedAt: 10,
    });
    store.set(applyLibraryFailureAtom, {
      projectStateKey: stateKey,
      error: "service unavailable",
    });
    store.set(applyLibrarySuccessAtom, {
      projectStateKey: stateKey,
      library: recovered,
      updatedAt: 20,
    });

    expect(store.get(libraryResourceFamily(stateKey))).toEqual({
      value: recovered,
      error: null,
      pending: false,
      stale: false,
      updatedAt: 20,
    });
  });

  it("clears the resource when the project service endpoint disappears", () => {
    const store = createStore();
    const stateKey = projectStateKey({ path: "/repo" });

    store.set(applyLibrarySuccessAtom, {
      projectStateKey: stateKey,
      library: library(),
      updatedAt: 10,
    });
    store.set(clearLibraryResourceAtom, stateKey);

    expect(store.get(libraryResourceFamily(stateKey))).toEqual({
      value: null,
      error: null,
      pending: false,
      stale: false,
      updatedAt: null,
    });
  });

  it("rejects in-flight library results from an old endpoint generation", () => {
    expect(
      isCurrentLibraryRequest(
        {
          projectStateKey: projectStateKey({ path: "/repo" }),
          endpointKey: "127.0.0.1:43190",
          generation: 1,
        },
        {
          projectStateKey: projectStateKey({ path: "/repo" }),
          endpointKey: "127.0.0.1:43191",
          generation: 2,
        },
      ),
    ).toBe(false);

    expect(
      isCurrentLibraryRequest(
        {
          projectStateKey: projectStateKey({ path: "/repo" }),
          endpointKey: "127.0.0.1:43191",
          generation: 2,
        },
        {
          projectStateKey: projectStateKey({ path: "/repo" }),
          endpointKey: "127.0.0.1:43191",
          generation: 2,
        },
      ),
    ).toBe(true);
  });
});
