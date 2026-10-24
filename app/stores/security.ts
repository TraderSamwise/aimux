import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { createSsrSafeJsonStorage, readBeforeWriteAtom } from "@/lib/jotai-storage";

const MAX_SECURITY_EVENTS = 100;

export interface SecurityEventRecord {
  id: string;
  kind: string;
  deviceId?: string;
  shareId?: string;
  sessionId?: string;
  actorUserId?: string;
  actorName?: string;
  actorEmail?: string;
  targetUserId?: string;
  targetName?: string;
  targetEmail?: string;
  title: string;
  body: string;
  createdAt: string;
  approvalCode?: string;
  country?: string;
  userAgent?: string;
}

export interface SecurityInboxEvent extends SecurityEventRecord {
  receivedAt: string;
  readAt?: string;
}

const asyncSecurityEventsAtom = atomWithStorage<SecurityInboxEvent[]>(
  "aimux-security-events",
  [],
  createSsrSafeJsonStorage<SecurityInboxEvent[]>(),
  { getOnInit: true },
);

// Module scope so the empty inbox keeps one identity across reads, and frozen
// because that identity is shared.
const NO_SECURITY_EVENTS: readonly SecurityInboxEvent[] = Object.freeze([]);

// All three writers below read this list and store a whole new one back, so a
// write before storage answered would replace the stored inbox with a list
// built on an empty one. The hold lives here, where all three pass.
export const securityEventsAtom = readBeforeWriteAtom(
  asyncSecurityEventsAtom,
  NO_SECURITY_EVENTS as SecurityInboxEvent[],
);

export const addSecurityEventAtom = atom(null, (get, set, event: SecurityEventRecord) => {
  const now = new Date().toISOString();
  const current = get(securityEventsAtom);
  const previous = current.find((candidate) => candidate.id === event.id);
  const next: SecurityInboxEvent = {
    ...event,
    receivedAt: previous?.receivedAt ?? now,
    readAt: previous?.readAt,
  };
  set(
    securityEventsAtom,
    [next, ...current.filter((candidate) => candidate.id !== event.id)].slice(
      0,
      MAX_SECURITY_EVENTS,
    ),
  );
});

export const markSecurityEventsReadAtom = atom(null, (get, set) => {
  const now = new Date().toISOString();
  set(
    securityEventsAtom,
    get(securityEventsAtom).map((event) => (event.readAt ? event : { ...event, readAt: now })),
  );
});

export const clearSecurityEventsAtom = atom(null, (_get, set) => {
  set(securityEventsAtom, []);
});

export const securityUnreadCountAtom = atom(
  (get) => get(securityEventsAtom).filter((event) => !event.readAt).length,
);
