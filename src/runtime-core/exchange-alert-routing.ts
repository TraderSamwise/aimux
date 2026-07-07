export interface ExchangeAlertThread {
  waitingOn?: string[];
}

export interface ExchangeAlertMessage {
  deliveredTo?: string[];
  to?: string[];
}

export interface ExchangeAlertTask {
  assignedBy?: string;
  assignedTo?: string;
}

function uniqueTrimmed(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean) as string[])];
}

function recipientsExcludingSender(values: Array<string | undefined>, from?: string): string[] {
  const sender = from?.trim();
  return uniqueTrimmed(values).filter((recipient) => recipient !== sender);
}

function stringArrayField(value: unknown, field: "deliveredTo" | "to" | "waitingOn"): string[] {
  if (!value || typeof value !== "object") return [];
  const fieldValue = (value as Record<string, unknown>)[field];
  return Array.isArray(fieldValue) ? fieldValue.filter((item): item is string => typeof item === "string") : [];
}

export function resolveExchangeMessageAlertRecipients(input: {
  explicitRecipients?: string[];
  message?: unknown;
  thread?: unknown;
  fallbackRecipients?: string[];
  from?: string;
}): string[] {
  const explicit = recipientsExcludingSender(input.explicitRecipients ?? [], input.from);
  if (explicit.length > 0) return explicit;

  const deliveredTo = recipientsExcludingSender(stringArrayField(input.message, "deliveredTo"), input.from);
  if (deliveredTo.length > 0) return deliveredTo;

  const waitingOn = recipientsExcludingSender(stringArrayField(input.thread, "waitingOn"), input.from);
  if (waitingOn.length > 0) return waitingOn;

  const messageRecipients = recipientsExcludingSender(stringArrayField(input.message, "to"), input.from);
  if (messageRecipients.length > 0) return messageRecipients;

  return recipientsExcludingSender(input.fallbackRecipients ?? [], input.from);
}

export function resolveExchangeTaskAssignmentRecipient(task: ExchangeAlertTask): string | undefined {
  return uniqueTrimmed([task.assignedTo])[0];
}

export function resolveExchangeTaskActorRecipient(task: ExchangeAlertTask): string | undefined {
  return uniqueTrimmed([task.assignedTo])[0];
}

export function resolveExchangeReviewOutcomeRecipient(task: ExchangeAlertTask): string | undefined {
  return uniqueTrimmed([task.assignedBy])[0];
}
