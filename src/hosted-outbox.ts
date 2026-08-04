import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { log } from "./debug.js";
import { appendHostedAudit } from "./hosted-audit.js";
import type { HostedEvent } from "./hosted-events.js";
import { withHostedLock } from "./hosted-lock.js";
import { getHostedDir, getHostedOutboxPath } from "./paths.js";

/**
 * Cross-process event spool.
 *
 * The CLI raises events — a revoked token, a changed grant, a lockdown — but it
 * is a short-lived process that does not hold the webhook secret and would exit
 * before any retry completed. So it writes them here, and whichever daemon is
 * running delivers them. Events raised while no daemon is up are delivered when
 * one starts, which is the behaviour an operator expects from a security alert.
 */

const MAX_SPOOLED = 500;
const MAX_SPOOL_BYTES = 1024 * 1024;

/**
 * Raise an event from the CLI: durable in the audit log, spooled for delivery.
 *
 * Audit first, because that record must survive whether or not any webhook is
 * ever configured or reachable.
 */
export function raiseHostedCliEvent(kind: HostedEvent["kind"], principalId: string | null, detail: string): void {
  const ts = new Date().toISOString();
  appendHostedAudit({
    ts,
    principalId: principalId ?? "-",
    label: "cli",
    method: "-",
    path: "-",
    sessionId: null,
    status: 0,
    requestBytes: 0,
    responseBytes: 0,
    event: kind,
    detail,
  });
  spoolHostedEvent({
    id: randomUUID(),
    kind,
    ts,
    principalId,
    label: "cli",
    fingerprint: null,
    addressKnown: false,
    userAgent: null,
    detail,
  });
}

export function spoolHostedEvent(event: HostedEvent): void {
  try {
    mkdirSync(getHostedDir(), { recursive: true, mode: 0o700 });
    // Under the same lock the drain takes: an append landing between the
    // drain's read and its delete would otherwise be silently discarded.
    const path = getHostedOutboxPath();
    // Nothing drains the spool while hosted mode is disabled, so cap it rather
    // than let a scripted CLI grow it without bound.
    if (existsSync(path) && statSync(path).size > MAX_SPOOL_BYTES) {
      log.warn("hosted outbox full, dropping event", "hosted", { kind: event.kind });
      return;
    }

    const append = () => appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    // Non-blocking, and appends anyway if the lock is held: an event lost is
    // worse than one that a concurrent drain happens to miss.
    if (withHostedLock(path, append, { wait: false }) === null) append();
  } catch (error) {
    log.warn("hosted event spool failed", "hosted", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Take everything spooled, leaving the file empty.
 *
 * Read and clear happen under the lock, and spooling takes the same lock, so a
 * concurrent CLI append is not lost between them. A line that will not parse is
 * dropped rather than retried forever.
 *
 * Delivery happens after the drain, so an event whose webhook never succeeds is
 * gone from the spool — the audit log keeps the record, which is the durable
 * half by design.
 */
export function drainHostedOutbox(): HostedEvent[] {
  const path = getHostedOutboxPath();
  if (!existsSync(path)) return [];

  return (
    withHostedLock(
      path,
      () => {
        if (!existsSync(path)) return [];
        const raw = readFileSync(path, "utf-8");
        rmSync(path, { force: true });
        const events = raw
          .split("\n")
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line) as HostedEvent];
            } catch {
              return [];
            }
          });
        if (events.length > MAX_SPOOLED) {
          log.warn("hosted outbox oversized, dropping oldest", "hosted", { dropped: events.length - MAX_SPOOLED });
          return events.slice(-MAX_SPOOLED);
        }
        return events;
      },
      // Never blocks the daemon's event loop: a contended drain simply happens
      // on the next tick, five seconds later.
      { wait: false },
    ) ?? []
  );
}
