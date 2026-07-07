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
  const explicit = uniqueTrimmed(input.explicitRecipients ?? []);
  if (explicit.length > 0) return recipientsExcludingSender(explicit, input.from);

  const deliveredTo = uniqueTrimmed(stringArrayField(input.message, "deliveredTo"));
  if (deliveredTo.length > 0) return recipientsExcludingSender(deliveredTo, input.from);

  const waitingOn = uniqueTrimmed(stringArrayField(input.thread, "waitingOn"));
  if (waitingOn.length > 0) return recipientsExcludingSender(waitingOn, input.from);

  const messageRecipients = uniqueTrimmed(stringArrayField(input.message, "to"));
  if (messageRecipients.length > 0) return recipientsExcludingSender(messageRecipients, input.from);

  return recipientsExcludingSender(input.fallbackRecipients ?? [], input.from);
}

export function resolveExchangeTaskAssignmentRecipient(task: ExchangeAlertTask): string | undefined {
  return uniqueTrimmed([task.assignedTo])[0];
}

export function resolveExchangeTaskOutcomeRecipient(input: {
  task: ExchangeAlertTask;
  thread?: unknown;
  from?: string;
}): string | undefined {
  const waitingOn = uniqueTrimmed(stringArrayField(input.thread, "waitingOn"));
  if (waitingOn.length > 0) return recipientsExcludingSender(waitingOn, input.from)[0];
  return recipientsExcludingSender([input.task.assignedBy], input.from)[0];
}

export function resolveExchangeReviewOutcomeRecipient(task: ExchangeAlertTask): string | undefined {
  return uniqueTrimmed([task.assignedBy])[0];
}
