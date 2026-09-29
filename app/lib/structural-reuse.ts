// A poll that re-reports the same agent still arrives as a fresh object, and a
// fresh object is a new identity, so every row below it re-renders whether or
// not anything about it changed. Reusing the previous object for entries that
// did not change turns "one agent's timestamp ticked" from a 35-row render into
// a 1-row render.

function isSame(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Returns `next`, with every entry replaced by the equal entry from `previous`
 * where one exists. If nothing changed at all, `previous` itself comes back, so
 * the array identity is stable too.
 */
export function reuseUnchangedEntries<T>(
  previous: readonly T[] | undefined,
  next: readonly T[],
  identity: (entry: T) => string,
): readonly T[] {
  if (!previous || previous.length === 0) return next;

  const byId = new Map<string, T>();
  for (const entry of previous) byId.set(identity(entry), entry);

  let reusedEveryEntry = previous.length === next.length;
  const merged = next.map((entry, index) => {
    const prior = byId.get(identity(entry));
    if (prior !== undefined && isSame(prior, entry)) {
      // Order matters as much as content: a reordered list is a changed list.
      if (previous[index] !== prior) reusedEveryEntry = false;
      return prior;
    }
    reusedEveryEntry = false;
    return entry;
  });

  return reusedEveryEntry ? previous : merged;
}
