import type { StorageReadState } from "@/lib/jotai-storage";
import {
  preferMachineBearingRef,
  projectKey,
  sameProjectRef,
  type ProjectRef,
} from "@/lib/project-key";

export interface UrlProjectSelectionInput {
  /** A shared chat owns the route; the viewer's own selection is not in play. */
  shareOwnsRoute: boolean;
  /** The project the URL names, if it names one. */
  urlProjectRef: ProjectRef | null;
  /** The selection as it stands. */
  selectedProjectRef: ProjectRef | null;
  /**
   * What happened to the stored selection's read, in full.
   *
   * The reason this is an input rather than an assumption: every guard below
   * compares the URL against the selection, and a selection that has not been
   * read compares as absent. A `?project=` link that names no machine would
   * then be adopted and PERSISTED over a machine-qualified key -- the exact
   * downgrade the guard two steps down exists to prevent, waved through
   * because the thing it protects had not loaded yet.
   *
   * All three answers, not a boolean, because a read that FAILED is the
   * interesting one: it will not arrive later, so waiting would strand the
   * deep link the user just tapped, but the selection it would be compared
   * against is unknown, so a machineless URL still must not be persisted over
   * it.
   */
  selectionReadState: StorageReadState;
  /** A selection the user just made by hand, which outranks the URL until it expires. */
  explicitProjectSelection: { key: string; expiresAt: number } | null;
  now: number;
}

export interface UrlProjectSelectionWrite {
  ref: ProjectRef;
  /** The hold has been honoured and is now spent. */
  clearExplicitSelection: boolean;
}

/**
 * What the URL should do to the selection, or `null` to leave it alone.
 *
 * Extracted from the layout for the same reason `sharedChatRedirect` was: the
 * effect that does this sits in a 500-line route component that no test in
 * this app renders, and it is a writer that PERSISTS what it decides.
 */
export function urlProjectSelectionWrite(
  input: UrlProjectSelectionInput,
): UrlProjectSelectionWrite | null {
  if (input.shareOwnsRoute || !input.urlProjectRef) return null;
  if (input.selectionReadState === "unread") return null;
  // A read that failed never answers, so the URL is honoured rather than left
  // waiting -- but only when it names a machine and so cannot downgrade the
  // key still on disk. A machineless one is refused: the screen renders the
  // URL's project either way, through `resolveRouteProjectRef`, so nothing is
  // stranded by declining to PERSIST it.
  if (input.selectionReadState === "failed" && !input.urlProjectRef.machineId) return null;
  if (sameProjectRef(input.urlProjectRef, input.selectedProjectRef)) return null;

  // A machineless URL does not downgrade a selection that knows which host
  // holds that same path; the layout's URL writer fills the machine back in.
  //
  // Through `preferMachineBearingRef` rather than re-spelling it, because
  // `resolveRouteProjectRef` -- what the layout and `useRouteProject` use to
  // READ the current project -- is built on the same helper. A second copy
  // here would agree today and drift silently.
  if (
    preferMachineBearingRef(input.urlProjectRef, input.selectedProjectRef) !== input.urlProjectRef
  ) {
    return null;
  }

  const urlKey = projectKey(input.urlProjectRef);
  const selectedKey = projectKey(input.selectedProjectRef);
  const { explicitProjectSelection: explicit } = input;
  if (
    explicit &&
    explicit.key === selectedKey &&
    explicit.key !== urlKey &&
    explicit.expiresAt > input.now
  ) {
    return null;
  }

  return { ref: input.urlProjectRef, clearExplicitSelection: explicit?.key === urlKey };
}
