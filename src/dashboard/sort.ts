export function dashboardCreatedSortKey(entry: {
  createdAt?: string;
  tmuxWindowIndex?: number;
  index?: number;
}): number {
  const parsed = entry.createdAt ? Date.parse(entry.createdAt) : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  if (typeof entry.tmuxWindowIndex === "number") return entry.tmuxWindowIndex;
  if (typeof entry.index === "number") return entry.index;
  return 0;
}

export function sortDashboardEntriesByCreatedAt<
  T extends { createdAt?: string; tmuxWindowIndex?: number; index?: number },
>(entries: T[]): T[] {
  return [...entries].sort((a, b) => dashboardCreatedSortKey(b) - dashboardCreatedSortKey(a));
}
