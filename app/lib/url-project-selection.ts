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
   * Whether the stored selection has come back from storage.
   *
   * The reason this is an input rather than an assumption: every guard below
   * compares the URL against the selection, and an unread selection compares
   * as absent. A `?project=` link that names no machine would then be adopted
   * and PERSISTED over a machine-qualified key -- the exact downgrade the
   * guard two steps down exists to prevent, waved through because the thing
   * it protects had not loaded yet.
   */
  selectionRead: boolean;
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
  if (!input.selectionRead) return null;
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
