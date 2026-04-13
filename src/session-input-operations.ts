import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getSessionInputOperationsDir } from "./paths.js";

export type SessionInputOperationState = "queued" | "applied" | "submitted" | "failed";

export interface SessionInputOperationRecord {
  id: string;
  sessionId: string;
  clientMessageId?: string;
  submit: boolean;
  state: SessionInputOperationState;
  createdAt: string;
  updatedAt: string;
  messageId?: string;
  error?: string;
}

function ensureOperationsDir(): string {
  const dir = getSessionInputOperationsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function operationPath(operationId: string): string {
  return join(ensureOperationsDir(), `${operationId}.json`);
}

export function createSessionInputOperation(input: {
  sessionId: string;
  clientMessageId?: string;
  submit?: boolean;
}): SessionInputOperationRecord {
  const ts = new Date().toISOString();
  const operation: SessionInputOperationRecord = {
    id: `inputop_${randomUUID()}`,
    sessionId: input.sessionId,
    clientMessageId: input.clientMessageId?.trim() || undefined,
    submit: input.submit === true,
    state: "queued",
    createdAt: ts,
    updatedAt: ts,
  };
  saveSessionInputOperation(operation);
  return operation;
}

export function saveSessionInputOperation(operation: SessionInputOperationRecord): SessionInputOperationRecord {
  const next: SessionInputOperationRecord = {
    ...operation,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(operationPath(next.id), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return next;
}

export function readSessionInputOperation(operationId: string): SessionInputOperationRecord | null {
  try {
    const raw = readFileSync(operationPath(operationId), "utf-8");
    return JSON.parse(raw) as SessionInputOperationRecord;
  } catch {
    return null;
  }
}
