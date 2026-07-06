import { atom } from "jotai";
import type { PrimitiveAtom } from "jotai";
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

const globalInboxRequestScope = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let globalInboxRequestSequence = 0;

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

function createGlobalInboxActionAtoms<T>(resourceAtom: PrimitiveAtom<GlobalInboxResource<T>>) {
  return {
    beginRefreshAtom: atom(null, (get, set, { requestKey }: BeginGlobalInboxRefreshInput) => {
      set(resourceAtom, beginGlobalInboxRefresh(get(resourceAtom), requestKey));
    }),
    applySuccessAtom: atom(
      null,
      (get, set, { requestKey, value, updatedAt }: ApplyGlobalInboxSuccessInput<T>) => {
        set(resourceAtom, applyGlobalInboxSuccess(get(resourceAtom), requestKey, value, updatedAt));
      },
    ),
    applyFailureAtom: atom(
      null,
      (get, set, { requestKey, error }: ApplyGlobalInboxFailureInput) => {
        set(resourceAtom, applyGlobalInboxFailure(get(resourceAtom), requestKey, error));
      },
    ),
    settleRefreshAtom: atom(null, (get, set, { requestKey }: SettleGlobalInboxRefreshInput) => {
      set(resourceAtom, settleGlobalInboxRefresh(get(resourceAtom), requestKey));
    }),
  };
}

const globalNotificationActions = createGlobalInboxActionAtoms<GlobalNotificationRow>(
  globalNotificationResourceAtom,
);
const globalThreadActions = createGlobalInboxActionAtoms<GlobalThreadRow>(globalThreadResourceAtom);

export const beginGlobalNotificationRefreshAtom = globalNotificationActions.beginRefreshAtom;
export const applyGlobalNotificationSuccessAtom = globalNotificationActions.applySuccessAtom;
export const applyGlobalNotificationFailureAtom = globalNotificationActions.applyFailureAtom;
export const settleGlobalNotificationRefreshAtom = globalNotificationActions.settleRefreshAtom;

export const beginGlobalThreadRefreshAtom = globalThreadActions.beginRefreshAtom;
export const applyGlobalThreadSuccessAtom = globalThreadActions.applySuccessAtom;
export const applyGlobalThreadFailureAtom = globalThreadActions.applyFailureAtom;
export const settleGlobalThreadRefreshAtom = globalThreadActions.settleRefreshAtom;

export function globalInboxRequestKey(
  kind: "notifications" | "threads",
  sourceKey: string,
  sequence = ++globalInboxRequestSequence,
): string {
  return `${kind}\u0000${sourceKey}\u0000${globalInboxRequestScope}\u0000${sequence}`;
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
