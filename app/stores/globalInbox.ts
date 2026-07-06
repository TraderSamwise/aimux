import { atom } from "jotai";
import type { NotificationRecord, ThreadSummaryResponse } from "@/lib/api";

export interface GlobalNotificationRow {
  projectName: string;
  projectPath: string;
  notification: NotificationRecord;
}

export interface GlobalThreadRow {
  projectName: string;
  projectPath: string;
  thread: ThreadSummaryResponse;
}

export interface GlobalInboxValue<T> {
  rows: T[];
  errors: string[];
  projectCount: number;
  fetchedAt: string;
}

export interface GlobalInboxResource<T> {
  value: GlobalInboxValue<T> | null;
  error: string | null;
  pending: boolean;
  pendingRequestKey: string | null;
  stale: boolean;
  updatedAt: number | null;
}

export interface BeginGlobalInboxRefreshInput {
  requestKey: string;
}

export interface ApplyGlobalInboxSuccessInput<T> {
  requestKey: string;
  value: GlobalInboxValue<T>;
  updatedAt?: number;
}

export interface ApplyGlobalInboxFailureInput {
  requestKey: string;
  error: string;
}

export interface SettleGlobalInboxRefreshInput {
  requestKey: string;
}

const emptyGlobalInboxResource = <T>(): GlobalInboxResource<T> => ({
  value: null,
  error: null,
  pending: false,
  pendingRequestKey: null,
  stale: false,
  updatedAt: null,
});

export const globalNotificationResourceAtom = atom<GlobalInboxResource<GlobalNotificationRow>>(
  emptyGlobalInboxResource<GlobalNotificationRow>(),
);

export const globalThreadResourceAtom = atom<GlobalInboxResource<GlobalThreadRow>>(
  emptyGlobalInboxResource<GlobalThreadRow>(),
);

function beginGlobalInboxRefresh<T>(
  current: GlobalInboxResource<T>,
  requestKey: string,
): GlobalInboxResource<T> {
  return {
    ...current,
    pending: true,
    pendingRequestKey: requestKey,
    stale: current.value !== null,
  };
}

function applyGlobalInboxSuccess<T>(
  current: GlobalInboxResource<T>,
  requestKey: string,
  value: GlobalInboxValue<T>,
  updatedAt?: number,
): GlobalInboxResource<T> {
  if (current.pendingRequestKey !== requestKey) return current;
  return {
    value,
    error: null,
    pending: false,
    pendingRequestKey: null,
    stale: false,
    updatedAt: updatedAt ?? Date.now(),
  };
}

function applyGlobalInboxFailure<T>(
  current: GlobalInboxResource<T>,
  requestKey: string,
  error: string,
): GlobalInboxResource<T> {
  if (current.pendingRequestKey !== requestKey) return current;
  return {
    ...current,
    error,
    pending: false,
    pendingRequestKey: null,
    stale: current.value !== null,
  };
}

function settleGlobalInboxRefresh<T>(
  current: GlobalInboxResource<T>,
  requestKey: string,
): GlobalInboxResource<T> {
  if (current.pendingRequestKey !== requestKey) return current;
  return {
    ...current,
    pending: false,
    pendingRequestKey: null,
    stale: current.value !== null,
  };
}

export const beginGlobalNotificationRefreshAtom = atom(
  null,
  (get, set, { requestKey }: BeginGlobalInboxRefreshInput) => {
    set(
      globalNotificationResourceAtom,
      beginGlobalInboxRefresh(get(globalNotificationResourceAtom), requestKey),
    );
  },
);

export const applyGlobalNotificationSuccessAtom = atom(
  null,
  (
    get,
    set,
    { requestKey, value, updatedAt }: ApplyGlobalInboxSuccessInput<GlobalNotificationRow>,
  ) => {
    set(
      globalNotificationResourceAtom,
      applyGlobalInboxSuccess(get(globalNotificationResourceAtom), requestKey, value, updatedAt),
    );
  },
);

export const applyGlobalNotificationFailureAtom = atom(
  null,
  (get, set, { requestKey, error }: ApplyGlobalInboxFailureInput) => {
    set(
      globalNotificationResourceAtom,
      applyGlobalInboxFailure(get(globalNotificationResourceAtom), requestKey, error),
    );
  },
);

export const settleGlobalNotificationRefreshAtom = atom(
  null,
  (get, set, { requestKey }: SettleGlobalInboxRefreshInput) => {
    set(
      globalNotificationResourceAtom,
      settleGlobalInboxRefresh(get(globalNotificationResourceAtom), requestKey),
    );
  },
);

export const beginGlobalThreadRefreshAtom = atom(
  null,
  (get, set, { requestKey }: BeginGlobalInboxRefreshInput) => {
    set(
      globalThreadResourceAtom,
      beginGlobalInboxRefresh(get(globalThreadResourceAtom), requestKey),
    );
  },
);

export const applyGlobalThreadSuccessAtom = atom(
  null,
  (get, set, { requestKey, value, updatedAt }: ApplyGlobalInboxSuccessInput<GlobalThreadRow>) => {
    set(
      globalThreadResourceAtom,
      applyGlobalInboxSuccess(get(globalThreadResourceAtom), requestKey, value, updatedAt),
    );
  },
);

export const applyGlobalThreadFailureAtom = atom(
  null,
  (get, set, { requestKey, error }: ApplyGlobalInboxFailureInput) => {
    set(
      globalThreadResourceAtom,
      applyGlobalInboxFailure(get(globalThreadResourceAtom), requestKey, error),
    );
  },
);

export const settleGlobalThreadRefreshAtom = atom(
  null,
  (get, set, { requestKey }: SettleGlobalInboxRefreshInput) => {
    set(
      globalThreadResourceAtom,
      settleGlobalInboxRefresh(get(globalThreadResourceAtom), requestKey),
    );
  },
);

export function globalInboxRequestKey(
  kind: "notifications" | "threads",
  sourceKey: string,
  sequence: number,
): string {
  return `${kind}\u0000${sourceKey}\u0000${sequence}`;
}

export function mergeGlobalRowsWithPrevious<T extends { projectPath: string }>(
  previousRows: readonly T[],
  nextRows: readonly T[],
  failedProjectPaths: ReadonlySet<string>,
): T[] {
  if (failedProjectPaths.size === 0) return [...nextRows];
  const retainedRows = previousRows.filter((row) => failedProjectPaths.has(row.projectPath));
  return [...nextRows, ...retainedRows];
}
